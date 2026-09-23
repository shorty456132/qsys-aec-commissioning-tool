'use strict';
// S2 — Advisor (ADR-12). Pure: advise(rig, values) → Finding[].
//
// S3 — advise(rig, values, { mode }): mode picks the input rule (talker/quiet).
// S4 — + { props }: design properties for the RT60-vs-tail rule; the field
// rules (seat SPL, acoustic SNR) read rig.field and need no meters.
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
// S5 — 'farend' = far-end audio playing, nobody in the room speaking: the
// input meter then reads the echo, so ELR can be derived.
const MODES = ['off', 'talker', 'quiet', 'farend'];
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

// S5 — output stage. Program peaks ≤ −3 dBFS (doc), any mode.
function outputPeakRule(chain, v) {
  if (!chain.output || typeof v !== 'number' || v <= PEAK_DBFS) return [];
  const g = knob(chain, 'output', 'output.gain');
  return [{
    id: `${chain.id}:output.level`, level: 'warn', trigger: { key: 'output.level', value: v }, source: GAIN_DOC,
    text: `Output ${fmtDbfs(v)} — above ${PEAK_DBFS} dBFS, near clipping. Lower ${g.label} (${g.pin}) on ${g.component}.`,
    adjust: [g],
  }];
}

// ELR = output level − mic echo level (ADR-07), both in dBFS. The input meter
// reads echo only in the far-end test, so ELR is derived only then.
// → { chain, value: number|null, needs: string|null } — `needs` says why not.
const ELR_MIN_DB = 6; // heuristic (v1)

function deriveElr(chain, values, mode) {
  const d = (value, needs) => ({ chain: chain.id, value, needs });
  const missing = ['input', 'output'].filter((s) => !chain[s]);
  if (missing.length) return d(null, `ELR needs a named ${missing.join(' and ')} component — set it on the Setup tab.`);
  if (mode !== 'farend') return d(null, 'ELR is read in the Far-end test — play far-end audio with nobody in the room speaking.');
  const out = values['output.level'];
  const mic = values['input.level'];
  if (typeof out !== 'number' || typeof mic !== 'number') return d(null, 'ELR needs live output and input meters.');
  return d(Math.round((out - mic) * 10) / 10, null);
}

function elrRule(chain, values, mode) {
  const { value } = deriveElr(chain, values, mode);
  if (value === null) return [];
  const base = { id: `${chain.id}:derived.elr`, trigger: { key: 'derived.elr', value }, source: 'heuristic', adjust: [] };
  if (value >= ELR_MIN_DB) return [{ ...base, level: 'ok', text: `ELR ${fmtDb(value)} — at or above ${ELR_MIN_DB} dB.` }];
  return [{
    ...base,
    level: 'warn',
    text: `ELR ${fmtDb(value)} — under ${ELR_MIN_DB} dB: the mic hears too much of the loudspeakers. This is a room/amp fix, not DSP — lower the amplifier gain, aim loudspeakers away from the mics, or move mics closer to the talkers.`,
  }];
}

// S4 — field readings (rig.field). These need no meters, so they apply with or
// without a Core. S5: with an output stage set, a one-way seat finding names
// its gain knob; otherwise the adjustment lives in the text only.
const SEAT_DBA = [65, 70];
const SNR_DB = [15, 25]; // < 15 bad (minimum), < 25 warn (target)

const fmtN = (v) => String(Math.round(v * 10) / 10);
const seatList = (idx) => `seat${idx.length > 1 ? 's' : ''} ${idx.map((i) => i + 1).join(', ')}`;

// The first chain with an output stage (the UI has one chain; ADR-10).
function outputGainKnob(rig) {
  const chain = rig.chains.find((c) => c.output);
  return chain ? [knob(chain, 'output', 'output.gain')] : [];
}

