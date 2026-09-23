'use strict';
// S2 — Advisor (ADR-12) + the rig → meter list mapping. Pure, no sockets.
// Run: node test-advisor.js

const assert = require('assert');
const { advise, MODES } = require('../src/advisor');
const { meterList } = require('../src/meters');
const { defaultRig } = require('../src/roles');

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

const aecRig = (channel = 1) => {
  const r = defaultRig();
  r.chains[0].aec = { component: 'Room1_AEC', channel };
  return r;
};
const rmlr = (findings) => findings.find((f) => f.trigger && f.trigger.key === 'aec.rmlr');

// --- meterList ----------------------------------------------------------------
test('meterList: empty rig → no meters', () => {
  assert.deepStrictEqual(meterList(defaultRig()), []);
});

test('meterList: AEC stage → RMLR + ERLE tagged with chain, role, component', () => {
  const m = meterList(aecRig(2));
  assert.deepStrictEqual(m.map((x) => [x.chain, x.role, x.component, x.key, x.pin]), [
    ['chain-1', 'aec', 'Room1_AEC', 'aec.rmlr', 'channel.2.ref.mic.ratio'],
    ['chain-1', 'aec', 'Room1_AEC', 'aec.erle', 'channel.2.ERLE'],
  ]);
  assert.deepStrictEqual([m[0].unit, m[0].lo, m[0].hi, m[0].label], ['dB', -10, 10, 'RMLR']);
});

// --- advise: RMLR rule ------------------------------------------------------------
test('advise: RMLR +5 → warn, trigger {aec.rmlr, 5}, adjust channel ref.gain, doc source', () => {
  const f = rmlr(advise(aecRig(1), { 'chain-1': { 'aec.rmlr': 5 } }));
  assert.ok(f, 'an RMLR finding');
  assert.strictEqual(f.level, 'warn');
  assert.deepStrictEqual(f.trigger, { key: 'aec.rmlr', value: 5 });
  assert.deepStrictEqual(f.adjust, [{ component: 'Room1_AEC', pin: 'channel.1.ref.gain', label: 'Reference gain' }]);
  assert.strictEqual(f.source, 'doc:AEC_Gain_Structure.md');
  assert.ok(/Reference gain/.test(f.text) && /channel\.1\.ref\.gain/.test(f.text), f.text);
  assert.ok(f.id, 'has an id');
});

test('advise: RMLR −5 → warn too (sign convention unverified — text never says raise/lower)', () => {
  const f = rmlr(advise(aecRig(1), { 'chain-1': { 'aec.rmlr': -5 } }));
  assert.strictEqual(f.level, 'warn');
  assert.ok(!/\b(raise|lower|increase|decrease)\b/i.test(f.text), f.text);
});

test('advise: RMLR 0 → ok, nothing to adjust', () => {
  const f = rmlr(advise(aecRig(1), { 'chain-1': { 'aec.rmlr': 0 } }));
  assert.strictEqual(f.level, 'ok');
  assert.deepStrictEqual(f.adjust, []);
});

test('advise: RMLR ±3 edge is ok; just past it warns', () => {
  const lv = (v) => rmlr(advise(aecRig(1), { 'chain-1': { 'aec.rmlr': v } })).level;
  assert.deepStrictEqual([lv(3), lv(-3), lv(3.1), lv(-3.1)], ['ok', 'ok', 'warn', 'warn']);
});

test('advise: no value (missing / stale) → no finding; no AEC stage → no finding', () => {
  assert.deepStrictEqual(advise(aecRig(1), {}), []);
  assert.deepStrictEqual(advise(aecRig(1), { 'chain-1': { 'aec.rmlr': null } }), []);
  assert.deepStrictEqual(advise(defaultRig(), { 'chain-1': { 'aec.rmlr': 5 } }), []);
});

test('advise: finding ids are unique per chain', () => {
  const r = aecRig(1);
  r.chains.push({ ...r.chains[0], id: 'chain-2', aec: { component: 'Room2_AEC', channel: 1 } });
  const f = advise(r, { 'chain-1': { 'aec.rmlr': 5 }, 'chain-2': { 'aec.rmlr': 5 } });
  assert.strictEqual(f.length, 2);
  assert.notStrictEqual(f[0].id, f[1].id);
  assert.strictEqual(f[1].adjust[0].component, 'Room2_AEC');
});

// --- S3: input stage ---------------------------------------------------------------
const inRig = (channel = 3) => {
  const r = defaultRig();
  r.chains[0].input = { component: 'Flex_In_Core-1', channel };
  return r;
};
const GAIN3 = { component: 'Flex_In_Core-1', pin: 'channel.3.input.gain', label: 'Input gain' };
const byKey = (findings, key) => findings.filter((f) => f.trigger && f.trigger.key === key);
const level = (v, mode, clip = 0) => byKey(advise(inRig(), { 'chain-1': { 'input.level': v, 'input.clip': clip } }, { mode }), 'input.level');
const lvl = (v, mode) => { const f = level(v, mode); return f.length ? f[0].level : null; };

