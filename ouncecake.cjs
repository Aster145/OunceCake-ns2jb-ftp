#!/usr/bin/env node
const path = require('node:path');
const { createInterface } = require('node:readline');
const { titleId, withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { discoverGames } = require('./engine/content.cjs');
const { prepareGame } = require('./engine/mounts.cjs');
const { prepareCardPartitions } = require('./engine/card-partitions.cjs');
const { saveCardReport } = require('./engine/card-report.cjs');
const { deployFtp, readImage } = require('./engine/ftp.cjs');
const { resolveRun } = require('./engine/run-directory.cjs');

const USAGE = 'Usage: node ouncecake.cjs <run-directory> [title-id] [--port 2121] [--base-only] [--check]\n' +
              '   or: node ouncecake.cjs --ns2jb <host-folder> [title-id] [--port 2121] [--base-only] [--check]\n' +
              'Use the run dir given by ns2jb (Run folder: <whatever>)\n' +
              '--ns2jb selects the single live RPC run created by NS2JB-RPC.cmd.\n' +
              '--check only checks the run files and local bridge status.\n' +
              '--base-only mounts only /base/romfs and /base/exefs; excludes updates and DLC.\n' +
              '--card-partitions exports inserted-card Update/Normal/Secure/Logo files; no title ID.\n' +
              'You can also provide a title ID to skip the selection menu and just mount a specific game\n';

function getArgs(argv) {
  const args = [];
  let port = 2121;
  let ns2jb;
  let check = false;
  let baseOnly = false;
  let cardPartitions = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help') {
      return { help: true };
    }

    if (a === '--check') { check = true; continue; }
    if (a === '--base-only') { baseOnly = true; continue; }
    if (a === '--card-partitions') { cardPartitions = true; continue; }
    if (a === '--ns2jb') {
      const folder = argv[++i];
      if (!folder || folder.startsWith('--') || ns2jb) throw Error('--ns2jb requires one host folder');
      ns2jb = path.resolve(folder);
      continue;
    }

    if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Invalid --port value\n' + USAGE);
      }
      continue;
    }

    if (a.startsWith('--')) {
      throw new Error('Unknown option: ' + a + '\n' + USAGE);
    }

    args.push(a);
  }

  if (ns2jb) {
    if (args.length > 1) throw Error(USAGE);
    if (cardPartitions && (baseOnly || args.length)) throw Error('--card-partitions cannot be combined with --base-only or a title ID');
    return { ns2jb, title: args.length ? titleId(args[0]) : undefined, port, check, baseOnly, cardPartitions };
  }
  if (args.length < 1 || args.length > 2) {
    throw new Error(USAGE);
  }

  if (args.length === 1 && /^(?:0x)?[0-9a-fA-F]{16}$/.test(args[0])) {
    throw new Error('You need to add a run directory\n' + USAGE);
  }

  const title = args.length === 2 ? titleId(args[1]) : undefined;
  if (cardPartitions && (baseOnly || title)) throw Error('--card-partitions cannot be combined with --base-only or a title ID');
  return { run: path.resolve(args[0]), title, port, check, baseOnly, cardPartitions };
}

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };

function printCardPartitions(partitions) {
  for (const partition of partitions) {
    console.log('/card/' + partition.name + ': ' + partition.status +
      ' | files=' + (partition.files ?? 0) + ' | bytes=' + (partition.bytes ?? 0) +
      (partition.error ? ' | ' + partition.error : ''));
  }
}

function gameMenu(games) {
  const width = String(games.length).length;
  return games
    .map((game, i) => {
      const number = String(i + 1).padStart(width);
      const name = game.name || 'Unknown title';
      const storages = game.storages.map((id) => storageNames[id]).join(', ');
      return number + '. ' + name + '  [' + game.title.toUpperCase() + ']  (' + storages + ')';
    })
    .join('\n');
}

