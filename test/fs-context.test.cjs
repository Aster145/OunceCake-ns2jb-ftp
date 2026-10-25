const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(memory, readGlobal) {
  const layout = { rootVptr: 0x543069f420, table: 0x54314fdba8, count: 1 };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../engine/fs-context.cjs'), 'utf8');
  const context = {
    module, Buffer, console: { log() {} },
    require(name) {
      if (name === 'node:fs/promises') return { readFile: async () => JSON.stringify(layout) };
      if (name === './fs-globals.cjs') return { readFsGlobalPointer: readGlobal };
      if (name.endsWith('fs-memory.cjs')) return { connect: async () => memory };
      if (name === './protocol.cjs') return require('../engine/protocol.cjs');
      return require(name);
    },
  };
  vm.runInNewContext(source + '\nmodule.exports.testing = {fsContext, programMapReader, findRegistryInterface};', context);
  return { ...module.exports.testing, layout };
}

test('program map global keeps the guarded RO reader', async () => {
  const manager = 0x5431400000;
  const reads = [];
  const globals = [];
  const memory = {
    read: async (address, length) => {
      reads.push(address);
      assert.equal(address, manager + 0x50);
      assert.equal(length, 16);
      const data = Buffer.alloc(16); data.writeBigUInt64LE(BigInt(address), 8); return data;
    },
  };
  const { programMapReader } = load(memory, async (_a, _layout, offset) => {
    globals.push(offset); return manager;
  });
  const attachment = { run: path.resolve('fixture-run'), live: { session: 'switch2-fixture' } };
  assert.equal((await (await programMapReader(attachment)).entries()).length, 0);
  assert.deepEqual(globals, [0x11e11d8]);
  assert.deepEqual(reads, [manager + 0x50]);
});

test('unsupported global mapping stops before following or modifying FS objects', async () => {
  let retainedCalls = 0;
  const { programMapReader } = load({ read: async () => { retainedCalls++; } },
    async () => { throw Error('FS program index map: unmapped address'); });
  await assert.rejects(programMapReader({ run: path.resolve('fixture-run'), live: { session: 'switch2-fixture' } }), /unmapped/);
  assert.equal(retainedCalls, 0);
});

test('registry lookup does not read the unused FS global at offset 0x11e1208', async () => {
  const object = 0x5430eec200;
  const reads = [];
  let layout;
  const memory = { read: async (address, length) => {
    reads.push(address);
    if (address === layout.table) {
      const row = Buffer.alloc(0x30);
      row.writeBigUInt64LE(BigInt(object), 0x20);
      row.writeBigUInt64LE(BigInt(layout.rootVptr + 0x5888), 0x28);
      return row;
    }
    assert.equal(address, object);
    assert.equal(length, 0x18);
    return Buffer.alloc(length);
  } };
  const loaded = load(memory, () => { throw Error('Unexpected global read'); });
  layout = loaded.layout;
  assert.equal((await loaded.findRegistryInterface({ memory, layout })).object, object);
  assert.deepEqual(reads, [layout.table, object]);
});

