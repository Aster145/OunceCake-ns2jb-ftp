const path = require('node:path');

const FS_PROGRAM_ID = '0400000000000000';
const MIN_POINTER = 0x100000000n;
const MAX_POINTER = 0x8000000000n;
const hex = value => '0x' + BigInt(value).toString(16);
const check = (ok, message) => { if (!ok) throw new Error(message); };

function mappingDescription(info) {
  const m = info?.memory;
  return m
    ? `mapping address=${m.address} size=${m.size} type=${m.type} attributes=${m.attributes} permissions=${m.permissions}`
    : `query result=${info?.result} queryResult=${info?.queryResult}`;
}

function readableRange(info, address, length, pid) {
  check(info?.result === 0 && info.queryResult === 0, 'RO memory query failed');
  check(info.programId === FS_PROGRAM_ID && info.pid === pid, 'RO query returned a different FS identity');
  const m = info.memory;
  check(m && Number.isInteger(m.type) && m.type > 0 &&
    Number.isInteger(m.permissions) && (m.permissions & 1), 'Target range is not mapped and readable');
  const start = BigInt(m.address), size = BigInt(m.size);
  check(size > 0n && start <= BigInt(address) && BigInt(address) + BigInt(length) <= start + size,
    'Target range crosses its readable mapping');
}

// The retained IStorage reader stalls on these FS image globals on observed
// runs. Query first, then use the existing RO process reader without fallback.
async function readFsGlobalPointer(attachment, layout, offset, label, deps = {}) {
  let client;
  let opened = false;
  let address;
  let mapping;
  let failure;
  try {
    check(Number.isSafeInteger(layout?.rootVptr) && Number.isSafeInteger(offset), 'Invalid FS layout offset');
    address = layout.rootVptr - 0x2b1420 + offset;
    check(Number.isSafeInteger(address) && BigInt(address) >= MIN_POINTER &&
      BigInt(address) + 8n <= MAX_POINTER, 'FS global address is noncanonical');
    check(address % 0x1000 + 8 <= 0x1000, 'FS global crosses the RO reader page boundary');
    const Client = deps.Client || require(path.join(attachment.run, 'switch2/process/client.cjs')).Client;
    client = new Client();
    await client.open();
    opened = true;
    const handle = await client.fsProcess();
    const identity = await client.info(handle);
    check(identity?.result === 0 && identity.programId === FS_PROGRAM_ID &&
      typeof identity.pid === 'string' && /^\d+$/.test(identity.pid) && BigInt(identity.pid) > 0n,
    `Exported process is not native FS (result=${identity?.result}, programId=${identity?.programId})`);

    mapping = await client.info(handle, address, identity.pid);
    readableRange(mapping, address, 8, identity.pid);
    const reply = await client.read(handle, identity.pid, address, 8);
    check(reply?.result === 0 && reply.mapResult === 0 && reply.unmapResult === 0,
      `RO read failed (result=${reply?.result}, mapResult=${reply?.mapResult}, unmapResult=${reply?.unmapResult})`);
    check(reply.length === 8 && typeof reply.hex === 'string' && /^[0-9a-fA-F]{16}$/.test(reply.hex),
      'RO pointer read was truncated or malformed');
    const pointer = Buffer.from(reply.hex, 'hex').readBigUInt64LE();
    check(pointer >= MIN_POINTER && pointer < MAX_POINTER, 'RO returned a null or noncanonical manager pointer');
    mapping = await client.info(handle, pointer, identity.pid);
    readableRange(mapping, pointer, 0x60, identity.pid);
    return Number(pointer);
  } catch (error) {
    const location = Number.isSafeInteger(address) ? hex(address) : 'unknown address';
    failure = new Error(`${label} at ${location}: ${error.message}` +
      (mapping ? `; ${mappingDescription(mapping)}` : '') +
      '. The installed FS version must match the OunceCake FS layout; no retained-read fallback was attempted.',
    { cause: error });
    failure.code = 'FS_GLOBAL_READ_UNAVAILABLE';
    failure.fsGlobalAddress = address;
    throw failure;
  } finally {
    // Client.close records a pending worker without issuing more native calls.
    // Before open establishes its record, Client has nothing safe to close.
    if (client && (opened || client.record)) {
      try { await client.close(); }
      catch (error) {
        if (failure) {
          failure.cleanupError = error;
          failure.message += ` Cleanup: ${error.message}`;
        } else {
          throw new Error(`${label} at ${hex(address)}: RO client cleanup failed: ${error.message}`, { cause: error });
        }
      }
    }
  }
}

module.exports = { readFsGlobalPointer };
