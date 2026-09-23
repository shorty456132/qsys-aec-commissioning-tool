'use strict';
// T4 — /api/connect, /api/disconnect, /api/status against a fake QRC server.
// No live Core required. Run: node test-server.js

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createApp } = require('../src/server');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(` FAIL  ${name}\n      ${e.message}`);
  }
}

// T5 fixtures — documented QRC shapes (QRC_Commands.md).
const FAKE_COMPONENTS = [
  { ID: 'MyGain', Name: 'MyGain', Type: 'gain', Properties: [], Controls: null, ControlSource: 2 },
  // S1: CONFIRMED AEC type string (ADR §Pins).
  // S4: tail_length is a string in seconds (CONFIRMED in emulation: "0.2").
  { ID: 'Room1_AEC', Name: 'Room1_AEC', Type: 'acoustic_echo_canceler_simd', Properties: [{ Name: 'tail_length', Value: '0.2' }, { Name: 'channel_count', Value: '2' }], Controls: null, ControlSource: 2 },
  // S3: CONFIRMED Flex type string; emulation reports no properties for it.
  { ID: 'Flex_In_Core-1', Name: 'Flex_In_Core-1', Type: 'io_card_flex_in_core_8flex', Properties: [], Controls: null, ControlSource: 2 },
];
const FAKE_CONTROLS = {
  Room1_AEC: [
    { Name: 'rmlr', Type: 'Float', Value: -2, ValueMin: -20, ValueMax: 20, String: '-2dB', Direction: 'Read Only' },
    { Name: 'gain', Type: 'Float', Value: 0, ValueMin: -100, ValueMax: 20, String: '0dB', Direction: 'Read/Write' },
  ],
};

// Fake QRC: EngineStatus broadcast on connect, replies to every request
// unless `silent`. Tracks live sockets so tests can count / drop them.
//
// S2 change groups (shapes: QRC_Commands.md). Groups live per connection:
// Id → Map("component\0pin" → last value sent). `fake.meters[comp][pin]` is
// the scripted meter track (ADR-13); Poll returns changes only, like a Core.
function fakeReply(msg, fake, conn) {
  const p = msg.params || {};
  if (msg.method === 'Component.GetComponents') return { result: FAKE_COMPONENTS };
  if (msg.method === 'Component.GetControls') {
    const c = FAKE_CONTROLS[p.Name];
    if (!c) return { error: { code: 8, message: 'Unknown component name' } };
    return { result: { Name: p.Name, Controls: c } };
  }
  if (msg.method === 'ChangeGroup.AddComponentControl') {
    fake.groupIds.add(p.Id);
    if (!conn.groups.has(p.Id)) conn.groups.set(p.Id, new Map());
    const g = conn.groups.get(p.Id);
    for (const c of p.Component.Controls) {
      const k = p.Component.Name + '\0' + c.Name;
      if (!g.has(k)) g.set(k, undefined); // undefined = never sent → first Poll reports it
    }
    return { result: true };
  }
  if (msg.method === 'ChangeGroup.Clear') {
    if (conn.groups.has(p.Id)) conn.groups.get(p.Id).clear();
    return { result: true };
  }
  if (msg.method === 'ChangeGroup.Poll') {
    if (fake.pollError) return { error: { code: 99, message: fake.pollError } };
    const g = conn.groups.get(p.Id);
    if (!g) return { error: { code: 6, message: 'Unknown change group' } };
    const changes = [];
    for (const [k, last] of g) {
      const [comp, pin] = k.split('\0');
      const v = (fake.meters[comp] || {})[pin];
      if (v === undefined || v === last) continue;
      g.set(k, v);
      changes.push({ Component: comp, Name: pin, Value: v, String: `${v}dB` });
    }
    if (changes.length) fake.changeLog.push(changes);
    return { result: { Id: p.Id, Changes: changes } };
  }
  return { result: true };
}