function registryLifecycle(options = {}) {
  const events = [];
  const layout = { rootVptr: 0x543069f420, table: 0x54314fdba8, count: 1 };
  const memory = {
    read: async () => { throw Error('Unexpected registry memory scan'); },
    pointer: async () => { throw Error('Unexpected registry global read'); },
  };
  const title = '0400a3a01ee4c000';
  const handle = 42;
  const owner = 0xf042424242424242n;
  const controls = { fah: Buffer.alloc(0x20, 1), fac: Buffer.alloc(0x40, 2) };
  const attachment = {
    run: path.resolve('fixture-run'), live: { session: 'switch2-fixture' },
    s: {
      base: 0x100000000,
      async write(address, bytes) {
        const expected = address === this.base + 0x8000 ? controls.fah : controls.fac;
        assert.deepEqual(bytes, expected);
      },
      async ipc(_label, actualHandle, command, input, ipcOptions) {
        assert.equal(actualHandle, handle);
        if (command === 0) {
          events.push('register');
          assert.equal(input.length, 40);
          assert.equal(input[0], 2);
          assert.equal(input.readBigUInt64LE(8), owner);
          assert.equal(input.readBigUInt64LE(16), BigInt('0x' + title));
          assert.equal(input.readBigUInt64LE(24), BigInt(controls.fah.length));
          assert.equal(input.readBigUInt64LE(32), BigInt(controls.fac.length));
          assert.equal(ipcOptions.send.length, 2);
          if (options.registerError) throw options.registerError;
          return { result: options.registerResult || 0 };
        }
        assert.equal(command, 1);
        assert.equal(input.length, 8);
        assert.equal(input.readBigUInt64LE(), owner);
        events.push('unregister');
        return { result: options.unregisterResult || 0 };
      },
    },
  };
  const fixture = {
    controls,
    async copy({ attachment: actual, reader }) {
      assert.equal(actual, attachment);
      assert.equal(reader.memory, memory);
      assert.equal(reader.layout.table, layout.table);
      return { handle, async close() { events.push('close'); } };
    },
    async mount({ attachment: actual, reader, owner: actualOwner }) {
      assert.equal(actual, attachment);
      assert.equal(reader.memory, memory);
      assert.equal(actualOwner, owner);
      events.push('mount');
      if (options.mountError) throw options.mountError;
      return 123;
    },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../engine/fs-context.cjs'), 'utf8');
  vm.runInNewContext(source + `
    accessControls = () => fixture.controls;
    copyProgramRegistry = fixture.copy;
    openCurrentProgramRomfs = fixture.mount;
  `, {
    module, Buffer, console, fixture,
    require(name) {
      if (name === 'node:fs/promises') return { readFile: async () => JSON.stringify(layout) };
      if (name === 'node:crypto') return { randomBytes: size => Buffer.alloc(size, 0x42) };
      if (name === './fs-globals.cjs') return {
        readFsGlobalPointer: async () => { throw Error('Unexpected FS image global read'); },
      };
      if (name.endsWith('fs-memory.cjs')) return { connect: async () => memory };
      if (name === './protocol.cjs') return require('../engine/protocol.cjs');
      return require(name);
    },
  });
  return {
    events,
    run: () => module.exports.openProgramRomfs({ attachment, title, storage: 2, policy: Buffer.alloc(0) }),
  };
}

test('owned program context mounts without a registry global and unregisters the same owner', async () => {
  const fixture = registryLifecycle();
  assert.equal(await fixture.run(), 123);
  assert.deepEqual(fixture.events, ['register', 'mount', 'unregister', 'close']);
});

test('failed RomFS mount still unregisters the acknowledged owned program context', async () => {
  const failure = Error('Composed RomFS mount failed');
  const fixture = registryLifecycle({ mountError: failure });
  await assert.rejects(fixture.run(), error => error === failure);
  assert.deepEqual(fixture.events, ['register', 'mount', 'unregister', 'close']);
});

test('rejected registration neither mounts nor unregisters a context', async () => {
  const fixture = registryLifecycle({ registerResult: 0x320002 });
  await assert.rejects(fixture.run(), /Register owned temporary program context.*PermissionDenied/);
  assert.deepEqual(fixture.events, ['register', 'close']);
});

test('uncertain registration timeout is not replayed or followed by unregister', async () => {
  const failure = Error('Console response timed out; restart the application');
  const fixture = registryLifecycle({ registerError: failure });
  await assert.rejects(fixture.run(), error => error === failure);
  assert.deepEqual(fixture.events, ['register', 'close']);
});

test('unregister failure closes the registry reference and does not report mount success', async () => {
  const fixture = registryLifecycle({ unregisterResult: 0x320002 });
  await assert.rejects(fixture.run(), /Remove owned temporary program context.*PermissionDenied/);
  assert.deepEqual(fixture.events, ['register', 'mount', 'unregister', 'close']);
});
