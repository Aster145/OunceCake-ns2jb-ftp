# Windows ns2jb-ftp integration

This directory contains OunceCake's adapter for a separately supplied Windows
`ns2jb-ftp` source package. It does not distribute that package or its runtime.
OunceCake's upstream documents the [kurumuz ns2jb fork](https://gitlab.com/kurumuz/ns2jb);
the Windows package tested here is a separate adaptation. Compatibility with an
arbitrary ns2jb checkout is not implied.

The tested Windows package was supplied as a source archive without repository
metadata or a license file. Its exact public revision and redistribution terms
have not been established, so its complete source files are not included as test
fixtures. Obtain the compatible package separately from a source you are
authorized to use. This repository's GPL license does not establish the license
of that external package.

`patch-ns2jb.cjs` applies changes to four unmodified source files:

| Adapter input | Path relative to the external source directory |
| --- | --- |
| `runner` | `run.cjs` |
| `pipeline` | `engine/switch2/pipeline.cjs` |
| `stages` | `engine/shared/stages.cjs` |
| `runControl` | `engine/switch2/memory/run-control.cjs` |

The adapter requires its expected text anchors to occur exactly once. A missing
or duplicate anchor fails with an unsupported-source error. This checks the
transformed sections; it is not a guarantee that every other part of an unknown
source package is compatible. For normal setup, follow
[the Windows instructions](../WINDOWS-OunceCake.md) and run `prepare-ns2jb.cjs`.

## Optional source integration tests

The default test run reports one explicit skip for the external source tests.
To enable all 14 host integration cases in PowerShell:

```powershell
$env:OUNCECAKE_NS2JB_SOURCE = 'C:\path\to\ns2jb-ftp'
node --test test/*.test.cjs
Remove-Item Env:OUNCECAKE_NS2JB_SOURCE
```

Use the original, unpatched source directory, not the generated `ns2jb-host`.
An empty, missing, or incompatible configured directory fails the tests instead
of silently skipping them. The test harness reads the four files above, patches
them in memory, and executes them with mocked RPC, filesystem, process, and
network dependencies. It does not modify the supplied source, connect to a
console, or establish a live RPC session. These tests verify lifecycle behavior;
they do not replace device testing.
