const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareCardPartitions } = require('../engine/card-partitions.cjs');

const file = (name, size = 4) => ({ name, type: 'file', size });
const directory = name => ({ name, type: 'directory', size: 0 });

function fixture({ trees = {}, openErrors = {}, listErrors = {}, inserted = [true, true],
  cardHandles = [0x12345678, 0x12345678], metadataError, onList } = {}) {
  const calls = [];
  const closed = [];
  const live = new Set();
  const directories = new Map();
  let directoryHandle = 200;
  let insertionReads = 0;
  let handleReads = 0;
  let readBytes;
  const u64 = value => {
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(BigInt(value));
    return data;
  };
  const opened = handle => {
    live.add(handle);
    return { result: 0, data: Buffer.alloc(0), handle };
  };
  const attachment = {
    run: 'unused-card-partition-fixture',
    root: 1,
    s: {
      base: 0x100000000,
      handles: live,
      close: async handle => {
        assert.ok(live.delete(handle), 'close a live, owned handle exactly once: ' + handle);
        closed.push(handle);
      },
      ipc: async (label, handle, command, input, options) => {
        calls.push({ label, handle, command, input, options });
        if (handle === 1 && command === 400) return opened(90);
        if (handle === 90 && command === 200) {
          return { result: 0, data: Buffer.from([inserted[insertionReads++] ? 1 : 0]) };
        }
        if (handle === 90 && command === 202) {
          const data = Buffer.alloc(4);
          data.writeUInt32LE(cardHandles[handleReads++]);
          return { result: 0, data };
        }
        if (handle === 90 && command === 203) {
          assert.equal(input.length, 4);
          assert.equal(input.readUInt32LE(), cardHandles[0]);
          if (metadataError) return { result: metadataError };
          const data = Buffer.alloc(16);
          data.writeUInt32LE(0x4c000000);
          data.writeBigUInt64LE(0x0100000000000816n, 8);
          return { result: 0, data };
        }
        if (handle === 1 && command === 31) {
          assert.equal(input.length, 8);
          assert.equal(input.readUInt32LE(0), cardHandles[0]);
          const partition = input.readUInt32LE(4);
          if (openErrors[partition]) return { result: openErrors[partition] };
          return opened(100 + partition);
        }
        if (command === 0 && directories.has(handle)) {
          const current = directories.get(handle);
          assert.equal(options.receive[0].size, 32 * 0x310);
          if (current.read) return { result: 0, data: u64(0) };
          current.read = true;
          readBytes = Buffer.alloc(current.entries.length * 0x310);
          current.entries.forEach((entry, index) => {
            const offset = index * 0x310;
            readBytes.write(entry.name, offset);
            readBytes[offset + 0x304] = entry.type === 'file' ? 1 : 0;
            readBytes.writeBigUInt64LE(BigInt(entry.size), offset + 0x308);
          });
          return { result: 0, data: u64(current.entries.length) };
        }
        assert.fail('Unexpected IPC operation: ' + label + ' handle=' + handle + ' command=' + command);
      },
    },
    domain: { oneHandle: reply => reply.handle },
    filesystem: {
      pathMethod: async (_s, handle, command, path, input) => {
        assert.equal(command, 9);
        assert.equal(input.readUInt32LE(), 3);
        const partition = handle - 100;
        if (listErrors[partition]) return { result: listErrors[partition] };
        onList?.(partition, path);
        const id = directoryHandle++;
        directories.set(id, { entries: trees[partition]?.[path] || [], read: false });
        return opened(id);
      },
      verifiedBytes: async (_s, _address, size) => {
        assert.equal(readBytes.length, size);
        return readBytes;
      },
    },
    service: async name => assert.fail('Partition export must not acquire a service: ' + name),
  };
  return { attachment, calls, closed, live };
}

