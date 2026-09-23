'use strict';
// Unit tests for qrc.js against a fake TCP server that speaks the same
// framing (T2 acceptance — no live Core required). Run: node test-qrc.js

const assert = require('assert');
const net = require('net');
const { QRC, QRCError } = require('./qrc');

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

function startFakeServer(onReq) {
  const fake = {};
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      fake.sock = sock; // test hook: lets tests simulate a remote close
      // Unsolicited broadcast immediately on connect (EngineStatus analogue).
      sock.write(JSON.stringify({ jsonrpc: '2.0', method: 'EngineStatus', params: { status: 'running' } }) + '\x00');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        for (;;) {
          const idx = buf.indexOf('\x00');
          if (idx < 0) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const msg = JSON.parse(frame);
          onReq(msg, sock);
        }
      });
    });
    fake.srv = srv;
    srv.listen(0, '127.0.0.1', () => { fake.port = srv.address().port; resolve(fake); });
  });
}

function reply(sock, msg, result) {
  sock.write(JSON.stringify({ jsonrpc: '2.0', result, id: msg.id }) + '\x00');
}

async function withServer(opts, fn) {
  const fake = await startFakeServer(opts.onReq);
  const qrc = new QRC({ host: '127.0.0.1', port: fake.port, timeoutMs: 800, ...opts.qrc });
  try {
    await qrc.connect();
    await fn(qrc, fake);
  } finally {
    qrc.close();
    fake.srv.close();
  }
}

