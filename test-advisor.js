'use strict';
// S2 — Advisor (ADR-12) + the rig → meter list mapping. Pure, no sockets.
// Run: node test-advisor.js

const assert = require('assert');
const { advise } = require('./advisor');
const { meterList } = require('./meters');
const { defaultRig } = require('./roles');

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
