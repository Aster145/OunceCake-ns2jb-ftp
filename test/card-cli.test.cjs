const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { getArgs } = require('../ouncecake.cjs');

test('card partition mode accepts host/run selection and rejects game-only selectors', () => {
  assert.equal(getArgs(['some-run', '--card-partitions']).cardPartitions, true);
  assert.equal(getArgs(['--ns2jb', 'some-host', '--card-partitions', '--check']).check, true);
  for (const args of [
    ['some-run', '--card-partitions', '--base-only'],
    ['some-run', '0100965017338000', '--card-partitions'],
    ['--ns2jb', 'some-host', '--card-partitions', '--base-only'],
    ['--ns2jb', 'some-host', '0100965017338000', '--card-partitions'],
  ]) assert.throws(() => getArgs(args), /cannot be combined/);
});

function cliFixture(failure) {
  const filename = path.resolve(__dirname, '../ouncecake.cjs');
  const localRequire = createRequire(filename);
  const process = new EventEmitter();
  const calls = { card: 0, reports: [], ftp: 0, closed: 0 };
  const attachment = { close: async () => { calls.closed++; } };
  const prepared = { index: Buffer.alloc(64), sources: [{ handle: 44, kind: 1 }],
    partitionReport: [{ name: 'update', status: 'ready', files: 1 }], cardMetadata: { handle: 123 } };
  const dependencies = {
    './engine/run-directory.cjs': { resolveRun: async () => 'fixture-run' },
    './engine/session.cjs': { attachGame: async () => attachment },
    './engine/content.cjs': { discoverGames: async () => assert.fail('card mode must not select a game') },
    './engine/mounts.cjs': { prepareGame: async () => assert.fail('card mode must not prepare game content') },
    './engine/card-partitions.cjs': { prepareCardPartitions: async options => {
      assert.equal(options.attachment, attachment); calls.card++; if (failure) throw failure; return prepared;
    } },
    './engine/card-report.cjs': { saveCardReport: async data => { calls.reports.push(data); return 'report.json'; } },
    './engine/ftp.cjs': { readImage: async () => Buffer.alloc(0), deployFtp: async options => {
      assert.equal(options.index, prepared.index); assert.equal(options.sources, prepared.sources);
      calls.ftp++; process.emit('SIGINT'); return { close: async () => {} };
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, AbortController, setInterval, clearInterval, process, console: { log() {} },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
  }, { filename });
  return { main: module.exports.main, calls };
}

test('card CLI skips game/license setup and reports before serving partition files', async () => {
  const fixture = cliFixture();
  await fixture.main(['fixture-run', '--card-partitions']);
  assert.equal(fixture.calls.card, 1);
  assert.equal(fixture.calls.ftp, 1);
  assert.equal(fixture.calls.closed, 1);
  assert.equal(fixture.calls.reports[0].cardMetadata.handle, 123);
  assert.equal(fixture.calls.reports[0].error, undefined);
});

test('card CLI preserves partition failure report without starting FTP', async () => {
  const error = Object.assign(new Error('Secure partition denied'), { code: 'CARD_PARTITIONS_INCOMPLETE',
    partitionReport: [{ name: 'secure', status: 'error', result: 0x320002 }] });
  const fixture = cliFixture(error);
  await assert.rejects(fixture.main(['fixture-run', '--card-partitions']), /Secure partition denied/);
  assert.equal(fixture.calls.ftp, 0);
  assert.equal(fixture.calls.closed, 1);
  assert.equal(fixture.calls.reports[0].partitionReport[0].result, 0x320002);
  assert.equal(fixture.calls.reports[0].error.code, error.code);
});