(async () => {
  await test('connect + NoOp; unsolicited broadcast discarded (id match)', async () => {
    await withServer(
      { qrc: { user: '' }, onReq: (m, s) => reply(s, m, null) },
      async (qrc) => {
        assert.strictEqual(qrc.connected, true);
        const r = await qrc.noop();
        assert.strictEqual(r, null);
      }
    );
  });

  await test('Logon sent before connect() resolves when user configured', async () => {
    let sawLogon = false;
    await withServer(
      {
        qrc: { user: 'admin', password: 'pw' },
        onReq: (m, s) => {
          if (m.method === 'Logon') {
            sawLogon = true;
            assert.deepStrictEqual(m.params, { User: 'admin', Password: 'pw' });
            reply(s, m, 'OK');
          } else reply(s, m, null);
        },
      },
      async () => {
        assert.strictEqual(sawLogon, true, 'Logon must be sent during connect()');
      }
    );
    assert.strictEqual(sawLogon, true);
  });

  await test('response matching when extra broadcasts interleave', async () => {
    await withServer(
      {
        onReq: (m, s) => {
          s.write(JSON.stringify({ jsonrpc: '2.0', method: 'EngineStatus', params: {} }) + '\x00');
          reply(s, m, { echoed: m.method });
        },
      },
      async (qrc) => {
        const r = await qrc.sendCommand('NoOp');
        assert.strictEqual(r.echoed, 'NoOp');
      }
    );
  });

  await test('fragmented response reassembled from persistent buffer', async () => {
    await withServer(
      {
        onReq: (m, s) => {
          const body = JSON.stringify({ jsonrpc: '2.0', result: 'long-result', id: m.id });
          s.write(body.slice(0, 8)); // partial frame
          setTimeout(() => s.write(body.slice(8) + '\x00'), 30);
        },
      },
      async (qrc) => {
        const r = await qrc.sendCommand('NoOp');
        assert.strictEqual(r, 'long-result');
      }
    );
  });

  await test('Component.Set: no reply — resolves without waiting', async () => {
    let setSeen = false;
    await withServer(
      { onReq: (m) => { if (m.method === 'Component.Set') setSeen = true; } }, // never replies
      async (qrc) => {
        const t0 = Date.now();
        const r = await qrc.set('AEC_1', [{ Name: 'rg', Value: -7 }]);
        assert.strictEqual(r, null);
        assert.ok(Date.now() - t0 < 200, 'should not wait for a reply');
        await new Promise((res) => setTimeout(res, 50)); // let the server side parse
        assert.ok(setSeen);
      }
    );
  });

  await test('Component.GetControls param shape {"Name": ...}', async () => {
    await withServer(
      {
        onReq: (m, s) => {
          if (m.method === 'Component.GetControls') {
            assert.deepStrictEqual(m.params, { Name: 'AEC_1' });
            reply(s, m, [{ Name: 'rg', Type: 'Gain' }]);
          } else reply(s, m, null);
        },
      },
      async (qrc) => {
        const r = await qrc.getControls('AEC_1');
        assert.strictEqual(r[0].Name, 'rg');
      }
    );
  });

  await test('JSON-RPC error surface → QRCError with code + message', async () => {
    await withServer(
      {
        onReq: (m, s) => s.write(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'component does not exist' }, id: m.id }) + '\x00'),
      },
      async (qrc) => {
        let err = null;
        try { await qrc.get('Nope'); } catch (e) { err = e; }
        assert(err instanceof QRCError);
        assert(err.message.includes('-32602'));
        assert(err.message.includes('component does not exist'));
      }
    );
  });

  await test('no reply within timeout → QRCError "Timed out"', async () => {
    await withServer(
      { onReq: () => {} }, // silent server
      async (qrc) => {
        let err = null;
        try { await qrc.noop(); } catch (e) { err = e; }
        assert(err instanceof QRCError);
        assert(err.message.includes('Timed out'));
      }
    );
  });

  await test('remote close rejects pending + further sends fail cleanly', async () => {
    await withServer({ onReq: () => {} }, async (qrc, fake) => {
      const p = qrc.noop();
      const guard = p.catch((e) => {
        assert(e instanceof QRCError);
      });
      setTimeout(() => fake.sock.end(), 50); // remote closes the socket
      await guard;
      let err = null;
      try { await qrc.noop(); } catch (e) { err = e; }
      assert(err instanceof QRCError);
      assert(err.message === 'Not connected');
    });
  });

  await test('connect() to a closed port rejects (does not hang)', async () => {
    // Grab a free port, then close it so nothing is listening.
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    const qrc = new QRC({ host: '127.0.0.1', port, timeoutMs: 800 });
    const t0 = Date.now();
    let err = null;
    try { await qrc.connect(); } catch (e) { err = e; }
    assert(err instanceof QRCError, 'expected QRCError');
    assert.ok(Date.now() - t0 < 700, 'should reject promptly');
    assert.strictEqual(qrc.connected, false);
  });

  await test('connect() times out when the host never answers', async () => {
    // 10.255.255.1 is a non-routable address → SYN goes nowhere.
    const qrc = new QRC({ host: '10.255.255.1', port: 1710, timeoutMs: 300 });
    const t0 = Date.now();
    let err = null;
    try { await qrc.connect(); } catch (e) { err = e; }
    assert(err instanceof QRCError, 'expected QRCError');
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.strictEqual(qrc.connected, false);
  });

  await test('failed Logon rejects connect() and leaves the socket closed', async () => {
    const fake = await startFakeServer((m, s) =>
      s.write(JSON.stringify({ jsonrpc: '2.0', error: { code: 10, message: 'Logon required' }, id: m.id }) + '\x00'));
    const qrc = new QRC({ host: '127.0.0.1', port: fake.port, user: 'x', password: 'bad', timeoutMs: 800 });
    let err = null;
    try { await qrc.connect(); } catch (e) { err = e; }
    fake.srv.close();
    assert(err instanceof QRCError);
    assert.strictEqual(qrc.connected, false);
  });

  await test('onClose callback fires on remote drop (not on local close)', async () => {
    let drops = 0;
    await withServer({ onReq: () => {} }, async (qrc, fake) => {
      qrc.onClose = () => drops++;
      fake.sock.end();
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(drops, 1);
    });
    assert.strictEqual(drops, 1, 'local close() must not fire onClose');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
