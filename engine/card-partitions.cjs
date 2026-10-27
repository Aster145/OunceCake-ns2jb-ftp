const { createGameFiles, buildIndex } = require('./mounts.cjs');
const { success, cleanup, throwIfCancelled } = require('./protocol.cjs');
const { readCardIdentity } = require('./card-identity.cjs');

// FsGameCardPartition values used by OpenGameCardFileSystem (IFileSystemProxy:31).
const PARTITIONS = [
  { name: 'update', partition: 0 },
  { name: 'normal', partition: 1 },
  { name: 'secure', partition: 2 },
  { name: 'logo', partition: 3 },
];

async function prepareCardPartitions({ attachment: a, shouldStop = () => false }) {
  const { s, root, domain } = a;
  const files = createGameFiles(a);
  const views = [];
  const sources = [];
  const opened = [];
  const partitionReport = PARTITIONS.map(partition => ({
    ...partition,
    path: '/card/' + partition.name,
    status: 'not-attempted',
    files: 0,
    directories: 0,
    bytes: 0,
  }));
  const cancelled = () => throwIfCancelled(shouldStop);
  let operator;
  let cardMetadata;
  const useNcmIdentity = a.live?.platform === 2;

  async function cardIdentity(final = false) {
    cancelled();
    const inserted = success(await s.ipc('IsGameCardInserted', operator, 200), 'IsGameCardInserted');
    if (!Buffer.isBuffer(inserted.data) || inserted.data.length < 1) {
      throw new Error('IsGameCardInserted returned no insertion state');
    }
    if (!inserted.data[0]) {
      throw Object.assign(new Error(final
        ? 'The game card was removed during preparation. FTP was not started.'
        : 'No game card is inserted. FTP was not started.'), {
        code: final ? 'CARD_CHANGED' : 'CARD_NOT_INSERTED',
      });
    }
    cancelled();
    const reply = success(await s.ipc('GetGameCardHandle', operator, 202), 'GetGameCardHandle');
    if (!Buffer.isBuffer(reply.data) || reply.data.length < 4) {
      throw new Error('GetGameCardHandle returned no card handle');
    }
    return reply.data.readUInt32LE(0);
  }

  async function listPartition(handle) {
    const pending = ['/'];
    const entries = [];
    while (pending.length) {
      cancelled();
      const directory = pending.pop();
      for (const item of await files.list({ handle, kind: 'filesystem' }, directory, shouldStop)) {
        if (!item.name || /[\/\\\0]/.test(item.name) || item.name === '.' || item.name === '..') {
          throw new Error('Invalid game-card directory entry name');
        }
        const entry = {
          path: directory.replace(/\/$/, '') + '/' + item.name,
          type: item.type,
          size: item.size,
        };
        entries.push(entry);
        if (entry.type === 'directory') pending.push(entry.path);
      }
    }
    return entries;
  }

  try {
    cancelled();
    if (useNcmIdentity) {
      cardMetadata = await readCardIdentity({ attachment: a, shouldStop });
    } else {
      operator = domain.oneHandle(success(
        await s.ipc('OpenDeviceOperator', root, 400), 'OpenDeviceOperator',
      ));
      cardMetadata = { handle: await cardIdentity() };
    }
    const cardHandle = cardMetadata.handle;
    if (!useNcmIdentity) {
      const metadataInput = Buffer.alloc(4);
      metadataInput.writeUInt32LE(cardHandle);
      try {
        cancelled();
        const metadata = success(await s.ipc(
          'GetGameCardUpdatePartitionInfo', operator, 203, metadataInput,
        ), 'GetGameCardUpdatePartitionInfo');
        if (!Buffer.isBuffer(metadata.data) || metadata.data.length < 16) {
          throw new Error('GetGameCardUpdatePartitionInfo returned incomplete metadata');
        }
        const versionRaw = metadata.data.readUInt32LE(0);
        cardMetadata.updatePartitionInfo = {
          versionRaw,
          versionHex: '0x' + versionRaw.toString(16).padStart(8, '0'),
          titleId: metadata.data.readBigUInt64LE(8).toString(16).padStart(16, '0'),
        };
      } catch (error) {
        if (error.code === 'FTP_CANCELLED') throw error;
        cardMetadata.updatePartitionInfo = { error: error.message };
        if (error.nativeResult) cardMetadata.updatePartitionInfo.result = error.nativeResult;
      }
    }

    for (const report of partitionReport) {
      cancelled();
      const input = Buffer.alloc(8);
      input.writeUInt32LE(cardHandle, 0);
      input.writeUInt32LE(report.partition, 4);
      const label = 'OpenGameCardFileSystem ' + report.name;
      let handle;
      try {
        handle = domain.oneHandle(success(await s.ipc(label, root, 31, input), label));
        opened.push(handle);
      } catch (error) {
        if (error.code === 'FTP_CANCELLED') throw error;
        report.status = error.nativeResult?.canonical === 0x7d202 ? 'missing' : 'error';
        report.error = error.message;
        if (error.nativeResult) report.result = error.nativeResult;
        continue;
      }

      try {
        const entries = await listPartition(handle);
        cancelled();
        report.files = entries.filter(entry => entry.type === 'file').length;
        report.directories = entries.length - report.files;
        report.bytes = entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.size : 0), 0);
        report.status = report.files ? 'ready' : 'empty';
        const mount = sources.length;
        sources.push({
          handle,
          kind: 1,
          size: 0,
          source: { cardHandle, partition: report.partition, name: report.name },
        });
        views.push({ path: report.path, mount, kind: 'filesystem', entries });
      } catch (error) {
        if (error.code === 'FTP_CANCELLED') throw error;
        report.status = 'error';
        report.error = error.message;
        if (error.nativeResult) report.result = error.nativeResult;
      }
    }

    // Never combine files from different insertions or silently reopen a replacement card.
    if (useNcmIdentity) {
      await readCardIdentity({ attachment: a, shouldStop, previous: cardMetadata });
    } else if (await cardIdentity(true) !== cardHandle) {
      throw Object.assign(new Error('The game card changed during preparation. FTP was not started.'), {
        code: 'CARD_CHANGED',
      });
    }
    cancelled();
    if (partitionReport.some(report => report.status === 'error')) {
      throw Object.assign(new Error('One or more game-card partitions could not be read. FTP was not started.'), {
        code: 'CARD_PARTITIONS_INCOMPLETE',
      });
    }
    if (!partitionReport.some(report => report.files > 0)) {
      throw Object.assign(new Error('No downloadable game-card files were found. FTP was not started.'), {
        code: 'CARD_FILES_EMPTY',
      });
    }
    const index = buildIndex(views);
    if (operator !== undefined) {
      const closing = operator;
      operator = undefined;
      await s.close(closing);
    }
    cancelled();
    return { index, sources, partitionReport, cardMetadata };
  } catch (failure) {
    const steps = opened.reverse().map(handle => () => s.close(handle));
    if (operator !== undefined) steps.push(() => s.close(operator));
    try {
      await cleanup(steps, failure);
    } catch (error) {
      error.partitionReport = partitionReport;
      error.cardMetadata = cardMetadata;
      throw error;
    }
  }
}

module.exports = { prepareCardPartitions };
