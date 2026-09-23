'use strict';
// S1 — Role registry + Rig validation (ADR-10). Pure: no I/O.
//
// A role's pins go in here only once CONFIRMED (ADR-04, ADR.md §Pins).
// `knobs` are named in findings, never written (ADR-06).

const { SessionError } = require('./session');

const ROLES = {
  aec: {
    id: 'aec',
    label: 'AEC',
    typeMatch: /^acoustic_echo_cancel/i, // CONFIRMED: acoustic_echo_canceler_simd
    meters: ({ channel }) => [
      { key: 'aec.rmlr', pin: `channel.${channel}.ref.mic.ratio`, label: 'RMLR', unit: 'dB', lo: -10, hi: 10 },
      { key: 'aec.erle', pin: `channel.${channel}.ERLE`, label: 'ERLE', unit: 'dB', lo: 0, hi: 20 },
    ],
    knobs: ({ channel }) => [
      { key: 'aec.refGain', pin: `channel.${channel}.ref.gain`, label: 'Reference gain', lo: -40, hi: 0 },
      { key: 'aec.minRef', pin: 'min.ref.level', label: 'Hold If Ref Level Below', lo: -100, hi: 0 },
      { key: 'aec.minMic', pin: 'min.mic.level', label: 'Hold If Mic Level Below', lo: -100, hi: 0 },
    ],
  },
};

// Single-selection stages of a chain, in signal order. `mixer` is the list stage.
const STAGES = ['input', 'micGain', 'aec', 'automixer', 'output'];
const CHAIN_KEYS = new Set(['id', 'label', 'mixer', ...STAGES]);

function defaultRig() {
  return {
    chains: [{ id: 'chain-1', label: 'Chain 1', input: null, micGain: null, aec: null, automixer: null, mixer: [], output: null }],
    field: { seatSpl: [], noiseFloor: null, rt60: null },
  };
}

const bad = (msg) => new SessionError(msg, 400);
const isChannel = (n) => Number.isInteger(n) && n >= 1;
const isName = (s) => typeof s === 'string' && s.trim() !== '';

function validateSelection(sel, where) {
  if (sel === null || sel === undefined) return null;
  if (typeof sel !== 'object') throw bad(`${where} must be {component, channel} or null`);
  if (!isName(sel.component)) throw bad(`${where}.component must be a component Code Name`);
  if (!isChannel(sel.channel)) throw bad(`${where}.channel must be an integer ≥ 1`);
  return { component: sel.component, channel: sel.channel };
}

function validateCrosspoint(x, where) {
  if (!x || typeof x !== 'object') throw bad(`${where} must be {component, in, out}`);
  if (!isName(x.component)) throw bad(`${where}.component must be a component Code Name`);
  if (!isChannel(x.in) || !isChannel(x.out)) throw bad(`${where}.in/out must be integers ≥ 1`);
  return { component: x.component, in: x.in, out: x.out };
}

function validateChain(c, i) {
  const where = `chains[${i}]`;
  if (!c || typeof c !== 'object') throw bad(`${where} must be an object`);
  for (const k of Object.keys(c)) if (!CHAIN_KEYS.has(k)) throw bad(`${where}: unknown role "${k}"`);
  if (!isName(c.id)) throw bad(`${where}.id is required`);
  const out = { id: c.id, label: typeof c.label === 'string' ? c.label : c.id };
  for (const s of STAGES) out[s] = validateSelection(c[s], `${where}.${s}`);
  const mixer = c.mixer === undefined ? [] : c.mixer;
  if (!Array.isArray(mixer)) throw bad(`${where}.mixer must be an array`);
  out.mixer = mixer.map((x, j) => validateCrosspoint(x, `${where}.mixer[${j}]`));
  // Key order matches defaultRig() so round-trips compare equal.
  return { id: out.id, label: out.label, input: out.input, micGain: out.micGain, aec: out.aec,
    automixer: out.automixer, mixer: out.mixer, output: out.output };
}

// Field readings are S4; for now accept only the default shape's types.
function validateField(f) {
  const d = defaultRig().field;
  if (f === undefined || f === null) return d;
  if (typeof f !== 'object') throw bad('field must be an object');
  const num = (v, k) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`field.${k} must be a number or null`);
    return v;
  };
  const seat = f.seatSpl === undefined ? [] : f.seatSpl;
  if (!Array.isArray(seat)) throw bad('field.seatSpl must be an array');
  return { seatSpl: seat.map((v, i) => num(v, `seatSpl[${i}]`)), noiseFloor: num(f.noiseFloor, 'noiseFloor'), rt60: num(f.rt60, 'rt60') };
}

// Throws a 400 SessionError on anything malformed; returns a normalized copy.
function validateRig(rig) {
  if (!rig || typeof rig !== 'object' || Array.isArray(rig)) throw bad('rig must be a JSON object');
  if (!Array.isArray(rig.chains)) throw bad('rig.chains must be an array');
  if (rig.chains.length < 1) throw bad('rig needs at least one chain');
  return { chains: rig.chains.map(validateChain), field: validateField(rig.field) };
}

module.exports = { ROLES, STAGES, defaultRig, validateRig };
