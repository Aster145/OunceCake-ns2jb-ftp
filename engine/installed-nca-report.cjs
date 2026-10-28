const fs = require('node:fs/promises');
const path = require('node:path');

async function saveInstalledNcaReport({ run, manifest }, directory = path.join(__dirname, '..', 'reports')) {
  await fs.mkdir(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  const filename = path.join(directory,
    'installed-nca-' + createdAt.replace(/[:.]/g, '-') + '-' + process.pid + '.json');
  await fs.writeFile(filename, JSON.stringify({
    format: 'ouncecake-installed-nca-v1', createdAt, run,
    prepared: true, transferVerified: false,
    scope: 'Raw NCA files registered for this application in internal User content storage. No tickets, keys, saves or SD/card files.',
    ...manifest,
  }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return filename;
}

module.exports = { saveInstalledNcaReport };
