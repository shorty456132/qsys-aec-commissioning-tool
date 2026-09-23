'use strict';
// S1 — Role registry (ADR-10) + rig validation. Pure, no sockets.
// Run: node test-roles.js

const assert = require('assert');
const { ROLES, STAGES, defaultRig, validateRig, chainSelections } = require('../src/roles');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(` FAIL  ${name}\n      ${e.message}`);
  }
}

test('AEC role: typeMatch accepts the CONFIRMED type, rejects others', () => {
  const r = ROLES.aec;
  assert.ok(r.typeMatch.test('acoustic_echo_canceler_simd'));
  assert.ok(!r.typeMatch.test('gain'));
  assert.ok(!r.typeMatch.test('io_card_flex_in_core_8flex'));
});

test('AEC role: meters({channel:1}) → RMLR + ERLE pins (CONFIRMED)', () => {
  const m = ROLES.aec.meters({ component: 'X', channel: 1 });
  assert.deepStrictEqual(m.map((x) => x.pin), ['channel.1.ref.mic.ratio', 'channel.1.ERLE']);
  const [rmlr, erle] = m;
  assert.deepStrictEqual([rmlr.key, rmlr.unit, rmlr.lo, rmlr.hi], ['aec.rmlr', 'dB', -10, 10]);
  assert.deepStrictEqual([erle.key, erle.unit, erle.lo, erle.hi], ['aec.erle', 'dB', 0, 20]);
  assert.ok(!/ELR/.test(erle.label.replace('ERLE', '')), 'ERLE is never labelled ELR (ADR-07)');
});

test('AEC role: meters follow the channel', () => {
  assert.strictEqual(ROLES.aec.meters({ component: 'X', channel: 3 })[0].pin, 'channel.3.ref.mic.ratio');
});

test('AEC role: knobs → ref.gain, min.ref.level, min.mic.level (CONFIRMED)', () => {
  const k = ROLES.aec.knobs({ component: 'X', channel: 2 });
  assert.deepStrictEqual(k.map((x) => x.pin), ['channel.2.ref.gain', 'min.ref.level', 'min.mic.level']);
  assert.deepStrictEqual([k[0].lo, k[0].hi], [-40, 0]);
  assert.deepStrictEqual([k[1].lo, k[1].hi], [-100, 0]);
});

// --- S3: input stage -----------------------------------------------------------
test('input role: typeMatch accepts the CONFIRMED Flex type, rejects others', () => {
  const r = ROLES.input;
  assert.ok(r.typeMatch.test('io_card_flex_in_core_8flex'));
  assert.ok(!r.typeMatch.test('acoustic_echo_canceler_simd'));
  assert.ok(!r.typeMatch.test('gain'));
});

test('input role: meters({channel:3}) → level (dBFS) + clip pins (CONFIRMED)', () => {
  const m = ROLES.input.meters({ component: 'X', channel: 3 });
  assert.deepStrictEqual(m.map((x) => x.pin), ['channel.3.digital.input.level', 'channel.3.clip']);
  const [level, clip] = m;
  assert.deepStrictEqual([level.key, level.unit, level.lo, level.hi], ['input.level', 'dBFS', -120, 20]);
  assert.deepStrictEqual([clip.key, clip.lo, clip.hi], ['input.clip', 0, 1]);
});

test('input role: knobs → channel.N.input.gain −100…+20 (CONFIRMED)', () => {
  const k = ROLES.input.knobs({ component: 'X', channel: 2 });
  assert.deepStrictEqual(k.map((x) => [x.key, x.pin, x.lo, x.hi]), [['input.gain', 'channel.2.input.gain', -100, 20]]);
});

test('output role: typeMatch accepts the CONFIRMED Flex Out + Line Out types, rejects others', () => {
  const r = ROLES.output;
  assert.ok(r.typeMatch.test('io_card_flex_out_core_24f'));
  assert.ok(r.typeMatch.test('io_card_line_out_core_24f'));
  assert.ok(!r.typeMatch.test('io_card_flex_in_core_24f'));
  assert.ok(!r.typeMatch.test('spaq_amplifier'));
  assert.ok(!r.typeMatch.test('meter2'));
});

