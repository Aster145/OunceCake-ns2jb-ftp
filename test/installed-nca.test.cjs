const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareInstalledNcas, discoverInstalledNcaGames } = require('../engine/installed-nca.cjs');
const { discoverGames } = require('../engine/content.cjs');

const TITLE = '0400a3a01ee4c000';
const PATCH = '0400a3a01ee4c800';
const DLC = '0400a3a01ee4d001';
const OTHER = '0100000000001000';
const id = number => BigInt(number).toString(16).padStart(32, '0');
const content = (number, type = 1, size = 0x4000, extra = {}) => ({ contentId: id(number), type, size, ...extra });
const pkg = (files, extra = {}) => ({ title: TITLE, owner: TITLE, type: 0x80, version: 0, storage: 4, files, ...extra });
const u64 = number => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(number)); return bytes; };

function fixture(packages = [pkg([content(1, 0), content(2)])], options = {}) {
  const calls = [], closed = [], live = new Set(), handles = new Map();
  const state = { stopped: false };
  let next = 100, pending = Buffer.alloc(0);
  const ok = (data = Buffer.alloc(0)) => ({ result: 0, data });
  const open = kind => {
    const handle = next++;
    live.add(handle); handles.set(handle, { kind });
    return { ...ok(), handle };
  };
  const keyFor = item => {
    const bytes = Buffer.alloc(16);
    bytes.writeBigUInt64LE(BigInt('0x' + item.title));
    bytes.writeUInt32LE(item.version, 8);
    bytes[12] = item.type; bytes[13] = item.installType || 0;
    return bytes;
  };
  const findKey = bytes => packages.find(item => keyFor(item).equals(bytes));
  const allFiles = packages.flatMap(item => item.files);
  const pathFor = file => file.path || '@UserContent://registered/00000001/' + file.contentId + '.nca';
  const attachment = {
    root: 2,
    service: async name => {
      if (name === 'ncm') return 1;
      assert.equal(name, 'ns:ro');
      assert.equal(live.size, 0, 'close metadata database before resolving names');
      return 3;
    },
    s: {
      base: 0x100000000, bytes: 0x80000, handles: live,
      close: async handle => { assert.ok(live.delete(handle), 'close each owned handle once'); closed.push(handle); },
      readOwned: async (_address, size) => {
        const bytes = Buffer.alloc(size); pending.copy(bytes);
        return options.shortRead ? bytes.subarray(0, Math.max(0, size - 1)) : bytes;
      },
      ipc: async (label, handle, command, input = Buffer.alloc(0), configuration) => {
        calls.push({ label, handle, command, input: Buffer.from(input), configuration });
        options.onCall?.(label, state);
        if (handle === 1) {
          assert.ok([4, 5].includes(command), 'only open NCM interfaces');
          assert.deepEqual([...input], [4], 'internal NCM storage only');
          return open(command === 5 ? 'database' : 'storage');
        }
        if (handle === 2) {
          assert.equal(command, 110, 'only open raw content filesystem');
          assert.deepEqual([...input], [1, 0, 0, 0], 'FS User differs from NCM BuiltInUser');
          if (options.openRawError) return { result: options.openRawError };
          return open('raw');
        }
        if (handle === 3) {
          assert.equal(command, 7989);
          return open('names');
        }
        if (handles.get(handle)?.kind === 'names') {
          assert.equal(command, 0);
          assert.equal(input[0], 1, 'read cached application names');
          if (options.nameReadError) return { result: options.nameReadError };
          const title = input.readBigUInt64LE(8).toString(16).padStart(16, '0');
          pending = Buffer.alloc(0x4000);
          pending.write(options.names?.[title] || 'Game ' + title);
          return ok();
        }
        assert.equal(handles.get(handle)?.kind, 'database');
        if (command === 5) {
          assert.equal(input.length, 32);
          assert.equal(input[1], 0, 'only complete installations');
          const application = input.readBigUInt64LE(8);
          assert.equal(application, options.discovery ? 0n : BigInt('0x' + TITLE));
          const minimum = input.readBigUInt64LE(16), maximum = input.readBigUInt64LE(24);
          const found = packages.filter(item => item.storage === 4 && item.type === input[0] &&
            (item.installType || 0) === 0 && (!application || BigInt('0x' + item.owner) === application) &&
            BigInt('0x' + item.title) >= minimum && BigInt('0x' + item.title) <= maximum);
          const capacity = configuration.receive[0].size / 16;
          const selected = found.slice(0, capacity);
          pending = Buffer.concat(selected.map(keyFor));
          const data = Buffer.alloc(8);
          data.writeInt32LE(found.length); data.writeInt32LE(selected.length, 4);
          return ok(data);
        }
        if (command === 6) {
          const title = input.readBigUInt64LE().toString(16).padStart(16, '0');
          const item = packages.filter(item => item.title === title && item.storage === 4)
            .sort((a, b) => b.version - a.version)[0];
          return item ? ok(keyFor(item)) : { result: 0xe05 };
        }
        if (command === 22) {
          assert.equal(input.length, 16);
          const item = findKey(input); assert.ok(item);
          return ok(u64(BigInt('0x' + (options.wrongOwner || item.owner))));
        }
        if (command === 4) {
          assert.equal(input.length, 24);
          assert.equal(input.readUInt32LE(4), 0);
          assert.equal(configuration.receive[0].size, 64 * 24);
          assert.equal(configuration.receive[0].mode, 0);
          const start = input.readInt32LE();
          const item = findKey(input.subarray(8)); assert.ok(item);
          const selected = item.files.slice(options.repeatPage ? 0 : start, (options.repeatPage ? 0 : start) + 64);
          pending = Buffer.alloc(selected.length * 24);
          selected.forEach((file, index) => {
            const at = index * 24;
            Buffer.from(file.contentId, 'hex').copy(pending, at);
            pending.writeUInt32LE(Number(BigInt(file.size) & 0xffffffffn), at + 16);
            pending[at + 20] = Number(BigInt(file.size) >> 32n);
            pending[at + 21] = file.attributes ?? 0xf1;
            pending[at + 22] = file.type; pending[at + 23] = file.idOffset || 0;
          });
          const data = Buffer.alloc(4); data.writeInt32LE(options.badCount ?? selected.length);
          return ok(data);
        }
        assert.fail('Unexpected NCM mutation or command: ' + command);
      },
    },
    domain: {
      oneHandle: reply => reply.handle,
      send: async (_s, _label, handle, packet) => {
        assert.equal(handles.get(handle)?.kind, 'storage');
        assert.equal(packet.readUInt32LE(24), 8);
        const contentId = packet.subarray(32, 48).toString('hex');
        const file = allFiles.find(item => item.contentId === contentId); assert.ok(file);
        pending = options.unterminated ? Buffer.alloc(0x300, 0x61) : Buffer.from(pathFor(file) + '\0');
        return ok();
      },
    },
    filesystem: {
      openFile: async (_s, handle, path) => {
        assert.equal(handles.get(handle)?.kind, 'raw');
        const file = allFiles.find(item => '/' + pathFor(item).replace(/^@UserContent:\/+/, '') === path);
        assert.ok(file, 'open only NCM-resolved files');
        if (options.fileOpenError) return { result: options.fileOpenError };
        const reply = open('file'); handles.get(reply.handle).file = file;
        options.onFile?.(state);
        return reply;
      },
      fileSize: async (_s, handle) => {
        if (options.sizeFailure) throw Error('FileGetSize failed');
        return BigInt(handles.get(handle).file.size) + BigInt(options.sizeDelta || 0);
      },
    },
  };
  return { attachment, calls, closed, live, handles, state,
    prepare: () => prepareInstalledNcas({ attachment, title: TITLE, shouldStop: () => state.stopped }),
    discover: () => discoverInstalledNcaGames({ attachment, shouldStop: () => state.stopped }) };
}

