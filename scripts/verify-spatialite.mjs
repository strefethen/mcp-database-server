#!/usr/bin/env node
/**
 * Smoke-test that the sqlite3 binding is ABI-compatible with mod_spatialite.
 *
 * This exercises the exact failure pattern that segfaults a bundled-libsqlite3
 * binding: open a connection, loadExtension(mod_spatialite), run two sequential
 * db.all() calls. If the ABI is mismatched, this segfaults the process between
 * the first callback and the second query dispatch (observed exit code 139).
 * If the ABI matches, both queries return cleanly.
 *
 * Exit codes
 * ----------
 *   0   ABI verified
 *   2   mod_spatialite not found
 *   3   open / load / query failed without crashing (clean error path)
 *   139 SIGSEGV — bundled-vs-system libsqlite3 ABI mismatch confirmed
 */

import sqlite3 from 'sqlite3';
import { existsSync } from 'node:fs';

const candidates = [
  process.env.SPATIALITE_PATH,
  '/usr/lib/aarch64-linux-gnu/mod_spatialite.so',
  '/usr/lib/x86_64-linux-gnu/mod_spatialite.so',
  '/usr/lib/mod_spatialite.so',
  '/usr/local/lib/mod_spatialite.so',
  '/opt/homebrew/lib/mod_spatialite.dylib',
  '/usr/local/lib/mod_spatialite.dylib',
].filter(Boolean);

const SPATIALITE = candidates.find(p => existsSync(p));
if (!SPATIALITE) {
  console.error('[verify-spatialite] mod_spatialite not found — install libsqlite3-mod-spatialite (Linux) or set SPATIALITE_PATH');
  process.exit(2);
}

const db = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE, (err) => {
  if (err) { console.error('[verify-spatialite] open failed:', err.message); process.exit(3); }
  db.loadExtension(SPATIALITE, (extErr) => {
    if (extErr) { console.error('[verify-spatialite] loadExtension failed:', extErr.message); process.exit(3); }
    db.all('SELECT spatialite_version() AS version', (e1, rows1) => {
      if (e1) { console.error('[verify-spatialite] first query failed:', e1.message); process.exit(3); }
      // The second db.all is the critical ABI-mismatch trigger.
      db.all('SELECT GeometryType(MakePoint(0, 0)) AS gtype', (e2, rows2) => {
        if (e2) { console.error('[verify-spatialite] second query failed:', e2.message); process.exit(3); }
        db.close(() => {
          console.error(`[verify-spatialite] OK — spatialite ${rows1[0].version}, GeometryType=${rows2[0].gtype}`);
          process.exit(0);
        });
      });
    });
  });
});