test('output role: meters({channel:2}) → digital output level (dBFS) (CONFIRMED)', () => {
  const m = ROLES.output.meters({ component: 'X', channel: 2 });
  assert.deepStrictEqual(m.map((x) => [x.key, x.pin, x.unit, x.lo, x.hi]),
    [['output.level', 'channel.2.digital.output.level', 'dBFS', -120, 20]]);
});

test('output role: knobs → channel.N.output.gain −100…+20 (CONFIRMED)', () => {
  const k = ROLES.output.knobs({ component: 'X', channel: 4 });
  assert.deepStrictEqual(k.map((x) => [x.key, x.pin, x.lo, x.hi]), [['output.gain', 'channel.4.output.gain', -100, 20]]);
});

test('defaultRig → one empty chain, empty field', () => {
  const r = defaultRig();
  assert.strictEqual(r.chains.length, 1);
  const c = r.chains[0];
  assert.ok(c.id && c.label);
  for (const s of STAGES) assert.strictEqual(c[s], null, s);
  assert.deepStrictEqual(c.mixer, []);
  assert.deepStrictEqual(r.field, { seatSpl: [], noiseFloor: null, rt60: null });
  assert.notStrictEqual(defaultRig(), defaultRig(), 'fresh object each call');
});

test('validateRig: default rig and an AEC selection pass, normalized', () => {
  assert.deepStrictEqual(validateRig(defaultRig()), defaultRig());
  const r = defaultRig();
  r.chains[0].aec = { component: '200ms_Acoustic_Echo_Canceler', channel: 1 };
  assert.deepStrictEqual(validateRig(r).chains[0].aec, { component: '200ms_Acoustic_Echo_Canceler', channel: 1 });
});

test('validateRig: missing stages/field default in', () => {
  const v = validateRig({ chains: [{ id: 'c1', label: 'Mic 1', aec: { component: 'A', channel: 2 } }] });
  assert.strictEqual(v.chains[0].input, null);
  assert.deepStrictEqual(v.chains[0].mixer, []);
  assert.deepStrictEqual(v.field, defaultRig().field);
});

function throws400(rig, re) {
  assert.throws(() => validateRig(rig), (e) => e.httpCode === 400 && re.test(e.message));
}

test('validateRig: unknown role key → 400', () => {
  const r = defaultRig();
  r.chains[0].subwoofer = { component: 'X', channel: 1 };
  throws400(r, /subwoofer/);
});

test('validateRig: bad channel → 400 (0, negative, fraction, string, missing)', () => {
  for (const channel of [0, -1, 1.5, '1', undefined]) {
    const r = defaultRig();
    r.chains[0].aec = { component: 'A', channel };
    throws400(r, /channel/);
  }
});

test('validateRig: bad component / shape → 400', () => {
  const r = defaultRig();
  r.chains[0].aec = { component: '', channel: 1 };
  throws400(r, /component/);
  throws400({ chains: 'nope' }, /chains/);
  throws400(null, /object/);
  throws400({ chains: [] }, /chain/);
});

// --- S4: field readings -----------------------------------------------------------
const withField = (field) => ({ chains: defaultRig().chains, field });

test('validateRig field: readings round-trip; empty (null / []) allowed', () => {
  const f = { seatSpl: [66, 68.5, 70], noiseFloor: 38, rt60: 0.6 };
  assert.deepStrictEqual(validateRig(withField(f)).field, f);
  assert.deepStrictEqual(validateRig(withField({ seatSpl: [], noiseFloor: null, rt60: null })).field, defaultRig().field);
  assert.deepStrictEqual(validateRig(withField({})).field, defaultRig().field, 'missing keys default in');
});

test('validateRig field: non-numbers → 400 (string, NaN, Infinity, null seat)', () => {
  for (const [k, v] of [['noiseFloor', '38'], ['rt60', NaN], ['noiseFloor', Infinity], ['rt60', '0.5']]) {
    throws400(withField({ ...defaultRig().field, [k]: v }), new RegExp(k));
  }
  throws400(withField({ seatSpl: [66, null] }), /seatSpl\[1\]/);
  throws400(withField({ seatSpl: ['66'] }), /seatSpl\[0\]/);
  throws400(withField({ seatSpl: 66 }), /seatSpl/);
});

