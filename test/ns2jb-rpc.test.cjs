'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {patchSources} = require('../integration/patch-ns2jb.cjs');

function registerHostSourceTests(sourceDirectory) {
  const sourceFiles = {
    runner: 'run.cjs',
    pipeline: 'engine/switch2/pipeline.cjs',
    stages: 'engine/shared/stages.cjs',
    runControl: 'engine/switch2/memory/run-control.cjs',
  };
  const originals = Object.fromEntries(Object.entries(sourceFiles).map(([name, relative]) =>
    [name, fs.readFileSync(path.join(sourceDirectory, relative), 'utf8')]));
  const patched = patchSources(originals);
  const copy = value => JSON.parse(JSON.stringify(value));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function deferred() {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise, resolve};
  }

  function load(source, stubs, proc, logs = [], filename = 'module.cjs') {
    const module = {exports: {}};
    const requireStub = name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.startsWith('node:')) return require(name);
      throw Error('Unexpected dependency: ' + name);
    };
    const context = {module, exports: module.exports, require: requireStub,
      process: proc || new EventEmitter(), __dirname: path.join('C:', 'mock-run', 'switch2'),
      __filename: filename, Buffer, console: {log: line => logs.push(line), error: line => logs.push(line)},
      setTimeout, clearTimeout, setInterval, clearInterval};
    new vm.Script(source, {filename}).runInNewContext(context);
    return module.exports;
  }

  function runnerHarness() {
    const proc = new EventEmitter();
    Object.assign(proc, {env: {}, execPath: process.execPath, stdin: new PassThrough(),
      stdout: new PassThrough(), argv: []});
    const child = new EventEmitter();
    Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), connected: true});
    const calls = [], logs = [];
    child.send = (value, callback) => {calls.push(['send', value]); callback();};
    child.kill = signal => calls.push(['kill', signal]);
    const stubs = {
      'node:fs/promises': {open: async () => ({fd: 42, close: async () => calls.push(['log-close'])})},
      'node:fs': {createWriteStream: () => new Writable({write(data, encoding, callback) {callback();}})},
      'node:child_process': {spawn: (...args) => {calls.push(['spawn', ...args]); return child;}},
      './engine/lib/connection.cjs': {}, './engine/lib/native.cjs': {},
      './engine/lib/qualify.cjs': {}, './engine/lib/bridge.cjs': {},
    };
    return {api: load(patched.runner, stubs, proc, logs, 'run.cjs'), proc, child, calls, logs};
  }

  function pipelineHarness({beforeExecution, onReadyWrite, failCleanup = false, failReady = false} = {}) {
    const proc = new EventEmitter();
    Object.assign(proc, {env: {NS2_RPC_ENABLED: '1', NS2_FTP_ENABLED: '0'}, pid: 12345,
      connected: true, disconnect() {this.connected = false; events.push('disconnect');}});
    const events = [], logs = [], snapshots = [];
    const ready = deferred();
    const acquisition = {report: 'acquisition.json', supervisorReport: 'supervisor.json', proof: {},
      retire: async () => {events.push('retire'); return {cleanedUp: true};},
      abandon: async () => {events.push('abandon');}};
    const save = async (filename, value) => {
      snapshots.push({filename, value: copy(value)});
      if (path.basename(filename) === 'rpc-ready.json') {
        events.push('marker:' + value.state);
        if (value.state === 'ready') {
          if (onReadyWrite) onReadyWrite(proc);
          if (failReady) throw Error('ready marker failure');
          ready.resolve();
        }
      }
    };
    const read = async filename => {
      if (filename === acquisition.report)
        return {retainedMemory: {captures: [{length: 0x4d8000}], promoted: true}, nativeRo: {}};
      if (filename.endsWith('-layout.json')) return {sdk: 0x100000, target: {entry: 1}};
      if (filename.endsWith('-sm-proof.json')) return {export: {handle: 1}};
      if (filename.endsWith('-loader-root-copy.json')) return {copy: {handle: 2}};
      throw Error('Unexpected read ' + filename);
    };
    const run = async (directory, name) => {
      events.push('stage:' + name);
      assert.ok(!['fs-tree', 'fs-dump', 'fs-save'].includes(name), 'RPC must not run filesystem exports');
      if (name === 'qualify') return {verified: true, cleanedUp: true, cleanup: {finished: true}};
      if (name === 'test-gate') return {verified: true, restored: true};
      if (name === 'launch') return {imageAccepted: true, restored: true, pid: 12, file: 'launch.json'};
      return {};
    };
    const request = async value => {
      events.push(value.command);
      if (value.command === 'root-native-donor-prepare')
        return {ready: true, files: [{name: 'main', verified: true, sha256: 'payload-hash'}]};
      if (value.command === 'root-native-donor-cleanup') {
        if (failCleanup) throw Error('cleanup failure');
        return {cleanedUp: true};
      }
      return {result: 0, transport: 0, handle: 1};
    };
    const runtime = {read, save, local: (session, suffix) => session + suffix, hash: () => 'payload-hash',
      executionFile: 'execution.json', activate: async () => ({pid: 12, file: 'identity.json'}),
      probe: async () => ({pid: 12, file: 'proof.json'}), handoff: async () => ({file: 'handoff.json'})};
    const stubs = {
      'node:fs/promises': {writeFile: async () => {}, readFile: async () => Buffer.from('payload')},
      '../shared/rpc.cjs': {a: {session: 'switch2-test'}, request: async () => ({ready: true})},
      '../shared/stages.cjs': {run}, './tools/fs-memory.cjs': {connect: async () => ({request})},
      './ro/runtime.cjs': runtime, './cleanup-scratch.cjs': {main: async () => ({})},
      './acquire.cjs': {start: async () => acquisition}, './ro/layout.cjs': {main: async () => ({})},
      './ro/objects.cjs': {main: async () => ({})},
      './process/fs-execute.cjs': {main: async () => {
        events.push('execution-verified');
        if (beforeExecution) beforeExecution(proc);
        return {verified: true, restored: true};
      }},
      './process/ftp-session.cjs': {runFtpSession() {assert.fail('RPC must not start host FTP');}},
    };
    return {api: load(patched.pipeline, stubs, proc, logs, 'pipeline.cjs'), proc, events, logs, snapshots, ready};
  }

  test('the exact source transformation compiles and rejects changed or duplicate anchors', () => {
    for (const [name, source] of Object.entries(patched)) assert.doesNotThrow(() => new vm.Script(source, {filename: name}));
    assert.throws(() => patchSources({...originals, runner: originals.runner.replace('options = {ftp:', 'options = {changed:')}), /options anchor/);
    assert.throws(() => patchSources({...originals, pipeline: originals.pipeline + "\n  const ftpMode = process.env.NS2_FTP_ENABLED === '1';"}), /held modes anchor/);
    assert.throws(() => patchSources(patched), /anchor/);
  });

  test('--rpc is accepted and rejects either FTP option in either order', () => {
    const {api} = runnerHarness();
    assert.deepEqual(copy(api.parseOptions(['192.168.1.8', '--rpc'])),
      {ftp: false, rpc: true, ftpPort: 2121, hostArgs: ['192.168.1.8']});
    for (const args of [['--rpc', '--ftp'], ['--ftp', '--rpc'],
      ['--rpc', '--ftp-port', '2122'], ['--ftp-port', '2122', '--rpc']])
      assert.throws(() => api.parseOptions(args), /cannot be combined/);
    assert.equal(api.parseOptions(['--ftp']).ftp, true);
  });

  for (const stopping of ['q', 'SIGINT', 'SIGTERM']) test('runner forwards ' + stopping + ' once and exposes RPC output', async () => {
    const {api, proc, child, calls, logs} = runnerHarness();
    const done = api.runEngine('mock-run', {rpc: true});
    await tick();
    const spawn = calls.find(call => call[0] === 'spawn');
    assert.equal(spawn[3].env.NS2_RPC_ENABLED, '1');
    assert.equal(spawn[3].env.NS2_FTP_ENABLED, '0');
    assert.equal(spawn[3].stdio.at(-1), 'ipc');
    child.stdout.write('RPC ready: mock-run\ninternal detail\n');
    if (stopping === 'q') proc.stdin.write('q\n'); else proc.emit(stopping);
    proc.emit('SIGINT');
    assert.deepEqual(copy(calls.filter(call => call[0] === 'send')), [['send', {type: 'ns2-rpc-stop'}]]);
    assert.ok(logs.includes('RPC ready: mock-run'));
    assert.ok(!logs.includes('internal detail'));
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    await done;
    assert.equal(proc.listenerCount('SIGINT'), 0);
    assert.equal(proc.listenerCount('SIGTERM'), 0);
    assert.ok(calls.some(call => call[0] === 'log-close'));
    assert.ok(!calls.some(call => call[0] === 'kill'));
  });

  for (const stopping of ['message', 'SIGINT', 'SIGTERM', 'disconnect'])
    test('RPC holds resources then closes its marker before cleanup on ' + stopping, async () => {
      const h = pipelineHarness();
      const done = h.api.main();
      await h.ready.promise;
      await tick();
      assert.ok(!h.events.includes('root-native-donor-cleanup'));
      assert.ok(!h.events.includes('retire'));
      assert.ok(h.logs.some(line => line.startsWith('RPC ready: ')));
      const published = h.snapshots.find(row => path.basename(row.filename) === 'rpc-ready.json').value;
      assert.equal(published.session, 'switch2-test');
      assert.equal(published.pid, 12345);
      assert.equal(published.state, 'ready');
      assert.ok(Number.isFinite(Date.parse(published.started)));
      if (stopping === 'message') h.proc.emit('message', {type: 'ns2-rpc-stop'}); else h.proc.emit(stopping);
      await done;
      const closed = h.events.indexOf('marker:closed');
      const cleanup = h.events.indexOf('root-native-donor-cleanup');
      assert.ok(h.events.indexOf('execution-verified') < h.events.indexOf('marker:ready'));
      assert.ok(closed > h.events.indexOf('marker:ready') && closed < cleanup);
      assert.ok(cleanup < h.events.indexOf('retire'));
      assert.equal(h.snapshots.filter(row => path.basename(row.filename) === 'rpc-ready.json').at(-1).value.state, 'closed');
      for (const event of ['message', 'SIGINT', 'SIGTERM', 'disconnect']) assert.equal(h.proc.listenerCount(event), 0);
      assert.equal(h.proc.connected, false);
    });

  test('a stop before verification finishes never advertises ready and still cleans up', async () => {
    const h = pipelineHarness({beforeExecution: proc => proc.emit('SIGTERM')});
    await h.api.main();
    assert.ok(!h.events.includes('marker:ready'));
    assert.ok(h.events.indexOf('marker:closed') < h.events.indexOf('root-native-donor-cleanup'));
    assert.ok(h.events.includes('retire'));
  });

  test('cleanup failure leaves RPC closed and removes listeners', async () => {
    const h = pipelineHarness({failCleanup: true});
    const done = h.api.main();
    await h.ready.promise;
    h.proc.emit('SIGINT');
    await assert.rejects(done, /cleanup failure/);
    assert.ok(h.events.includes('abandon'));
    assert.equal(h.snapshots.filter(row => path.basename(row.filename) === 'rpc-ready.json').at(-1).value.state, 'closed');
    for (const event of ['message', 'SIGINT', 'SIGTERM', 'disconnect']) assert.equal(h.proc.listenerCount(event), 0);
  });

  test('failure publishing the ready marker still closes the marker and listeners', async () => {
    const h = pipelineHarness({failReady: true});
    await assert.rejects(h.api.main(), /ready marker failure/);
    assert.ok(h.events.indexOf('marker:closed') < h.events.indexOf('abandon'));
    assert.equal(h.snapshots.filter(row => path.basename(row.filename) === 'rpc-ready.json').at(-1).value.state, 'closed');
    for (const event of ['message', 'SIGINT', 'SIGTERM', 'disconnect']) assert.equal(h.proc.listenerCount(event), 0);
  });

  test('a stop while publishing ready skips the ready announcement and closes before cleanup', async () => {
    const h = pipelineHarness({onReadyWrite: proc => proc.emit('SIGTERM')});
    await h.api.main();
    assert.ok(!h.logs.some(line => line.startsWith('RPC ready: ')));
    assert.ok(h.events.indexOf('marker:closed') < h.events.indexOf('root-native-donor-cleanup'));
  });

  test('RPC stages preload the existing Ctrl+C handler and acquisition defers SIGINT', async () => {
    const proc = new EventEmitter();
    Object.assign(proc, {env: {NS2_RPC_ENABLED: '1'}, pid: 12345});
    const stages = load(patched.stages, {}, proc);
    const args = stages.nodeArguments('stage.cjs', ['one']);
    assert.equal(args[0], '--require');
    assert.ok(args[1].endsWith('managed-interrupt.cjs'));
    assert.deepEqual(copy(args.slice(2)), ['stage.cjs', 'one']);
    const runControl = load(patched.runControl, {
      './local-endpoint.cjs': {scratch: async () => 'mock-scratch'},
      '../../shared/atomic-write.cjs': {}, 'node:fs/promises': {rmdir: async () => {}},
    }, proc);
    const control = new runControl.RunControl({id: 'test', save: async () => {}});
    await control.start();
    proc.emit('SIGINT');
    assert.equal(control.state.mode, 'running');
    proc.emit('SIGTERM');
    assert.equal(control.state.mode, 'stopping');
    await control.close();
    assert.equal(proc.listenerCount('SIGINT'), 0);
    assert.equal(proc.listenerCount('SIGTERM'), 0);
  });
}

const sourceDirectory = process.env.OUNCECAKE_NS2JB_SOURCE;
if (sourceDirectory === undefined) {
  test('ns2jb host source integration tests', {
    skip: 'Set OUNCECAKE_NS2JB_SOURCE to a compatible, unpatched Windows ns2jb-ftp source directory.',
  }, () => {});
} else {
  if (!sourceDirectory.trim()) throw new Error('OUNCECAKE_NS2JB_SOURCE must name a source directory');
  registerHostSourceTests(path.resolve(sourceDirectory));
}
