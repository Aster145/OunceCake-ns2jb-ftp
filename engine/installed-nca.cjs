const { buildIndex } = require('./mounts.cjs');
const { discoverGames } = require('./content.cjs');
const { titleId, idBytes, fixedOutput, success, cleanup, withCleanup, throwIfCancelled } = require('./protocol.cjs');

// NCM IDs differ from FS content-storage IDs: BuiltInUser=4, User=1.
// ABI: libnx nx/source/services/ncm.c (List/ListContentInfo/GetPath),
// nx/include/switch/services/ncm_types.h (24-byte ContentInfo, 40-bit size).
// Installed ContentMeta includes its own Meta NCA, unlike packaged CNMT:
// Atmosphere libraries/libstratosphere/source/ncm/ncm_content_meta.cpp,
// PackagedContentMetaReader::ConvertToContentMeta.
const NCM_USER = 4;
const FS_USER = 1;
const PAGE = 64;
const INFO_BYTES = 24;
const MAX_ID = 0xffffffffffffffffn;
const CONTENT_NAMES = ['Meta', 'Program', 'Data', 'Control', 'HtmlDocument', 'LegalInformation', 'DeltaFragment'];
const PACKAGES = [{ type: 0x80, kind: 'base' }, { type: 0x81, kind: 'update' }, { type: 0x82, kind: 'dlc' }];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hexId = value => value.toString(16).padStart(16, '0');

function sourcePath(contentPath, contentId) {
  check(typeof contentPath === 'string' && /^@UserContent:\/{1,2}registered\//.test(contentPath),
    'NCM content path is not in internal User registered content');
  const filename = '/' + contentPath.replace(/^@UserContent:\/+/, '');
  const parts = filename.slice(1).split('/');
  check(!/[\\\0\r\n]/.test(filename) && parts.every(part => part && part !== '.' && part !== '..') &&
    parts.at(-1).toLowerCase() === contentId + '.nca' && Buffer.byteLength(filename) <= 0x300,
  'NCM registered content path does not match its content ID');
  return filename;
}

function metadataQueries(s, shouldStop) {
  const cancelled = () => throwIfCancelled(shouldStop);
  const request = async (label, handle, command, input = Buffer.alloc(0), options) => {
    cancelled();
    const reply = success(await s.ipc(label, handle, command, input, options), label);
    // Let the caller record returned handles before observing cancellation.
    return reply;
  };
  const read = async (address, bytes) => {
    const data = await s.readOwned(address, bytes);
    check(Buffer.isBuffer(data) && data.length === bytes, 'NCM returned truncated metadata');
    cancelled();
    return data;
  };
  const output = s.base + 0x6000;
  check(Number.isSafeInteger(s.bytes) && s.bytes >= 0x6000 + PAGE * INFO_BYTES,
    'Owned RPC allocation is too small for NCA metadata');
  const maxKeys = Math.min(4096, Math.floor((s.bytes - 0x6000) / 16));
  async function listKeys(database, title, type, minimum, maximum, capacity = PAGE) {
    const input = Buffer.alloc(32);
    input[0] = type;
    input[1] = 0; // Full installations only; preserve each full key/version.
    idBytes(title).copy(input, 8);
    input.writeBigUInt64LE(minimum, 16);
    input.writeBigUInt64LE(maximum, 24);
    const reply = await request('List internal installed NCA packages', database, 5, input, {
      receive: [{ address: output, size: capacity * 16, mode: 0 }],
    });
    check(reply.data.length >= 8, 'NCM package list has no counts');
    const total = reply.data.readInt32LE(0), count = reply.data.readInt32LE(4);
    check(total >= 0 && count >= 0 && count <= capacity && count === Math.min(total, capacity),
      'NCM package list returned invalid counts');
    if (total > count) {
      if (capacity < maxKeys) return listKeys(database, title, type, minimum, maximum, Math.min(total, maxKeys));
      check(minimum < maximum, 'Too many installed versions for one title; no partial NCA export was prepared');
      const middle = (minimum + maximum) / 2n;
      return [...await listKeys(database, title, type, minimum, middle),
        ...await listKeys(database, title, type, middle + 1n, maximum)];
    }
    const bytes = count ? await read(output, count * 16) : Buffer.alloc(0);
    const keys = [], seen = new Set();
    for (let at = 0; at < bytes.length; at += 16) {
      const key = Buffer.from(bytes.subarray(at, at + 16));
      const id = key.readBigUInt64LE(), identity = key.toString('hex');
      check(key[12] === type && key[13] === 0 && minimum <= id && id <= maximum && !seen.has(identity),
        'NCM package list returned an unexpected or duplicate key');
      seen.add(identity);
      keys.push(key);
    }
    return keys;
  }
  return { request, read, output, listKeys };
}