test('validateRig field: ranges — SPL/noise 0…140 dB, RT60 > 0…20 s, ≤ 32 seats', () => {
  const ok = (f) => validateRig(withField({ ...defaultRig().field, ...f }));
  ok({ seatSpl: [0, 140], noiseFloor: 0, rt60: 20 });
  ok({ noiseFloor: 140, rt60: 0.01 });
  throws400(withField({ seatSpl: [-1] }), /seatSpl\[0\]/);
  throws400(withField({ seatSpl: [140.1] }), /seatSpl\[0\]/);
  throws400(withField({ noiseFloor: -0.1 }), /noiseFloor/);
  throws400(withField({ noiseFloor: 141 }), /noiseFloor/);
  throws400(withField({ rt60: 0 }), /rt60/);
  throws400(withField({ rt60: 20.1 }), /rt60/);
  throws400(withField({ seatSpl: new Array(33).fill(66) }), /seatSpl/);
});

// --- S6: mixer crosspoints ----------------------------------------------------------
const XP = { component: 'Mixer_8x8', in: 1, out: 8, feedsRef: false };
const withMixer = (mixer) => { const r = defaultRig(); r.chains[0].mixer = mixer; return r; };

test('mixer role: typeMatch accepts the CONFIRMED `mixer` type only', () => {
  const r = ROLES.mixer;
  assert.ok(r.typeMatch.test('mixer'));
  assert.ok(!r.typeMatch.test('auto_mixer_gating_adaptive'));
  assert.ok(!r.typeMatch.test('gain'));
});

test('mixer role: meters(crosspoint) → crosspoint gain + input/output mute pins (CONFIRMED)', () => {
  const m = ROLES.mixer.meters(XP);
  assert.deepStrictEqual(m.map((x) => x.pin), ['input.1.output.8.gain', 'input.1.mute', 'output.8.mute']);
  assert.deepStrictEqual(m.map((x) => x.key),
    ['mixer.Mixer_8x8.1.8.gain', 'mixer.Mixer_8x8.1.8.inMute', 'mixer.Mixer_8x8.1.8.outMute']);
  assert.deepStrictEqual([m[0].unit, m[0].lo, m[0].hi], ['dB', -100, 10]);
  assert.deepStrictEqual([m[1].lo, m[1].hi, m[2].lo, m[2].hi], [0, 1, 0, 1]);
});

test('mixer role: keys differ per crosspoint and per mixer', () => {
  const keys = [XP, { ...XP, out: 2 }, { ...XP, in: 2 }, { ...XP, component: 'Mixer_B' }]
    .map((x) => ROLES.mixer.meters(x)[0].key);
  assert.strictEqual(new Set(keys).size, 4, keys.join(' '));
});

test('mixer role: knobs → crosspoint gain −100…+10 (CONFIRMED)', () => {
  const k = ROLES.mixer.knobs({ ...XP, in: 3, out: 5 });
  assert.deepStrictEqual(k.map((x) => [x.key, x.pin, x.lo, x.hi]), [['mixer.gain', 'input.3.output.5.gain', -100, 10]]);
});

test('validateRig mixer: add several crosspoints, remove one — round-trips; feedsRef defaults false', () => {
  const three = [XP, { component: 'Mixer_8x8', in: 1, out: 1 }, { component: 'Mixer_8x8', in: 2, out: 8, feedsRef: true }];
  const v = validateRig(withMixer(three)).chains[0].mixer;
  assert.deepStrictEqual(v, [XP, { component: 'Mixer_8x8', in: 1, out: 1, feedsRef: false }, { component: 'Mixer_8x8', in: 2, out: 8, feedsRef: true }]);
  const two = validateRig(withMixer([v[0], v[2]])).chains[0].mixer;
  assert.deepStrictEqual(two.map((x) => [x.in, x.out]), [[1, 8], [2, 8]]);
  assert.deepStrictEqual(validateRig(withMixer([])).chains[0].mixer, []);
});

