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
  // S7. Gating Automatic Mic Mixer (relative threshold) — pins CONFIRMED, Core 24f.
  // `snr` = "Signal Level Above Noise" (per channel); `config.minimum.snr` =
  // "Threshold Level Above Noise", one setting for every channel. Booleans Poll
  // as 0/1 like the Flex clip. Other automixer types → "show all" (NEEDS-TEST).
  automixer: {
    id: 'automixer',
    label: 'Automixer',
    typeMatch: /^auto_mixer_gating_adaptive$/i, // CONFIRMED: auto_mixer_gating_adaptive
    meters: ({ channel }) => [
      { key: 'automixer.open', pin: `channel.${channel}.open`, label: 'Gate open', unit: '', lo: 0, hi: 1 },
      { key: 'automixer.snr', pin: `channel.${channel}.snr`, label: 'Signal above noise', unit: 'dB', lo: 0, hi: 50 },
      { key: 'automixer.threshold', pin: 'config.minimum.snr', label: 'Threshold above noise', unit: 'dB', lo: 0, hi: 50 },
      { key: 'automixer.mute', pin: `channel.${channel}.post.gate.mute`, label: 'Post-gate mute', unit: '', lo: 0, hi: 1 },
      { key: 'automixer.manual', pin: `channel.${channel}.manual`, label: 'Manual', unit: '', lo: 0, hi: 1 },
    ],
    knobs: ({ channel }) => [
      { key: 'automixer.threshold', pin: 'config.minimum.snr', label: 'Threshold Level Above Noise', lo: 0, hi: 50 },
      { key: 'automixer.mute', pin: `channel.${channel}.post.gate.mute`, label: 'Post-Gate Mute', lo: 0, hi: 1 },
      { key: 'automixer.manual', pin: `channel.${channel}.manual`, label: 'Manual', lo: 0, hi: 1 },
    ],
  },
  // S5. Flex Out + Line Out share these pins (CONFIRMED, Core 24f). Dante Tx → "show all" (NEEDS-TEST).
  output: {
    id: 'output',
    label: 'Output',
    typeMatch: /^io_card_(flex|line)_out/i, // CONFIRMED: io_card_flex_out_core_24f, io_card_line_out_core_24f
    meters: ({ channel }) => [
      // NEEDS-TEST: dBFS scale of the live meter (S10); range CONFIRMED −120…+20.
      { key: 'output.level', pin: `channel.${channel}.digital.output.level`, label: 'Output level', unit: 'dBFS', lo: -120, hi: 20 },
    ],
    knobs: ({ channel }) => [
      { key: 'output.gain', pin: `channel.${channel}.output.gain`, label: 'Output gain', lo: -100, hi: 20 },
    ],
  },
  // S6. One selection = one crosspoint {component, in, out, feedsRef}. The mixer
  // has no meters, so these are control values the poller reads (CONFIRMED,
  // type `mixer`, Core 24f). A crosspoint is closed at −100 dB or when its
  // input or output is muted. NEEDS-TEST: the crosspoint mute pin that exists
  // only when the design property crosspoint_mute is "True" (not in the design).
  mixer: {
    id: 'mixer',
    label: 'Mixer crosspoint',
    typeMatch: /^mixer$/i, // CONFIRMED: mixer (not the gating automixer, S7)
    meters: (x) => {
      const k = crosspointKey(x);
      const at = `In ${x.in} → Out ${x.out}`;
      return [
        { key: `${k}.gain`, pin: `input.${x.in}.output.${x.out}.gain`, label: `${at} gain`, unit: 'dB', lo: -100, hi: 10 },
        // Boolean; Poll reports it as 0/1 like the Flex clip (CONFIRMED there).
        { key: `${k}.inMute`, pin: `input.${x.in}.mute`, label: `In ${x.in} mute`, unit: '', lo: 0, hi: 1 },
        { key: `${k}.outMute`, pin: `output.${x.out}.mute`, label: `Out ${x.out} mute`, unit: '', lo: 0, hi: 1 },
      ];
    },
    knobs: (x) => [
      { key: 'mixer.gain', pin: `input.${x.in}.output.${x.out}.gain`, label: 'Crosspoint gain', lo: -100, hi: 10 },
    ],
  },
};

// Meter-key prefix for one crosspoint — unique per mixer + in + out.
function crosspointKey(x) {
  return `mixer.${x.component}.${x.in}.${x.out}`;
}

// Single-selection stages of a chain, in signal order. `mixer` is the list stage.
const STAGES = ['input', 'micGain', 'aec', 'automixer', 'output'];

// Every set selection of a chain as [roleId, sel], in signal order:
// input → micGain → aec → automixer → mixer crosspoints → output.
function chainSelections(chain) {
  const one = (s) => (chain[s] ? [[s, chain[s]]] : []);
  return [
    ...['input', 'micGain', 'aec', 'automixer'].flatMap(one),
    ...(chain.mixer || []).map((x) => ['mixer', x]),
    ...one('output'),
  ];
}
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

// S6 — feedsRef: the tech says this crosspoint feeds the AEC reference (QRC
// can't see wiring, ADR-10). Optional, default false.
function validateCrosspoint(x, where) {
  if (!x || typeof x !== 'object') throw bad(`${where} must be {component, in, out, feedsRef}`);
  if (!isName(x.component)) throw bad(`${where}.component must be a component Code Name`);
  if (!isChannel(x.in) || !isChannel(x.out)) throw bad(`${where}.in/out must be integers ≥ 1`);
  if (x.feedsRef !== undefined && typeof x.feedsRef !== 'boolean') throw bad(`${where}.feedsRef must be true or false`);
  return { component: x.component, in: x.in, out: x.out, feedsRef: x.feedsRef === true };
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
  const seen = new Set();
  out.mixer = mixer.map((x, j) => {
    const v = validateCrosspoint(x, `${where}.mixer[${j}]`);
    if (seen.has(crosspointKey(v))) throw bad(`${where}.mixer[${j}]: duplicate crosspoint In ${v.in} → Out ${v.out} on ${v.component}`);
    seen.add(crosspointKey(v));
    return v;
  });
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

module.exports = { ROLES, STAGES, defaultRig, validateRig, chainSelections, crosspointKey };
