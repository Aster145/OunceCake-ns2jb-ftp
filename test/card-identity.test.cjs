const test = require('node:test');
const assert = require('node:assert/strict');
const { readCardIdentity } = require('../engine/card-identity.cjs');
const { discoverApplications } = require('../engine/content.cjs');

const title = '0100965017338000';
const otherTitle = '0100000000001000';
const contentId = '12a4f22ba0c98538e4f163df86186e39';
const actualPath = '@GcS00000000://' + contentId + '.nca';

function fixture(records = [{ title, contentId, path: actualPath, version: 0 }], options = {}) {
  const state = { records, inactive: false, readHook: options.readHook };
  const calls = [];
  const handles = new Map();
  const live = new Set();
  let nextHandle = 100;
  let readBytes;
  const reply = data => ({ result: 0, data: data || Buffer.alloc(24) });
  const opened = details => {
    const handle = nextHandle++;
    handles.set(handle, details);
    live.add(handle);
    return { ...reply(), handle };
  };
  const keyOf = record => {
    const key = Buffer.alloc(16);
    key.writeBigUInt64LE(BigInt('0x' + record.title));
    key.writeUInt32LE(record.version || 0, 8);
    key[12] = 0x80;
    return key;
  };
  const attachment = {
    s: {
      base: 0x100000000,
      handles: live,
      close: async handle => {
        assert.ok(live.delete(handle), 'close an owned handle once');
        handles.delete(handle);
      },
      readOwned: async (_address, size) => {
        state.readHook?.();
        const result = Buffer.alloc(size);
        readBytes.copy(result);
        return result;
      },
      ipc: async (label, handle, command, input) => {
        calls.push({ label, handle, command, input });
        if (handle === 1 && (command === 5 || command === 4)) {
          if (state.inactive && input[0] === 2) return { result: 0x20a05 };
          return opened({ kind: command === 5 ? 'database' : 'storage', storage: input[0] });
        }
        const object = handles.get(handle);
        assert.equal(object?.kind, 'database', 'only NCM read operations are permitted');
        if (command === 5) {
          assert.equal(input[0], 0x80);
          const min = input.readBigUInt64LE(16);
          const max = input.readBigUInt64LE(24);
          const found = state.records.filter(record =>
            (record.storage ?? 2) === object.storage &&
            BigInt('0x' + record.title) >= min && BigInt('0x' + record.title) <= max);
          readBytes = Buffer.concat(found.slice(0, 32).map(keyOf));
          const data = Buffer.alloc(8);
          data.writeInt32LE(found.length);
          data.writeInt32LE(Math.min(found.length, 32), 4);
          return reply(data);
        }
        const requestedTitle = input.subarray(command === 6 ? 0 : 8, command === 6 ? 8 : 16)
          .readBigUInt64LE().toString(16).padStart(16, '0');
        const record = state.records.find(item => item.title === requestedTitle &&
          (item.storage ?? 2) === object.storage);
        if (!record) return { result: 0xe05 };
        if (command === 6) return reply(keyOf(record));
        assert.equal(input[0], 1, 'only resolve Program content');
        if (record.error) return { result: record.error };
        if (command === 3) return reply(Buffer.from(record.contentId, 'hex'));
        if (command === 24) return reply();
        assert.fail('Unexpected IPC: ' + label + ' command=' + command);
      },
    },
    service: async name => {
      assert.equal(name, 'ncm', 'no license or filesystem services');
      return 1;
    },
    domain: {
      oneHandle: response => response.handle,
      send: async (_s, label, handle, packet) => {
        assert.equal(handles.get(handle)?.kind, 'storage');
        assert.equal(packet.readUInt32LE(24), 8, 'only NCM GetPath');
        const id = packet.subarray(32, 48).toString('hex');
        const record = state.records.find(item => item.contentId === id);
        assert.ok(record, 'the path belongs to the selected content');
        readBytes = Buffer.from(record.path + '\0');
        calls.push({ label, handle, command: 8 });
        return reply();
      },
    },
  };
  return { state, attachment, calls, live };
}

test('actual Switch 2 path yields valid zero handle and reads only card storage', async () => {
  const f = fixture();
  assert.deepEqual(await readCardIdentity({ attachment: f.attachment }), {
    handle: 0, route: 'ncm-gamecard-path', applicationTitle: title,
    contentId, contentPath: actualPath, version: 0,
  });
  assert.deepEqual(f.calls.filter(call => call.handle === 1).map(call => call.input[0]), [2, 2, 2]);
  assert.equal(f.live.size, 0, 'metadata handles are closed before returning');
});

