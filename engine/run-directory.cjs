const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

// Only the local bridge status is queried here. No console memory calls or writes.
function bridgeReady(connection, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: connection.port, path: '/', method: 'POST',
      headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
    }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(parts).toString());
          if (response.statusCode !== 200 || result.ready !== true) throw Error('RPC is not ready');
          resolve(true);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Error('RPC status timed out')));
    request.on('error', reject);
    request.end(JSON.stringify({ command: 'status' }));
  });
}

async function inspectRun(run, { requireMarker = false, probe = bridgeReady } = {}) {
  run = path.resolve(run);
  const engine = path.join(run, 'switch2');
  const connection = await readJson(path.join(run, 'connection.json'));
  const session = connection.addresses?.session;
  if (connection.addresses?.platform !== 2 || typeof session !== 'string' ||
      session !== path.basename(run) || !Number.isInteger(connection.port) ||
      connection.port < 1 || connection.port > 65535) {
    throw Error('Not a Switch 2 run directory');
  }
  let marker;
  try { marker = await readJson(path.join(engine, 'rpc-ready.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (requireMarker && !marker || marker && (marker.state !== 'ready' || marker.session !== session)) {
    throw Error('RPC host is not holding this run; start NS2JB-RPC.cmd and wait for RPC ready');
  }
  const current = await readJson(path.join(engine, 'current-acquisition.json'));
  const root = await readJson(path.join(engine, 'ro/root/current-root.json'));
  if (current.session !== session || root.session !== session ||
      typeof current.socketPath !== 'string' || !current.socketPath ||
      !Number.isInteger(root.rootHandle) || root.rootHandle <= 0) {
    throw Error('FS state does not belong to this run');
  }
  for (const file of ['app/session.cjs', 'app/domain.cjs', 'app/filesystem.cjs',
    'tools/fs-memory.cjs', 'ro/' + session + '-layout.json', 'ro/' + session + '-loader-root-copy.json']) {
    await fs.access(path.join(engine, file));
  }
  // Windows named pipes are not filesystem entries: do not fs.access(socketPath).
  await probe(connection);
  return run;
}

async function resolveRun({ run, ns2jb }, options = {}) {
  if (run) {
    try { return await inspectRun(run, options); }
    catch (error) { throw Error('Cannot attach to ' + run + ': ' + error.message); }
  }
  const folder = path.join(ns2jb, 'runs');
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Error('No RPC runs found. Start NS2JB-RPC.cmd and wait for RPC ready.');
  }
  const live = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('switch2-')) continue;
    try {
      live.push(await inspectRun(path.join(folder, entry.name), { ...options, requireMarker: true }));
    } catch { /* Incomplete, closed, or disconnected runs cannot be selected. */ }
  }
  if (!live.length) throw Error('No live RPC run found. Start NS2JB-RPC.cmd and wait for RPC ready.');
  if (live.length > 1) throw Error('Multiple live runs found. Pass one Run folder explicitly:\n' + live.join('\n'));
  return live[0];
}

module.exports = { bridgeReady, inspectRun, resolveRun };
