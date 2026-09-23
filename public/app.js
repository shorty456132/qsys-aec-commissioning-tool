// Frontend: Setup tab (connection + chain editor) and Monitor tab (ADR-09).
// All state lives on the server — rig.json via /api/rig, QRC via /api/status.
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const COLORS = { connected: 'var(--green)', connecting: 'var(--amber)', disconnected: 'var(--gray)' };
  const FALLBACK_CHANNELS = 16; // when a component has no channel_count property

  let rig = null;        // last rig loaded from / saved to the server
  let candidates = [];   // [{name, type, properties}] for the AEC dropdown
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
    if (changed) loadCandidates();
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

  // --- chain editor: AEC stage (S1) ----------------------------------------------
  const chain = () => rig.chains[0];

  function channelCount(name) {
    const c = candidates.find((x) => x.name === name);
    const n = c && parseInt(c.properties && c.properties.channel_count, 10);
    return n > 0 ? n : FALLBACK_CHANNELS;
  }

  function renderAec() {
    const sel = chain().aec;
    const saved = sel ? sel.component : '';
    const names = candidates.map((c) => c.name);
    let opts = '<option value="">(none)</option>' + candidates.map((c) =>
      '<option value="' + esc(c.name) + '">' + esc(c.name) + ' — ' + esc(c.type) + '</option>').join('');
    if (saved && !names.includes(saved)) {
      const why = lastState === 'connected' ? 'not in this design' : 'saved';
      opts += '<option value="' + esc(saved) + '">' + esc(saved) + ' (' + why + ')</option>';
    }
    $('aec-comp').innerHTML = opts;
    $('aec-comp').value = saved;
    renderChannels(sel ? sel.channel : 1);
  }

  function renderChannels(want) {
    const comp = $('aec-comp').value;
    const n = Math.max(channelCount(comp), want || 1);
    let opts = '';
    for (let i = 1; i <= n; i++) opts += '<option>' + i + '</option>';
    $('aec-ch').innerHTML = opts;
    $('aec-ch').value = String(want || 1);
    $('aec-ch').disabled = !comp;
  }

  async function loadCandidates() {
    candidates = [];
    if (lastState === 'connected') {
      try {
        const r = await api('GET', '/api/roles/aec/candidates' + ($('aec-all').checked ? '?all=1' : ''));
        candidates = r.components;
        $('rig-msg').textContent = '';
      } catch (e) {
        $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      }
    }
    if (rig) renderAec();
  }

  $('aec-all').addEventListener('change', loadCandidates);
  $('aec-comp').addEventListener('change', () => renderChannels(1));

  $('rig-save').addEventListener('click', async () => {
    const comp = $('aec-comp').value;
    const next = JSON.parse(JSON.stringify(rig));
    next.chains[0].aec = comp ? { component: comp, channel: Number($('aec-ch').value) } : null;
    $('rig-msg').textContent = 'Saving…';
    try {
      rig = await api('PUT', '/api/rig', next);
      $('rig-msg').innerHTML = '<span class="ok">Saved to rig.json</span>';
    } catch (e) {
      $('rig-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    }
  });

  async function loadRig() {
    try {
      rig = await api('GET', '/api/rig');
      $('chain-label').textContent = chain().label;
      renderAec();
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
  // Values past the range are drawn pinned at the edge and flagged.
  function renderMeter(card, m, centred) {
    card.classList.toggle('stale', !m || m.stale);
    const fill = card.querySelector('.fill');
    if (!m || m.value === null) {
      fill.style.width = '0';
      card.querySelector('.val').textContent = '—';
      return;
    }
    const span = m.hi - m.lo;
    const clamped = Math.min(m.hi, Math.max(m.lo, m.value));
    const pos = (clamped - m.lo) / span * 100;
    const zero = centred ? (0 - m.lo) / span * 100 : 0;
    fill.style.left = Math.min(pos, zero) + '%';
    fill.style.width = Math.abs(pos - zero) + '%';
    const out = centred && Math.abs(m.value) > 3;
    fill.style.background = m.stale ? 'var(--gray)' : out ? 'var(--amber)' : 'var(--green)';
    const pinned = m.value <= m.lo || m.value >= m.hi ? ' (pinned)' : '';
    const v = (centred && m.value > 0 ? '+' : '') + m.value.toFixed(1) + ' ' + m.unit;
    card.querySelector('.val').textContent = v + pinned + (m.stale ? ' · stale' : '');
  }

  function renderMonitor(s) {
    const where = s.error ? ' <span class="err">(' + esc(s.error) + ')</span>' : '';
    $('mon-status').innerHTML = '<i style="background:' + (COLORS[s.state] || COLORS.disconnected) + '"></i><span>' +
      esc(s.state) + where + (s.meters.length ? '' : ' — no metered stage set; pick an AEC on the Setup tab') + '</span>';
    const byKey = (k) => s.meters.find((m) => m.key === k);
    renderMeter($('mon-rmlr'), byKey('aec.rmlr'), true);
    renderMeter($('mon-erle'), byKey('aec.erle'), false);
    $('mon-findings').innerHTML = s.findings.length
      ? s.findings.map((f) => '<li><i style="background:' + (LEVEL_COLORS[f.level] || COLORS.disconnected) + '"></i><span>' +
          esc(f.text) + '</span><span class="src">' + esc(f.source) + '</span></li>').join('')
      : '<li><span class="csub">No findings — needs live meter values.</span></li>';
  }

  async function pollMonitor() {
    try { renderMonitor(await api('GET', '/api/monitor')); }
    catch (e) { renderMonitor({ state: 'disconnected', error: 'Tool server unreachable', meters: [], findings: [] }); }
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
