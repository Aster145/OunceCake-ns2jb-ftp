const { discoverApplications, resolveProgramContent } = require('./content.cjs');
const { throwIfCancelled } = require('./protocol.cjs');

// NCM may know an application without an available Program entry. These are
// absence results, not permission or transport failures.
// Module 5: ContentNotFound (5), ContentMetaNotFound (7),
// ContentInfoNotFound (220), GameCardContentStorageNotActive (251), and
// GameCardContentMetaDatabaseNotActive (261). Values are (description << 9) | 5.
// https://github.com/Atmosphere-NX/Atmosphere/blob/master/libraries/libvapours/include/vapours/results/ncm_results.hpp
const absent = new Set([0xa05, 0xe05, 0x1b805, 0x1f605, 0x20a05]);
const identityFields = ['handle', 'applicationTitle', 'contentId', 'contentPath', 'version'];

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function identityFromSource(applicationTitle, source) {
  // A handle of zero is valid. The observed Switch 2 path also has two slashes
  // after the colon; preserve the exact path when checking card continuity.
  const match = typeof source.contentPath === 'string' &&
    /^@Gc[UNS]([0-9a-fA-F]{8}):\/{1,2}[^\/\\\0\r\n][^\\\0\r\n]*$/.exec(source.contentPath);
  if (source.storage !== 2 || !match) {
    throw failure('CARD_PATH_UNSUPPORTED',
      'NCM did not return a game-card partition path for the selected card application');
  }
  return {
    handle: Number.parseInt(match[1], 16),
    route: 'ncm-gamecard-path',
    applicationTitle,
    contentId: source.contentId,
    contentPath: source.contentPath,
    version: source.version,
  };
}

async function readCardIdentity({ attachment, shouldStop = () => false, previous }) {
  throwIfCancelled(shouldStop);

  const resolve = async applicationTitle => {
    throwIfCancelled(shouldStop);
    const source = await resolveProgramContent({
      ...attachment, storage: 2, title: applicationTitle, update: undefined,
    });
    throwIfCancelled(shouldStop);
    return identityFromSource(applicationTitle, source);
  };

  if (previous) {
    let current;
    try {
      current = await resolve(previous.applicationTitle);
    } catch (error) {
      if (error.code === 'CARD_PATH_UNSUPPORTED' || absent.has(error.nativeResult?.canonical)) {
        throw failure('CARD_CHANGED',
          'The selected game card is no longer available through the same NCM content path', error);
      }
      throw error;
    }
    if (identityFields.some(field => current[field] !== previous[field])) {
      throw failure('CARD_CHANGED', 'The game-card identity changed during partition preparation');
    }
    return current;
  }

  const applications = await discoverApplications({ ...attachment, storages: [2], shouldStop });
  throwIfCancelled(shouldStop);
  let lastMissing;
  for (const application of applications) {
    throwIfCancelled(shouldStop);
    if (application.storage !== 2) {
      throw failure('CARD_PATH_UNSUPPORTED', 'Card discovery returned an unexpected storage');
    }
    try {
      return await resolve(application.contentTitle);
    } catch (error) {
      if (!absent.has(error.nativeResult?.canonical)) throw error;
      lastMissing = error;
    }
  }
  throw failure('CARD_NOT_INDEXED',
    'NCM has no readable Program metadata for the game card; this does not prove that no card is inserted',
    lastMissing);
}

module.exports = { readCardIdentity };