async function pickGame(games, signal) {
  const input = process.stdin;
  const output = process.stdout;

  if (!games.length) {
    throw new Error('No games were found. How did you even run this?');
  }

  output.write(gameMenu(games) + '\n');

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const close = () => rl.close();
  rl.once('SIGINT', close);
  signal.addEventListener('abort', close, { once: true });

  const prompt = () => output.write('Choose a game: ');

  try {
    if (signal.aborted) return null;

    prompt();

    for await (const line of lines) {
      if (signal.aborted) return null;

      const value = line.trim();

      if (/^q(?:uit)?$/i.test(value)) return null;

      if (/^[0-9]+$/.test(value)) {
        const number = Number(value);

        if (Number.isSafeInteger(number) && number >= 1 && number <= games.length) return games[number - 1];
      }

      output.write('Enter a number from 1 to ' + games.length + ', or q.\n');
      prompt();
    }

    return null;
  } finally {
    signal.removeEventListener('abort', close);
    rl.close();
  }
}

async function waitForStop(signal, stop) {
  if (signal.aborted) return;
  let rl;
  let finished;
  const stopped = new Promise(resolve => { finished = resolve; });
  const line = value => { if (/^q(?:uit)?$/i.test(value.trim())) stop(); };
  signal.addEventListener('abort', finished, { once: true });
  // The FTP thread runs on the console. Keep its owner alive even after stdin
  // reaches EOF; a pending Promise and signal listeners do not keep Node alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const input = process.stdin;
    const output = process.stdout;
    if (input && typeof input.on === 'function' && !input.destroyed && !input.readableEnded) {
      rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output?.isTTY) });
      rl.on('line', line);
      rl.on('SIGINT', stop);
    }
    if (!signal.aborted) await stopped;
  } finally {
    clearInterval(keepAlive);
    signal.removeEventListener('abort', finished);
    if (rl) {
      rl.removeListener('line', line);
      rl.removeListener('SIGINT', stop);
      rl.close();
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = getArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const run = await resolveRun(options);
  console.log('Run folder: ' + run);
  if (options.check) {
    console.log('Connection check passed: local RPC is ready; no game was mounted.');
    return;
  }
  if (options.baseOnly) {
    console.log('Base-only mode: only /base/romfs and /base/exefs; updates and DLC are excluded.');
  }
  if (options.cardPartitions) {
    console.log('Card-partition mode: read-only Update / Normal / Secure / Logo files from the inserted card.');
    console.log('This exposes partition files, not a byte-identical XCI image.');
  }
  const image = await readImage();
  const { port } = options;
  let { title } = options;
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let attachment;
  let server;
  await withCleanup(async () => {
    attachment = await attachGame(run);
    const shouldStop = () => cancellation.signal.aborted;
    if (!options.cardPartitions && !title) {
      const selected = await pickGame(await discoverGames({ ...attachment, shouldStop }), cancellation.signal);
      if (!selected || shouldStop()) return;
      title = selected.title;
    }
    let prepared;
    if (options.cardPartitions) {
      try {
        prepared = await prepareCardPartitions({ attachment, shouldStop });
      } catch (error) {
        const report = await saveCardReport({ run, partitionReport: error.partitionReport || [],
          cardMetadata: error.cardMetadata, error: { code: error.code, message: error.message } });
        printCardPartitions(error.partitionReport || []);
        console.log('Card partition report: ' + report);
        throw error;
      }
      const report = await saveCardReport({ run, partitionReport: prepared.partitionReport,
        cardMetadata: prepared.cardMetadata });
      printCardPartitions(prepared.partitionReport);
      console.log('Card partition report: ' + report);
    } else {
      prepared = await prepareGame({ attachment, title, shouldStop, baseOnly: options.baseOnly });
    }
    if (shouldStop()) return;
    server = await deployFtp({ attachment, image, ...prepared, port });
    console.log('FTP up! ftp://<switch 2 ip>:' + port);
    console.log('Type q or quit and press Enter (or Ctrl-C) to stop. Wait for "Stopped" before closing NS2JB-RPC.');
    await waitForStop(cancellation.signal, stop);
  }, () => server?.close(), () => attachment?.close(), () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
  if (server) console.log('Stopped. OunceCake FTP and its resources are closed; you may now stop NS2JB-RPC.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getArgs, pickGame, main };