test('meterList: input stage comes before AEC (signal order), level + clip', () => {
  const r = inRig(3);
  r.chains[0].aec = { component: 'Room1_AEC', channel: 1 };
  assert.deepStrictEqual(meterList(r).map((x) => [x.role, x.key]), [
    ['input', 'input.level'], ['input', 'input.clip'], ['aec', 'aec.rmlr'], ['aec', 'aec.erle'],
  ]);
});

test('advise: clip → bad, adjust input.gain, in every mode (incl. no mode)', () => {
  for (const mode of [undefined, 'off', 'talker', 'quiet']) {
    const f = byKey(advise(inRig(), { 'chain-1': { 'input.level': -18, 'input.clip': 1 } }, { mode }), 'input.clip');
    assert.strictEqual(f.length, 1, String(mode));
    assert.strictEqual(f[0].level, 'bad');
    assert.deepStrictEqual(f[0].adjust, [GAIN3]);
    assert.strictEqual(f[0].source, 'doc:AEC_Gain_Structure.md');
    assert.ok(/lower/i.test(f[0].text) && /channel\.3\.input\.gain/.test(f[0].text), f[0].text);
  }
  assert.deepStrictEqual(byKey(advise(inRig(), { 'chain-1': { 'input.clip': 0 } }), 'input.clip'), [], 'no clip → silent');
});

test('advise: peak > −3 dBFS → warn "lower" in every mode; −3 itself is not a peak', () => {
  for (const mode of ['off', 'talker', 'quiet']) {
    const [f] = level(-2.9, mode);
    assert.strictEqual(f.level, 'warn', mode);
    assert.ok(/lower/i.test(f.text) && /-3 dBFS/.test(f.text), f.text);
    assert.deepStrictEqual(f.adjust, [GAIN3]);
  }
  assert.strictEqual(lvl(-3, 'off'), null, 'off mode: −3 → nothing');
});

test('advise: talker window −20…−15 edges ok; below → warn raise; above → warn lower', () => {
  assert.deepStrictEqual([lvl(-20, 'talker'), lvl(-15, 'talker'), lvl(-17.5, 'talker')], ['ok', 'ok', 'ok']);
  const [lo] = level(-20.1, 'talker');
  const [hi] = level(-14.9, 'talker');
  assert.deepStrictEqual([lo.level, hi.level], ['warn', 'warn']);
  assert.ok(/raise/i.test(lo.text) && /lower/i.test(hi.text), lo.text + ' | ' + hi.text);
  assert.deepStrictEqual(lo.adjust, [GAIN3]);
  assert.deepStrictEqual(level(-17, 'talker')[0].adjust, []);
  assert.strictEqual(lo.source, 'doc:AEC_Gain_Structure.md');
});

test('advise: quiet room ≤ −40 ok; −40…−35 warn; > −35 bad; never says lower the gain', () => {
  assert.deepStrictEqual([lvl(-40, 'quiet'), lvl(-39.9, 'quiet'), lvl(-35, 'quiet'), lvl(-34.9, 'quiet')],
    ['ok', 'warn', 'warn', 'bad']);
  const [f] = level(-30, 'quiet');
  assert.deepStrictEqual(f.adjust, [], 'gain does not fix SNR (doc)');
  assert.ok(/noise reduction/i.test(f.text), f.text);
  assert.strictEqual(f.source, 'doc:AEC_Gain_Structure.md');
});

test('advise: one input.level finding per chain (peak wins over the mode rule)', () => {
  assert.strictEqual(level(-2, 'talker').length, 1);
  assert.strictEqual(level(-2, 'quiet').length, 1);
  assert.ok(/-3 dBFS/.test(level(-2, 'quiet')[0].text));
});

test('advise: off / no mode → no talker or noise findings; no input stage or value → none', () => {
  assert.strictEqual(lvl(-30, 'off'), null);
  assert.strictEqual(lvl(-30, undefined), null);
  assert.deepStrictEqual(advise(inRig(), {}, { mode: 'talker' }), []);
  assert.deepStrictEqual(advise(defaultRig(), { 'chain-1': { 'input.level': -30, 'input.clip': 1 } }, { mode: 'talker' }), []);
});

test('advise: MODES lists the Monitor modes', () => {
  assert.deepStrictEqual(MODES, ['off', 'talker', 'quiet']);
});

// --- S4: field readings ---------------------------------------------------------------
const fieldRig = (field) => { const r = defaultRig(); r.field = { ...r.field, ...field }; return r; };
const fieldF = (field, key, opts) => byKey(advise(fieldRig(field), {}, opts), key);

