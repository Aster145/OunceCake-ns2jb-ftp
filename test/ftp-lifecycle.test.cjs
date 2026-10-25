const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const filename = path.join(__dirname, '../engine/ftp.cjs');
const source = fs.readFileSync(filename, 'utf8');

function fixture(options = {}) {
  const events = [];
  const workers = [];
  let now = 0;
  const sdkBase = 0x100000000;
  const allocation = 0x200000000;
  const destination = 0x300000000;
  const worker = 0x20000a000;
  const thread = { create: 1255648, join: 1256736, tryWait: 1217808 };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, require: createRequire(filename),
    __dirname: path.dirname(filename), Buffer, Date: FakeDate,
    setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
  });
  // Replace only SDK symbol discovery; all startup, polling and teardown code runs unchanged.
  vm.runInContext(source + '\nmodule.exports.setResolver = fn => { resolveSdkFunctions = fn; };', context, { filename });
  module.exports.setResolver(async () => Object.fromEntries(
    ['socket', 'bind', 'listen', 'accept', 'recv', 'send', 'close', 'poll', 'sockname', 'fcntl', 'get_errno']
      .map((name, i) => [name, sdkBase + i * 4]),
  ));

  class Session {
    constructor(label, bytes) {
      this.bytes = bytes;
      this.base = 0;
      this.threads = new Set();
      this.handles = new Set([55]);
      this.rpc = {
        query: async () => { throw new Error('Unexpected memory query'); },
        call4: async (address) => {
          assert.equal(address, sdkBase + thread.create);
          events.push(['create']);
          if (options.createError) throw new Error('Create reply lost');
          return options.createResult || 0;
        },
        call3: async (address) => {
          if (address === sdkBase + thread.tryWait) {
            events.push(['tryWait']);
            return options.stopped === false ? 0 : 1;
          }
          assert.equal(address, sdkBase + thread.join);
          events.push(['join']);
          return options.joinResult || 0;
        },
      };
      workers.push(this);
    }
    async initialize() { this.base = allocation; events.push(['initialize']); }
    async verifyCode(expected, label) {
      events.push(['verify', label]);
      assert.equal(typeof expected.offset, 'number');
      assert.match(expected.bytes, /^[a-f0-9]+$/);
      if (options.verifyError) throw new Error('SDK instructions differ');
    }
    async read() { throw new Error('Unexpected memory read'); }
    async write(address) {
      if (address === this.base + 0x400c) events.push(['stop']);
    }
    async readOwned(address, length) {
      const bytes = Buffer.alloc(length);
      if (address === this.base + 0xa000) {
        if (options.workerReadError) throw new Error('Worker reference reply lost');
        bytes.writeBigUInt64LE(BigInt(worker));
      } else {
        assert.equal(address, this.base + 0x4000);
        bytes.writeUInt32LE(options.state ?? 1, 16);
        bytes.writeUInt32LE(options.startupResult || 0, 20);
      }
      return bytes;
    }
    async ipc(label, handle, command, input) {
      if (command === 0x524f0010) {
        events.push(['probe']);
        const data = Buffer.alloc(128);
        data.writeBigUInt64LE(10n);
        data.writeBigUInt64LE(BigInt(options.destination ?? destination), 88);
        return { result: options.probeResult || 0, data };
      }
      const kind = command === 0x524f0012 ? 'map' : 'unmap';
      assert.ok(command === 0x524f0012 || command === 0x524f0013);
      events.push([kind, Number(input.readBigUInt64LE(16))]);
      return { result: kind === 'unmap' ? options.unmapResult || 0 : 0, data: Buffer.alloc(0) };
    }
    async cleanup() {
      if (this.threads.size) { events.push(['deferred']); return; }
      this.handles.clear();
      events.push(['free']);
    }
  }
  const attachment = {
    Session, live: { sdk: sdkBase }, s: { threads: new Set() },
    service: async () => 99,
    close: async () => {
      events.push([attachment.s.threads.size ? 'attachment-deferred' : 'attachment-cleanup']);
    },
  };
  return {
    events, workers, attachment,
    start: () => module.exports.deployFtp({ attachment, image: Buffer.alloc(5000),
      index: Buffer.alloc(32), sources: [{ handle: 15, kind: 0, size: 128 }], port: 2121 }),
  };
}

