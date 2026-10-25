const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const title = '0400a3a01ee4c000';

function fixture({ menu = false, closeError } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  const events = [];
  const messages = [];
  const interfaces = [];
  let signalReady;
  let signalMenu;
  const ready = new Promise(resolve => { signalReady = resolve; });
  const menuReady = new Promise(resolve => { signalMenu = resolve; });
  proc.stdout.on('data', bytes => {
    if (bytes.toString().includes('Choose a game:')) signalMenu();
  });
  const filename = path.join(__dirname, '..', 'ouncecake.cjs');
  const localRequire = createRequire(filename);
  const dependencies = {
    'node:readline': {
      createInterface(options) {
        const rl = readline.createInterface(options);
        interfaces.push(rl);
        return rl;
      },
    },
    './engine/run-directory.cjs': { resolveRun: async () => 'fixture-run' },
    './engine/session.cjs': {
      attachGame: async () => ({ close: async () => { events.push('attachment-close'); } }),
    },
    './engine/content.cjs': {
      discoverGames: async () => [{ title, name: 'Fixture game', storages: [2] }],
    },
    './engine/mounts.cjs': {
      prepareGame: async options => {
        assert.equal(options.title, title);
        assert.equal(proc.stdin.listenerCount('data'), 0, 'no stop reader during game preparation');
        assert.equal(interfaces.length, menu ? 1 : 0);
        return {};
      },
    },
    './engine/ftp.cjs': {
      readImage: async () => Buffer.alloc(0),
      deployFtp: async () => {
        assert.equal(proc.stdin.listenerCount('data'), 0, 'no stop reader before FTP startup completes');
        return { close: async () => {
          events.push('server-close');
          if (closeError) throw closeError;
        } };
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: proc, Buffer, AbortController, setInterval, clearInterval,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
    console: { log(message) {
      messages.push(message);
      if (message.startsWith('Type q')) signalReady();
      if (message.startsWith('Stopped.')) events.push('stopped');
    } },
  }, { filename });
  return {
    proc, events, messages, interfaces, ready, menuReady,
    run: () => module.exports.main(menu ? ['fixture-run'] : ['fixture-run', title]),
  };
}

function assertDetached(h) {
  assert.equal(h.proc.listenerCount('SIGINT'), 0);
  assert.equal(h.proc.listenerCount('SIGTERM'), 0);
  assert.equal(h.proc.stdin.listenerCount('data'), 0);
  assert.equal(h.proc.stdin.listenerCount('end'), 0);
  for (const rl of h.interfaces) {
    assert.equal(rl.closed, true);
    assert.equal(rl.listenerCount('line'), 0);
  }
}

for (const command of ['q', ' QUIT ']) {
  test(command.trim() + ' after FTP startup closes resources before reporting Stopped', async () => {
    const h = fixture();
    const running = h.run();
    await h.ready;
    assert.equal(h.interfaces.length, 1);
    h.proc.stdin.write('not-a-stop-command\n');
    assert.deepEqual(h.events, []);
    h.proc.stdin.write(command + '\n');
    await running;
    assert.deepEqual(h.events, ['server-close', 'attachment-close', 'stopped']);
    assert.match(h.messages.find(message => message.startsWith('Type q')), /Wait for "Stopped" before closing NS2JB-RPC/);
    assertDetached(h);
  });
}

test('game selection owns stdin until it completes, then q controls FTP shutdown', async () => {
  const h = fixture({ menu: true });
  const running = h.run();
  await h.menuReady;
  assert.equal(h.interfaces.length, 1);
  h.proc.stdin.write('1\n');
  await h.ready;
  assert.equal(h.interfaces.length, 2);
  assert.equal(h.interfaces[0].closed, true);
  h.proc.stdin.write('q\n');
  await running;
  assert.deepEqual(h.events, ['server-close', 'attachment-close', 'stopped']);
  assertDetached(h);
});

for (const stopEvent of ['process SIGINT', 'readline SIGINT']) {
  test(stopEvent + ' retains normal FTP cleanup and removes the stop reader', async () => {
    const h = fixture();
    const running = h.run();
    await h.ready;
    if (stopEvent === 'process SIGINT') h.proc.emit('SIGINT');
    else h.interfaces[0].emit('SIGINT');
    await running;
    assert.deepEqual(h.events, ['server-close', 'attachment-close', 'stopped']);
    assertDetached(h);
  });
}

test('failed FTP cleanup never reports Stopped but still detaches input and signals', async () => {
  const failure = Error('FTP thread did not stop');
  const h = fixture({ closeError: failure });
  const running = h.run();
  await h.ready;
  h.proc.stdin.write('q\n');
  await assert.rejects(running, error => error === failure);
  assert.deepEqual(h.events, ['server-close', 'attachment-close']);
  assert.equal(h.messages.some(message => message.startsWith('Stopped.')), false);
  assertDetached(h);
});

test('stdin EOF keeps the FTP owner alive until a later stop signal', { timeout: 10000 }, async () => {
  const filename = path.join(__dirname, '..', 'ouncecake.cjs');
  const source = `
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = process.argv[1];
    const localRequire = createRequire(filename);
    const dependencies = {
      './engine/run-directory.cjs': { resolveRun: async () => 'fixture-run' },
      './engine/session.cjs': { attachGame: async () => ({ close: async () => console.log('attachment-close') }) },
      './engine/mounts.cjs': { prepareGame: async () => ({}) },
      './engine/ftp.cjs': {
        readImage: async () => Buffer.alloc(0),
        deployFtp: async () => ({ close: async () => console.log('server-close') }),
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, process, console, Buffer, AbortController, setInterval, clearInterval,
      require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
    });
    process.stdin.once('end', () => {
      console.log('input-ended');
      // This cannot keep the child alive on its own: only the CLI owns that duty.
      setTimeout(() => process.emit('SIGTERM'), 100).unref();
    });
    module.exports.main(['fixture-run', '${title}']).catch(error => {
      console.error(error.stack); process.exitCode = 1;
    });
  `;
  const child = spawn(process.execPath, ['-e', source, filename], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end();
  const result = await exited;
  assert.equal(result.code, 0, errors);
  assert.equal(result.signal, null);
  assert.match(output, /input-ended/);
  assert.match(output, /input-ended[\s\S]*server-close[\s\S]*attachment-close[\s\S]*Stopped\./);
});
