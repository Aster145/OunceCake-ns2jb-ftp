const test = require('node:test');
const assert = require('node:assert/strict');
const { readFsGlobalPointer } = require('../engine/fs-globals.cjs');

const layout = { rootVptr: 0x543069f420 };
const offset = 0x11e12d0;
const address = 0x54315cf2d0;
const manager = 0x5431400000;
const identity = { result: 0, pid: '8', programId: '0400000000000000' };
const mapping = (at, size = 0x1000) => ({ ...identity, queryResult: 0,
  memory: { address: String(at), size: String(size), type: 4, attributes: 0, permissions: 3 } });
const bytes = Buffer.alloc(8);
bytes.writeBigUInt64LE(BigInt(manager));
const readReply = { result: 0, mapResult: 0, unmapResult: 0, length: 8, hex: bytes.toString('hex') };

function fixture(options = {}) {
  const calls = [];
  let instance;
  class Client {
    constructor() {
      instance = this;
      this.memory = { read() { throw new Error('Dangerous retained read must not be called'); } };
    }
    async open() {
      calls.push(['open']);
      if (options.openEarlyError) throw options.openEarlyError;
      this.record = {};
      if (options.openLateError) throw options.openLateError;
      return this;
    }
    async fsProcess() { calls.push(['fsProcess']); return 42; }
    async info(handle, at, pid) {
      calls.push(['info', handle, at, pid]);
      if (at === undefined) return options.identity || identity;
      return BigInt(at) === BigInt(address)
        ? options.globalMapping || mapping(address - 0x2d0)
        : options.managerMapping || mapping(manager);
    }
    async read(...args) {
      calls.push(['read', ...args]);
      if (options.readError) {
        this.pending = !!options.pending;
        throw options.readError;
      }
      return options.readReply || readReply;
    }
    async close() {
      calls.push(['close', !!this.pending]);
      if (options.closeError) throw options.closeError;
      if (this.pending) this.record.pending = true;
      else this.record.closed = true;
    }
  }
  return { calls, get client() { return instance; },
    run: () => readFsGlobalPointer({ run: 'unused-with-injected-client' }, layout, offset,
      'Program registry manager', { Client }) };
}

test('FS global is queried and read through RO, then its manager mapping is checked', async () => {
  const f = fixture();
  assert.equal(await f.run(), manager);
  assert.deepEqual(f.calls, [
    ['open'], ['fsProcess'], ['info', 42, undefined, undefined],
    ['info', 42, address, '8'], ['read', 42, '8', address, 8],
    ['info', 42, BigInt(manager), '8'], ['close', false],
  ]);
  assert.equal(f.client.record.closed, true);
});

test('a non-FS process is rejected before querying or reading the global', async () => {
  const f = fixture({ identity: { ...identity, programId: '0100c9100b06a000' } });
  await assert.rejects(f.run(), /not native FS/);
  assert.equal(f.calls.filter(c => c[0] === 'info').length, 1);
  assert.ok(!f.calls.some(c => c[0] === 'read'));
  assert.deepEqual(f.calls.at(-1), ['close', false]);
});

for (const [name, value] of [
  ['query error', { ...identity, result: 0xd401 }],
  ['unmapped', { ...mapping(address), memory: { ...mapping(address).memory, type: 0 } }],
  ['unreadable', { ...mapping(address), memory: { ...mapping(address).memory, permissions: 4 } }],
  ['short mapping', mapping(address, 4)],
  ['identity mismatch', { ...mapping(address), pid: '9' }],
]) {
  test(`global ${name} stops before the dangerous read`, async () => {
    const f = fixture({ globalMapping: value });
    await assert.rejects(f.run(), error => error.code === 'FS_GLOBAL_READ_UNAVAILABLE' &&
      error.message.includes('Program registry manager at 0x54315cf2d0') &&
      error.message.includes('FS version'));
    assert.ok(!f.calls.some(c => c[0] === 'read'));
    assert.deepEqual(f.calls.at(-1), ['close', false]);
  });
}

for (const [name, value] of [
  ['native error', { ...readReply, result: 0xd401 }],
  ['mapping error', { ...readReply, mapResult: 0xd401 }],
  ['unmap error', { ...readReply, unmapResult: 0xd401 }],
  ['short read', { ...readReply, length: 7 }],
  ['short hex', { ...readReply, hex: '00' }],
  ['bad hex', { ...readReply, hex: 'xxxxxxxxxxxxxxxx' }],
  ['null pointer', { ...readReply, hex: '0000000000000000' }],
  ['tagged pointer', { ...readReply, hex: '00000000405400ff' }],
]) {
  test(`RO ${name} is not retried or routed to retained memory`, async () => {
    const f = fixture({ readReply: value });
    await assert.rejects(f.run(), /no retained-read fallback/);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'info').length, 2);
    assert.deepEqual(f.calls.at(-1), ['close', false]);
  });
}

test('manager must have at least 0x60 readable bytes', async () => {
  const f = fixture({ managerMapping: mapping(manager, 0x58) });
  await assert.rejects(f.run(), /crosses its readable mapping/);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 1);
  assert.deepEqual(f.calls.at(-1), ['close', false]);
});

test('pending worker is preserved by the client close path', async () => {
  const f = fixture({ readError: new Error('Native worker is pending'), pending: true });
  await assert.rejects(f.run(), /Native worker is pending/);
  assert.deepEqual(f.calls.at(-1), ['close', true]);
  assert.equal(f.client.record.pending, true);
  assert.equal(f.client.record.closed, undefined);
});

test('open failure before the client record exists does not call unsafe close', async () => {
  const f = fixture({ openEarlyError: new Error('Endpoint unavailable') });
  await assert.rejects(f.run(), /Endpoint unavailable/);
  assert.deepEqual(f.calls, [['open']]);
});

test('partial open with a client record closes its owned state', async () => {
  const f = fixture({ openLateError: new Error('Service lookup failed') });
  await assert.rejects(f.run(), /Service lookup failed/);
  assert.deepEqual(f.calls, [['open'], ['close', false]]);
});

test('cleanup error does not hide the original RO failure', async () => {
  const f = fixture({ readError: new Error('Original read failure'), closeError: new Error('Close failure') });
  await assert.rejects(f.run(), error => error.message.includes('Original read failure') &&
    error.cleanupError.message === 'Close failure');
});
