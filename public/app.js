// Frontend: Setup tab (connection + chain editor) and Monitor tab (ADR-09).
// All state lives on the server — rig.json via /api/rig, QRC via /api/status.
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const COLORS = { connected: 'var(--green)', connecting: 'var(--amber)', disconnected: 'var(--gray)' };
  const FALLBACK_CHANNELS = 16; // when a component has no channel_count property

  let rig = null;        // last rig loaded from / saved to the server
  const candidates = {};  // role → [{name, type, properties}] for that stage's dropdown
  let lastState = null;
  let busy = false;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }

  // --- tabs --------------------------------------------------------------------
  function showTab(name) {
    for (const t of ['setup', 'monitor']) {
      $('tab-' + t).classList.toggle('on', t === name);
      $('view-' + t).classList.toggle('hidden', t !== name);
    }
    if (name === 'monitor') startMonitor(); else stopMonitor();
  }
  $('tab-setup').onclick = () => showTab('setup');
  $('tab-monitor').onclick = () => showTab('monitor');

  // --- connection ----------------------------------------------------------------
  function showStatus(st) {
    const where = st.host ? ' — ' + esc(st.host) + ':' + st.port : '';
    const err = st.error ? ' <span class="err">(' + esc(st.error) + ')</span>' : '';
    $('conn-status').innerHTML = '<i style="background:' + (COLORS[st.state] || COLORS.disconnected) + '"></i><span>' + st.state + where + err + '</span>';
    const up = st.state !== 'disconnected';
    $('c-connect').disabled = busy || up;
    $('c-disconnect').disabled = busy || !up;
    const changed = st.state !== lastState && (st.state === 'connected' || lastState === 'connected');
    lastState = st.state;
    if (changed) loadAllCandidates();
  }

  async function refreshStatus() {
    try { showStatus(await api('GET', '/api/status')); }
    catch (e) { showStatus({ state: 'disconnected', error: 'Tool server unreachable' }); }
  }

  $('conn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    busy = true;
    showStatus({ state: 'connecting', host: $('c-host').value, port: $('c-port').value });
    try {
      await api('POST', '/api/connect', {
        host: $('c-host').value, port: $('c-port').value, user: $('c-user').value, pass: $('c-pass').value,
      });
    } catch (err) { /* the status refresh below shows the error */ }
    busy = false;
    refreshStatus();
  });

  $('c-disconnect').addEventListener('click', async () => {
    busy = true;
    try { await api('POST', '/api/disconnect'); } catch (err) { /* status refresh below */ }
    busy = false;
    refreshStatus();
  });

  // --- chain editor: one row per stage (S1 AEC, S3 input, S5 output, S7 automixer) ---
  // Each row has #<role>-comp, #<role>-ch and #<role>-all; the role id is the chain key.
  const STAGE_ROLES = ['input', 'aec', 'automixer', 'output'];
  const chain = () => rig.chains[0];

  // AEC: channel_count; gating automixer: n_channels (CONFIRMED); Flex: neither.
  function channelCount(role, name) {
    const c = candidates[role].find((x) => x.name === name);
    const p = (c && c.properties) || {};
    const n = parseInt(p.channel_count || p.n_channels, 10);
    return n > 0 ? n : FALLBACK_CHANNELS;
  }

  function renderStage(role) {
    const sel = chain()[role];
    const saved = sel ? sel.component : '';
    const names = candidates[role].map((c) => c.name);
    let opts = '<option value="">(none)</option>' + candidates[role].map((c) =>
      '<option value="' + esc(c.name) + '">' + esc(c.name) + ' — ' + esc(c.type) + '</option>').join('');
    if (saved && !names.includes(saved)) {
      const why = lastState === 'connected' ? 'not in this design' : 'saved';
      opts += '<option value="' + esc(saved) + '">' + esc(saved) + ' (' + why + ')</option>';
    }
    $(role + '-comp').innerHTML = opts;
    $(role + '-comp').value = saved;
    renderChannels(role, sel ? sel.channel : 1);
  }

  function renderChannels(role, want) {
    const comp = $(role + '-comp').value;
    const n = Math.max(channelCount(role, comp), want || 1);
    let opts = '';
    for (let i = 1; i <= n; i++) opts += '<option>' + i + '</option>';
    $(role + '-ch').innerHTML = opts;
    $(role + '-ch').value = String(want || 1);
    $(role + '-ch').disabled = !comp;
  }

  async function loadCandidates(role) {
    candidates[role] = [];
    if (lastState === 'connected') {
      try {
        const r = await api('GET', '/api/roles/' + role + '/candidates' + ($(role + '-all').checked ? '?all=1' : ''));
        candidates[role] = r.components;
        $('rig-msg').textContent = '';
      } catch (e) {
        $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      }
    }
    if (rig) (role === 'mixer' ? renderMixerPicker : renderStage)(role);
  }

  const loadAllCandidates = () => [...STAGE_ROLES, 'mixer'].forEach(loadCandidates);

  for (const role of STAGE_ROLES) {
    candidates[role] = [];
    $(role + '-all').addEventListener('change', () => loadCandidates(role));
    $(role + '-comp').addEventListener('change', () => renderChannels(role, 1));
  }

  // --- mixer crosspoints (S6): a list edited here, saved with the rest -------------
  // xps mirrors chain().mixer until Save; key = mixer + in + out (the server rejects duplicates).
  let xps = [];
  candidates.mixer = [];
  const xpKey = (x) => 'mixer.' + x.component + '.' + x.in + '.' + x.out;

  function mixerSize(name, prop) {
    const c = candidates.mixer.find((x) => x.name === name);
    const n = c && parseInt(c.properties && c.properties[prop], 10);
    return n > 0 ? n : FALLBACK_CHANNELS;
  }

  function numberOptions(id, n, keep) {
    let opts = '';
    for (let i = 1; i <= n; i++) opts += '<option>' + i + '</option>';
    $(id).innerHTML = opts;
    $(id).value = String(keep && keep <= n ? keep : 1);
  }

  function renderMixerPicker() {
    const keep = $('mixer-comp').value || (xps[0] && xps[0].component) || '';
    const names = candidates.mixer.map((c) => c.name);
    let opts = '<option value="">(pick a mixer)</option>' + candidates.mixer.map((c) =>
      '<option value="' + esc(c.name) + '">' + esc(c.name) + ' — ' + esc(c.type) + '</option>').join('');
    if (keep && !names.includes(keep)) opts += '<option value="' + esc(keep) + '">' + esc(keep) + ' (' + (lastState === 'connected' ? 'not in this design' : 'saved') + ')</option>';
    $('mixer-comp').innerHTML = opts;
    $('mixer-comp').value = keep;
    renderMixerSize();
    renderXpList();
  }

  function renderMixerSize() {
    const comp = $('mixer-comp').value;
    numberOptions('mixer-in', mixerSize(comp, 'n_inputs'), Number($('mixer-in').value));
    numberOptions('mixer-out', mixerSize(comp, 'n_outputs'), Number($('mixer-out').value));
    for (const id of ['mixer-in', 'mixer-out', 'mixer-ref', 'mixer-add']) $(id).disabled = !comp;
  }

  function renderXpList() {
    $('mixer-list').innerHTML = xps.length ? xps.map((x, i) =>
      '<li><span>' + esc(x.component) + ' · In ' + x.in + ' → Out ' + x.out + '</span>' +
      (x.feedsRef ? '<span class="tag">AEC ref</span>' : '') +
      '<button type="button" data-rm="' + i + '">Remove</button></li>').join('')
      : '<li><span class="csub">No crosspoints — this mic path isn\'t checked through the mixer.</span></li>';
  }

  $('mixer-all').addEventListener('change', () => loadCandidates('mixer'));
  $('mixer-comp').addEventListener('change', renderMixerSize);
  $('mixer-add').addEventListener('click', () => {
    const x = { component: $('mixer-comp').value, in: Number($('mixer-in').value), out: Number($('mixer-out').value), feedsRef: $('mixer-ref').checked };
    if (!x.component) return;
    if (xps.some((y) => xpKey(y) === xpKey(x))) {
      $('rig-msg').innerHTML = '<span class="err">In ' + x.in + ' → Out ' + x.out + ' is already in the list</span>';
      return;
    }
    xps.push(x);
    $('mixer-ref').checked = false;
    $('rig-msg').textContent = 'Unsaved changes';
    renderXpList();
  });
  $('mixer-list').addEventListener('click', (e) => {
    const i = e.target.getAttribute && e.target.getAttribute('data-rm');
    if (i === null || i === undefined) return;
    xps.splice(Number(i), 1);
    $('rig-msg').textContent = 'Unsaved changes';
    renderXpList();
  });

  // --- field readings (S4): empty box = not measured; the server checks ranges ----
  function renderField() {
    const f = rig.field;
    $('field-seats').value = f.seatSpl.join(', ');
    $('field-noise').value = f.noiseFloor === null ? '' : f.noiseFloor;
    $('field-rt60').value = f.rt60 === null ? '' : f.rt60;
  }

  function readField() {
    const num = (id, what) => {
      const s = $(id).value.trim();
      if (s === '') return null;
      const v = Number(s);
      if (!Number.isFinite(v)) throw new Error(what + ' must be a number');
      return v;
    };
    const seats = $('field-seats').value.split(/[\s,;]+/).filter((s) => s !== '').map((s, i) => {
      const v = Number(s);
      if (!Number.isFinite(v)) throw new Error('Seat ' + (i + 1) + ' SPL "' + s + '" is not a number');
      return v;
    });
    return { seatSpl: seats, noiseFloor: num('field-noise', 'Noise floor'), rt60: num('field-rt60', 'RT60') };
  }

  $('rig-save').addEventListener('click', async () => {
    const next = JSON.parse(JSON.stringify(rig));
    for (const role of STAGE_ROLES) {
      const comp = $(role + '-comp').value;
      next.chains[0][role] = comp ? { component: comp, channel: Number($(role + '-ch').value) } : null;
    }
    next.chains[0].mixer = xps.map((x) => ({ ...x }));
    try { next.field = readField(); } catch (e) {
      $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      return;
    }
    $('rig-msg').textContent = 'Saving…';
    try {
      rig = await api('PUT', '/api/rig', next);
      xps = chain().mixer.map((x) => ({ ...x }));
      renderXpList();
      renderField();
      $('rig-msg').innerHTML = '<span class="ok">Saved to rig.json</span>';
    } catch (e) {
      $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    }
  });

  async function loadRig() {
    try {
      rig = await api('GET', '/api/rig');
      $('chain-label').textContent = chain().label;
      STAGE_ROLES.forEach(renderStage);
      xps = chain().mixer.map((x) => ({ ...x }));
      renderMixerPicker();
      renderField();
    } catch (e) {
      $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      $('rig-save').disabled = true; // never overwrite a rig.json we couldn't read
    }
  }

  // --- Monitor tab (S2): short-polls /api/monitor while visible (ADR-11) ----------
  const MONITOR_MS = 500;
  const LEVEL_COLORS = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)' };
  let monTimer = null;

  // Bar meter. `centred` bars grow from 0 in the middle (RMLR); others from lo.
  // `lo`/`hi` override the meter's range for display (the input bar shows −60…0
  // of −120…+20); `warn(v)` turns the bar amber. Values past the displayed range
  // are drawn pinned at the edge and flagged.
  function renderMeter(card, m, { centred = false, lo, hi, warn = () => false } = {}) {
    card.classList.toggle('stale', !m || m.stale);
    const fill = card.querySelector('.fill');
    if (!m || m.value === null) {
      fill.style.width = '0';
      card.querySelector('.val').textContent = '—';
      return;
    }
    lo = lo === undefined ? m.lo : lo;
    hi = hi === undefined ? m.hi : hi;
    const span = hi - lo;
    const clamped = Math.min(hi, Math.max(lo, m.value));
    const pos = (clamped - lo) / span * 100;
    const zero = centred ? (0 - lo) / span * 100 : 0;
    fill.style.left = Math.min(pos, zero) + '%';
    fill.style.width = Math.abs(pos - zero) + '%';
    fill.style.background = m.stale ? 'var(--gray)' : warn(m.value) ? 'var(--amber)' : 'var(--green)';
    const pinned = m.value <= lo || m.value >= hi ? ' (pinned)' : '';
    const v = (centred && m.value > 0 ? '+' : '') + m.value.toFixed(1) + ' ' + m.unit;
    card.querySelector('.val').textContent = v + pinned + (m.stale ? ' · stale' : '');
  }

  // S6 — one row per saved crosspoint: gain + mutes (control values; the mixer has
  // no meters). An open AEC-ref crosspoint is drawn red — the advisor says why.
  function renderMixerCard(byKey) {
    const list = rig ? chain().mixer : [];
    if (!list.length) {
      $('mon-mixer-rows').innerHTML = '<p class="csub" style="margin:8px 0 0">No crosspoints set — add them on the Setup tab.</p>';
      return;
    }
    $('mon-mixer-rows').innerHTML = list.map((x) => {
      const k = xpKey(x);
      const g = byKey(k + '.gain');
      const on = (m) => !!(m && m.value !== null && m.value >= 0.5);
      const mutes = [on(byKey(k + '.inMute')) && 'in ' + x.in + ' muted', on(byKey(k + '.outMute')) && 'out ' + x.out + ' muted'].filter(Boolean);
      const live = g && g.value !== null && !g.stale;
      const closed = live && (g.value <= -100 || mutes.length);
      const colour = !live ? 'var(--mute)' : x.feedsRef && !closed ? 'var(--red)' : '';
      const val = g && g.value !== null ? (g.value > 0 ? '+' : '') + g.value.toFixed(1) + ' dB' : '—';
      return '<div class="xprow"><span>In ' + x.in + ' → Out ' + x.out + '</span>' + (x.feedsRef ? '<span class="tag">AEC ref</span>' : '') +
        '<span class="csub">' + esc(x.component) + (mutes.length ? ' · ' + mutes.join(', ') : '') + (g && g.stale ? ' · stale' : '') + '</span>' +
        '<span class="v" style="color:' + colour + '">' + val + '</span></div>';
    }).join('');
  }

  // S7 — gate card: signal-above-noise bar with the threshold marked; amber when
  // at or under the threshold (the talker's gate wouldn't open). Mute/Manual noted.
  function renderAutomixerCard(byKey) {
    const snr = byKey('automixer.snr');
    const thr = byKey('automixer.threshold');
    const t = thr && thr.value !== null && !thr.stale ? thr.value : null;
    renderMeter($('mon-automixer'), snr, { warn: (v) => t !== null && v <= t });
    const mark = $('mon-am-thr');
    mark.style.display = t === null ? 'none' : '';
    if (t !== null) mark.style.left = Math.min(100, Math.max(0, t / 50 * 100)) + '%';
    const on = (k) => { const m = byKey(k); return !!(m && !m.stale && m.value !== null && m.value >= 0.5); };
    $('mon-am-open').classList.toggle('on', on('automixer.open'));
    const flags = [t !== null && 'threshold ' + t.toFixed(1) + ' dB', on('automixer.mute') && 'post-gate muted', on('automixer.manual') && 'manual'].filter(Boolean);
    $('mon-am-flags').textContent = snr ? flags.join(' · ') : 'No automixer set — pick one on the Setup tab.';
  }

  function renderMonitor(s) {
    const where = s.error ? ' <span class="err">(' + esc(s.error) + ')</span>' : '';
    $('mon-status').innerHTML = '<i style="background:' + (COLORS[s.state] || COLORS.disconnected) + '"></i><span>' +
      esc(s.state) + where + (s.meters.length ? '' : ' — no metered stage set; pick an input, AEC, automixer, mixer crosspoint or output on the Setup tab') + '</span>';
    const byKey = (k) => s.meters.find((m) => m.key === k);
    renderMeter($('mon-input'), byKey('input.level'), { lo: -60, hi: 0, warn: (v) => v > -3 });
    const clip = byKey('input.clip');
    $('mon-clip').classList.toggle('on', !!(clip && !clip.stale && clip.value >= 0.5));
    renderMeter($('mon-rmlr'), byKey('aec.rmlr'), { centred: true, warn: (v) => Math.abs(v) > 3 });
    renderMeter($('mon-erle'), byKey('aec.erle'));
    renderMeter($('mon-output'), byKey('output.level'), { lo: -60, hi: 0, warn: (v) => v > -3 });
    renderAutomixerCard(byKey);
    renderMixerCard(byKey);
    // S5 — ELR is derived server-side; `needs` says why there's no value yet.
    const elr = s.derived && s.derived.elr && s.derived.elr[0];
    $('mon-elr-val').textContent = elr && elr.value !== null ? (elr.value > 0 ? '+' : '') + elr.value.toFixed(1) + ' dB' : '—';
    $('mon-elr-val').style.color = elr && elr.value !== null && elr.value < 6 ? 'var(--amber)' : '';
    $('mon-elr-needs').textContent = elr ? (elr.needs || 'ERLE is not ELR.') : 'ELR needs a named output component — set the output stage. ERLE is not ELR.';
    if (s.mode) for (const r of document.querySelectorAll('input[name="mon-mode"]')) r.checked = r.value === s.mode;
    $('mon-findings').innerHTML = s.findings.length
      ? s.findings.map((f) => '<li><i style="background:' + (LEVEL_COLORS[f.level] || COLORS.disconnected) + '"></i><span>' +
          esc(f.text) + '</span><span class="src">' + esc(f.source) + '</span></li>').join('')
      : '<li><span class="csub">No findings — needs live meter values.</span></li>';
  }

  async function pollMonitor() {
    try { renderMonitor(await api('GET', '/api/monitor')); }
    catch (e) { renderMonitor({ state: 'disconnected', error: 'Tool server unreachable', meters: [], findings: [] }); }
  }

  // S3 — talker / quiet-room mode picks which input rule the advisor applies.
  for (const r of document.querySelectorAll('input[name="mon-mode"]')) {
    r.addEventListener('change', async () => {
      try { await api('PUT', '/api/monitor/mode', { mode: r.value }); } catch (e) { /* next poll shows the server's mode */ }
      pollMonitor();
    });
  }

  function startMonitor() {
    if (monTimer) return;
    pollMonitor();
    monTimer = setInterval(pollMonitor, MONITOR_MS);
  }

  function stopMonitor() {
    clearInterval(monTimer);
    monTimer = null;
  }

  loadRig().then(refreshStatus);
  setInterval(refreshStatus, 2000); // surfaces remote drops
})();
