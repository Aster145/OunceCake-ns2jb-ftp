const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { buildIndex } = require('../engine/mounts.cjs');

const identity = Object.freeze({
  route: 'ncm-gamecard-path', handle: 0, applicationTitle: '0100965017338000',
  contentId: '12a4f22ba0c98538e4f163df86186e39', version: 0,
  contentPath: '@GcS00000000://12a4f22ba0c98538e4f163df86186e39.nca',
});

function fixture({ initialError, recheckError } = {}) {
  const events = [];
  const live = new Set();
  const closed = [];
  const attachment = {
    live: { platform: 2 }, root: 1,
    domain: { oneHandle: reply => reply.handle },
    s: {
      handles: live,
      ipc: async (label, handle, command, input) => {
        assert.equal(handle, 1);
        assert.equal(command, 31, 'Switch 2 must not call DeviceOperator 400/200/202/203');
        assert.equal(input.length, 8);
        assert.equal(input.readUInt32LE(), 0, 'zero is a valid card handle');
        const partition = input.readUInt32LE(4);
        events.push('open:' + partition);
        const result = 100 + partition;
        live.add(result);
        return { result: 0, handle: result };
      },
      close: async handle => {
        assert.ok(live.delete(handle));
        closed.push(handle);
      },
    },
  };
  const filename = path.resolve(__dirname, '../engine/card-partitions.cjs');
  const localRequire = createRequire(filename);
  const dependencies = {
    './mounts.cjs': {
      buildIndex,
      createGameFiles: actual => {
        assert.equal(actual, attachment);
        return { list: async (mount, directory) => {
          assert.equal(directory, '/');
          const partition = mount.handle - 100;
          events.push('list:' + partition);
          return partition === 1 ? [] : [{ name: 'test.nca', type: 'file', size: 16 }];
        } };
      },
    },
    './card-identity.cjs': {
      readCardIdentity: async options => {
        assert.equal(options.attachment, attachment);
        if (options.previous) {
          assert.equal(options.previous, identity, 'pin the original complete identity');
          events.push('recheck');
          if (recheckError) throw recheckError;
        } else {
          events.push('identify');
          if (initialError) throw initialError;
        }
        return identity;
      },
    },
  };
  const context = {
    Buffer, module: { exports: {} },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { ...context.module.exports, attachment, events, live, closed };
}

test('Switch 2 enumerates four partitions between pinned NCM identity checks without legacy commands', async () => {
  const f = fixture();
  const result = await f.prepareCardPartitions({ attachment: f.attachment });
  assert.deepEqual(f.events, ['identify', 'open:0', 'list:0', 'open:1', 'list:1',
    'open:2', 'list:2', 'open:3', 'list:3', 'recheck']);
  assert.equal(result.cardMetadata, identity);
  assert.equal(result.sources.length, 4);
  assert.equal(result.partitionReport[1].status, 'empty');
  assert.equal(result.index.subarray(0, 8).toString(), 'NS2FTPIX');
  assert.deepEqual([...f.live], [100, 101, 102, 103]);
});

test('failed Switch 2 identity recheck closes every partition instead of returning FTP sources', async () => {
  const changed = Object.assign(new Error('Card changed'), { code: 'CARD_CHANGED' });
  const f = fixture({ recheckError: changed });
  await assert.rejects(f.prepareCardPartitions({ attachment: f.attachment }), error => {
    assert.equal(error.code, 'CARD_CHANGED');
    assert.equal(error.cardMetadata, identity);
    return true;
  });
  assert.deepEqual(f.closed, [103, 102, 101, 100]);
  assert.equal(f.live.size, 0);
});

test('unindexed Switch 2 card does not attempt partitions or legacy interface fallback', async () => {
  const missing = Object.assign(new Error('No card metadata'), { code: 'CARD_NOT_INDEXED' });
  const f = fixture({ initialError: missing });
  await assert.rejects(f.prepareCardPartitions({ attachment: f.attachment }), { code: 'CARD_NOT_INDEXED' });
  assert.deepEqual(f.events, ['identify']);
  assert.equal(f.live.size, 0);
});