test('validateRig mixer: bad crosspoint → 400 (in/out, component, feedsRef, duplicate)', () => {
  throws400(withMixer([{ ...XP, in: 0 }]), /mixer\[0\]/);
  throws400(withMixer([{ ...XP, out: '8' }]), /mixer\[0\]/);
  throws400(withMixer([{ ...XP, component: '' }]), /mixer\[0\]\.component/);
  throws400(withMixer([{ ...XP, feedsRef: 'yes' }]), /mixer\[0\]\.feedsRef/);
  throws400(withMixer([XP, { ...XP, feedsRef: true }]), /mixer\[1\].*duplicate/i);
  throws400(withMixer({ ...XP }), /mixer must be an array/);
});

// --- S7: gating automixer ---------------------------------------------------------
test('automixer role: typeMatch accepts the CONFIRMED gating (relative threshold) type only', () => {
  const r = ROLES.automixer;
  assert.ok(r.typeMatch.test('auto_mixer_gating_adaptive'));
  assert.ok(!r.typeMatch.test('mixer'));
  assert.ok(!r.typeMatch.test('auto_mixer_gated'), 'absolute-threshold gating mixer: pins unconfirmed → show all');
  assert.ok(!r.typeMatch.test('auto_mixer'));
});

test('automixer role: meters({channel:3}) → open, signal above noise, threshold, post-gate mute, manual (CONFIRMED)', () => {
  const m = ROLES.automixer.meters({ component: 'X', channel: 3 });
  assert.deepStrictEqual(m.map((x) => [x.key, x.pin]), [
    ['automixer.open', 'channel.3.open'],
    ['automixer.snr', 'channel.3.snr'],
    ['automixer.threshold', 'config.minimum.snr'],
    ['automixer.mute', 'channel.3.post.gate.mute'],
    ['automixer.manual', 'channel.3.manual'],
  ]);
  const by = Object.fromEntries(m.map((x) => [x.key, x]));
  assert.deepStrictEqual([by['automixer.snr'].unit, by['automixer.snr'].lo, by['automixer.snr'].hi], ['dB', 0, 50]);
  assert.deepStrictEqual([by['automixer.threshold'].lo, by['automixer.threshold'].hi], [0, 50]);
  for (const k of ['automixer.open', 'automixer.mute', 'automixer.manual']) assert.deepStrictEqual([by[k].lo, by[k].hi], [0, 1], k);
});

test('automixer role: knobs → threshold (shared), post-gate mute, manual (CONFIRMED)', () => {
  const k = ROLES.automixer.knobs({ component: 'X', channel: 2 });
  assert.deepStrictEqual(k.map((x) => [x.key, x.pin]), [
    ['automixer.threshold', 'config.minimum.snr'],
    ['automixer.mute', 'channel.2.post.gate.mute'],
    ['automixer.manual', 'channel.2.manual'],
  ]);
  assert.deepStrictEqual([k[0].label, k[0].lo, k[0].hi], ['Threshold Level Above Noise', 0, 50]);
});

test('validateRig: an automixer selection round-trips', () => {
  const r = defaultRig();
  r.chains[0].automixer = { component: 'Gating_Automatic_Mic_Mixer', channel: 4 };
  assert.deepStrictEqual(validateRig(r).chains[0].automixer, { component: 'Gating_Automatic_Mic_Mixer', channel: 4 });
});

test('chainSelections: signal order input → micGain → aec → automixer → mixer[] → output, unset stages skipped', () => {
  const r = withMixer([XP, { ...XP, out: 2 }]);
  const c = r.chains[0];
  c.output = { component: 'Out', channel: 1 };
  c.input = { component: 'In', channel: 1 };
  c.aec = { component: 'A', channel: 1 };
  assert.deepStrictEqual(chainSelections(c).map(([role, sel]) => [role, sel.component, sel.out]), [
    ['input', 'In', undefined], ['aec', 'A', undefined], ['mixer', 'Mixer_8x8', 8], ['mixer', 'Mixer_8x8', 2], ['output', 'Out', undefined],
  ]);
  assert.deepStrictEqual(chainSelections(defaultRig().chains[0]), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