test('multi-application card skips absent Program entries and never queries Internal or SD', async () => {
  const f = fixture([
    { title: otherTitle, error: 0x1b805, version: 3 },
    { title, contentId, path: '@GcN1234aBcD:/' + contentId + '.nca', version: 2 },
    { title: '0100000000002000', storage: 4, contentId: 'ff'.repeat(16), path: '@UserContent:/internal.nca' },
  ]);
  const result = await readCardIdentity({ attachment: f.attachment });
  assert.equal(result.applicationTitle, title);
  assert.equal(result.handle, 0x1234abcd);
  assert.ok(f.calls.filter(call => call.handle === 1).every(call => call.input[0] === 2));
  assert.equal(f.live.size, 0);
});

test('non-card and malformed mount paths fail without trying another application', async () => {
  for (const path of ['@UserContent:/test.nca', '@SdCardContent:/test.nca', '@GcApp:/test.nca',
    '@GcS1234567:/test.nca', '@GcS123456789:/test.nca', '@GcS00000000:/',
    '@GcS00000000:/test.nca\n']) {
    const f = fixture([
      { title: otherTitle, contentId, path, version: 2 },
      { title, contentId: 'ff'.repeat(16), path: actualPath, version: 1 },
    ]);
    await assert.rejects(readCardIdentity({ attachment: f.attachment }), { code: 'CARD_PATH_UNSUPPORTED' });
    assert.equal(f.calls.filter(call => call.command === 6).length, 1);
    assert.equal(f.live.size, 0);
  }
});

test('unindexed card gives CARD_NOT_INDEXED without claiming it is physically absent', async () => {
  for (const mode of ['empty', 'inactive', 'missing-program']) {
    const f = fixture(mode === 'missing-program' ? [{ title, error: 0x1b805 }] : []);
    f.state.inactive = mode === 'inactive';
    await assert.rejects(readCardIdentity({ attachment: f.attachment }), error => {
      assert.equal(error.code, 'CARD_NOT_INDEXED');
      assert.match(error.message, /does not prove that no card is inserted/);
      return true;
    });
    assert.equal(f.live.size, 0);
  }
});

test('recheck stays pinned to the original application without rediscovery', async () => {
  const f = fixture();
  const previous = await readCardIdentity({ attachment: f.attachment });
  f.state.records.unshift({ title: otherTitle, contentId: 'aa'.repeat(16), path: '@GcS00000001:/new.nca', version: 9 });
  f.calls.length = 0;
  assert.deepEqual(await readCardIdentity({ attachment: f.attachment, previous }), previous);
  assert.equal(f.calls.filter(call => call.command === 5 && call.handle !== 1).length, 0);
  assert.equal(f.calls.filter(call => call.command === 6).length, 1);
});

test('card removal, handle, exact path, content ID and version changes reject the recheck', async () => {
  for (const change of ['removed', 'inactive', 'handle', 'path', 'contentId', 'version', 'non-card']) {
    const f = fixture();
    const previous = await readCardIdentity({ attachment: f.attachment });
    const record = f.state.records[0];
    if (change === 'removed') f.state.records = [];
    if (change === 'inactive') f.state.inactive = true;
    if (change === 'handle') record.path = actualPath.replace('00000000', '00000001');
    if (change === 'path') record.path = actualPath.replace('://', ':/');
    if (change === 'contentId') record.contentId = 'ab'.repeat(16);
    if (change === 'version') record.version = 1;
    if (change === 'non-card') record.path = '@UserContent:/test.nca';
    await assert.rejects(readCardIdentity({ attachment: f.attachment, previous }), { code: 'CARD_CHANGED' });
    assert.equal(f.live.size, 0);
  }
});

test('permission failures remain errors and do not fall through to another game', async () => {
  const f = fixture([{ title: otherTitle, error: 0x320002, version: 2 },
    { title, contentId, path: actualPath, version: 1 }]);
  await assert.rejects(readCardIdentity({ attachment: f.attachment }), error => {
    assert.equal(error.nativeResult?.canonical, 0x320002);
    return true;
  });
  assert.equal(f.calls.filter(call => call.command === 6).length, 1);
  assert.equal(f.live.size, 0);
});

test('cancellation before discovery and during its list read closes owned handles', async () => {
  const initial = fixture();
  await assert.rejects(readCardIdentity({ attachment: initial.attachment, shouldStop: () => true }),
    { code: 'FTP_CANCELLED' });
  assert.equal(initial.calls.length, 0);
  let stopped = false;
  const f = fixture(undefined, { readHook: () => { stopped = true; } });
  await assert.rejects(readCardIdentity({ attachment: f.attachment, shouldStop: () => stopped }),
    { code: 'FTP_CANCELLED' });
  assert.equal(f.live.size, 0);
  assert.equal(f.calls.filter(call => call.command === 6).length, 0);
});

test('normal content discovery preserves its default storage order', async () => {
  const f = fixture([]);
  assert.deepEqual(await discoverApplications(f.attachment), []);
  assert.deepEqual(f.calls.filter(call => call.handle === 1).map(call => call.input[0]), [4, 5, 2]);
  assert.equal(f.live.size, 0);
});
