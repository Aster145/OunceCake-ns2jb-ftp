const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveCardReport } = require('../engine/card-report.cjs');

test('saved partition report keeps raw metadata and does not claim downloaded files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ouncecake-card-report-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ouncecake-card-report-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const filename = await saveCardReport({ run: 'a-run', cardMetadata: { handle: 7,
    updatePartitionInfo: { versionRaw: 1234, titleId: '0100000000000816' } },
    partitionReport: [{ name: 'update', status: 'ready', files: 3 }, { name: 'logo', status: 'missing' }],
  }, dir);
  const report = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(report.cardMetadata.updatePartitionInfo.versionRaw, 1234);
  assert.equal(report.prepared, true);
  assert.equal(report.transferVerified, false);
  assert.equal(report.partitions[1].status, 'missing');
});
