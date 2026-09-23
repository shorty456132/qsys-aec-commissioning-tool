'use strict';
// S1 — Role registry (ADR-10) + rig validation. Pure, no sockets.
// Run: node test-roles.js

const assert = require('assert');
const { ROLES, STAGES, defaultRig, validateRig } = require('../src/roles');

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