function indexFiles(index) {
  const rows = Number(index.readBigUInt64LE(16)), strings = Number(index.readBigUInt64LE(32)), files = [], paths = [];
  const string = offset => index.subarray(strings + offset, index.indexOf(0, strings + offset)).toString();
  for (let row = 0; row < rows; row++) {
    const at = 64 + row * 48;
    const name = string(index.readUInt32LE(at + 16)), parent = index.readUInt32LE(at);
    paths.push(row ? paths[parent].replace(/\/$/, '') + '/' + name : '/');
    if (index.readUInt32LE(at + 12)) files.push({ path: paths[row],
      sourcePath: string(index.readUInt32LE(at + 28)), size: Number(index.readBigUInt64LE(at + 40)) });
  }
  return files;
}

test('internal raw NCA export includes Meta and every content type for the selected base, update and DLC', async () => {
  const f = fixture([
    pkg([content(1, 0), content(2, 1, 0x100000001), content(3, 3), content(4, 4), content(5, 5)]),
    pkg([content(6, 0), content(7, 1), content(8, 6)], { title: PATCH, type: 0x81, version: 655360 }),
    pkg([content(9, 0), content(10, 2)], { title: DLC, type: 0x82, version: 3 }),
    pkg([content(11, 0), content(12)], { title: OTHER, owner: OTHER }),
    pkg([content(13, 0), content(14)], { storage: 2 }),
    pkg([content(15, 0), content(16)], { storage: 5 }),
  ]);
  const result = await f.prepare();
  assert.equal(result.manifest.files, 10);
  assert.equal(result.manifest.storage, 'Internal');
  assert.equal(result.manifest.transferVerified, false);
  assert.deepEqual(result.manifest.packages.map(item => item.kind), ['base', 'update', 'dlc']);
  const files = indexFiles(result.index);
  assert.equal(files.length, 10);
  const main = files.find(file => file.path.endsWith(id(2) + '.nca'));
  assert.equal(main.path, '/installed/' + TITLE + '/base/0/' + id(2) + '.nca');
  assert.equal(main.sourcePath, '/registered/00000001/' + id(2) + '.nca');
  assert.equal(main.size, 0x100000001, 'high size byte must not include attributes');
  assert.equal(result.manifest.bytes, 0x100000001 + 9 * 0x4000);
  assert.equal(f.live.size, 1);
  assert.equal(f.handles.get([...f.live][0]).kind, 'raw');
  assert.deepEqual(result.sources, [{ handle: [...f.live][0], kind: 1, size: 0 }]);
});