function startFakeQRC({ silent = false } = {}) {
  const fake = { socks: new Set(), methods: [], meters: {}, groupIds: new Set(), changeLog: [], pollError: null };
  return new Promise((resolve) => {
    fake.srv = net.createServer((sock) => {
      const conn = { groups: new Map() };
      fake.socks.add(sock);
      sock.on('close', () => fake.socks.delete(sock));
      sock.on('error', () => {});
      if (silent) return void sock.resume(); // read + ignore, like any non-QRC service
      sock.write(JSON.stringify({ jsonrpc: '2.0', method: 'EngineStatus', params: { State: 'Active' } }) + '\x00');
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf-8');
        let i;
        while ((i = buf.indexOf('\x00')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          fake.methods.push(msg.method);
          if (msg.id !== undefined && !fake.mute) sock.write(JSON.stringify({ jsonrpc: '2.0', ...fakeReply(msg, fake, conn), id: msg.id }) + '\x00');
        }
      });
    });
    fake.srv.listen(0, '127.0.0.1', () => { fake.port = fake.srv.address().port; resolve(fake); });
  });
}

function startApp(opts = {}) {
  const app = createApp({ qrcTimeoutMs: 400, ...opts });
  return new Promise((resolve) => app.listen(0, '127.0.0.1', () => resolve(app)));
}

function call(app, method, path, body, raw) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: '127.0.0.1', port: app.address().port, method, path, headers: data ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ code: res.statusCode, body: s ? JSON.parse(s) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getRaw(app, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.address().port, path }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ code: res.statusCode, type: res.headers['content-type'], text: s }));
    }).on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every app gets its own rig.json in a temp dir — tests never touch the repo's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-rig-'));
let rigN = 0;
const tmpRigPath = () => path.join(TMP, `rig-${++rigN}.json`);

async function withRig(opts, fn, appOpts) {
  const fake = await startFakeQRC(opts);
  const app = await startApp({ rigPath: tmpRigPath(), ...appOpts });
  try {
    await fn(app, fake);
  } finally {
    app.session.disconnect();
    await new Promise((r) => app.close(r));
    for (const s of fake.socks) s.destroy();
    fake.srv.close();
  }
}

