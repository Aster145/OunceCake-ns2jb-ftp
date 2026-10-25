'use strict';

// Transform the supplied Windows FTP fork without editing its source checkout.
// Exact, unique anchors deliberately reject unsupported upstream revisions.
function patchSources({runner, pipeline, stages, runControl}) {
  function edit(source, name, changes) {
    if (typeof source !== 'string') throw new TypeError(name + ' source must be text');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    let result = source.replaceAll('\r\n', '\n');
    for (const [label, before, after] of changes) {
      const at = result.indexOf(before);
      if (at < 0 || result.indexOf(before, at + before.length) >= 0)
        throw new Error('Unsupported ns2jb ' + name + ': expected one ' + label + ' anchor');
      result = result.slice(0, at) + after + result.slice(at + before.length);
    }
    return eol === '\n' ? result : result.replaceAll('\n', eol);
  }

  runner = edit(runner, 'run.cjs', [
    ['options', 'const options = {ftp: false, ftpPort: 2121, hostArgs: []};',
      'const options = {ftp: false, rpc: false, ftpPort: 2121, hostArgs: []};'],
    ['rpc flag', "if (args[i] === '--ftp') options.ftp = true;",
      "if (args[i] === '--rpc') options.rpc = true;\n    else if (args[i] === '--ftp') options.ftp = true;"],
    ['usage', "else throw Error('Usage: node run.cjs [computer-IP] [--ftp] [--ftp-port 2121]');",
      "else throw Error('Usage: node run.cjs [computer-IP] [--rpc | --ftp [--ftp-port 2121]]');"],
    ['mode conflict', "  if (options.hostArgs.length > 1) throw Error('Specify only one computer IP');",
      "  if (options.rpc && options.ftp) throw Error('--rpc cannot be combined with --ftp or --ftp-port');\n" +
      "  if (options.hostArgs.length > 1) throw Error('Specify only one computer IP');"],
    ['held engine', 'async function runEngine(directory, options = {}) {',
      'async function runEngine(directory, options = {}) {\n  const held = Boolean(options.ftp || options.rpc);'],
    ['engine listeners', '  let input, stopHandler, child;', '  let input, stopHandler, child, lines;'],
    ['IPC stdio', "stdio: options.ftp ? ['ignore', 'pipe', 'pipe', 'ipc']", "stdio: held ? ['ignore', 'pipe', 'pipe', 'ipc']"],
    ['RPC environment', "env: {...process.env, NS2_FTP_ENABLED: options.ftp ? '1' : '0',",
      "env: {...process.env, NS2_FTP_ENABLED: options.ftp ? '1' : '0',\n          NS2_RPC_ENABLED: options.rpc ? '1' : '0',"],
    ['stop setup', '    if (options.ftp) {', '    if (held) {'],
    ['stop notice', "console.log('FTP stop requested. Waiting for the current operation and cleanup.');",
      "console.log((options.rpc ? 'RPC' : 'FTP') + ' stop requested. Waiting for the current operation and cleanup.');"],
    ['stop message', "child.send({type: 'ns2-ftp-stop'}, () => {});",
      "child.send({type: options.rpc ? 'ns2-rpc-stop' : 'ns2-ftp-stop'}, () => {});"],
    ['SIGTERM stop', "      process.on('SIGINT', stopHandler);",
      "      process.on('SIGINT', stopHandler);\n      process.on('SIGTERM', stopHandler);"],
    ['stdout reader', '    const lines = readline.createInterface({input: child.stdout});',
      '    lines = readline.createInterface({input: child.stdout});'],
    ['RPC stdout', '/^[1-4]\\/4 |^FTP |^FS execution verified;/', '/^[1-4]\\/4 |^FTP |^RPC |^FS execution verified;/'],
    ['engine cleanup', "    if (stopHandler) process.off('SIGINT', stopHandler);",
      "    if (stopHandler) {\n      process.off('SIGINT', stopHandler);\n      process.off('SIGTERM', stopHandler);\n    }\n    if (lines) lines.close();"],
    ['help', "console.log('Usage: node run.cjs [computer-IP] [--ftp] [--ftp-port 2121]\\n--ftp: keep the verified session open for read-only FTP on 127.0.0.1.\\nSwitch 2 only. No npm install required. See WINDOWS-START.md for setup.');",
      "console.log('Usage: node run.cjs [computer-IP] [--rpc | --ftp [--ftp-port 2121]]\\n--rpc: keep the verified session open for OunceCake; no host FTP server.\\n--ftp: keep the verified session open for read-only FTP on 127.0.0.1.\\nSwitch 2 only. No npm install required. See ../WINDOWS-OunceCake.md for setup.');"],
  ]);

  pipeline = edit(pipeline, 'pipeline.cjs', [
    ['held modes', "  const ftpMode = process.env.NS2_FTP_ENABLED === '1';",
      "  const ftpMode = process.env.NS2_FTP_ENABLED === '1';\n" +
      "  const rpcMode = process.env.NS2_RPC_ENABLED === '1';\n" +
      "  check(!(ftpMode && rpcMode), 'RPC and FTP modes are mutually exclusive');\n" +
      "  const heldMode = ftpMode || rpcMode;\n" +
      "  const rpcReadyFile = path.join(__dirname, 'rpc-ready.json');\n" +
      "  const rpcState = {session: a.session, state: 'closed', pid: process.pid, started: record.started};\n" +
      "  const closeRpc = async () => {\n" +
      "    if (!rpcMode) return;\n" +
      "    rpcState.state = 'closed';\n" +
      "    await save(rpcReadyFile, rpcState);\n" +
      "  };"],
    ['stop messages', "  const onMessage = message => {if (message?.type === 'ns2-ftp-stop') requestStop();};\n  if (ftpMode) {",
      "  const onMessage = message => {\n" +
      "    if (message?.type === (rpcMode ? 'ns2-rpc-stop' : 'ns2-ftp-stop')) requestStop();\n" +
      "  };\n  if (heldMode) {"],
    ['pipeline SIGTERM', "    process.on('SIGINT', requestStop);",
      "    process.on('SIGINT', requestStop);\n    process.on('SIGTERM', requestStop);"],
    ['stage label', "    console.log(ftpMode ? '4/4 Running the FS demo before FTP' : '4/4 Running the FS demo and cleaning up');",
      "    console.log(rpcMode ? '4/4 Verifying FS before RPC' :\n      ftpMode ? '4/4 Running the FS demo before FTP' : '4/4 Running the FS demo and cleaning up');"],
    ['RPC hold', "    let ftpFailure;\n    if (ftpMode) {",
      "    let ftpFailure;\n" +
      "    if (rpcMode) {\n" +
      "      if (!stopRequested) await stage('Held RPC for OunceCake', async () => {\n" +
      "        try {\n" +
      "          rpcState.state = 'ready';\n" +
      "          await save(rpcReadyFile, rpcState);\n" +
      "          if (!stopRequested) {\n" +
      "            console.log('RPC ready: ' + path.resolve(__dirname, '..'));\n" +
      "            console.log('RPC stop: close OunceCake first, then type q and Enter here.');\n" +
      "            await stop;\n" +
      "          }\n" +
      "          return {closed: true};\n" +
      "        } finally {await closeRpc();}\n" +
      "      });\n" +
      "      await closeRpc();\n" +
      "      console.log('RPC stopped. Restoring and releasing FS resources...');\n" +
      "    } else if (ftpMode) {"],
    ['pipeline cleanup', "    if (ftpMode) {\n      process.off('message', onMessage);\n      process.off('disconnect', requestStop);\n      process.off('SIGINT', requestStop);\n      if (process.connected) process.disconnect();\n    }\n    record.finished = new Date().toISOString(); await save(file, record);",
      "    if (heldMode) {\n      process.off('message', onMessage);\n      process.off('disconnect', requestStop);\n      process.off('SIGINT', requestStop);\n      process.off('SIGTERM', requestStop);\n      if (process.connected) process.disconnect();\n    }\n" +
      "    await closeRpc();\n" +
      "    record.finished = new Date().toISOString(); await save(file, record);"],
  ]);
  stages = edit(stages, 'stages.cjs', [
    ['managed RPC stages', "  const preload = process.env.NS2_FTP_ENABLED === '1' ?",
      "  const preload = process.env.NS2_FTP_ENABLED === '1' || process.env.NS2_RPC_ENABLED === '1' ?"],
  ]);
  runControl = edit(runControl, 'run-control.cjs', [
    ['managed RPC acquisition', "managedStop = process.env.NS2_FTP_ENABLED === '1'",
      "managedStop = process.env.NS2_FTP_ENABLED === '1' || process.env.NS2_RPC_ENABLED === '1'"],
  ]);
  return {runner, pipeline, stages, runControl};
}

module.exports = {patchSources};