test('ListContentInfo advances its real start index through multiple pages including EOF', async () => {
  const f = fixture([pkg(Array.from({ length: 131 }, (_, n) => content(n + 1, n ? 2 : 0)))]);
  const result = await f.prepare();
  assert.equal(result.manifest.files, 131);
  assert.deepEqual(f.calls.filter(call => call.label === 'List all installed NCA content types')
    .map(call => call.input.readInt32LE()), [0, 64, 128, 131]);
});

test('package enumeration preserves all versions by resizing a truncated NCM key list', async () => {
  const f = fixture(Array.from({ length: 70 }, (_, n) => pkg([content(n + 1, 0)], { version: n })));
  const result = await f.prepare();
  assert.equal(result.manifest.packages.length, 70);
  assert.deepEqual(result.manifest.packages.map(item => item.version), Array.from({ length: 70 }, (_, n) => n));
  assert.deepEqual(f.calls.filter(call => call.command === 5 && call.handle !== 1 && call.input[0] === 0x80)
    .map(call => call.configuration.receive[0].size / 16), [64, 70]);
});

test('fragment-only installations and other applications never enter the export', async () => {
  const f = fixture([pkg([content(1, 0)], { installType: 1 }),
    pkg([content(2, 0)], { title: OTHER, owner: OTHER })]);
  await assert.rejects(f.prepare(), error => error.code === 'INSTALLED_NCA_NOT_FOUND');
  assert.equal(f.live.size, 0);
  assert.ok(!f.calls.some(call => call.command === 110));
});

test('owner mismatch aborts without exposing a different application', async () => {
  const f = fixture(undefined, { wrongOwner: OTHER });
  await assert.rejects(f.prepare(), /owner does not match/);
  assert.equal(f.live.size, 0);
});

test('missing Meta content refuses an incomplete package', async () => {
  const f = fixture([pkg([content(1)])]);
  await assert.rejects(f.prepare(), /no Meta NCA/);
  assert.equal(f.live.size, 0);
});

for (const [name, options, expected] of [
  ['raw filesystem open failure', { openRawError: 0x320002 }, /Open raw internal/],
  ['NCA open failure', { fileOpenError: 0x202 }, /Open installed raw NCA/],
  ['NCA size lookup failure', { sizeFailure: true }, /FileGetSize failed/],
  ['NCM/file size disagreement', { sizeDelta: 1 }, /file size differs/],
  ['bad content count', { badCount: 65 }, /invalid count/],
  ['unterminated NCM path', { unterminated: true }, /terminator/],
  ['truncated RPC metadata', { shortRead: true }, /truncated metadata/],
  ['nonadvancing content pagination', { repeatPage: true }, /repeated a content ID/],
]) test(name + ' closes all acquired preparation handles', async () => {
  const f = fixture(undefined, options);
  await assert.rejects(f.prepare(), expected);
  assert.equal(f.live.size, 0);
});

for (const invalid of ['@SdContent:/registered/' + id(1) + '.nca',
  '@UserContent:/registered/../' + id(1) + '.nca',
  '@UserContent:/registered/' + id(999) + '.nca']) {
  test('reject a path outside the selected User content identity: ' + invalid, async () => {
    const f = fixture([pkg([content(1, 0, 4096, { path: invalid })])]);
    await assert.rejects(f.prepare(), /content path/);
    assert.equal(f.live.size, 0);
  });
}

test('cancellation after acquiring a raw filesystem still closes that returned handle', async () => {
  const f = fixture(undefined, { onCall: (label, state) => {
    if (label === 'Open raw internal content filesystem') state.stopped = true;
  } });
  await assert.rejects(f.prepare(), error => error.code === 'FTP_CANCELLED');
  assert.equal(f.live.size, 0);
});