function indexEntries(index) {
  assert.equal(index.subarray(0, 8).toString(), 'NS2FTPIX');
  assert.equal(index.readUInt32LE(8), 1);
  assert.equal(index.readUInt32LE(12), 48);
  const count = Number(index.readBigUInt64LE(16));
  const strings = Number(index.readBigUInt64LE(32));
  const cstring = offset => {
    const start = strings + offset;
    return index.subarray(start, index.indexOf(0, start)).toString();
  };
  const entries = [];
  for (let id = 0; id < count; id++) {
    const row = 64 + id * 48;
    const parent = index.readUInt32LE(row);
    const name = cstring(index.readUInt32LE(row + 16));
    entries.push({
      path: id ? entries[parent].path.replace(/\/$/, '') + '/' + name : '/',
      type: index.readUInt32LE(row + 12) ? 'file' : 'directory',
      mount: index.readUInt32LE(row + 24),
      sourcePath: cstring(index.readUInt32LE(row + 28)),
      offset: Number(index.readBigUInt64LE(row + 32)),
      size: Number(index.readBigUInt64LE(row + 40)),
    });
  }
  return entries;
}

test('all four partition IDs use the current card handle and preserve raw NCA filesystem paths', async () => {
  const f = fixture({ trees: {
    0: { '/': [file('firmware.cnmt.nca', 1024), directory('nested')], '/nested': [file('system.nca', 8192)] },
    1: { '/': [file('normal.nca', 16)] },
    2: { '/': [file('game.nca', 0x100000001)] },
    3: { '/': [file('logo.png', 99)] },
  } });
  const result = await prepareCardPartitions({ attachment: f.attachment });
  assert.deepEqual(f.calls.filter(call => call.command === 31).map(call => [...call.input]), [
    [0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0],
    [0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0],
    [0x78, 0x56, 0x34, 0x12, 2, 0, 0, 0],
    [0x78, 0x56, 0x34, 0x12, 3, 0, 0, 0],
  ]);
  assert.deepEqual(result.sources.map(source => [source.handle, source.kind]), [[100, 1], [101, 1], [102, 1], [103, 1]]);
  const entries = indexEntries(result.index);
  for (const name of ['update', 'normal', 'secure', 'logo']) {
    assert.ok(entries.some(entry => entry.path === '/card/' + name));
  }
  assert.deepEqual(entries.find(entry => entry.path === '/card/update/nested/system.nca'), {
    path: '/card/update/nested/system.nca', type: 'file', mount: 0,
    sourcePath: '/nested/system.nca', offset: 0, size: 8192,
  });
  assert.equal(entries.find(entry => entry.path === '/card/secure/game.nca').size, 0x100000001);
  assert.deepEqual(result.partitionReport.map(report => report.status), ['ready', 'ready', 'ready', 'ready']);
  assert.equal(result.partitionReport[0].bytes, 9216);
  assert.equal(result.partitionReport[0].directories, 1);
  assert.deepEqual(result.cardMetadata, { handle: 0x12345678, updatePartitionInfo: {
    versionRaw: 0x4c000000, versionHex: '0x4c000000', titleId: '0100000000000816',
  } });
  assert.deepEqual([...f.live], [100, 101, 102, 103], 'successful filesystem handles stay session-owned');
  assert.equal(f.closed.filter(handle => handle === 90).length, 1);
});

test('empty mounted partition is visible; missing partition is reported without a fake FTP directory', async () => {
  const f = fixture({ trees: { 0: { '/': [file('firmware.nca')] } }, openErrors: { 2: 0x7d202, 3: 0x7d202 } });
  const result = await prepareCardPartitions({ attachment: f.attachment });
  assert.deepEqual(result.partitionReport.map(report => report.status), ['ready', 'empty', 'missing', 'missing']);
  assert.equal(result.partitionReport[2].result.name, 'PartitionNotFound');
  const paths = indexEntries(result.index).map(entry => entry.path);
  assert.ok(paths.includes('/card/normal'));
  assert.ok(!paths.includes('/card/secure'));
  assert.equal(result.sources.length, 2);
});