function seatRule(field, outGain = []) {
  const seats = field.seatSpl;
  if (!seats.length) return [];
  const [lo, hi] = SEAT_DBA;
  const idx = (pred) => seats.map((v, i) => (pred(v) ? i : -1)).filter((i) => i >= 0);
  const low = idx((v) => v < lo);
  const high = idx((v) => v > hi);
  const span = `${fmtN(Math.min(...seats))}–${fmtN(Math.max(...seats))} dBA`;
  const f = (level, text, adjust = []) => [{
    id: 'field:seatSpl', level, text, trigger: { key: 'field.seatSpl', value: seats }, adjust, source: GAIN_DOC,
  }];
  if (low.length && high.length) {
    return f('warn', `Seat SPL spans ${span} — ${seatList(low)} below ${lo} dBA, ${seatList(high)} above ${hi} dBA. One gain change can't fix both; check loudspeaker coverage and aiming, then set the level.`);
  }
  const g = outGain[0];
  const where = g ? `the amplifier gain or ${g.label} (${g.pin}) on ${g.component}` : 'the amplifier gain or the output level';
  if (low.length) return f('warn', `Far-end level below ${lo} dBA at ${seatList(low)} (${span}). Raise ${where} toward ${lo}…${hi} dBA.`, outGain);
  if (high.length) return f('warn', `Far-end level above ${hi} dBA at ${seatList(high)} (${span}). Lower ${where} toward ${lo}…${hi} dBA.`, outGain);
  return f('ok', `Seat SPL ${span} — inside ${lo}…${hi} dBA at every seat.`);
}

// Acoustic SNR at the worst (quietest) seat: SPL − room noise floor.
function snrRule(field) {
  if (!field.seatSpl.length || typeof field.noiseFloor !== 'number') return [];
  const spl = Math.min(...field.seatSpl);
  const snr = Math.round((spl - field.noiseFloor) * 10) / 10;
  const [min, target] = SNR_DB;
  const calc = `quietest seat ${fmtN(spl)} dBA − noise floor ${fmtN(field.noiseFloor)} dB SPL`;
  const fixes = `Reduce the room noise (HVAC, projector fans, acoustic treatment); raising the far-end level only helps up to ${SEAT_DBA[1]} dBA.`;
  const f = (level, text) => [{
    id: 'field:snr', level, text, trigger: { key: 'field.snr', value: snr }, adjust: [], source: GAIN_DOC,
  }];
  if (snr < min) return f('bad', `Acoustic SNR ${fmtN(snr)} dB (${calc}) — under the ${min} dB minimum. ${fixes}`);
  if (snr < target) return f('warn', `Acoustic SNR ${fmtN(snr)} dB (${calc}) — under the ${target} dB target. ${fixes}`);
  return f('ok', `Acoustic SNR ${fmtN(snr)} dB (${calc}) — at or above the ${target} dB target.`);
}

// RT60 vs the AEC's tail_length design property (seconds, a string —
// CONFIRMED "0.2" in emulation). The doc only says "longer tail if
// reverberant"; comparing against RT60 is our own rule → heuristic.
function tailRule(chain, rt60, props) {
  if (!chain.aec || typeof rt60 !== 'number' || !props) return [];
  const p = props[chain.aec.component];
  const tail = p ? Number.parseFloat(p.tail_length) : NaN;
  if (!Number.isFinite(tail)) return [];
  const base = { id: `${chain.id}:aec.tail`, trigger: { key: 'field.rt60', value: rt60 }, source: 'heuristic' };
  if (rt60 <= tail) {
    return [{ ...base, level: 'ok', text: `RT60 ${fmtN(rt60)} s fits the AEC tail length (${fmtN(tail)} s) on ${chain.aec.component}.`, adjust: [] }];
  }
  const t = { component: chain.aec.component, pin: 'tail_length', label: 'Tail Length (design property)' };
  return [{
    ...base,
    level: 'warn',
    text: `RT60 ${fmtN(rt60)} s is longer than the AEC tail length (${fmtN(tail)} s) on ${t.component}. Consider a longer ${t.label} in Designer — each longer tail step doubles the AEC's DSP cost.`,
    adjust: [t],
  }];
}

// opts.mode ∈ MODES (default 'off'): which input rule applies (S3).
// opts.props = { [component]: { [property]: string } } from Component.GetComponents
// on the current connection (S4); omitted → no rule that needs the design.
function advise(rig, values, { mode = 'off', props = null } = {}) {
  const field = rig.field || { seatSpl: [], noiseFloor: null, rt60: null };
  const out = [...seatRule(field, outputGainKnob(rig)), ...snrRule(field)];
  for (const chain of rig.chains) {
    const v = values[chain.id] || {};
    out.push(...clipRule(chain, v['input.clip']));
    out.push(...levelRule(chain, v['input.level'], mode));
    out.push(...rmlrRule(chain, v['aec.rmlr']));
    out.push(...tailRule(chain, field.rt60, props));
    out.push(...outputPeakRule(chain, v['output.level']));
    out.push(...elrRule(chain, v, mode));
  }
  return out;
}

module.exports = { advise, deriveElr, MODES, RMLR_WINDOW_DB };