(async () => {
  await test('status starts disconnected', async () => {
    await withRig({}, async (app) => {
      const r = await call(app, 'GET', '/api/status');
      assert.strictEqual(r.code, 200);
      assert.strictEqual(r.body.state, 'disconnected');
    });
  });

  await test('connect → connected; status reports host/port; NoOp round-trip verifies QRC', async () => {
    await withRig({}, async (app, fake) => {
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.state, 'connected');
      const s = await call(app, 'GET', '/api/status');
      assert.strictEqual(s.body.state, 'connected');
      assert.strictEqual(s.body.host, '127.0.0.1');
      assert.strictEqual(s.body.port, fake.port);
      assert.ok(fake.methods.includes('NoOp'));
    });
  });

  await test('second connect while connected → 409; still one QRC socket (ADR-03)', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      assert.strictEqual(r.code, 409);
      await wait(50);
      assert.strictEqual(fake.socks.size, 1);
      assert.strictEqual((await call(app, 'GET', '/api/status')).body.state, 'connected');
    });
  });

  await test('disconnect is clean (socket closed) and reconnect works', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const d = await call(app, 'POST', '/api/disconnect');
      assert.strictEqual(d.code, 200);
      assert.strictEqual(d.body.state, 'disconnected');
      assert.strictEqual(d.body.error, null, 'user disconnect is not an error');
      await wait(50);
      assert.strictEqual(fake.socks.size, 0);
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      assert.strictEqual(r.body.state, 'connected');
    });
  });

  await test('disconnect when already disconnected is a harmless 200', async () => {
    await withRig({}, async (app) => {
      const d = await call(app, 'POST', '/api/disconnect');
      assert.strictEqual(d.code, 200);
      assert.strictEqual(d.body.state, 'disconnected');
    });
  });

  await test('connect to closed port → 502 with error; status keeps the error', async () => {
    const tmp = net.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const app = await startApp();
    try {
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port });
      assert.strictEqual(r.code, 502);
      assert.ok(r.body.error);
      const s = await call(app, 'GET', '/api/status');
      assert.strictEqual(s.body.state, 'disconnected');
      assert.ok(s.body.error);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  await test('TCP listener that is not QRC (no NoOp reply) → 502, not left connected', async () => {
    await withRig({ silent: true }, async (app, fake) => {
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      assert.strictEqual(r.code, 502);
      assert.strictEqual((await call(app, 'GET', '/api/status')).body.state, 'disconnected');
      await wait(50);
      assert.strictEqual(fake.socks.size, 0);
    });
  });

  await test('remote drop → status disconnected with error', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      for (const s of fake.socks) s.destroy();
      await wait(100);
      const s = await call(app, 'GET', '/api/status');
      assert.strictEqual(s.body.state, 'disconnected');
      assert.ok(/closed/i.test(s.body.error), s.body.error);
    });
  });

  await test('bad input → 400 (bad JSON, missing host, bad port)', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await call(app, 'POST', '/api/connect', undefined, '{nope')).code, 400);
      assert.strictEqual((await call(app, 'POST', '/api/connect', { port: 1710 })).code, 400);
      assert.strictEqual((await call(app, 'POST', '/api/connect', { host: 'x', port: 70000 })).code, 400);
      assert.strictEqual((await call(app, 'POST', '/api/connect', { host: 'x', port: 'abc' })).code, 400);
    });
  });

  await test('port defaults to 1710; password is never echoed back', async () => {
    const { parseConnectBody } = require('../src/session');
    assert.strictEqual(parseConnectBody({ host: 'core.local' }).port, 1710);
    await withRig({}, async (app, fake) => {
      const r = await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port, user: 'tech', pass: 's3cret' });
      assert.ok(!JSON.stringify(r.body).includes('s3cret'));
      const s = await call(app, 'GET', '/api/status');
      assert.ok(!JSON.stringify(s.body).includes('s3cret'));
      assert.strictEqual(s.body.user, 'tech');
      assert.ok(fake.methods.includes('Logon'));
    });
  });

  // --- T5 discovery ---------------------------------------------------------
  await test('discovery endpoints → 409 when not connected', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await call(app, 'GET', '/api/components')).code, 409);
      assert.strictEqual((await call(app, 'GET', '/api/controls?name=Room1_AEC')).code, 409);
    });
  });

  await test('GET /api/components → normalized list, AEC candidate first', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const r = await call(app, 'GET', '/api/components');
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.components.map((c) => [c.name, c.aecCandidate]), [['Room1_AEC', true], ['Flex_In_Core-1', false], ['MyGain', false]]);
      assert.ok(fake.methods.includes('Component.GetComponents'));
    });
  });

  await test('GET /api/controls?name= → normalized controls with tags', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const r = await call(app, 'GET', '/api/controls?name=Room1_AEC');
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.name, 'Room1_AEC');
      const rmlr = r.body.controls.find((c) => c.name === 'rmlr');
      assert.deepStrictEqual([rmlr.min, rmlr.max, rmlr.direction, rmlr.tags], [-20, 20, 'Read Only', ['rmlr?']]);
    });
  });

  await test('GET /api/controls: missing name → 400; unknown component → 502 with QRC error', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      assert.strictEqual((await call(app, 'GET', '/api/controls')).code, 400);
      const r = await call(app, 'GET', '/api/controls?name=Nope');
      assert.strictEqual(r.code, 502);
      assert.ok(/unknown component/i.test(r.body.error), r.body.error);
      // A QRC error reply does not drop the session.
      assert.strictEqual((await call(app, 'GET', '/api/status')).body.state, 'connected');
    });
  });

  // --- Keepalive (ADR-08): Core drops clients idle 60 s --------------------
  const countNoOps = (fake) => fake.methods.filter((m) => m === 'NoOp').length;

  await test('keepalive defaults to 58 s', async () => {
    const app = createApp();
    assert.strictEqual(app.session.keepaliveMs, 58000);
  });

  await test('keepalive: NoOp sent every interval while connected', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const afterConnect = countNoOps(fake); // the connect-time NoOp
      await wait(280);
      const n = countNoOps(fake) - afterConnect;
      assert.ok(n >= 3 && n <= 6, `expected ~4 keepalive NoOps in 280 ms @60 ms, got ${n}`);
      assert.strictEqual((await call(app, 'GET', '/api/status')).body.state, 'connected');
    }, { keepaliveMs: 60 });
  });

  await test('keepalive stops after disconnect', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      await call(app, 'POST', '/api/disconnect');
      const n = countNoOps(fake);
      await wait(200);
      assert.strictEqual(countNoOps(fake), n);
    }, { keepaliveMs: 50 });
  });

  await test('keepalive stops after remote drop', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      for (const s of fake.socks) s.destroy();
      await wait(80);
      assert.strictEqual(app.session._keepaliveTimer, null);
    }, { keepaliveMs: 50 });
  });

  await test('keepalive NoOp unanswered → disconnected with error, socket closed', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      fake.mute = true;
      await wait(50 + 400 + 150); // interval + qrcTimeoutMs + slack
      const s = await call(app, 'GET', '/api/status');
      assert.strictEqual(s.body.state, 'disconnected');
      assert.ok(/keepalive/i.test(s.body.error), s.body.error);
      assert.strictEqual(fake.socks.size, 0);
    }, { keepaliveMs: 50 });
  });

  await test('ping + static still served', async () => {
    const app = await startApp();
    try {
      assert.strictEqual((await call(app, 'GET', '/api/ping')).code, 200);
      assert.strictEqual((await call(app, 'GET', '/api/nope')).code, 404);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  // --- S1: rig persistence (ADR-10) ------------------------------------------
  const { defaultRig } = require('../src/roles');
  const aecRig = () => {
    const r = defaultRig();
    r.chains[0].aec = { component: 'Room1_AEC', channel: 1 };
    return r;
  };

  await test('GET /api/rig with no file → default rig', async () => {
    await withRig({}, async (app) => {
      const r = await call(app, 'GET', '/api/rig');
      assert.strictEqual(r.code, 200);
      assert.deepStrictEqual(r.body, defaultRig());
    });
  });

  await test('PUT /api/rig round-trips and writes rig.json', async () => {
    const rigPath = tmpRigPath();
    await withRig({}, async (app) => {
      const p = await call(app, 'PUT', '/api/rig', aecRig());
      assert.strictEqual(p.code, 200, JSON.stringify(p.body));
      assert.deepStrictEqual(p.body, aecRig());
      assert.deepStrictEqual((await call(app, 'GET', '/api/rig')).body, aecRig());
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(rigPath, 'utf-8')), aecRig());
    }, { rigPath });
  });

  await test('PUT /api/rig: unknown role key → 400; bad channel → 400; bad JSON → 400; nothing written', async () => {
    const rigPath = tmpRigPath();
    await withRig({}, async (app) => {
      const bad = aecRig();
      bad.chains[0].subwoofer = { component: 'X', channel: 1 };
      assert.strictEqual((await call(app, 'PUT', '/api/rig', bad)).code, 400);
      const badCh = aecRig();
      badCh.chains[0].aec.channel = 0;
      assert.strictEqual((await call(app, 'PUT', '/api/rig', badCh)).code, 400);
      assert.strictEqual((await call(app, 'PUT', '/api/rig', undefined, '{nope')).code, 400);
      assert.ok(!fs.existsSync(rigPath), 'rejected PUTs never write');
      assert.deepStrictEqual((await call(app, 'GET', '/api/rig')).body, defaultRig());
    }, { rigPath });
  });

  await test('rig survives an app restart', async () => {
    const rigPath = tmpRigPath();
    await withRig({}, async (app) => {
      await call(app, 'PUT', '/api/rig', aecRig());
    }, { rigPath });
    await withRig({}, async (app) => {
      assert.deepStrictEqual((await call(app, 'GET', '/api/rig')).body, aecRig());
    }, { rigPath });
  });

  await test('corrupt rig.json → GET 500 with error, not a silent default', async () => {
    const rigPath = tmpRigPath();
    fs.writeFileSync(rigPath, '{broken');
    await withRig({}, async (app) => {
      const r = await call(app, 'GET', '/api/rig');
      assert.strictEqual(r.code, 500);
      assert.ok(/rig\.json|rig-/i.test(r.body.error), r.body.error);
    }, { rigPath });
  });

  // --- S1: role candidates ---------------------------------------------------
  await test('GET /api/roles/aec/candidates → 409 when not connected', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await call(app, 'GET', '/api/roles/aec/candidates')).code, 409);
    });
  });

  await test('GET /api/roles/aec/candidates → only typeMatch components; ?all=1 → every component', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const r = await call(app, 'GET', '/api/roles/aec/candidates');
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.role, 'aec');
      assert.deepStrictEqual(r.body.components.map((c) => c.name), ['Room1_AEC']);
      assert.strictEqual(r.body.components[0].properties.channel_count, '2');
      const all = await call(app, 'GET', '/api/roles/aec/candidates?all=1');
      assert.deepStrictEqual(all.body.components.map((c) => c.name).sort(), ['Flex_In_Core-1', 'MyGain', 'Room1_AEC']);
    });
  });

  await test('GET /api/roles/input/candidates → only the Flex input (S3)', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
      const r = await call(app, 'GET', '/api/roles/input/candidates');
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.components.map((c) => c.name), ['Flex_In_Core-1']);
    });
  });

  await test('GET /api/roles/<unknown>/candidates → 404', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await call(app, 'GET', '/api/roles/subwoofer/candidates')).code, 404);
    });
  });

  // --- S2: Monitor — change-group meter poller (ADR-11) ----------------------
  const FAST = { pollMs: 30 };
  const RMLR1 = 'channel.1.ref.mic.ratio';
  const ERLE1 = 'channel.1.ERLE';
  const connect = (app, fake) => call(app, 'POST', '/api/connect', { host: '127.0.0.1', port: fake.port });
  const monitor = async (app) => (await call(app, 'GET', '/api/monitor')).body;
  const meter = (snap, key) => snap.meters.find((m) => m.key === key);
  const countOf = (fake, method) => fake.methods.filter((m) => m === method).length;

  await test('meter poll defaults to 500 ms', async () => {
    assert.strictEqual(createApp().poller.intervalMs, 500);
  });

  await test('GET /api/monitor: disconnected + empty rig → no meters, no findings', async () => {
    await withRig({}, async (app) => {
      const r = await call(app, 'GET', '/api/monitor');
      assert.strictEqual(r.code, 200);
      assert.strictEqual(r.body.state, 'disconnected');
      assert.deepStrictEqual([r.body.meters, r.body.findings], [[], []]);
      assert.ok(typeof r.body.t === 'number');
    });
  });

  await test('monitor: one change group; Poll changes merged into the cache (partial updates kept)', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 5, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(150);
      let s = await monitor(app);
      assert.strictEqual(s.state, 'connected');
      assert.strictEqual(s.error, null);
      assert.deepStrictEqual([meter(s, 'aec.rmlr').value, meter(s, 'aec.erle').value], [5, 10]);
      assert.deepStrictEqual([meter(s, 'aec.rmlr').stale, meter(s, 'aec.rmlr').component, meter(s, 'aec.rmlr').pin],
        [false, 'Room1_AEC', RMLR1]);
      assert.ok(countOf(fake, 'ChangeGroup.AddComponentControl') >= 1);
      // Only ERLE moves → Poll returns only ERLE; RMLR must survive from the cache.
      fake.meters.Room1_AEC[ERLE1] = 12;
      await wait(150);
      assert.deepStrictEqual(fake.changeLog[fake.changeLog.length - 1].map((c) => c.Name), [ERLE1]);
      s = await monitor(app);
      assert.deepStrictEqual([meter(s, 'aec.rmlr').value, meter(s, 'aec.erle').value], [5, 12]);
      assert.strictEqual(fake.groupIds.size, 1);
    }, FAST);
  });

  await test('monitor: RMLR +5 → warn finding naming ref.gain in the snapshot', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 5, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(150);
      const f = (await monitor(app)).findings.find((x) => x.trigger && x.trigger.key === 'aec.rmlr');
      assert.strictEqual(f.level, 'warn');
      assert.strictEqual(f.adjust[0].pin, 'channel.1.ref.gain');
    }, FAST);
  });

  await test('monitor: rig change → Clear + re-add on the same group; no second group (max 4, ADR-11)', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 1, [ERLE1]: 2, 'channel.2.ref.mic.ratio': -4, 'channel.2.ERLE': 7 } };
      await connect(app, fake);
      await wait(150);
      const ch2 = aecRig();
      ch2.chains[0].aec.channel = 2;
      await call(app, 'PUT', '/api/rig', ch2);
      await wait(150);
      assert.ok(countOf(fake, 'ChangeGroup.Clear') >= 1, 'group cleared');
      assert.strictEqual(fake.groupIds.size, 1, `groups used: ${[...fake.groupIds]}`);
      assert.strictEqual(countOf(fake, 'ChangeGroup.Destroy'), 0);
      const s = await monitor(app);
      assert.deepStrictEqual(s.meters.map((m) => [m.pin, m.value]), [['channel.2.ref.mic.ratio', -4], ['channel.2.ERLE', 7]]);
    }, FAST);
  });

  await test('monitor: rig saved before a restart is polled on the next connect', async () => {
    const rigPath = tmpRigPath();
    fs.writeFileSync(rigPath, JSON.stringify(aecRig()));
    await withRig({}, async (app, fake) => {
      fake.meters = { Room1_AEC: { [RMLR1]: 0, [ERLE1]: 15 } };
      await connect(app, fake);
      await wait(150);
      assert.strictEqual(meter(await monitor(app), 'aec.erle').value, 15);
    }, { ...FAST, rigPath });
  });

  await test('monitor: disconnect → poller stops; state disconnected, meters stale, no findings', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 5, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(120);
      await call(app, 'POST', '/api/disconnect');
      const polls = countOf(fake, 'ChangeGroup.Poll');
      await wait(150);
      assert.strictEqual(countOf(fake, 'ChangeGroup.Poll'), polls, 'no polls after disconnect');
      const s = await monitor(app);
      assert.strictEqual(s.state, 'disconnected');
      assert.strictEqual(s.meters.length, 2);
      assert.ok(s.meters.every((m) => m.stale), 'all meters stale');
      assert.deepStrictEqual(s.findings, []);
    }, FAST);
  });

  await test('monitor: remote drop → poller stops; reconnect rebuilds the group and polls again', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 5, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(120);
      for (const s of fake.socks) s.destroy();
      await wait(80);
      const polls = countOf(fake, 'ChangeGroup.Poll');
      await wait(120);
      assert.strictEqual(countOf(fake, 'ChangeGroup.Poll'), polls);
      assert.ok(meter(await monitor(app), 'aec.rmlr').stale);
      const adds = countOf(fake, 'ChangeGroup.AddComponentControl');
      await connect(app, fake);
      await wait(150);
      assert.ok(countOf(fake, 'ChangeGroup.AddComponentControl') > adds, 'group re-added on the new connection');
      const s = await monitor(app);
      assert.deepStrictEqual([meter(s, 'aec.rmlr').value, meter(s, 'aec.rmlr').stale, s.error], [5, false, null]);
    }, FAST);
  });

  await test('monitor: a Poll error is surfaced in the snapshot (meters stale), then clears on recovery', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', aecRig());
      fake.meters = { Room1_AEC: { [RMLR1]: 5, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(120);
      fake.pollError = 'boom';
      await wait(120);
      let s = await monitor(app);
      assert.ok(/boom/.test(s.error), `error: ${s.error}`);
      assert.ok(s.meters.every((m) => m.stale));
      assert.deepStrictEqual(s.findings, [], 'no advice on stale values');
      assert.strictEqual(s.state, 'connected', 'a QRC error reply does not drop the session');
      fake.pollError = null;
      await wait(120);
      s = await monitor(app);
      assert.strictEqual(s.error, null);
      assert.strictEqual(meter(s, 'aec.rmlr').stale, false);
    }, FAST);
  });

  // --- S3: input stage + Monitor mode --------------------------------------------
  const LEVEL3 = 'channel.3.digital.input.level';
  const CLIP3 = 'channel.3.clip';
  const inputRig = () => {
    const r = defaultRig();
    r.chains[0].input = { component: 'Flex_In_Core-1', channel: 3 };
    return r;
  };
  const inputFinding = (snap, key) => snap.findings.find((f) => f.trigger && f.trigger.key === key);

  await test('monitor mode: defaults to off; PUT /api/monitor/mode sets it; bad mode → 400', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await monitor(app)).mode, 'off');
      const r = await call(app, 'PUT', '/api/monitor/mode', { mode: 'talker' });
      assert.deepStrictEqual([r.code, r.body], [200, { mode: 'talker' }]);
      assert.strictEqual((await monitor(app)).mode, 'talker');
      const bad = await call(app, 'PUT', '/api/monitor/mode', { mode: 'loud' });
      assert.strictEqual(bad.code, 400);
      assert.ok(/mode/.test(bad.body.error));
      assert.strictEqual((await monitor(app)).mode, 'talker', 'unchanged after a bad PUT');
    });
  });

  await test('monitor: input stage polled; talker mode −24 dBFS → warn naming input.gain; quiet mode → bad', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', inputRig());
      fake.meters = { 'Flex_In_Core-1': { [LEVEL3]: -24, [CLIP3]: 0 } };
      await connect(app, fake);
      await wait(150);
      let s = await monitor(app);
      assert.deepStrictEqual(s.meters.map((m) => [m.key, m.value, m.stale]), [['input.level', -24, false], ['input.clip', 0, false]]);
      assert.strictEqual(inputFinding(s, 'input.level'), undefined, 'off mode: no talker/noise advice');
      await call(app, 'PUT', '/api/monitor/mode', { mode: 'talker' });
      s = await monitor(app);
      const f = inputFinding(s, 'input.level');
      assert.strictEqual(f.level, 'warn');
      assert.deepStrictEqual(f.adjust, [{ component: 'Flex_In_Core-1', pin: 'channel.3.input.gain', label: 'Input gain' }]);
      await call(app, 'PUT', '/api/monitor/mode', { mode: 'quiet' });
      assert.strictEqual(inputFinding(await monitor(app), 'input.level').level, 'bad');
    }, FAST);
  });

  await test('monitor: clip → bad finding in off mode', async () => {
    await withRig({}, async (app, fake) => {
      await call(app, 'PUT', '/api/rig', inputRig());
      fake.meters = { 'Flex_In_Core-1': { [LEVEL3]: -10, [CLIP3]: 1 } };
      await connect(app, fake);
      await wait(150);
      assert.strictEqual(inputFinding(await monitor(app), 'input.clip').level, 'bad');
    }, FAST);
  });

  // --- S4: field readings --------------------------------------------------------
  const fieldFinding = (snap, key) => snap.findings.find((f) => f.trigger && f.trigger.key === key);

  await test('PUT /api/rig: field readings round-trip; bad reading → 400, nothing written', async () => {
    const rigPath = tmpRigPath();
    await withRig({}, async (app) => {
      const bad = aecRig();
      bad.field = { seatSpl: [66, 'loud'], noiseFloor: null, rt60: null };
      const b = await call(app, 'PUT', '/api/rig', bad);
      assert.strictEqual(b.code, 400);
      assert.ok(/seatSpl\[1\]/.test(b.body.error), b.body.error);
      assert.ok(!fs.existsSync(rigPath), 'rejected PUT never writes');
      const good = aecRig();
      good.field = { seatSpl: [66, 69], noiseFloor: 40, rt60: 0.5 };
      assert.strictEqual((await call(app, 'PUT', '/api/rig', good)).code, 200);
      assert.deepStrictEqual((await call(app, 'GET', '/api/rig')).body.field, good.field);
    }, { rigPath });
  });

  await test('monitor: seat SPL + SNR findings show without a Core (no meters needed)', async () => {
    await withRig({}, async (app) => {
      const r = defaultRig();
      r.field = { seatSpl: [62, 64], noiseFloor: 50, rt60: null };
      await call(app, 'PUT', '/api/rig', r);
      const s = await monitor(app);
      assert.strictEqual(s.state, 'disconnected');
      assert.strictEqual(fieldFinding(s, 'field.seatSpl').level, 'warn');
      assert.deepStrictEqual([fieldFinding(s, 'field.snr').level, fieldFinding(s, 'field.snr').trigger.value], ['bad', 12]);
    });
  });

  await test('monitor: RT60 vs the AEC tail_length read from the design; gone after disconnect', async () => {
    await withRig({}, async (app, fake) => {
      const r = aecRig();
      r.field.rt60 = 0.6;
      await call(app, 'PUT', '/api/rig', r);
      assert.strictEqual(fieldFinding(await monitor(app), 'field.rt60'), undefined, 'no tail known before connecting');
      fake.meters = { Room1_AEC: { [RMLR1]: 0, [ERLE1]: 10 } };
      await connect(app, fake);
      await wait(150);
      assert.ok(countOf(fake, 'Component.GetComponents') >= 1, 'poller read the component properties');
      const f = fieldFinding(await monitor(app), 'field.rt60');
      assert.strictEqual(f.level, 'warn');
      assert.ok(/0\.2 s/.test(f.text), f.text);
      assert.deepStrictEqual(f.adjust, [{ component: 'Room1_AEC', pin: 'tail_length', label: 'Tail Length (design property)' }]);
      await call(app, 'POST', '/api/disconnect');
      assert.strictEqual(fieldFinding(await monitor(app), 'field.rt60'), undefined, 'design props not trusted offline');
    }, FAST);
  });

  // --- Shutdown: closing the app server ends its QRC connection (ADR-03) ------------
  await test('app.close() disconnects the Core session and stops the poller — no socket left open', async () => {
    const fake = await startFakeQRC();
    const app = await startApp({ rigPath: tmpRigPath(), pollMs: 30 });
    try {
      await call(app, 'PUT', '/api/rig', aecRig());
      await connect(app, fake);
      await wait(100);
      assert.strictEqual(fake.socks.size, 1, 'connected');
      await new Promise((r) => app.close(r)); // no session.disconnect() first
      await wait(100);
      assert.strictEqual(fake.socks.size, 0, 'Core socket closed with the app');
      assert.strictEqual(app.session.state, 'disconnected');
      const polls = countOf(fake, 'ChangeGroup.Poll');
      await wait(100);
      assert.strictEqual(countOf(fake, 'ChangeGroup.Poll'), polls, 'poller stopped');
    } finally {
      for (const s of fake.socks) s.destroy();
      fake.srv.close();
    }
  });

  // --- S1: new shell (ADR-09) ------------------------------------------------
  await test('/ serves the Setup/Monitor shell; v1 simulator is gone', async () => {
    const app = await startApp();
    try {
      const r = await getRaw(app, '/');
      assert.strictEqual(r.code, 200);
      assert.ok(/text\/html/.test(r.type));
      assert.ok(/id="tab-setup"/.test(r.text) && /id="tab-monitor"/.test(r.text), 'has both tabs');
      assert.ok(!/gain-model\.js/.test(r.text), 'no simulator script');
      // S2: Monitor tab — RMLR + ERLE meters, ELR placeholder (ADR-07), findings.
      assert.ok(/id="mon-rmlr"/.test(r.text) && /id="mon-erle"/.test(r.text) && /id="mon-findings"/.test(r.text));
      assert.ok(/needs a named output component/.test(r.text), 'ELR card placeholder');
      // S3: input stage on Setup; input meter + talker/quiet mode switch on Monitor.
      assert.ok(/id="input-comp"/.test(r.text) && /id="input-ch"/.test(r.text), 'input stage picker');
      assert.ok(/id="mon-input"/.test(r.text) && /name="mon-mode"/.test(r.text), 'input meter + mode switch');
      // S4: field readings on Setup.
      assert.ok(/id="field-seats"/.test(r.text) && /id="field-noise"/.test(r.text) && /id="field-rt60"/.test(r.text), 'field inputs');
      assert.strictEqual((await getRaw(app, '/gain-model.js')).code, 404);
      assert.strictEqual((await getRaw(app, '/aec-erl-rmlr-emulator-v1.html')).code, 404, 'v1 reference not served');
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
