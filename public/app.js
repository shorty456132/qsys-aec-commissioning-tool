// Frontend logic. Simulator mode is the v1 behavior, driven through the
// shared GainModel so live mode (Phase 1+) uses identical rules.
'use strict';
(function () {
  const G = window.GainModel;
  const $ = (id) => document.getElementById(id);

  const S = {};
  let tap = 'post';

  function fader(key, host) {
    const f = G.FADERS[key];
    S[key] = f.def;
    const w = document.createElement('div');
    w.className = 'strip';
    w.innerHTML = '<div class="lbl">' + f.lbl + '</div><input type="range" class="fad" min="0" max="1000" step="1" aria-label="' + f.lbl + '"><input class="vbox" aria-label="' + f.lbl + ' value">';
    host.appendChild(w);
    const r = w.querySelector('.fad'), b = w.querySelector('.vbox');
    f.set = (v) => {
      v = Math.max(f.min, Math.min(f.max, v));
      S[key] = v;
      r.value = G.toPos(f, v);
      b.value = G.fmt(v, f.unit);
    };
    r.addEventListener('input', () => { S[key] = G.toDb(f, +r.value); b.value = G.fmt(S[key], f.unit); upd(); });
    r.addEventListener('dblclick', () => { f.set(f.def); upd(); });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseFloat(b.value.replace('−', '-'));
        if (!isNaN(v)) f.set(v); else f.set(S[key]);
        upd();
        b.blur();
      }
    });
    b.addEventListener('blur', () => { b.value = G.fmt(S[key], f.unit); });
    f.set(f.def);
  }

  function meter(id, label, host, lo, hi, ticks, center) {
    const w = document.createElement('div');
    w.className = 'strip';
    let sc = '';
    ticks.forEach((t) => { sc += '<span style="bottom:' + ((t - lo) / (hi - lo) * 100) + '%">' + String(t).replace('-', '−') + '</span>'; });
    w.innerHTML = '<div class="lbl">' + label + '</div><div class="mwrap"><div class="scale">' + sc + '</div><div class="meter"><div class="f" id="m-' + id + '"></div>' + (center !== undefined ? '<div class="tgt" style="bottom:calc(' + ((center - lo) / (hi - lo) * 100) + '% - 1px)"></div>' : '') + '</div></div><input class="vbox" id="v-' + id + '" readonly>';
    host.appendChild(w);
  }

  function setM(id, v, lo, hi, col, center) {
    const e = $('m-' + id), c = Math.max(lo, Math.min(hi, v));
    if (center === undefined) {
      e.style.bottom = '0';
      e.style.height = ((c - lo) / (hi - lo) * 100) + '%';
    } else {
      const a = (center - lo) / (hi - lo) * 100, b = (c - lo) / (hi - lo) * 100;
      e.style.bottom = Math.min(a, b) + '%';
      e.style.height = Math.abs(b - a) + '%';
    }
    e.style.background = col;
  }

  fader('src', $('g-src'));
  fader('out', $('g-out')); meter('drv', 'Output Level', $('g-out'), -60, 0, [0, -20, -40, -60]);
  fader('xpt', $('g-mix'));
  fader('rg', $('g-aec')); meter('ref', 'Reference Level', $('g-aec'), -60, 0, [0, -20, -40, -60]); meter('rmlr', 'RMLR', $('g-aec'), -20, 20, [20, 10, 0, -10, -20], 0);
  fader('hm', $('g-hold')); fader('hr', $('g-hold'));
  fader('inG', $('g-in')); meter('mic', 'Mic Level (echo)', $('g-in'), -60, 0, [0, -20, -40, -60]); meter('talk', 'Talker Level', $('g-in'), -60, 0, [0, -20, -40, -60]);
  fader('amp', $('g-room')); fader('loss', $('g-room'));

  function setTap(t) {
    tap = t;
    $('tap-post').classList.toggle('on', t === 'post');
    $('tap-pre').classList.toggle('on', t === 'pre');
  }
  $('tap-post').onclick = () => { setTap('post'); upd(); };
  $('tap-pre').onclick = () => { setTap('pre'); upd(); };
  document.querySelectorAll('[data-p]').forEach((b) => {
    b.onclick = () => {
      const p = G.PRESETS[b.dataset.p];
      for (const k in G.FADERS) G.FADERS[k].set(p[k]);
      setTap(p.tap);
      upd();
    };
  });

  function upd() {
    const m = G.compute(S, tap);
    const mc = G.meterColors(m);

    setM('drv', m.drive, -60, 0, G.COLORS[mc.drv]); $('v-drv').value = G.fmt(m.drive);
    setM('ref', m.ref, -60, 0, G.COLORS[mc.ref]); $('v-ref').value = G.fmt(m.ref);
    setM('rmlr', m.rmlr, -20, 20, G.COLORS[mc.rmlr], 0);
    $('v-rmlr').value = Math.abs(m.rmlr) >= 20 ? (m.rmlr > 0 ? 'PIN +' : 'PIN −') : G.fmt(m.rmlr);
    setM('mic', m.mic, -60, 0, G.COLORS[mc.mic]); $('v-mic').value = G.fmt(m.mic);
    setM('talk', m.talk, -60, 0, G.COLORS[mc.talk]); $('v-talk').value = G.fmt(m.talk);
    $('led').style.background = m.adapting ? '#2fbf55' : '#5a2830';

    $('c-erl').textContent = G.fmt(m.erl);
    $('c-erl').style.color = mc.erl === 'bad' ? 'var(--red)' : mc.erl === 'warn' ? 'var(--amber)' : 'var(--txt)';
    $('c-rmlr').textContent = Math.abs(m.rmlr) >= 20 ? 'Pinned' : G.fmt(m.rmlr);
    $('c-rmlr').style.color = G.COLORS[mc.rmlr];
    $('c-snr').textContent = G.fmt(m.snr);
    $('c-spl').textContent = Math.round(m.splSeat) + ' dB';
    $('c-spl').style.color = mc.spl === 'bad' ? 'var(--red)' : mc.spl === 'warn' ? 'var(--amber)' : 'var(--txt)';

    const s = G.issues(S, tap, m);
    $('status').innerHTML = s.map((i) =>
      '<div><i style="background:' + G.COLORS[i.level] + '"></i><span>' + i.text + '</span></div>'
    ).join('');
  }

  window.sim = { state: S, setTap, update: upd, compute: G.compute, issues: G.issues };

  upd();

  // --- Live mode (T4): single QRC session owned by the server ---------------
  const STATE_COLOR = { connected: G.COLORS.ok, connecting: G.COLORS.warn, disconnected: G.COLORS.gray };
  let pollTimer = null;
  let busy = false;
  let lastState = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function showStatus(st) {
    const where = st.host ? ' — ' + esc(st.host) + ':' + st.port : '';
    const err = st.error ? ' <span style="color:var(--red)">(' + esc(st.error) + ')</span>' : '';
    $('conn-status').innerHTML = '<i style="background:' + (STATE_COLOR[st.state] || G.COLORS.gray) + '"></i><span>' + st.state + where + err + '</span>';
    $('conn-banner').textContent = st.state === 'connected' ? 'Live: ' + st.host + ':' + st.port : '';
    const up = st.state !== 'disconnected';
    $('c-connect').disabled = busy || up;
    $('c-disconnect').disabled = busy || !up;
    $('d-scan').disabled = st.state !== 'connected';
    if (st.state !== 'connected' && lastState === 'connected') clearDiscovery();
    lastState = st.state;
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
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
      showStatus(await api('POST', '/api/connect', {
        host: $('c-host').value, port: $('c-port').value, user: $('c-user').value, pass: $('c-pass').value,
      }));
    } catch (err) {
      showStatus({ state: 'disconnected', error: String(err.message || err) });
    }
    busy = false;
    refreshStatus();
  });

  $('c-disconnect').addEventListener('click', async () => {
    busy = true;
    try { showStatus(await api('POST', '/api/disconnect')); } catch (err) { /* status refresh below */ }
    busy = false;
    refreshStatus();
  });

  // --- Design discovery (T5): read-only component picker + control list -----
  function clearDiscovery() {
    $('d-comps').innerHTML = '';
    $('d-ctrls').innerHTML = '';
    $('d-msg').textContent = '';
  }

  const fmtVal = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(3)) : String(v));

  async function showControls(name, btn) {
    document.querySelectorAll('#d-comps button').forEach((b) => b.classList.toggle('on', b === btn));
    $('d-ctrls').innerHTML = '<p class="sub">Loading ' + esc(name) + '…</p>';
    const r = await api('GET', '/api/controls?name=' + encodeURIComponent(name));
    if (r.error) { $('d-ctrls').innerHTML = '<p style="color:var(--red)">' + esc(r.error) + '</p>'; return; }
    $('d-ctrls').innerHTML = '<table class="ctrls"><thead><tr><th>Pin</th><th>Type</th><th>Value</th><th>String</th><th>Min</th><th>Max</th><th>Direction</th></tr></thead><tbody>' +
      r.controls.map((c) => '<tr><td>' + esc(c.name) + c.tags.map((t) => ' <span class="badge">' + esc(t) + '</span>').join('') +
        '</td><td>' + esc(c.type || '') + '</td><td>' + esc(fmtVal(c.value)) + '</td><td>' + esc(c.string || '') +
        '</td><td>' + esc(fmtVal(c.min)) + '</td><td>' + esc(fmtVal(c.max)) + '</td><td>' + esc(c.direction || '') + '</td></tr>').join('') +
      '</tbody></table><p class="sub">' + r.controls.length + ' controls on <b>' + esc(r.name) + '</b></p>';
  }

  $('d-scan').addEventListener('click', async () => {
    clearDiscovery();
    $('d-msg').textContent = 'Scanning…';
    try {
      const r = await api('GET', '/api/components');
      if (r.error) { $('d-msg').textContent = r.error; return; }
      const aec = r.components.filter((c) => c.aecCandidate).length;
      $('d-msg').textContent = r.components.length + ' named components, ' + aec + ' AEC candidate' + (aec === 1 ? '' : 's');
      r.components.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span>' + esc(c.name) + '<br><span class="t">' + esc(c.type) + '</span></span>' + (c.aecCandidate ? '<span class="badge">AEC?</span>' : '');
        b.onclick = () => showControls(c.name, b).catch((e) => { $('d-ctrls').textContent = String(e.message || e); });
        $('d-comps').appendChild(b);
      });
    } catch (e) {
      $('d-msg').textContent = String(e.message || e);
    }
  });

  function setMode(mode) {
    const live = mode === 'live';
    $('mode-sim').classList.toggle('on', !live);
    $('mode-live').classList.toggle('on', live);
    $('sim-view').classList.toggle('hidden', live);
    $('live-view').classList.toggle('hidden', !live);
    clearInterval(pollTimer);
    if (live) {
      refreshStatus();
      pollTimer = setInterval(refreshStatus, 2000); // surfaces remote drops
    }
  }
  $('mode-sim').onclick = () => setMode('sim');
  $('mode-live').onclick = () => setMode('live');
})();
