# SQLite + SpatiaLite Build Mechanism

This server rebuilds the `sqlite3` npm package from source against the system
libsqlite3 instead of using its bundled binary. Without this, loading
`mod_spatialite` into the running process segfaults on statement finalization.
This page explains why, how the rebuild is wired up, and how to verify or
troubleshoot it.

## Why a rebuild is necessary

`sqlite3` ships a prebuilt native binding (`node_sqlite3.node`) that
statically embeds its own libsqlite3. `mod_spatialite.so` on Linux is built
against the *system* libsqlite3. When both are loaded into one process they
disagree about libsqlite3 struct layouts, and the next statement-finalize
call inside the binding dereferences an incompatible pointer.

This is a documented SpatiaLite community failure mode. Brice Lambson traced
it via `LD_DEBUG` and posted to the SpatiaLite-users list (Aug 2019):

> *Loading mod_spatialite triggered libsqlite3 to load as a dependency, but
> the extension was compiled against a different SQLite version. This
> version mismatch prevented proper symbol resolution, causing the segfault.*

The SpatiaLite maintainer's stance is unambiguous:

> *Mixing at random libraries of different origin/generation is a well known
> recipe leading to disaster.*

Rebuilding `sqlite3` with `--sqlite=<prefix>` switches its `binding.gyp` to
link dynamically against `<prefix>/lib/libsqlite3.so.0`, the same library
`mod_spatialite` was built against. Both libraries then share one copy of
libsqlite3 at runtime, and the ABI mismatch goes away.

## How the rebuild is wired up

Three pieces, in order of when they run.

### 1. `pnpm-workspace.yaml` allows the rebuild to run at all

```yaml
allowBuilds:
  sqlite3: true
```

pnpm's default policy is to refuse install scripts. Without this entry pnpm
silently skips `sqlite3`'s install step and the prebuilt is retained.

### 2. `scripts/postinstall-sqlite3.mjs` does the actual rebuild

Triggered by the `postinstall` lifecycle script in `package.json`. The
script:

1. Detects an installation prefix containing `include/sqlite3.h`
   (`/usr` on Debian/Ubuntu, `/opt/homebrew` on Apple Silicon, `/usr/local`
   on Intel macOS, or `$SQLITE_PREFIX` if you set it).
2. Resolves `node-gyp` from this project's `devDependencies` and the path
   to the `sqlite3` package inside `node_modules/.pnpm`.
3. Invokes `node-gyp rebuild --sqlite=<prefix>` inside that package.
   This bypasses `sqlite3`'s default install script — which would otherwise
   pull the bundled prebuilt regardless of any environment variables — and
   forces a fresh compile that links against the system libsqlite3.
4. Runs `scripts/verify-spatialite.mjs` to confirm the binding can actually
   load `mod_spatialite` and execute two sequential queries without
   crashing.

### 3. `scripts/verify-spatialite.mjs` is the smoke test

Opens an in-memory SQLite database, calls `loadExtension(mod_spatialite)`,
then runs two `db.all()` queries in a row — the exact pattern that fails
when the ABI is mismatched. If both queries return, the binding is good.
A `SIGSEGV` (exit 139) from this script means the rebuild silently
produced a still-bundled binary or pointed at a libsqlite3 different from
the one mod_spatialite expects.

## Platform prerequisites

| OS | Install command |
| --- | --- |
| Debian / Ubuntu | `sudo apt install libsqlite3-dev libsqlite3-mod-spatialite` |
| Fedora / RHEL | `sudo dnf install sqlite-devel libspatialite-devel` |
| Arch | `sudo pacman -S sqlite libspatialite` |
| macOS Homebrew | `brew install sqlite libspatialite` |

You also need a C++ toolchain (`gcc` / `clang`), `make`, and Python 3 for
`node-gyp`. On Debian-derived systems these come from `build-essential` and
`python3`.

## Running it

The rebuild runs automatically on `pnpm install`. To force a fresh rebuild
without reinstalling everything:

```bash
pnpm run build:sqlite3
```

To run only the verification (e.g., in CI smoke tests):

```bash
pnpm run verify:spatialite
```

To skip the rebuild — for example in a CI image where you've already baked
the compiled binding in — set `SKIP_BUILD_SQLITE3=1`. To skip the
verification (rarely a good idea), set `SKIP_VERIFY_SQLITE3=1`.

## Troubleshooting

**Verification segfaults (exit 139).** The binding is still ABI-mismatched
with `mod_spatialite`. Confirm both reference the same libsqlite3:

```bash
ldd node_modules/.pnpm/sqlite3@*/node_modules/sqlite3/build/Release/node_sqlite3.node | grep sqlite
ldd /usr/lib/$(uname -m)-linux-gnu/mod_spatialite.so | grep sqlite
```

Both lines should resolve `libsqlite3.so.0` to the same absolute path. If
the binding shows no `libsqlite3` at all, the rebuild silently fell back to
the bundled amalgamation — verify `pnpm-workspace.yaml` still has
`allowBuilds: { sqlite3: true }`.

**Verification fails with "module not found".** `mod_spatialite` isn't
installed. On Debian: `sudo apt install libsqlite3-mod-spatialite`.

**`node-gyp` errors about missing Python or compiler.** Install
`build-essential` and `python3` on Debian, or the equivalents on your
platform.

**A newer libsqlite3 in `/usr/local` shadows the distro version.** If
`pkg-config --modversion sqlite3` reports a different version than
`/usr/bin/sqlite3 --version`, you have a duplicate install. Either remove
the `/usr/local` build, or set `SQLITE_PREFIX=/usr` so the rebuild
deliberately targets the distro library that `mod_spatialite` was built
against.

## References

- [SpatiaLite-users: Segfaults with recent builds of mod_spatialite](https://groups.google.com/g/spatialite-users/c/71jnc6QVN-A)
- [TryGhost/node-sqlite3 — build-from-source documentation](https://github.com/TryGhost/node-sqlite3#building-from-source)
- [node-gyp documentation](https://github.com/nodejs/node-gyp)
- [pnpm `onlyBuiltDependencies` / `allowBuilds`](https://pnpm.io/settings#onlybuiltdependencies)
