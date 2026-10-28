'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const readline = require('node:readline');

const TITLE = '0400a3a01ee4c000';

const GAMES = [
  { title: TITLE, name: 'Pokopia', storages: [4] },
  { title: '0100c9100b06a000', name: 'SmileBASIC 4', storages: [4] },
];

function cliFixture({ prepareError, reportError, selection, games = GAMES } = {}) {
  const filename = path.resolve(__dirname, '../ouncecake.cjs');
  const localRequire = createRequire(filename);
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stdout.on('data', data => {
    if (data.toString().includes('Choose a game:') && selection !== undefined) {
      setImmediate(() => process.stdin.write(selection + '\n'));
    }
  });
  const calls = { resolved: [], attached: 0, prepared: [], reports: [], image: 0,
    ftp: [], attachmentClosed: 0, ftpClosed: 0, events: [], logs: [], discovered: 0 };
  const attachment = { close: async () => { calls.attachmentClosed++; } };
  const image = Buffer.alloc(32);
  const prepared = { index: Buffer.alloc(64), sources: [{ handle: 41, kind: 1 }],
    manifest: { title: TITLE, files: [{ path: '/installed/update/test.nca', bytes: 123 }] } };
  const dependencies = {
    'node:readline': { createInterface: options => {
      assert.notEqual(selection, undefined, 'explicit title must not open a selection menu');
      return readline.createInterface(options);
    } },
    './engine/run-directory.cjs': { resolveRun: async options => { calls.resolved.push(options); return 'fixture-run'; } },
    './engine/session.cjs': { attachGame: async run => { assert.equal(run, 'fixture-run'); calls.attached++; return attachment; } },
    './engine/content.cjs': { discoverGames: async () => assert.fail('an explicit installed title must not enumerate the game menu') },
    './engine/mounts.cjs': { prepareGame: async () => assert.fail('raw installed NCAs must not use prepareGame') },
    './engine/card-partitions.cjs': { prepareCardPartitions: async () => assert.fail('raw installed NCAs must not mount card partitions') },
    './engine/card-report.cjs': { saveCardReport: async () => assert.fail('installed NCA mode must not write a card report') },
    './engine/installed-nca.cjs': { discoverInstalledNcaGames: async options => {
      assert.equal(options.attachment, attachment); calls.discovered++;
      return games;
    }, prepareInstalledNcas: async options => {
      calls.prepared.push(options); calls.events.push('prepare');
      assert.equal(options.attachment, attachment);
      assert.equal(options.title, selection ? games[Number(selection) - 1]?.title : TITLE);
      assert.equal(typeof options.shouldStop, 'function'); assert.equal(options.shouldStop(), false);
      if (prepareError) throw prepareError;
      return prepared;
    } },
    './engine/installed-nca-report.cjs': { saveInstalledNcaReport: async data => {
      calls.reports.push(data); calls.events.push('report');
      if (reportError) throw reportError;
      return 'installed-report.json';
    } },
    './engine/ftp.cjs': { readImage: async () => { calls.image++; return image; }, deployFtp: async options => {
      calls.ftp.push(options); calls.events.push('ftp');
      assert.equal(options.attachment, attachment); assert.equal(options.image, image);
      assert.equal(options.index, prepared.index); assert.equal(options.sources, prepared.sources);
      assert.ok(calls.logs.some(line => line.includes('installed-report.json')), 'print the saved manifest path before starting FTP');
      process.emit('SIGINT');
      return { close: async () => { calls.ftpClosed++; } };
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, AbortController, setInterval, clearInterval, process,
    console: { log: (...parts) => { calls.logs.push(parts.join(' ')); } },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
  }, { filename });
  return { ...module.exports, calls, prepared, process };
}

test('installed NCA arguments accept an explicit title with a run folder or ns2jb host', () => {
  const { getArgs } = cliFixture();
  const run = getArgs(['some-run', '--installed-nca', TITLE.toUpperCase(), '--port', '2221']);
  assert.equal(run.run, path.resolve('some-run')); assert.equal(run.title, TITLE);
  assert.equal(run.installedNca, true); assert.equal(run.port, 2221);
  const host = getArgs(['--ns2jb', 'some-host', '0x' + TITLE.toUpperCase(), '--installed-nca', '--check']);
  assert.equal(host.ns2jb, path.resolve('some-host')); assert.equal(host.title, TITLE);
  assert.equal(host.installedNca, true); assert.equal(host.check, true);
});

test('installed NCA arguments allow menu selection and reject incompatible mount modes', () => {
  const { getArgs } = cliFixture();
  for (const args of [
    ['some-run', '--installed-nca'],
    ['--ns2jb', 'some-host', '--installed-nca'],
    ['some-run', '--installed-nca', '--check'],
    ['--ns2jb', 'some-host', '--installed-nca', '--check'],
  ]) {
    assert.equal(getArgs(args).installedNca, true);
    assert.equal(getArgs(args).title, undefined);
  }
  for (const selection of [['some-run'], ['--ns2jb', 'some-host']]) {
    for (const mode of ['--base-only', '--card-partitions']) {
      assert.throws(() => getArgs([...selection, TITLE, '--installed-nca', mode]), /cannot be combined/i);
    }
    assert.throws(() => getArgs([...selection, 'not-a-title', '--installed-nca']), /Title must be 16 hexadecimal digits/);
  }
});

test('installed NCA CLI skips menus and game/card mounts, reports and serves prepared sources', async () => {
  const fixture = cliFixture();
  await fixture.main(['fixture-run', TITLE.toUpperCase(), '--installed-nca', '--port', '2221']);
  assert.equal(fixture.calls.attached, 1); assert.equal(fixture.calls.prepared.length, 1);
  assert.equal(fixture.calls.reports.length, 1);
  assert.equal(fixture.calls.reports[0].run, 'fixture-run');
  assert.equal(fixture.calls.reports[0].manifest, fixture.prepared.manifest);
  assert.deepEqual(fixture.calls.events, ['prepare', 'report', 'ftp']);
  assert.equal(fixture.calls.ftp.length, 1); assert.equal(fixture.calls.ftp[0].port, 2221);
  assert.equal(fixture.calls.ftpClosed, 1); assert.equal(fixture.calls.attachmentClosed, 1);
  assert.equal(fixture.process.listenerCount('SIGINT'), 0); assert.equal(fixture.process.listenerCount('SIGTERM'), 0);
});

test('installed NCA CLI accepts automatic live-run selection without prompting', async () => {
  const fixture = cliFixture();
  await fixture.main(['--ns2jb', 'fixture-host', TITLE, '--installed-nca']);
  assert.equal(fixture.calls.resolved[0].ns2jb, path.resolve('fixture-host'));
  assert.equal(fixture.calls.prepared.length, 1); assert.equal(fixture.calls.ftp.length, 1);
});

test('installed NCA preparation or manifest failures never start FTP and release the attachment', async () => {
  for (const failureAt of ['prepareError', 'reportError']) {
    const error = new Error('Installed NCA ' + failureAt);
    const fixture = cliFixture({ [failureAt]: error });
    await assert.rejects(fixture.main(['fixture-run', TITLE, '--installed-nca']), candidate => candidate === error);
    assert.equal(fixture.calls.ftp.length, 0); assert.equal(fixture.calls.ftpClosed, 0);
    assert.equal(fixture.calls.attachmentClosed, 1);
    assert.equal(fixture.process.listenerCount('SIGINT'), 0); assert.equal(fixture.process.listenerCount('SIGTERM'), 0);
  }
});

test('installed NCA check only resolves RPC readiness and never attaches, mounts or deploys', async () => {
  for (const selection of [['fixture-run'], ['--ns2jb', 'fixture-host']]) {
    const fixture = cliFixture();
    await fixture.main([...selection, TITLE, '--installed-nca', '--check']);
    assert.equal(fixture.calls.resolved.length, 1); assert.equal(fixture.calls.resolved[0].check, true);
    assert.equal(fixture.calls.attached, 0); assert.equal(fixture.calls.prepared.length, 0);
    assert.equal(fixture.calls.reports.length, 0); assert.equal(fixture.calls.image, 0);
    assert.equal(fixture.calls.ftp.length, 0); assert.equal(fixture.calls.attachmentClosed, 0);
  }
});

test('installed NCA menu exports the selected different game', async () => {
  const fixture = cliFixture({ selection: '2' });
  await fixture.main(['--ns2jb', 'fixture-host', '--installed-nca']);
  assert.equal(fixture.calls.discovered, 1);
  assert.equal(fixture.calls.prepared[0].title, GAMES[1].title);
  assert.equal(fixture.calls.ftp.length, 1);
  assert.equal(fixture.calls.attachmentClosed, 1);
});

test('quitting installed NCA selection releases the connection without preparing FTP', async () => {
  const fixture = cliFixture({ selection: 'q' });
  await fixture.main(['fixture-run', '--installed-nca']);
  assert.equal(fixture.calls.prepared.length, 0);
  assert.equal(fixture.calls.ftp.length, 0);
  assert.equal(fixture.calls.attachmentClosed, 1);
});

test('empty internal storage has an explicit error and no FTP deployment', async () => {
  const fixture = cliFixture({ games: [] });
  await assert.rejects(fixture.main(['fixture-run', '--installed-nca']), /No installed game content.*internal storage/);
  assert.equal(fixture.calls.ftp.length, 0);
  assert.equal(fixture.calls.attachmentClosed, 1);
});

test('generic launcher check does not open the game menu', async () => {
  const fixture = cliFixture();
  await fixture.main(['--ns2jb', 'fixture-host', '--installed-nca', '--check']);
  assert.equal(fixture.calls.discovered, 0);
  assert.equal(fixture.calls.attached, 0);
});