async function discoverInstalledNcaGames({ attachment: a, shouldStop = () => false }) {
  const { s, domain } = a;
  const { request, listKeys } = metadataQueries(s, shouldStop);
  let database;
  const applications = await withCleanup(async () => {
    throwIfCancelled(shouldStop);
    const ncm = await a.service('ncm');
    database = domain.oneHandle(await request('Open internal content metadata database', ncm, 5,
      Buffer.from([NCM_USER])));
    const owners = new Map();
    for (const { type } of PACKAGES) {
      // A zero application filter includes update/DLC-only installations too.
      const keys = await listKeys(database, '0000000000000000', type, 0n, MAX_ID);
      for (const key of keys) {
        const reply = await request('Find internal NCA package application', database, 22, key);
        check(reply.data.length >= 8 && reply.data.readBigUInt64LE() !== 0n,
          'NCM package has no valid owner application');
        const owner = hexId(reply.data.readBigUInt64LE());
        owners.set(owner, { contentTitle: owner, storage: NCM_USER });
      }
    }
    return [...owners.values()];
  }, async () => { if (database !== undefined) await s.close(database); });
  // Resolve names only for this inventory; never enumerate card or SD games.
  return discoverGames({ ...a, shouldStop, applications });
}

async function prepareInstalledNcas({ attachment: a, title, shouldStop = () => false }) {
  title = titleId(title);
  const { s, root, domain, filesystem } = a;
  const owned = new Set();
  const cancelled = () => throwIfCancelled(shouldStop);
  const own = (reply, label) => {
    const handle = domain.oneHandle(success(reply, label));
    owned.add(handle);
    return handle;
  };
  const close = async handle => {
    if (!owned.has(handle)) return;
    await s.close(handle);
    owned.delete(handle);
  };
  const { request, read, output, listKeys } = metadataQueries(s, shouldStop);
  let database, store, raw;

  async function listContent(key) {
    const result = [], seen = new Set();
    for (let start = 0;;) {
      const input = Buffer.alloc(24);
      input.writeInt32LE(start);
      key.copy(input, 8);
      const reply = await request('List all installed NCA content types', database, 4, input, {
        receive: [{ address: output, size: PAGE * INFO_BYTES, mode: 0 }],
      });
      check(reply.data.length >= 4, 'NCM content list has no count');
      const count = reply.data.readInt32LE();
      check(count >= 0 && count <= PAGE && start + count <= 0xffff,
        'NCM content list returned an invalid count');
      if (!count) break;
      const bytes = await read(output, count * INFO_BYTES);
      for (let at = 0; at < bytes.length; at += INFO_BYTES) {
        const row = bytes.subarray(at, at + INFO_BYTES);
        const contentId = row.subarray(0, 16).toString('hex');
        check(!seen.has(contentId), 'NCM content pagination repeated a content ID');
        seen.add(contentId);
        result.push({ contentId, size: row.readUInt32LE(16) + row[20] * 2 ** 32,
          attributes: row[21], contentType: row[22], idOffset: row[23],
          contentTypeName: CONTENT_NAMES[row[22]] || 'Type' + row[22] });
      }
      start += count;
      // Read the next page even after a short page; only a zero count proves EOF.
    }
    check(result.some(item => item.contentType === 0),
      'Installed package has no Meta NCA; a complete package cannot be exported');
    return result;
  }

  async function resolve(info) {
    cancelled();
    const address = s.base + 0x3000;
    success(await domain.send(s, 'Resolve internal NCA path', store,
      fixedOutput(8, Buffer.from(info.contentId, 'hex'), address, 0x300)), 'Resolve internal NCA path');
    const bytes = await read(address, 0x300);
    const end = bytes.indexOf(0);
    check(end > 0, 'NCM content path has no valid terminator');
    const contentPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    return { contentPath, sourcePath: sourcePath(contentPath, info.contentId) };
  }

  try {
    cancelled();
    const ncm = await a.service('ncm');
    database = own(await request('Open internal content metadata database', ncm, 5, Buffer.from([NCM_USER])),
      'Open internal content metadata database');
    const packages = [];
    for (const type of PACKAGES) {
      const selectedId = BigInt('0x' + title);
      const keys = await listKeys(database, title, type.type, type.kind === 'base' ? selectedId : 0n,
        type.kind === 'base' ? selectedId : MAX_ID);
      keys.sort((a, b) => a.readUInt32LE(8) - b.readUInt32LE(8) ||
        hexId(a.readBigUInt64LE()).localeCompare(hexId(b.readBigUInt64LE())));
      for (const key of keys) {
        const owner = await request('Verify installed NCA package owner', database, 22, key);
        check(owner.data.length >= 8 && owner.data.readBigUInt64LE() === selectedId,
          'NCM package owner does not match the selected application');
        const contentTitle = hexId(key.readBigUInt64LE()), version = key.readUInt32LE(8);
        const suffix = type.kind === 'base' ? 'base/' + version :
          (type.kind === 'update' ? 'updates' : 'dlc') + '/' + contentTitle + '/' + version;
        packages.push({ kind: type.kind, contentTitle, version, path: '/installed/' + title + '/' + suffix,
          metaType: type.type, installType: key[13], files: await listContent(key) });
      }
    }
    if (!packages.length) throw Object.assign(new Error('No installed NCA packages for this title were found in internal storage'),
      { code: 'INSTALLED_NCA_NOT_FOUND' });
    store = own(await request('Open internal NCM content storage', ncm, 4, Buffer.from([NCM_USER])),
      'Open internal NCM content storage');
    const storageId = Buffer.alloc(4); storageId.writeUInt32LE(FS_USER);
    raw = own(await request('Open raw internal content filesystem', root, 110, storageId),
      'Open raw internal content filesystem');
    const resolved = new Map();
    let files = 0, bytes = 0;
    for (const pkg of packages) {
      for (const file of pkg.files) {
        cancelled();
        let physical = resolved.get(file.contentId);
        if (!physical) {
          physical = await resolve(file);
          const opened = success(await filesystem.openFile(s, raw, physical.sourcePath), 'Open installed raw NCA');
          const handle = opened.handle;
          owned.add(handle);
          try {
            const size = await filesystem.fileSize(s, handle);
            check(size <= BigInt(Number.MAX_SAFE_INTEGER) && size === BigInt(file.size),
              'Installed NCA file size differs from its NCM content record: ' + file.contentId);
            physical.size = Number(size);
          } finally { await close(handle); }
          resolved.set(file.contentId, physical);
        }
        check(physical.size === file.size, 'Shared NCA has conflicting package sizes');
        Object.assign(file, physical, { name: file.contentId + '.nca' });
        file.remotePath = pkg.path + '/' + file.name;
        files++; bytes += file.size;
        check(Number.isSafeInteger(bytes), 'Installed NCA total exceeds supported size precision');
      }
    }
    const index = buildIndex(packages.map(pkg => ({ path: pkg.path, kind: 'filesystem', mount: 0,
      entries: pkg.files.map(file => ({ path: '/' + file.name, sourcePath: file.sourcePath, type: 'file', size: file.size })) })));
    await close(store);
    await close(database);
    cancelled();
    return { index, sources: [{ handle: raw, kind: 1, size: 0 }],
      manifest: { title, storage: 'Internal', storageId: NCM_USER, fsContentStorageId: FS_USER,
        packages, files, bytes, transferVerified: false } };
  } catch (error) {
    await cleanup([...owned].reverse().map(handle => () => close(handle)), error);
  }
}

module.exports = { prepareInstalledNcas, discoverInstalledNcaGames };