test('advise seat SPL: none entered → no finding; all inside 65…70 (edges incl.) → ok', () => {
  assert.deepStrictEqual(fieldF({}, 'field.seatSpl'), []);
  const [f] = fieldF({ seatSpl: [65, 67.5, 70] }, 'field.seatSpl');
  assert.strictEqual(f.level, 'ok');
  assert.deepStrictEqual(f.trigger, { key: 'field.seatSpl', value: [65, 67.5, 70] });
  assert.deepStrictEqual(f.adjust, []);
  assert.strictEqual(f.source, 'doc:AEC_Gain_Structure.md');
  assert.strictEqual(f.id, 'field:seatSpl');
});

test('advise seat SPL: a seat below 65 → warn "raise" amp/output; above 70 → warn "lower"; names the seats', () => {
  const [lo] = fieldF({ seatSpl: [66, 64.9, 64] }, 'field.seatSpl');
  assert.strictEqual(lo.level, 'warn');
  assert.ok(/raise/i.test(lo.text) && /amplifier|output/i.test(lo.text), lo.text);
  assert.ok(/seats? 2, 3/.test(lo.text), lo.text);
  const [hi] = fieldF({ seatSpl: [70.1] }, 'field.seatSpl');
  assert.strictEqual(hi.level, 'warn');
  assert.ok(/lower/i.test(hi.text) && /amplifier|output/i.test(hi.text), hi.text);
});

test('advise seat SPL: seats both below and above → warn about coverage, not a single gain move', () => {
  const [f] = fieldF({ seatSpl: [63, 72] }, 'field.seatSpl');
  assert.strictEqual(f.level, 'warn');
  assert.ok(/coverage/i.test(f.text), f.text);
  assert.ok(!/\braise\b/i.test(f.text), f.text);
});

test('advise acoustic SNR: needs seats + noise floor; uses the worst (quietest) seat', () => {
  assert.deepStrictEqual(fieldF({ seatSpl: [68] }, 'field.snr'), []);
  assert.deepStrictEqual(fieldF({ noiseFloor: 40 }, 'field.snr'), []);
  const [f] = fieldF({ seatSpl: [70, 66], noiseFloor: 40 }, 'field.snr');
  assert.deepStrictEqual(f.trigger, { key: 'field.snr', value: 26 });
  assert.strictEqual(f.source, 'doc:AEC_Gain_Structure.md');
  assert.strictEqual(f.id, 'field:snr');
});

test('advise acoustic SNR: < 15 bad; 15…< 25 warn; ≥ 25 ok (edges)', () => {
  const lv = (snr) => fieldF({ seatSpl: [68], noiseFloor: 68 - snr }, 'field.snr')[0].level;
  assert.deepStrictEqual([lv(14.9), lv(15), lv(24.9), lv(25), lv(30)], ['bad', 'warn', 'warn', 'ok', 'ok']);
  const [bad] = fieldF({ seatSpl: [68], noiseFloor: 60 }, 'field.snr');
  assert.ok(/noise/i.test(bad.text), bad.text);
});

const TAIL_PROPS = { Room1_AEC: { tail_length: '0.2', channel_count: '1' } };
const tailF = (rt60, props = TAIL_PROPS, rig = aecRig(1)) => {
  rig.field.rt60 = rt60;
  return byKey(advise(rig, {}, { props }), 'field.rt60');
};

test('advise tail: RT60 > AEC tail_length property → warn, heuristic, names Tail Length + DSP cost', () => {
  const [f] = tailF(0.6);
  assert.strictEqual(f.level, 'warn');
  assert.strictEqual(f.source, 'heuristic');
  assert.deepStrictEqual(f.trigger, { key: 'field.rt60', value: 0.6 });
  assert.deepStrictEqual(f.adjust, [{ component: 'Room1_AEC', pin: 'tail_length', label: 'Tail Length (design property)' }]);
  assert.ok(/0\.2 s/.test(f.text) && /0\.6 s/.test(f.text) && /DSP/.test(f.text), f.text);
  assert.strictEqual(f.id, 'chain-1:aec.tail');
});

test('advise tail: RT60 ≤ tail (edge incl.) → ok; tail read from props, not assumed', () => {
  assert.strictEqual(tailF(0.2)[0].level, 'ok');
  assert.strictEqual(tailF(0.15)[0].level, 'ok');
  assert.strictEqual(tailF(0.4, { Room1_AEC: { tail_length: '0.5' } })[0].level, 'ok');
  assert.strictEqual(tailF(0.6, { Room1_AEC: { tail_length: '0.5' } })[0].level, 'warn');
});

test('advise tail: no RT60 / no AEC / no props / unparseable tail_length → no finding', () => {
  assert.deepStrictEqual(tailF(null), []);
  const r = aecRig(1);
  r.field.rt60 = 0.6;
  assert.deepStrictEqual(byKey(advise(r, {}), 'field.rt60'), [], 'no props passed');
  assert.deepStrictEqual(tailF(0.6, null), []);
  assert.deepStrictEqual(tailF(0.6, {}), []);
  assert.deepStrictEqual(tailF(0.6, { Room1_AEC: { tail_length: 'long' } }), []);
  assert.deepStrictEqual(tailF(0.6, TAIL_PROPS, defaultRig()), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
