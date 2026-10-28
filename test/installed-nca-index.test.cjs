const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndex } = require('../engine/mounts.cjs');

test('filesystem aliases preserve the raw path and NCA size above 4 GiB', () => {
  const actual = '/registered/000000D5/' + 'a'.repeat(32) + '.nca';
  const index = buildIndex([{ path: '/installed/title/updates/655360', kind: 'filesystem', mount: 0,
    entries: [{ type: 'file', path: '/' + 'a'.repeat(32) + '.nca', sourcePath: actual, size: 7298181632 }] }]);
  const count = Number(index.readBigUInt64LE(16));
  const strings = Number(index.readBigUInt64LE(32));
  const nodes = Array.from({ length: count }, (_, i) => index.subarray(64 + i * 48, 64 + (i + 1) * 48));
  const node = nodes.find(row => row.readUInt32LE(12) === 1);
  const at = strings + node.readUInt32LE(28);
  assert.equal(index.toString('utf8', at, index.indexOf(0, at)), actual);
  assert.equal(node.readBigUInt64LE(40), 7298181632n);
});

test('invalid raw filesystem aliases cannot enter the native index', () => {
  for (const sourcePath of ['relative.nca', '/registered/../x', '/registered\\x', '/x\0y', '/' + 'x'.repeat(769)]) {
    assert.throws(() => buildIndex([{ path: '/installed', kind: 'filesystem', mount: 0,
      entries: [{ type: 'file', path: '/test.nca', sourcePath, size: 1 }] }]), /filesystem source path/);
  }
});
