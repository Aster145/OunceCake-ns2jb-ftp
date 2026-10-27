const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { getArgs } = require('../ouncecake.cjs');

const title = '0400a3a01ee4c000';

function loadModule(relative, dependencies, extra = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const localRequire = createRequire(filename);
  const context = {
    Buffer, AbortController, setTimeout, setInterval, clearInterval, module: { exports: {} },
    console: { log() {} },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
    ...extra,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function mountsFixture({ absentBaseRomfs = false, emptyCode = false } = {}) {
  const calls = { updates: 0, dlc: 0, resolved: [], code: [], update: [], closed: [] };
  let handle = 100;
  let currentSelection;
  const directories = new Map();
  const reply = data => ({ result: 0, data: data || Buffer.alloc(16), handle: handle++ });
  const romfs = Buffer.alloc(0x94);
  [0x50, 0x50, 0, 0x50, 24, 0x68, 0, 0x68, 40, 0x90]
    .forEach((value, index) => romfs.writeBigUInt64LE(BigInt(value), index * 8));
  for (const offset of [4, 8, 16]) romfs.writeUInt32LE(0xffffffff, 0x50 + offset);
  romfs.writeUInt32LE(0xffffffff, 0x68 + 4);
  romfs.writeBigUInt64LE(4n, 0x68 + 16);
  romfs.writeUInt32LE(0xffffffff, 0x68 + 24);
  romfs.writeUInt32LE(8, 0x68 + 28);
  romfs.write('data.bin', 0x68 + 32);
  romfs.write('data', 0x90);
  const codeEntry = Buffer.alloc(0x310);
  codeEntry.write('main');
  codeEntry[0x304] = 1;
  codeEntry.writeBigUInt64LE(4n, 0x308);
  const resolveContent = async options => {
    calls.resolved.push(options);
    const selection = options.update ? 'update' : options.dlc ? 'dlc' : undefined;
    currentSelection = selection;
    return {
      contentPath: '@fixture/' + (selection || 'base'), attributes: 0,
      storage: options.storage, contentType: 1, selection, metaType: selection ? 0x81 : 0x80,
      contentTitle: (options.update || options.dlc)?.contentTitle || options.title,
    };
  };
  const module = loadModule('engine/mounts.cjs', {
    './content.cjs': {
      discoverUpdates: async () => {
        calls.updates++;
        return [{ contentTitle: '0400a3a01ee4c800', version: 655360, storage: 4 }];
      },
      discoverDlc: async () => {
        calls.dlc++;
        return [{ contentTitle: '0400a3a01ee4d001', version: 1, storage: 4 }];
      },
      resolveProgramContent: resolveContent,
      resolveDlcContent: resolveContent,
    },
    './program.cjs': {
      createProgramMounts: () => ({
        openCode: async options => { calls.code.push(options); return handle++; },
        openUpdate: async options => { calls.update.push(options); return handle++; },
      }),
      prepareInstalledLicense: async () => assert.fail('Fixture does not require a license retry'),
    },
  });
  const attachment = {
    root: 1,
    s: {
      base: 0x100000000,
      write: async () => {},
      close: async value => { calls.closed.push(value); },
      ipc: async (label, directory) => {
        if (label === 'Read game directory') {
          const count = emptyCode || directories.get(directory) ? 0 : 1;
          directories.set(directory, true);
          return reply(u64(count));
        }
        return reply(label === 'Game storage size' ? u64(romfs.length) : Buffer.alloc(16));
      },
    },
    service: async () => 2,
    domain: {
      oneHandle: value => value.handle,
      send: async (_s, label) => {
        if (absentBaseRomfs && !currentSelection && label === 'OpenDataStorageByPath') {
          return { result: 0x7d202 };
        }
        return reply(label === 'Read selected NCA ProgramId' ? u64('0x' + title) : undefined);
      },
    },
    filesystem: {
      pathMethod: async () => {
        const opened = reply();
        directories.set(opened.handle, false);
        return opened;
      },
      readStorage: async (_s, _handle, offset, length) => romfs.subarray(offset, offset + length),
      verifiedBytes: async () => codeEntry,
    },
  };
  return { calls, attachment, prepareGame: module.prepareGame };
}

function indexPaths(index) {
  const count = Number(index.readBigUInt64LE(16));
  const strings = Number(index.readBigUInt64LE(32));
  const paths = [];
  for (let id = 0; id < count; id++) {
    const row = 64 + id * 48;
    const parent = index.readUInt32LE(row);
    const start = strings + index.readUInt32LE(row + 16);
    const name = index.subarray(start, start + index.readUInt32LE(row + 20)).toString();
    paths.push(id ? (paths[parent] === '/' ? '' : paths[parent]) + '/' + name : '/');
  }
  return paths;
}

test('base-only preserves base RomFS and ExeFS without update or DLC discovery or mounting', async () => {
  const fixture = mountsFixture();
  const result = await fixture.prepareGame({ attachment: fixture.attachment, title, baseOnly: true });
  assert.deepEqual(indexPaths(result.index), [
    '/', '/base', '/base/romfs', '/base/romfs/data.bin', '/base/exefs', '/base/exefs/main',
  ]);
  assert.equal(result.sources.length, 2);
  assert.equal(fixture.calls.updates, 0);
  assert.equal(fixture.calls.dlc, 0);
  assert.equal(fixture.calls.update.length, 0);
  assert.equal(fixture.calls.code.length, 1);
  assert.equal(fixture.calls.resolved.length, 2);
  assert.ok(fixture.calls.resolved.every(options => !options.update && !options.dlc));
});

test('default preparation retains base, update RomFS/ExeFS, and DLC', async () => {
  const fixture = mountsFixture();
  const result = await fixture.prepareGame({ attachment: fixture.attachment, title });
  const paths = indexPaths(result.index);
  for (const expected of ['/base/romfs', '/base/exefs', '/updates/655360/romfs',
    '/updates/655360/exefs', '/dlc/0400a3a01ee4d001/1/romfs']) {
    assert.ok(paths.includes(expected), expected);
  }
  assert.equal(result.sources.length, 5);
  assert.equal(fixture.calls.updates, 1);
  assert.equal(fixture.calls.dlc, 1);
  assert.equal(fixture.calls.update.length, 2);
  assert.equal(fixture.calls.resolved.filter(options => options.dlc).length, 1);
});

test('base-only rejects a missing RomFS and empty ExeFS instead of serving an empty game', async () => {
  const fixture = mountsFixture({ absentBaseRomfs: true, emptyCode: true });
  await assert.rejects(
    fixture.prepareGame({ attachment: fixture.attachment, title, baseOnly: true }),
    error => error.code === 'GAME_FILES_EMPTY',
  );
  assert.equal(fixture.calls.updates, 0);
  assert.equal(fixture.calls.dlc, 0);
});

test('missing base RomFS and empty base ExeFS still allow full mode to expose update files', async () => {
  const fixture = mountsFixture({ absentBaseRomfs: true, emptyCode: true });
  const result = await fixture.prepareGame({ attachment: fixture.attachment, title });
  const paths = indexPaths(result.index);
  assert.equal(paths.includes('/base/romfs'), false);
  assert.ok(paths.includes('/base/exefs'));
  assert.ok(paths.includes('/updates/655360/romfs/data.bin'));
  assert.equal(fixture.calls.updates, 1);
  assert.equal(fixture.calls.update.length, 2);
});

test('both explicit run and host discovery accept base-only with existing options', () => {
  for (const input of [['fixture-run', title, '--base-only', '--port', '2221'],
    ['--base-only', '--ns2jb', 'fixture-host', title, '--port', '2221']]) {
    const options = getArgs(input);
    assert.equal(options.baseOnly, true);
    assert.equal(options.title, title);
    assert.equal(options.port, 2221);
  }
  assert.equal(getArgs(['fixture-run']).baseOnly, false);
  assert.equal(getArgs(['--ns2jb', 'fixture-host']).baseOnly, false);
});

test('main passes base-only to preparation and explains exclusions before mounting', async () => {
  for (const input of [['fixture-run', title, '--base-only'],
    ['--ns2jb', 'fixture-host', title, '--base-only']]) {
    const fakeProcess = new EventEmitter();
    const messages = [];
    let preparedOptions;
    let resolvedOptions;
    const attachment = { close: async () => {} };
    const cli = loadModule('ouncecake.cjs', {
      './engine/run-directory.cjs': { resolveRun: async options => { resolvedOptions = options; return 'fixture-run'; } },
      './engine/session.cjs': { attachGame: async () => attachment },
      './engine/content.cjs': { discoverGames: async () => assert.fail('Explicit title skips the menu') },
      './engine/mounts.cjs': { prepareGame: async options => {
        preparedOptions = options;
        assert.ok(messages.some(line => /Base-only.*updates and DLC are excluded/.test(line)));
        return { index: Buffer.alloc(0), sources: [] };
      } },
      './engine/ftp.cjs': {
        readImage: async () => Buffer.alloc(0),
        deployFtp: async () => { fakeProcess.emit('SIGINT'); return { close: async () => {} }; },
      },
    }, { process: fakeProcess, console: { log: (...args) => messages.push(args.join(' ')) } });
    await cli.main(input);
    assert.equal(resolvedOptions.baseOnly, true);
    assert.equal(preparedOptions.baseOnly, true);
    assert.equal(preparedOptions.title, title);
    assert.equal(preparedOptions.attachment, attachment);
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  }
});

test('base launcher selects base-only and help documents both CLI forms', async () => {
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'OUNCECAKE-BASE.cmd'), 'utf8');
  assert.match(launcher, /--ns2jb "%OUNCECAKE_NS2JB_HOST%" --base-only %\*/);
  const messages = [];
  const cli = loadModule('ouncecake.cjs', {}, { console: { log: value => messages.push(value) } });
  await cli.main(['--help']);
  assert.match(messages[0], /<run-directory>.*\[--base-only\]/);
  assert.match(messages[0], /--ns2jb <host-folder>.*\[--base-only\]/);
  assert.match(messages[0], /excludes updates and DLC/);
});
