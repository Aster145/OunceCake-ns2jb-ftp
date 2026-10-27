const fs = require('node:fs/promises');
const path = require('node:path');

async function saveCardReport({ run, cardMetadata, partitionReport, error }, directory = path.join(__dirname, '..', 'reports')) {
  await fs.mkdir(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  const filename = path.join(directory, 'card-partitions-' + createdAt.replace(/[:.]/g, '-') + '-' + process.pid + '.json');
  await fs.writeFile(filename, JSON.stringify({
    format: 'ouncecake-card-partitions-v1', createdAt, run,
    scope: 'Files inside accessible game-card partitions; excludes outer XCI image headers, certificates and padding.',
    prepared: !error,
    transferVerified: false,
    cardMetadata, partitions: partitionReport, error,
  }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return filename;
}

module.exports = { saveCardReport };
