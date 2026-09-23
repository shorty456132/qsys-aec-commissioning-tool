'use strict';
// S2 — Advisor (ADR-12). Pure: advise(rig, values) → Finding[].
//
// S3 — advise(rig, values, { mode }): mode picks the input rule (talker/quiet).
// `values` = { [chainId]: { [meterKey]: number } }, fresh values only — the
// caller leaves stale meters out, so there's never advice on stale data.
// Every finding names its trigger, the control(s) to turn and its source.

const { ROLES } = require('./roles');

// RMLR ≈ 0 dB (doc: AEC_Gain_Structure.md); the ±3 dB window is heuristic (v1).
const RMLR_WINDOW_DB = 3;

const fmtDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

function knob(chain, roleId, key) {
  const sel = chain[roleId];
  const k = ROLES[roleId].knobs(sel).find((x) => x.key === key);
  return { component: sel.component, pin: k.pin, label: k.label };
}

// NEEDS-TEST: RMLR sign convention (S10) — so the text says "adjust", never
// "raise"/"lower".
function rmlrRule(chain, v) {
  if (!chain.aec || typeof v !== 'number') return [];
  const base = { id: `${chain.id}:aec.rmlr`, trigger: { key: 'aec.rmlr', value: v }, source: 'doc:AEC_Gain_Structure.md' };
  if (Math.abs(v) <= RMLR_WINDOW_DB) {
    return [{ ...base, level: 'ok', text: `RMLR ${fmtDb(v)} — within ±${RMLR_WINDOW_DB} dB of 0.`, adjust: [] }];
  }
  const ref = knob(chain, 'aec', 'aec.refGain');
  return [{
    ...base,
    level: 'warn',
    text: `RMLR ${fmtDb(v)} — outside ±${RMLR_WINDOW_DB} dB. Adjust ${ref.label} (${ref.pin}) on ${ref.component} to bring RMLR toward 0 dB.`,
    adjust: [ref],
  }];
}

// S3 — input stage (doc: AEC_Gain_Structure.md). One meter can't tell speech
// from room noise, so the tech picks the Monitor mode: 'talker' = someone
// speaking normally at the mic, 'quiet' = nobody speaking, no program.
const MODES = ['off', 'talker', 'quiet'];
const GAIN_DOC = 'doc:AEC_Gain_Structure.md';
const TALKER_DBFS = [-20, -15];
const NOISE_DBFS = [-40, -35]; // ≤ −40 ok; up to −35 marginal; above → < 15 dB SNR
const PEAK_DBFS = -3;

const fmtDbfs = (v) => `${v.toFixed(1)} dBFS`;

function clipRule(chain, v) {
  if (!chain.input || typeof v !== 'number' || v < 0.5) return [];
  const g = knob(chain, 'input', 'input.gain');
  return [{
    id: `${chain.id}:input.clip`, level: 'bad', trigger: { key: 'input.clip', value: v }, source: GAIN_DOC,
    text: `Input clipping — lower ${g.label} (${g.pin}) on ${g.component} until peaks stay below ${PEAK_DBFS} dBFS.`,
    adjust: [g],
  }];
}

// At most one finding per chain: a peak outranks the mode's window.
function levelRule(chain, v, mode) {
  if (!chain.input || typeof v !== 'number') return [];
  const g = knob(chain, 'input', 'input.gain');
  const at = `${g.label} (${g.pin}) on ${g.component}`;
  const f = (level, text, adjust) => [{
    id: `${chain.id}:input.level`, level, trigger: { key: 'input.level', value: v }, source: GAIN_DOC, text, adjust,
  }];
  if (v > PEAK_DBFS) return f('warn', `Input ${fmtDbfs(v)} — above ${PEAK_DBFS} dBFS, near clipping. Lower ${at}.`, [g]);
  if (mode === 'talker') {
    const [lo, hi] = TALKER_DBFS;
    if (v < lo) return f('warn', `Talker ${fmtDbfs(v)} — below the ${lo}…${hi} dBFS window. Raise ${at}.`, [g]);
    if (v > hi) return f('warn', `Talker ${fmtDbfs(v)} — above the ${lo}…${hi} dBFS window. Lower ${at}.`, [g]);
    return f('ok', `Talker ${fmtDbfs(v)} — inside the ${lo}…${hi} dBFS window.`, []);
  }
  if (mode === 'quiet') {
    const [ok, max] = NOISE_DBFS;
    if (v <= ok) return f('ok', `Room noise ${fmtDbfs(v)} — at or below ${ok} dBFS.`, []);
    // Gain moves speech and noise together, so it isn't the fix (doc).
    const fixes = 'Try AEC noise reduction, EQ, or acoustic treatment — changing input gain won\'t improve speech-to-noise.';
    if (v <= max) return f('warn', `Room noise ${fmtDbfs(v)} — between ${ok} and ${max} dBFS, marginal speech-to-noise. ${fixes}`, []);
    return f('bad', `Room noise ${fmtDbfs(v)} — above ${max} dBFS, under 15 dB speech-to-noise. ${fixes}`, []);
  }
  return [];
}

// opts.mode ∈ MODES (default 'off'): which input rule applies (S3).
function advise(rig, values, { mode = 'off' } = {}) {
  const out = [];
  for (const chain of rig.chains) {
    const v = values[chain.id] || {};
    out.push(...clipRule(chain, v['input.clip']));
    out.push(...levelRule(chain, v['input.level'], mode));
    out.push(...rmlrRule(chain, v['aec.rmlr']));
  }
  return out;
}

module.exports = { advise, MODES, RMLR_WINDOW_DB };
