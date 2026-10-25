const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { getArgs, main } = require('../ouncecake.cjs');
const { bridgeReady, inspectRun, resolveRun } = require('../engine/run-directory.cjs');

async function fixture(t) {
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ouncecake-test-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  return host;
}

async function addRun(host, name, state = 'ready') {
  const run = path.join(host, 'runs', name);
  const engine = path.join(run, 'switch2');
  async function write(file, value) {
    const target = path.join(run, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
  await write('connection.json', { port: 43210, token: 'fixture-only', addresses: { platform: 2, session: name } });
  await write('switch2/rpc-ready.json', { session: name, state, pid: 123 });
  await write('switch2/current-acquisition.json', { session: name, socketPath: '\\\\.\\pipe\\ns2-fixture' });
  await write('switch2/ro/root/current-root.json', { session: name, rootHandle: 123 });
  for (const file of ['app/session.cjs', 'app/domain.cjs', 'app/filesystem.cjs', 'tools/fs-memory.cjs',
    'ro/' + name + '-layout.json', 'ro/' + name + '-loader-root-copy.json']) {
    await write('switch2/' + file, '// Fixture must never be required or executed.');
  }
  return { run, engine, write };
}

test('CLI retains explicit run/title/port and adds host discovery/check', () => {
  const explicit = getArgs(['C:\\host with spaces\\runs\\switch2-abc', '0100000000000001', '--port', '2221']);
  assert.equal(explicit.title, '0100000000000001');
  assert.equal(explicit.port, 2221);
  const discovered = getArgs(['--ns2jb', 'C:\\host with spaces', '--check']);
  assert.equal(discovered.check, true);
  assert.ok(discovered.ns2jb.endsWith('host with spaces'));
  assert.throws(() => getArgs(['--ns2jb']), /requires one host folder/);
  assert.throws(() => getArgs(['--ns2jb', 'host', 'a-run-directory']), /16 hexadecimal/);
  assert.throws(() => getArgs(['--ns2jb', 'host', '--port', '21']), /Invalid --port/);
});

test('named pipe is accepted without a filesystem existence check', async t => {
  const host = await fixture(t);
  const { run } = await addRun(host, 'switch2-pipe');
  let checks = 0;
  assert.equal(await inspectRun(run, { probe: async () => { checks++; } }), run);
  assert.equal(checks, 1);
});

test('discovery skips incomplete, closed and disconnected runs rather than picking the newest', async t => {
  const host = await fixture(t);
  const old = await addRun(host, 'switch2-active');
  await addRun(host, 'switch2-closed', 'closed');
  const disconnected = await addRun(host, 'switch2-disconnected');
  await disconnected.write('connection.json', { port: 43211, addresses: { platform: 2, session: 'switch2-disconnected' } });
  await fs.mkdir(path.join(host, 'runs', 'switch2-incomplete'));
  const run = await resolveRun({ ns2jb: host }, { probe: async ({ port }) => {
    if (port !== 43210) throw Error('Connection refused');
  } });
  assert.equal(run, old.run);
});

test('ambiguous live hosts require an explicit run and mismatched session is rejected', async t => {
  const host = await fixture(t);
  const a = await addRun(host, 'switch2-a');
  await addRun(host, 'switch2-b');
  const options = { probe: async () => true };
  await assert.rejects(resolveRun({ ns2jb: host }, options), /Multiple live runs/);
  await a.write('switch2/ro/root/current-root.json', { session: 'switch2-b', rootHandle: 123 });
  await assert.rejects(inspectRun(a.run, options), /FS state/);
});

test('explicit upstream RPC run without this adaptation marker remains supported', async t => {
  const host = await fixture(t);
  const { run, engine } = await addRun(host, 'switch2-upstream');
  await fs.unlink(path.join(engine, 'rpc-ready.json'));
  assert.equal(await resolveRun({ run }, { probe: async () => true }), run);
  await assert.rejects(resolveRun({ ns2jb: host }, { probe: async () => true }), /No live RPC/);
});

async function fakeBridge(t, ready = true) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let data = '';
    for await (const part of req) data += part;
    requests.push({ body: JSON.parse(data), auth: req.headers.authorization });
    res.end(JSON.stringify({ ready }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, requests };
}

test('connection check sends only authenticated local status; never imports runtime or mounts a game', async t => {
  const host = await fixture(t);
  const { run, write } = await addRun(host, 'switch2-check');
  const { port, requests } = await fakeBridge(t);
  await write('connection.json', { port, token: 'fixture-only', addresses: { platform: 2, session: 'switch2-check' } });
  await main([run, '--check']);
  assert.deepEqual(requests, [{ body: { command: 'status' }, auth: 'Bearer fixture-only' }]);
});

test('unready local bridge is not accepted as a live host', async t => {
  const { port } = await fakeBridge(t, false);
  await assert.rejects(bridgeReady({ port, token: 'fixture-only' }), /not ready/);
});
