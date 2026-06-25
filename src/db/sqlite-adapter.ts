import sqlite3 from "sqlite3";
import * as fs from "fs";
import { DbAdapter } from "./adapter.js";

console.error("[INFO] Initializing SQLite database adapter");

/**
 * Locate the SpatiaLite loadable module across platforms.
 * Override with SPATIALITE_PATH env var.
 */
function findSpatialitePath(): string | null {
  if (process.env.SPATIALITE_PATH) {
    return process.env.SPATIALITE_PATH;
  }
  const candidates = [
    // Linux (Debian/Ubuntu, multiple arches)
    "/usr/lib/aarch64-linux-gnu/mod_spatialite.so",
    "/usr/lib/x86_64-linux-gnu/mod_spatialite.so",
    "/usr/lib/mod_spatialite.so",
    "/usr/local/lib/mod_spatialite.so",
    // macOS (Homebrew Apple Silicon / Intel)
    "/opt/homebrew/lib/mod_spatialite.dylib",
    "/usr/local/lib/mod_spatialite.dylib",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * SQLite database adapter implementation
 */
export class SqliteAdapter implements DbAdapter {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private readonly: boolean;

  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    this.dbPath = dbPath;
    this.readonly = options.readonly === true;
  }

  /**
   * Attach another SQLite database to the current connection.
   *
   * Uses the URI form `file:<path>?mode=ro&immutable=1` so that SQLite treats the
   * attached file as strictly read-only and skips journal/WAL sidecar allocation.
   * That matters when the file lives in a directory the running process can't
   * write to (e.g. /var/lib/commutedash/ owned by the `commutedash` service user
   * with mode 750) — a default ATTACH would succeed, then fail at first query
   * with "attempt to write a readonly database" when SQLite tried to create a
   * journal file. `immutable=1` is also an explicit promise that the file will
   * not change while attached, which is correct for reference datasets like
   * TIGER, the CalTrans CCTV catalog, and PeMS station_metadata: those are
   * updated by replacing the file (and restarting the server), never in place.
   */
  private attachDatabase(dbPath: string, alias: string): Promise<void> {
    return new Promise((resolve) => {
      const uri = `file:${dbPath}?mode=ro&immutable=1`;
      this.db!.exec(`ATTACH DATABASE '${uri}' AS ${alias}`, (err) => {
        if (err) {
          console.error(`[ERROR] Failed to attach ${alias} database: ${err.message}`);
        } else {
          console.error(`[INFO] ${dbPath} database attached as '${alias}' (read-only, immutable)`);
        }
        resolve();
      });
    });
  }

  private async attachDatabaseIfExists(dbPath: string, alias: string): Promise<void> {
    if (!fs.existsSync(dbPath)) return;
    await this.attachDatabase(dbPath, alias);
  }

  // A schema alias is interpolated directly into ATTACH/DETACH (it cannot be
  // bound as a parameter), so it must be validated to prevent SQL injection.
  // Valid alias: a letter or underscore followed by word characters.
  private static isValidAlias(alias: string): boolean {
    return /^[A-Za-z_]\w*$/.test(alias);
  }

  /**
   * Attach an existing database file at runtime (agent-callable). Unlike the
   * internal best-effort {@link attachDatabase} used for reference datasets,
   * this rejects on error so the caller learns of failures. The file is opened
   * `mode=ro` so the attached database cannot be written.
   * @param dbPath Path to an existing database file
   * @param alias Schema alias to reference the attached database by
   */
  async attachDatabaseExplicit(dbPath: string, alias: string): Promise<void> {
    if (!SqliteAdapter.isValidAlias(alias)) {
      throw new Error(`Invalid alias '${alias}': must start with a letter or underscore and contain only word characters`);
    }
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    // Percent-encode each path segment (preserving '/') so that '?', '&', '#'
    // and '=' embedded in the caller-supplied path cannot open or extend the
    // URI query string and override mode=ro (e.g. ".../x.db?mode=rwc&" would
    // otherwise reopen the attached database read-write, bypassing read-only).
    // encodeURIComponent leaves "'" unescaped, so the SQL-literal quote escape
    // below is still required.
    const encodedPath = dbPath.split('/').map(encodeURIComponent).join('/');
    const uri = `file:${encodedPath}?mode=ro`.replace(/'/g, "''");
    await new Promise<void>((resolve, reject) => {
      this.db!.exec(`ATTACH DATABASE '${uri}' AS ${alias}`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Detach a previously attached database by alias (agent-callable).
   * @param alias Schema alias used when the database was attached
   */
  async detachDatabase(alias: string): Promise<void> {
    if (!SqliteAdapter.isValidAlias(alias)) {
      throw new Error(`Invalid alias '${alias}': must start with a letter or underscore and contain only word characters`);
    }
    await this.run(`DETACH DATABASE ${alias}`);
  }

  /**
   * List databases visible on the connection (main + attached) via
   * PRAGMA database_list.
   */
  async listDatabases(): Promise<Array<{ seq: number; name: string; file: string }>> {
    return this.all("PRAGMA database_list") as Promise<Array<{ seq: number; name: string; file: string }>>;
  }

  /**
   * Initialize the SQLite database connection
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure the dbPath is accessible. OPEN_URI is required so subsequent
      // ATTACH statements may use `file:...?mode=ro&immutable=1` URI filenames
      // (URI parsing is otherwise opt-in and only activates for paths that
      // begin with `file:` — plain paths like this.dbPath continue to work).
      const openMode = (this.readonly
        ? sqlite3.OPEN_READONLY
        : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) | sqlite3.OPEN_URI;
      console.error(`[INFO] Opening SQLite database at: ${this.dbPath} (${this.readonly ? 'readonly' : 'readwrite'})`);
      this.db = new sqlite3.Database(this.dbPath, openMode, async (err) => {
        if (err) {
          console.error(`[ERROR] SQLite connection error: ${err.message}`);
          reject(err);
        } else {
          console.error("[INFO] SQLite database opened successfully");

          // Order matters here: ATTACH the sibling reference databases BEFORE
          // loading SpatiaLite. On at least the aarch64 build of node-sqlite3
          // + libspatialite shipped on Debian Bookworm, calling ATTACH after
          // mod_spatialite has been loaded crashes the process with SIGSEGV
          // (verified May 2026, sqlite3@5.x). Attaching first sidesteps the
          // crash; SpatiaLite functions still bind to all currently-attached
          // databases when loaded afterward.
          await this.attachDatabaseIfExists('/var/lib/commutedash/tiger.sqlite', 'tiger');
          await this.attachDatabaseIfExists('/var/lib/commutedash/caltrans.sqlite', 'caltrans');
          await this.attachDatabaseIfExists('/var/lib/commutedash/pems.sqlite', 'pems');

          // Load SpatiaLite extension
          const spatialitePath = findSpatialitePath();
          if (!spatialitePath) {
            console.error("[ERROR] SpatiaLite module not found. Install libsqlite3-mod-spatialite (Linux) or set SPATIALITE_PATH env var.");
            resolve();
            return;
          }
          this.db!.loadExtension(spatialitePath, (extErr) => {
            if (extErr) {
              console.error(`[ERROR] Failed to load SpatiaLite extension from ${spatialitePath}: ${extErr.message}`);
            } else {
              console.error(`[INFO] SpatiaLite extension loaded from ${spatialitePath}`);
            }
            resolve();
          });
        }
      });
    });
  }

  /**
   * Execute a SQL query and get all results
   * @param query SQL query to execute
   * @param params Query parameters
   * @returns Promise with query results
   */
  async all(query: string, params: any[] = []): Promise<any[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    console.error(`[SQLITE][ALL] Executing SQL:`, query, params && params.length ? `| Params: ${JSON.stringify(params)}` : '');
    return new Promise((resolve, reject) => {
      this.db!.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  /**
   * Execute a SQL query that modifies data
   * @param query SQL query to execute
   * @param params Query parameters
   * @returns Promise with result info
   */
  async run(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    console.error(`[SQLITE][RUN] Executing SQL:`, query, params && params.length ? `| Params: ${JSON.stringify(params)}` : '');
    return new Promise((resolve, reject) => {
      this.db!.run(query, params, function(this: sqlite3.RunResult, err: Error | null) {
        if (err) {
          reject(err);
        } else {
          resolve({ changes: this.changes, lastID: this.lastID });
        }
      });
    });
  }

  /**
   * Execute multiple SQL statements
   * @param query SQL statements to execute
   * @returns Promise that resolves when execution completes
   */
  async exec(query: string): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    console.error(`[SQLITE][EXEC] Executing SQL:`, query);
    return new Promise((resolve, reject) => {
      this.db!.exec(query, (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }
      
      this.db.close((err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          this.db = null;
          resolve();
        }
      });
    });
  }

  /**
   * Get database metadata
   */
  getMetadata(): { name: string, type: string, path: string } {
    return {
      name: "SQLite",
      type: "sqlite",
      path: this.dbPath
    };
  }

  /**
   * Whether this SQLite connection was opened read-only.
   */
  isReadOnly(): boolean {
    return this.readonly;
  }

  /**
   * Get database-specific query for listing tables.
   *
   * By default, hides system / internal tables (SQLite metadata, SpatiaLite catalog,
   * RTree shadow tables, Litestream replication state). These are valid tables but
   * dominate the result on spatially-indexed databases and obscure application schema.
   * Pass `includeSystem=true` to bypass the filter when introspecting infrastructure.
   */
  getListTablesQuery(includeSystem: boolean = false): string {
    if (includeSystem) {
      return "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
    }
    return `
      SELECT name FROM sqlite_master
      WHERE type='table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'idx_%'
        AND name NOT LIKE 'spatial_ref_sys%'
        AND name NOT LIKE 'geometry_columns%'
        AND name NOT LIKE 'views_geometry_columns%'
        AND name NOT LIKE 'virts_geometry_columns%'
        AND name NOT LIKE 'vector_layers%'
        AND name NOT LIKE 'vector_coverages%'
        AND name NOT LIKE 'raster_coverages%'
        AND name NOT LIKE 'SE_%'
        AND name NOT LIKE 'ISO_metadata%'
        AND name NOT LIKE 'wms_%'
        AND name NOT LIKE 'rl2%'
        AND name NOT LIKE 'topologies%'
        AND name NOT LIKE '\\_litestream\\_%' ESCAPE '\\'
        AND name NOT LIKE '\\_ls\\_%' ESCAPE '\\'
        AND name NOT IN (
          'SpatialIndex','ElementaryGeometries','KNN2','data_licenses',
          'spatialite_history','sql_statements_log','stored_procedures',
          'stored_variables','unit','networks','geom_cols_ref_sys'
        )
      ORDER BY name`;
  }

  /**
   * Get database-specific query for describing a table
   * @param tableName Table name
   */
  getDescribeTableQuery(tableName: string): string {
    return `PRAGMA table_info(${tableName})`;
  }
}