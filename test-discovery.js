'use strict';
// T5 — discovery normalizers (pure). Fixtures follow the documented QRC
// response shapes (qsys-scripter Documents/.../External_Control_APIs-QRC-
// QRC_Commands.md: Component.GetComponents / Component.GetControls).
// Run: node test-discovery.js

const assert = require('assert');
const { normalizeComponents, normalizeControls } = require('./discovery');

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

const COMPONENTS = [
  { ID: 'MyGain', Name: 'MyGain', Type: 'gain', Properties: [{ Name: 'max_gain', Value: 20, PrettyName: 'Max Gain (dB)' }], Controls: null, ControlSource: 2 },
  { ID: 'Room1_AEC', Name: 'Room1_AEC', Type: 'acoustic_echo_canceller', Properties: [], Controls: null, ControlSource: 2 },
  { ID: 'Zeta', Name: 'Zeta', Type: 'mixer', Properties: [] },
  { ID: 'Canceler', Name: 'Canceler', Type: 'aec_processor' },
];

const CONTROLS = {
  Name: 'Room1_AEC',
  Controls: [
    { Name: 'gain', Type: 'Float', Value: 0.0, ValueMin: -100.0, ValueMax: 20.0, StringMin: '-100dB', StringMax: '20.0dB', String: '0dB', Position: 0.8333, Direction: 'Read/Write' },
    { Name: 'bypass', Type: 'Boolean', Value: false, String: 'no', Position: 0.0, Direction: 'Read/Write' },
    { Name: 'rmlr.meter', Type: 'Float', Value: -3.2, ValueMin: -20, ValueMax: 20, String: '-3.2dB', Direction: 'Read Only' },
    { Name: 'erl', Type: 'Float', Value: 12, String: '12dB', Direction: 'Read Only' },
    { Name: 'elr', Type: 'Float', Value: 12, String: '12dB', Direction: 'Read Only' },
  ],
};

test('components: name/type/properties kept; ID/ControlSource dropped', () => {
  const out = normalizeComponents(COMPONENTS);
  const g = out.find((c) => c.name === 'MyGain');
  assert.deepStrictEqual(g, { name: 'MyGain', type: 'gain', aecCandidate: false, properties: { max_gain: 20 } });
});

test('components: AEC candidates by type or name (aec|echo), listed first, then alphabetical', () => {
  const out = normalizeComponents(COMPONENTS);
  assert.deepStrictEqual(out.map((c) => c.name), ['Canceler', 'Room1_AEC', 'MyGain', 'Zeta']);
  assert.deepStrictEqual(out.map((c) => c.aecCandidate), [true, true, false, false]);
});

test('components: tolerates missing Properties / empty or non-array result', () => {
  assert.deepStrictEqual(normalizeComponents([{ Name: 'X', Type: 't' }])[0].properties, {});
  assert.deepStrictEqual(normalizeComponents(null), []);
  assert.deepStrictEqual(normalizeComponents({}), []);
});

test('controls: fields mapped, min/max null when absent, sorted by name', () => {
  const out = normalizeControls(CONTROLS);
  assert.strictEqual(out.name, 'Room1_AEC');
  assert.deepStrictEqual(out.controls.map((c) => c.name), ['bypass', 'elr', 'erl', 'gain', 'rmlr.meter']);
  const gain = out.controls.find((c) => c.name === 'gain');
  assert.deepStrictEqual(gain, {
    name: 'gain', type: 'Float', value: 0, string: '0dB', min: -100, max: 20, direction: 'Read/Write', tags: [],
  });
  const byp = out.controls.find((c) => c.name === 'bypass');
  assert.strictEqual(byp.min, null);
  assert.strictEqual(byp.max, null);
});

test('controls: probable RMLR / ELR pins tagged (hints only — not CONFIRMED)', () => {
  const out = normalizeControls(CONTROLS);
  const tags = Object.fromEntries(out.controls.map((c) => [c.name, c.tags]));
  assert.deepStrictEqual(tags['rmlr.meter'], ['rmlr?']);
  assert.deepStrictEqual(tags.erl, ['elr?']);
  assert.deepStrictEqual(tags.elr, ['elr?']);
  assert.deepStrictEqual(tags.gain, []);
});

test('controls: real Q-SYS AEC pin names (Session 3 emulation) — ref.mic.ratio is RMLR; ERLE is NOT ELR', () => {
  const out = normalizeControls({
    Name: '200ms_Acoustic_Echo_Canceler',
    Controls: [
      { Name: 'channel.1.ref.mic.ratio', Type: 'Float', Value: 0, ValueMin: -10, ValueMax: 10, Direction: 'Read Only' },
      { Name: 'channel.1.ERLE', Type: 'Float', Value: 0, ValueMin: 0, ValueMax: 20, Direction: 'Read Only' },
      { Name: 'channel.1.ref.gain', Type: 'Float', Value: -23.3, ValueMin: -40, ValueMax: 0, Direction: 'Read/Write' },
    ],
  });
  const tags = Object.fromEntries(out.controls.map((c) => [c.name, c.tags]));
  assert.deepStrictEqual(tags['channel.1.ref.mic.ratio'], ['rmlr?']);
  assert.deepStrictEqual(tags['channel.1.ERLE'], []);
  assert.deepStrictEqual(tags['channel.1.ref.gain'], []);
});

test('controls: tolerates missing Controls', () => {
  assert.deepStrictEqual(normalizeControls({ Name: 'X' }), { name: 'X', controls: [] });
  assert.deepStrictEqual(normalizeControls(null), { name: null, controls: [] });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
