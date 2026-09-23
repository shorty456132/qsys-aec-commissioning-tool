'use strict';
// S1 — Role registry + Rig validation (ADR-10). Pure: no I/O.
//
// A role's pins go in here only once CONFIRMED (ADR-04, ADR.md §Pins).
// `knobs` are named in findings, never written (ADR-06).

const { SessionError } = require('./session');

const ROLES = {
  // S3. Mic/Line In + Dante Rx aren't in the emulation design yet → "show all"
  // until their type strings + pins are CONFIRMED (NEEDS-TEST).
  input: {
    id: 'input',
    label: 'Input',
    typeMatch: /^io_card_flex_in/i, // CONFIRMED: io_card_flex_in_core_8flex
    meters: ({ channel }) => [
      // NEEDS-TEST: dBFS scale of the live meter (S10); range CONFIRMED −120…+20.
      { key: 'input.level', pin: `channel.${channel}.digital.input.level`, label: 'Input level', unit: 'dBFS', lo: -120, hi: 20 },
      // Boolean; CONFIRMED Poll reports it as 0/1.
      { key: 'input.clip', pin: `channel.${channel}.clip`, label: 'Clip', unit: '', lo: 0, hi: 1 },
    ],
    knobs: ({ channel }) => [
      { key: 'input.gain', pin: `channel.${channel}.input.gain`, label: 'Input gain', lo: -100, hi: 20 },
    ],
  },
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

// S4 — field readings. Empty is allowed (null / []); anything entered must be
// a plausible number: SPL + noise floor in dB SPL, broadband RT60 in seconds.
const SPL_RANGE = [0, 140];
const RT60_MAX_S = 20;
const MAX_SEATS = 32;

function validateField(f) {
  const d = defaultRig().field;
  if (f === undefined || f === null) return d;
  if (typeof f !== 'object' || Array.isArray(f)) throw bad('field must be an object');
  const num = (v, k, ok, range) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw bad(`field.${k} must be a number ${range}`);
    return v;
  };
  const spl = (v, k) => num(v, k, (x) => x >= SPL_RANGE[0] && x <= SPL_RANGE[1], `in ${SPL_RANGE[0]}…${SPL_RANGE[1]} dB`);
  const opt = (v, check) => (v === null || v === undefined ? null : check(v));
  const seat = f.seatSpl === undefined || f.seatSpl === null ? [] : f.seatSpl;
  if (!Array.isArray(seat)) throw bad('field.seatSpl must be an array of numbers');
  if (seat.length > MAX_SEATS) throw bad(`field.seatSpl takes at most ${MAX_SEATS} seats`);
  return {
    seatSpl: seat.map((v, i) => spl(v, `seatSpl[${i}]`)),
    noiseFloor: opt(f.noiseFloor, (v) => spl(v, 'noiseFloor')),
    rt60: opt(f.rt60, (v) => num(v, 'rt60', (x) => x > 0 && x <= RT60_MAX_S, `in (0, ${RT60_MAX_S}] s`)),
  };
}

// Throws a 400 SessionError on anything malformed; returns a normalized copy.
function validateRig(rig) {
  if (!rig || typeof rig !== 'object' || Array.isArray(rig)) throw bad('rig must be a JSON object');
  if (!Array.isArray(rig.chains)) throw bad('rig.chains must be an array');
  if (rig.chains.length < 1) throw bad('rig needs at least one chain');
  return { chains: rig.chains.map(validateChain), field: validateField(rig.field) };
}

module.exports = { ROLES, STAGES, defaultRig, validateRig };