function has(f, name) { return f.events.some(event => event[0] === name); }
function retained(f) {
  assert.ok(f.attachment.s.threads.has('standalone-ftp'));
  assert.ok(f.workers[0].threads.size);
  assert.ok(f.workers[0].handles.has(55));
  assert.equal(has(f, 'unmap'), false);
  assert.equal(has(f, 'free'), false);
}

test('ready FTP verifies helpers and stops, joins, unmaps in reverse order, then frees', async () => {
  const f = fixture();
  const server = await f.start();
  assert.equal(has(f, 'free'), false);
  assert.deepEqual(f.events.filter(event => event[0] === 'verify').map(event => event[1]),
    ['FTP create', 'FTP join', 'FTP tryWait', 'FTP send', 'FTP close']);
  await server.close();
  assert.deepEqual(f.events.filter(event => ['stop', 'tryWait', 'join', 'unmap', 'free'].includes(event[0])),
    [['stop'], ['tryWait'], ['join'], ['unmap', 0x300001000], ['unmap', 0x300000000], ['free']]);
  assert.equal(f.attachment.s.threads.size, 0);
  assert.equal(f.workers[0].threads.size, 0);
});

test('startup deadline rejects instead of returning FTP ready and still stops its thread', async () => {
  const f = fixture({ state: 0 });
  await assert.rejects(f.start(), /startup timed out/);
  assert.ok(has(f, 'join'));
  assert.ok(has(f, 'free'));
});

test('native startup failure is reported and its stopped thread is cleaned up', async () => {
  const f = fixture({ state: 3, startupResult: 0x123 });
  await assert.rejects(f.start(), /Native FTP startup failed: 0x123/);
  assert.ok(has(f, 'free'));
});

test('stop timeout preserves both sessions and never joins or releases mappings', async () => {
  const f = fixture({ stopped: false });
  const server = await f.start();
  await assert.rejects(server.close(), /thread did not stop/);
  await f.attachment.close();
  retained(f);
  assert.equal(has(f, 'join'), false);
  assert.ok(has(f, 'attachment-deferred'));
});

test('failed join preserves thread markers, handles, mappings and allocation', async () => {
  const f = fixture({ joinResult: 8 });
  const server = await f.start();
  await assert.rejects(server.close(), /Could not join FTP thread: 8/);
  await f.attachment.close();
  retained(f);
  assert.ok(has(f, 'attachment-deferred'));
});

for (const failure of ['createError', 'workerReadError']) {
  test(failure + ' keeps resources when thread startup outcome cannot be confirmed', async () => {
    const f = fixture({ [failure]: true });
    await assert.rejects(f.start(), /startup outcome is unknown/);
    retained(f);
    assert.equal(has(f, 'join'), false);
  });
}

test('known thread creation failure safely unmaps and releases the unused allocation', async () => {
  const f = fixture({ createResult: 9 });
  await assert.rejects(f.start(), /Could not start FTP thread: 9/);
  assert.ok(has(f, 'free'));
  assert.equal(f.attachment.s.threads.size, 0);
});

test('RO process failure is rejected before code mapping or thread startup', async () => {
  const f = fixture({ probeResult: 0x123 });
  await assert.rejects(f.start(), /FTP verify application process: result 0x123/);
  assert.equal(has(f, 'map'), false);
  assert.equal(has(f, 'create'), false);
  assert.ok(has(f, 'free'));
});

for (const destination of [0, 0x300000001, 2 ** 39]) {
  test('invalid mapping destination ' + destination + ' is rejected before mapping', async () => {
    const f = fixture({ destination });
    await assert.rejects(f.start(), /invalid FTP process or code mapping address/);
    assert.equal(has(f, 'map'), false);
    assert.equal(has(f, 'create'), false);
  });
}

test('SDK instruction mismatch aborts before the RO request or native thread', async () => {
  const f = fixture({ verifyError: true });
  await assert.rejects(f.start(), /SDK instructions differ/);
  assert.equal(has(f, 'probe'), false);
  assert.equal(has(f, 'create'), false);
  assert.ok(has(f, 'free'));
});

test('failed unmap does not free the allocation backing the remaining code alias', async () => {
  const f = fixture({ unmapResult: 8 });
  const server = await f.start();
  await assert.rejects(server.close(), /FTP owned code mapping: result 0x8/);
  assert.ok(has(f, 'join'));
  assert.equal(has(f, 'free'), false);
});
