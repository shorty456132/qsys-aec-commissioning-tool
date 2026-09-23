// T3 — Shared gain model + issue heuristics. Ported verbatim from
// aec-erl-rmlr-emulator-v1.html so the Simulator view and the live view
// (Phase 2) run the same rules. UMD: browser global + Node require.
//
// Model (v1, read in full — see ADR.md §"The v1 model"):
//   drive = src + out
//   ref   = drive + xpt + rg            (post-tap)   |  src + xpt + rg (pre-tap)
//   spl   = drive + amp + 100
//   echo  = spl − loss − 85 + inG
//   talk  = 65 − 85 + inG
//   noise = 40 − 85 + inG
//   mic   = max(echo, noise)
//   ELR   = drive − echo    (room return loss)
//   RMLR  = ref − mic        (target 0 dB, ±3 on-target)
//   adapting = ref >= hr && mic >= hm  (hold thresholds)

(function (root) {
  'use strict';

  // Fader definitions. Ranges follow Q-SYS gain controls (−100…+20 dB);
  // `taper` faders map like a Q-SYS gain fader (see v1 toPos/toDb).
  const FADERS = {
    src:  { lbl: 'Source Level',            min: -60,  max: 0,   def: -20, unit: 'dBFS' },
    out:  { lbl: 'Output Gain',            min: -100, max: 20,  def: 0,   taper: 1 },
    xpt:  { lbl: 'Crosspoint Gain',        min: -100, max: 20,  def: 0,   taper: 1 },
    rg:   { lbl: 'Reference Gain',         min: -20,  max: 20,  def: 0 },
    hm:   { lbl: 'Hold If Mic Level Below', min: -100, max: 0,  def: -60 },
    hr:   { lbl: 'Hold If Ref Level Below', min: -100, max: 0,  def: -60 },
    inG:  { lbl: 'Gain',                   min: -100, max: 20,  def: 0,   taper: 1 },
    amp:  { lbl: 'Amp Gain',               min: -20,  max: 20,  def: 0 },
    loss: { lbl: 'Speaker-to-Mic Loss',    min: 5,    max: 45,  def: 25,  unit: 'dB' },
  };

  const FADER_KEYS = Object.keys(FADERS);

  const PRESETS = {
    reset:   { src: -20, out: 0,   xpt: 0,   rg: 0, hm: -60, hr: -60, inG: 0,   amp: 0,  loss: 25, tap: 'post' },
    tuned:   { src: -20, out: 0,   xpt: -7,  rg: 0, hm: -60, hr: -60, inG: 3,   amp: 0,  loss: 25, tap: 'post' },
    hotamp:  { src: -20, out: 0,   xpt: -7,  rg: 0, hm: -60, hr: -60, inG: 3,   amp: 14, loss: 25, tap: 'post' },
    distant: { src: -20, out: 0,   xpt: -7,  rg: 0, hm: -60, hr: -60, inG: 3,   amp: 0,  loss: 43, tap: 'post' },
    starved: { src: -20, out: 0,   xpt: -7,  rg: 0, hm: -60, hr: -60, inG: -15, amp: 0,  loss: 25, tap: 'post' },
    pretap:  { src: -20, out: 8,   xpt: -7,  rg: 0, hm: -60, hr: -60, inG: 3,   amp: 0,  loss: 25, tap: 'pre'  },
  };

  function toPos(f, db) {
    if (!f.taper) return ((db - f.min) / (f.max - f.min)) * 1000;
    return db >= -40 ? 250 + ((db + 40) / 60) * 750 : ((db + 100) / 60) * 250;
  }
  function toDb(f, p) {
    let d;
    if (!f.taper) d = f.min + (p / 1000) * (f.max - f.min);
    else d = p >= 250 ? -40 + ((p - 250) / 750) * 60 : -100 + (p / 250) * 60;
    return Math.round(d * 10) / 10;
  }

  function fmt(v, u) {
    const r = Math.round(v * 10) / 10;
    const s = (Number.isInteger(r) ? r.toString() : r.toFixed(1)).replace('-', '−');
    return s + (u || 'dB');
  }

  // Pure model: given fader values S {src,out,xpt,rg,hm,hr,inG,amp,loss} and
  // tap ('post'|'pre'), returns every derived quantity the UI and the issue
  // engine need.
  function compute(S, tap) {
    const drive = S.src + S.out;
    const ref = (tap === 'post' ? drive : S.src) + S.xpt + S.rg;
    const spl = drive + S.amp + 100;
    const splSeat = spl - 10;
    const echo = spl - S.loss - 85 + S.inG;
    const talk = 65 - 85 + S.inG;
    const noise = 40 - 85 + S.inG;
    const mic = Math.max(echo, noise);
    const erl = drive - echo;
    const rmlr = ref - mic;
    const snr = talk - noise;
    const adapting = ref >= S.hr && mic >= S.hm;
    const echoBuried = echo < noise + 6;
    return { drive, ref, spl, splSeat, echo, talk, noise, mic, erl, rmlr, snr, adapting, echoBuried };
  }

  // Issue engine — wording carried verbatim from v1 so the tech recognizes
  // the messages. Returns [{level: 'ok'|'warn'|'bad', text, value}].
  function issues(S, tap, m) {
    const rmlr = m.rmlr;
    const rmlrColor = Math.abs(rmlr) <= 3 ? 'ok' : Math.abs(rmlr) <= 8 ? 'warn' : 'bad';
    const s = [];

    if (m.talk < -20) s.push({ level: 'warn', text: 'Talker below −20 dBFS: raise Input Gain before touching the reference.', value: m.talk });
    else if (m.talk > -15) s.push({ level: m.talk > -3 ? 'bad' : 'warn', text: 'Talker hot: back off Input Gain.', value: m.talk });
    else s.push({ level: 'ok', text: 'Input in the −20 to −15 dBFS speech window.', value: m.talk });

    if (tap === 'pre' && S.out !== 0)
      s.push({ level: 'bad', text: 'Reference is tapped before Output Gain, so it no longer tracks what the speakers play. Move the tap after Output Gain.', value: null });

    if (m.echoBuried)
      s.push({ level: 'bad', text: 'Echo is buried in the noise floor. RMLR reads high regardless; a reference trim can\'t fix this (distant mic / high room loss).', value: m.echo });
    else if (rmlr > 3)
      s.push({ level: rmlrColor, text: 'RMLR high: reference hotter than the echo. Lower Crosspoint Gain or Reference Gain — raising them makes it worse.', value: rmlr });

    if (rmlr < -3) s.push({ level: rmlrColor, text: 'RMLR low: echo hotter than the reference. Check ERL and amp gain before raising the reference.', value: rmlr });
    if (Math.abs(rmlr) <= 3) s.push({ level: 'ok', text: 'RMLR on target: reference matches the echo the mic actually hears.', value: rmlr });

    if (!m.adapting)
      s.push({ level: 'warn', text: 'Adaptive filter held: ' + (m.ref < S.hr ? 'reference below Hold If Ref Level Below' : 'mic below Hold If Mic Level Below') + '.', value: null });

    if (m.erl < 6) s.push({ level: 'bad', text: 'ERL under 6dB: the room is returning too much echo. Room/amp fix, not a DSP fix.', value: m.erl });
    if (m.splSeat > 84) s.push({ level: 'bad', text: 'Seat SPL over 84 dB: amp too hot for voice lift — feedback risk and low ERL. Pull amp gain in the field.', value: m.splSeat });
    if (m.ref > -3 || m.drive > -3) s.push({ level: 'bad', text: 'Signal near clipping.', value: null });

    return s;
  }

  // Display colors shared by sim + live views.
  const COLORS = { blue: '#3b8ee0', ok: '#3fbf5f', warn: '#e3a52a', bad: '#e04444', gray: '#6c6f74' };

  // v1 meter coloring rules.
  function meterColors(m) {
    const rc = Math.abs(m.rmlr) <= 3 ? 'ok' : Math.abs(m.rmlr) <= 8 ? 'warn' : 'bad';
    return {
      drv: m.drive > -3 ? 'bad' : 'blue',
      ref: m.ref > -3 ? 'bad' : 'blue',
      rmlr: rc,
      mic: m.echo < m.noise + 6 ? 'gray' : 'blue',
      talk: m.talk > -3 ? 'bad' : (m.talk >= -20 && m.talk <= -15 ? 'ok' : 'warn'),
      erl: m.erl < 6 ? 'bad' : m.erl < 10 ? 'warn' : null,
      spl: m.splSeat > 84 ? 'bad' : m.splSeat > 78 ? 'warn' : null,
    };
  }

  const api = { FADERS, FADER_KEYS, PRESETS, toPos, toDb, fmt, compute, issues, meterColors, COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GainModel = api;
})(typeof window !== 'undefined' ? window : this);
