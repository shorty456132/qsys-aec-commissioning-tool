'use strict';
// T3 acceptance: public/gain-model.js must reproduce the v1 HTML's behavior.
// Runs v1's own inline <script> against a minimal fake DOM, then compares its
// meter readouts + status messages to GainModel for every preset and a sweep
// of random states. Run: node test-gain-model.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./public/gain-model');

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

// --- load v1 in a fake DOM ---------------------------------------------------
function fakeEl() {
  const el = {
    style: {}, value: '', textContent: '', innerHTML: '', dataset: {},
    classList: { toggle() {} },
    addEventListener() {},
    appendChild() {},
    _kids: {},
    querySelector(sel) { return (el._kids[sel] ||= fakeEl()); },
  };
  return el;
}

function loadV1() {
  const html = fs.readFileSync(path.join(__dirname, 'aec-erl-rmlr-emulator-v1.html'), 'utf-8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const presetBtns = Object.keys(G.PRESETS).map((p) => Object.assign(fakeEl(), { dataset: { p } }));
  const document = {
    getElementById: (id) => (els[id] ||= fakeEl()),
    createElement: () => fakeEl(),
    querySelectorAll: () => presetBtns,
  };
  const ctx = vm.createContext({ document, Math, Number, String });
  vm.runInContext(src + '\n;globalThis.__v1 = { S, F, upd, setTap };', ctx);
  return { v1: ctx.__v1, els, presetBtns };
}

const { v1, els, presetBtns } = loadV1();
const V1_LEVEL = { 'var(--green)': 'ok', 'var(--amber)': 'warn', 'var(--red)': 'bad' };

function v1Status() {
  const out = [];
  const re = /<i style="background:([^"]+)"><\/i><span>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(els.status.innerHTML))) out.push({ level: V1_LEVEL[m[1]], text: m[2] });
  return out;
}

function assertParity(S, tap, label) {
  const m = G.compute(S, tap);
  const got = G.issues(S, tap, m).map(({ level, text }) => ({ level, text }));
  assert.deepStrictEqual(got, v1Status(), `${label}: status messages differ`);
  const readouts = {
    'v-drv': G.fmt(m.drive), 'v-ref': G.fmt(m.ref), 'v-mic': G.fmt(m.mic), 'v-talk': G.fmt(m.talk),
    'v-rmlr': Math.abs(m.rmlr) >= 20 ? (m.rmlr > 0 ? 'PIN +' : 'PIN −') : G.fmt(m.rmlr),
  };
  for (const [id, want] of Object.entries(readouts)) {
    assert.strictEqual(want, els[id].value, `${label}: ${id} readout differs`);
  }
  assert.strictEqual(G.fmt(m.erl), els['c-erl'].textContent, `${label}: ERL card differs`);
  assert.strictEqual(Math.round(m.splSeat) + ' dB', els['c-spl'].textContent, `${label}: SPL card differs`);
  assert.strictEqual(m.adapting ? '#2fbf55' : '#5a2830', els.led.style.background, `${label}: adapt LED differs`);
}

// --- tests -------------------------------------------------------------------
test('fader definitions match v1', () => {
  for (const k of Object.keys(v1.F)) {
    const { set, ...v1f } = v1.F[k];
    const { set: _s, ...gf } = G.FADERS[k];
    assert.deepStrictEqual(gf, v1f, `fader ${k}`);
  }
  assert.deepStrictEqual(G.FADER_KEYS, Object.keys(v1.F));
});

test('toPos/toDb taper matches v1 round-trip', () => {
  for (const k of G.FADER_KEYS) {
    const f = G.FADERS[k];
    for (let p = 0; p <= 1000; p += 50) {
      const db = G.toDb(f, p);
      assert.ok(db >= f.min - 1e-9 && db <= f.max + 1e-9, `${k} toDb(${p}) out of range`);
      assert.ok(Math.abs(G.toPos(f, db) - p) <= 1, `${k} round-trip at ${p}`);
    }
  }
});

for (const btn of presetBtns) {
  test(`preset "${btn.dataset.p}" — same meters + findings as v1`, () => {
    btn.onclick();
    const p = G.PRESETS[btn.dataset.p];
    const S = {};
    for (const k of G.FADER_KEYS) S[k] = p[k];
    assert.deepStrictEqual({ ...v1.S }, S);
    assertParity(S, p.tap, btn.dataset.p);
  });
}

test('500 random states — same meters + findings as v1', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i++) {
    const S = {};
    for (const k of G.FADER_KEYS) {
      const f = G.FADERS[k];
      S[k] = Math.round((f.min + rnd() * (f.max - f.min)) * 10) / 10;
      v1.S[k] = S[k];
    }
    const tap = rnd() < 0.5 ? 'post' : 'pre';
    v1.setTap(tap);
    v1.upd();
    assertParity(S, tap, `random #${i}`);
  }
});

test('ELR / RMLR definitions (ADR §v1 model)', () => {
  const S = { ...G.PRESETS.tuned };
  const m = G.compute(S, 'post');
  assert.strictEqual(m.erl, m.drive - m.echo);
  assert.strictEqual(m.rmlr, m.ref - m.mic);
  assert.strictEqual(m.mic, Math.max(m.echo, m.noise));
});

test('every finding carries the triggering value field (T8 prep)', () => {
  const S = { ...G.PRESETS.hotamp };
  for (const i of G.issues(S, 'post', G.compute(S, 'post'))) assert.ok('value' in i);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
