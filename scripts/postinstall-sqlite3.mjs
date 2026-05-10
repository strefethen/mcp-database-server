#!/usr/bin/env node
/**
 * Rebuild the sqlite3 npm package from source against the SYSTEM libsqlite3.
 *
 * Why this exists
 * ---------------
 * node-sqlite3 ships a statically-bundled libsqlite3 inside its native .node
 * binary. mod_spatialite.so on Linux is built against the system libsqlite3.
 * When mod_spatialite is loaded into a Node process whose binding statically
 * links a different libsqlite3, symbol resolution disagrees about struct
 * layouts and the process segfaults on statement finalization. This is a
 * documented SpatiaLite community failure mode — see docs/SQLITE_SPATIALITE_BUILD.md
 * for citations.
 *
 * The fix is to rebuild the binding so it dynamically links against the same
 * libsqlite3 mod_spatialite was built against — i.e. the system library.
 *
 * Invocation
 * ----------
 *   - pnpm install              (runs automatically via `postinstall` script)
 *   - pnpm run build:sqlite3    (manual rerun)
 *
 * Environment
 * -----------
 *   SQLITE_PREFIX        Override prefix detection (e.g. /opt/homebrew, /usr/local).
 *   SKIP_BUILD_SQLITE3   Set to "1" to skip the rebuild (CI with prebaked binary).
 *   SKIP_VERIFY_SQLITE3  Set to "1" to skip the post-build verification.
 *
 * Exit codes
 * ----------
 *   0   success (or skipped by env var)
 *   2   sqlite3.h not found at any candidate prefix
 *   3   pnpm rebuild failed
 *   4   verification failed (binding rebuilt but mod_spatialite still misbehaves)
 */

import { execSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

if (process.env.SKIP_BUILD_SQLITE3 === '1') {
  console.error('[postinstall-sqlite3] SKIP_BUILD_SQLITE3=1 set; not rebuilding.');
  process.exit(0);
}

function detectSqlitePrefix() {
  if (process.env.SQLITE_PREFIX) return process.env.SQLITE_PREFIX;
  const candidates = platform() === 'darwin'
    ? [arch() === 'arm64' ? '/opt/homebrew' : '/usr/local', '/usr/local', '/opt/homebrew']
    : ['/usr', '/usr/local'];
  for (const p of candidates) {
    if (existsSync(join(p, 'include', 'sqlite3.h'))) return p;
  }
  return null;
}

const prefix = detectSqlitePrefix();
if (!prefix) {
  console.error(`
[postinstall-sqlite3] FATAL: SQLite development headers not found.

Install the headers, then re-run \`pnpm install\` (or \`pnpm run build:sqlite3\`):

  Debian / Ubuntu:   sudo apt install libsqlite3-dev
  Fedora / RHEL:     sudo dnf install sqlite-devel
  Arch Linux:        sudo pacman -S sqlite
  macOS (Homebrew):  brew install sqlite

Or set SQLITE_PREFIX to an install prefix that contains include/sqlite3.h.

See docs/SQLITE_SPATIALITE_BUILD.md for why this step is required.
`);
  process.exit(2);
}

console.error(`[postinstall-sqlite3] Rebuilding sqlite3 against system libsqlite3 at ${prefix}`);

// Bypass sqlite3's install script (which runs `prebuild-install -r napi`
// and downloads the bundled-libsqlite3 prebuilt regardless of npm_config_*
// vars in pnpm) and drive node-gyp directly. The binding.gyp's `sqlite`
// variable, when set to a non-`internal` path, switches the build to link
// dynamically against <prefix>/lib/libsqlite3 using <prefix>/include headers.
let sqlite3Dir;
try {
  sqlite3Dir = dirname(realpathSync(require.resolve('sqlite3/package.json')));
} catch (e) {
  console.error('[postinstall-sqlite3] FATAL: cannot resolve sqlite3 package — was `pnpm install` run?');
  process.exit(3);
}

let nodeGypBin;
try {
  nodeGypBin = join(dirname(require.resolve('node-gyp/package.json')), 'bin', 'node-gyp.js');
} catch (e) {
  console.error('[postinstall-sqlite3] FATAL: cannot resolve node-gyp — it must be a devDependency.');
  process.exit(3);
}

try {
  execSync(`node ${nodeGypBin} rebuild --sqlite=${prefix}`, {
    cwd: sqlite3Dir,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('[postinstall-sqlite3] FATAL: node-gyp rebuild failed. See output above.');
  process.exit(3);
}

if (process.env.SKIP_VERIFY_SQLITE3 === '1') {
  console.error('[postinstall-sqlite3] SKIP_VERIFY_SQLITE3=1 set; skipping verification.');
  process.exit(0);
}

console.error('[postinstall-sqlite3] Verifying mod_spatialite compatibility...');
try {
  execSync(`node ${join(HERE, 'verify-spatialite.mjs')}`, { stdio: 'inherit' });
} catch (e) {
  console.error(`
[postinstall-sqlite3] FATAL: verification failed.

The sqlite3 binding rebuilt successfully but the mod_spatialite ABI check
did not pass. This usually means the system libsqlite3 the binding linked
against is not the same one mod_spatialite was built against. Common cause:
a newer libsqlite3 installed under /usr/local shadowing the distro libsqlite3.

Diagnostics to run:
  ldd $(node -p "require('sqlite3').VERSION || ''; require.resolve('sqlite3')")/build/Release/node_sqlite3.node
  ldd /usr/lib/aarch64-linux-gnu/mod_spatialite.so
Both should reference the same libsqlite3.so.0.
`);
  process.exit(4);
}

console.error('[postinstall-sqlite3] OK: rebuild and verification passed.');
