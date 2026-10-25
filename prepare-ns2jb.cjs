#!/usr/bin/env node
// Prepare an isolated RPC-only host from the user's Windows ns2jb-ftp package.
const fs = require('node:fs/promises');
const path = require('node:path');
const { patchSources } = require('./integration/patch-ns2jb.cjs');

async function prepare(source, destination = path.join(__dirname, 'ns2jb-host')) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  const files = {
    runner: 'run.cjs',
    pipeline: 'engine/switch2/pipeline.cjs',
    stages: 'engine/shared/stages.cjs',
    runControl: 'engine/switch2/memory/run-control.cjs',
  };
  const original = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) =>
    [key, await fs.readFile(path.join(source, file), 'utf8')])));
  // Validate the source revision before creating or copying anything.
  const patched = patchSources(original);
  await fs.access(path.join(source, 'bootstrap.bas'));
  await fs.mkdir(destination); // Refuse to overwrite an earlier host or its runs.
  await fs.cp(path.join(source, 'engine'), path.join(destination, 'engine'), { recursive: true });
  await fs.copyFile(path.join(source, 'bootstrap.bas'), path.join(destination, 'bootstrap.bas'));
  for (const [key, file] of Object.entries(files)) {
    await fs.writeFile(path.join(destination, file), patched[key]);
  }
  await fs.writeFile(path.join(destination, 'source.json'), JSON.stringify({
    source, prepared: new Date().toISOString(), mode: 'ouncecake-rpc',
  }, null, 2) + '\n');
  console.log('Prepared RPC host: ' + destination);
  console.log('Start with NS2JB-RPC.cmd, then OUNCECAKE-START.cmd after RPC ready.');
  return destination;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node prepare-ns2jb.cjs <ns2jb-ftp-folder> [new-host-folder]');
  } else if (args.length < 1 || args.length > 2) {
    console.error('Usage: node prepare-ns2jb.cjs <ns2jb-ftp-folder> [new-host-folder]');
    process.exitCode = 1;
  } else {
    prepare(...args).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { prepare };
