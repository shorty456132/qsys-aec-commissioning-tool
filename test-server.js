'use strict';
// T4 — /api/connect, /api/disconnect, /api/status against a fake QRC server.
// No live Core required. Run: node test-server.js

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createApp } = require('./server');

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
  { ID: 'Room1_AEC', Name: 'Room1_AEC', Type: 'acoustic_echo_canceler_simd', Properties: [{ Name: 'channel_count', Value: '2' }], Controls: null, ControlSource: 2 },
];
const FAKE_CONTROLS = {
  Room1_AEC: [
    { Name: 'rmlr', Type: 'Float', Value: -2, ValueMin: -20, ValueMax: 20, String: '-2dB', Direction: 'Read Only' },
    { Name: 'gain', Type: 'Float', Value: 0, ValueMin: -100, ValueMax: 20, String: '0dB', Direction: 'Read/Write' },
  ],
};

// Fake QRC: EngineStatus broadcast on connect, replies to every request
// unless `silent`. Tracks live sockets so tests can count / drop them.
function fakeReply(msg) {
  if (msg.method === 'Component.GetComponents') return { result: FAKE_COMPONENTS };
  if (msg.method === 'Component.GetControls') {
    const c = FAKE_CONTROLS[msg.params && msg.params.Name];
    if (!c) return { error: { code: 8, message: 'Unknown component name' } };
    return { result: { Name: msg.params.Name, Controls: c } };
  }
  return { result: true };
}

function startFakeQRC({ silent = false } = {}) {
  const fake = { socks: new Set(), methods: [] };
  return new Promise((resolve) => {
    fake.srv = net.createServer((sock) => {
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
          if (msg.id !== undefined && !fake.mute) sock.write(JSON.stringify({ jsonrpc: '2.0', ...fakeReply(msg), id: msg.id }) + '\x00');
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
    const { parseConnectBody } = require('./session');
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
      assert.deepStrictEqual(r.body.components.map((c) => [c.name, c.aecCandidate]), [['Room1_AEC', true], ['MyGain', false]]);
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
  const { defaultRig } = require('./roles');
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
      assert.deepStrictEqual(all.body.components.map((c) => c.name).sort(), ['MyGain', 'Room1_AEC']);
    });
  });

  await test('GET /api/roles/<unknown>/candidates → 404', async () => {
    await withRig({}, async (app) => {
      assert.strictEqual((await call(app, 'GET', '/api/roles/subwoofer/candidates')).code, 404);
    });
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