test('cancellation after opening an NCA closes its file and preparation handles', async () => {
  const f = fixture(undefined, { onFile: state => { state.stopped = true; } });
  await assert.rejects(f.prepare(), error => error.code === 'FTP_CANCELLED');
  assert.equal(f.live.size, 0);
});

test('installed NCA menu includes update-only and DLC-only owners and excludes card, SD and fragments', async () => {
  const dlcOwner = '0100000000002000';
  const f = fixture([
    pkg([], { title: PATCH, type: 0x81, version: 655360 }), // Pokopia has no internal base.
    pkg([], { title: PATCH, type: 0x81, version: 589824 }),
    pkg([], { title: DLC, type: 0x82 }), // Same owner appears only once.
    pkg([], { title: OTHER, owner: OTHER }),
    pkg([], { title: '0100000000003001', owner: dlcOwner, type: 0x82 }),
    pkg([], { title: '0100000000004000', owner: '0100000000004000', storage: 5 }),
    pkg([], { title: '0100000000005000', owner: '0100000000005000', storage: 2 }),
    pkg([], { title: '0100000000006000', owner: '0100000000006000', installType: 1 }),
  ], { discovery: true, names: { [TITLE]: 'Pokémon Pokopia', [OTHER]: 'SmileBASIC 4', [dlcOwner]: 'DLC only' } });
  assert.deepEqual(await f.discover(), [
    { title: dlcOwner, name: 'DLC only', storages: [4] },
    { title: TITLE, name: 'Pokémon Pokopia', storages: [4] },
    { title: OTHER, name: 'SmileBASIC 4', storages: [4] },
  ]);
  assert.deepEqual(f.calls.filter(call => call.handle === 1).map(call => [...call.input]), [[4]]);
  assert.equal(f.calls.filter(call => call.label === 'Read installed game name').length, 3);
  assert.ok(!f.calls.some(call => call.command === 110 || call.label === 'List all installed NCA content types'));
  assert.equal(f.live.size, 0);
});

test('installed NCA menu reuses complete package pagination before owner deduplication', async () => {
  const f = fixture(Array.from({ length: 70 }, (_, n) => pkg([], { title: PATCH, type: 0x81, version: n })),
    { discovery: true });
  assert.equal((await f.discover()).length, 1);
  assert.deepEqual(f.calls.filter(call => call.command === 5 && call.handle !== 1 && call.input[0] === 0x81)
    .map(call => call.configuration.receive[0].size / 16), [64, 70]);
  assert.equal(f.calls.filter(call => call.command === 22).length, 70);
  assert.equal(f.live.size, 0);
});

test('installed NCA menu returns empty without querying names when no internal full packages exist', async () => {
  const f = fixture([pkg([], { storage: 2 }), pkg([], { storage: 5 }), pkg([], { installType: 1 })],
    { discovery: true });
  assert.deepEqual(await f.discover(), []);
  assert.ok(!f.calls.some(call => call.handle === 3));
  assert.equal(f.live.size, 0);
});

test('an update-only owner remains selectable when its cached name and internal base are absent', async () => {
  const f = fixture([pkg([], { title: PATCH, type: 0x81 })], { discovery: true, nameReadError: 0xe05 });
  assert.deepEqual(await f.discover(), [{ title: TITLE, name: null, storages: [4] }]);
  assert.ok(f.calls.filter(call => call.handle === 1).every(call => call.input[0] === 4));
  assert.equal(f.live.size, 0);
});

test('invalid owner and cancellation close discovery metadata without starting name resolution', async () => {
  for (const options of [{ wrongOwner: '0000000000000000' }, {
    onCall: (label, state) => { if (label === 'Open internal content metadata database') state.stopped = true; },
  }, {
    onCall: (label, state) => { if (label === 'Find internal NCA package application') state.stopped = true; },
  }]) {
    const f = fixture(undefined, { discovery: true, ...options });
    await assert.rejects(f.discover(), options.wrongOwner ? /valid owner/ : { code: 'FTP_CANCELLED' });
    assert.ok(!f.calls.some(call => call.handle === 3));
    assert.equal(f.live.size, 0);
  }
});

test('provided application inventory resolves and deduplicates names without NCM enumeration', async () => {
  const f = fixture();
  const applications = [{ contentTitle: TITLE, storage: 4 }, { contentTitle: TITLE, storage: 4 }];
  assert.deepEqual(await discoverGames({ ...f.attachment, applications }),
    [{ title: TITLE, name: 'Game ' + TITLE, storages: [4] }]);
  assert.ok(!f.calls.some(call => call.handle === 1));
  assert.equal(f.live.size, 0);
  assert.deepEqual(await discoverGames({ ...f.attachment, applications: [] }), []);
  assert.ok(!f.calls.some(call => call.handle === 1));
});