test('permission failure reports all partition outcomes and closes every opened handle instead of starting partial export', async () => {
  const f = fixture({ trees: { 0: { '/': [file('firmware.nca')] }, 2: { '/': [file('game.nca')] } },
    openErrors: { 1: 0x320002, 3: 0x7d202 } });
  await assert.rejects(prepareCardPartitions({ attachment: f.attachment }), error => {
    assert.equal(error.code, 'CARD_PARTITIONS_INCOMPLETE');
    assert.deepEqual(error.partitionReport.map(report => report.status), ['ready', 'error', 'ready', 'missing']);
    assert.equal(error.partitionReport[1].result.canonical, 0x320002);
    assert.equal(error.cardMetadata.handle, 0x12345678);
    return true;
  });
  assert.equal(f.calls.filter(call => call.command === 31).length, 4);
  assert.equal(f.live.size, 0);
});

test('directory read failure is an error, not an empty partition, and still checks other partitions', async () => {
  const f = fixture({ listErrors: { 0: 0x320002 }, trees: { 2: { '/': [file('game.nca')] } } });
  await assert.rejects(prepareCardPartitions({ attachment: f.attachment }), error => {
    assert.equal(error.code, 'CARD_PARTITIONS_INCOMPLETE');
    assert.equal(error.partitionReport[0].status, 'error');
    assert.equal(error.partitionReport[2].status, 'ready');
    return true;
  });
  assert.equal(f.live.size, 0);
});

test('no inserted card never opens partitions and closes the device operator', async () => {
  const f = fixture({ inserted: [false] });
  await assert.rejects(prepareCardPartitions({ attachment: f.attachment }), { code: 'CARD_NOT_INSERTED' });
  assert.equal(f.calls.some(call => call.command === 31), false);
  assert.deepEqual(f.closed, [90]);
});

test('a changed or removed card invalidates the whole index without reopening a new identity', async () => {
  for (const change of [{ cardHandles: [123, 456] }, { inserted: [true, false] }]) {
    const f = fixture({ ...change, trees: { 0: { '/': [file('firmware.nca')] } } });
    await assert.rejects(prepareCardPartitions({ attachment: f.attachment }), { code: 'CARD_CHANGED' });
    assert.equal(f.calls.filter(call => call.command === 31).length, 4);
    assert.equal(f.live.size, 0);
  }
});

test('cancellation during enumeration closes directory, filesystem, and operator handles', async () => {
  let stopped = false;
  const f = fixture({ onList: () => { stopped = true; } });
  await assert.rejects(prepareCardPartitions({ attachment: f.attachment, shouldStop: () => stopped }), {
    code: 'FTP_CANCELLED',
  });
  assert.equal(f.calls.filter(call => call.command === 31).length, 1);
  assert.equal(f.live.size, 0);
});

test('all empty or absent partitions reject FTP and release successfully opened empty filesystems', async () => {
  const f = fixture({ openErrors: { 2: 0x7d202, 3: 0x7d202 } });
  await assert.rejects(prepareCardPartitions({ attachment: f.attachment }), error => {
    assert.equal(error.code, 'CARD_FILES_EMPTY');
    assert.deepEqual(error.partitionReport.map(report => report.status), ['empty', 'empty', 'missing', 'missing']);
    return true;
  });
  assert.equal(f.live.size, 0);
});

test('optional update metadata errors retain native result and do not hide readable partition files', async () => {
  const f = fixture({ metadataError: 0x320002, trees: { 0: { '/': [file('firmware.nca')] } } });
  const result = await prepareCardPartitions({ attachment: f.attachment });
  assert.equal(result.cardMetadata.updatePartitionInfo.result.name, 'PermissionDenied');
  assert.match(result.cardMetadata.updatePartitionInfo.error, /GetGameCardUpdatePartitionInfo/);
  assert.ok(indexEntries(result.index).some(entry => entry.path === '/card/update/firmware.nca'));
});
