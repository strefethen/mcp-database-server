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
   * Attach another SQLite database to the current connection
   */
  private attachDatabase(dbPath: string, alias: string): Promise<void> {
    return new Promise((resolve) => {
      this.db!.exec(`ATTACH DATABASE '${dbPath}' AS ${alias}`, (err) => {
        if (err) {
          console.error(`[ERROR] Failed to attach ${alias} database: ${err.message}`);
        } else {
          console.error(`[INFO] ${dbPath} database attached as '${alias}'`);
        }
        resolve();
      });
    });
  }

  private async attachDatabaseIfExists(dbPath: string, alias: string): Promise<void> {
    if (!fs.existsSync(dbPath)) return;
    await this.attachDatabase(dbPath, alias);
  }

  /**
   * Initialize the SQLite database connection
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure the dbPath is accessible
      const openMode = this.readonly
        ? sqlite3.OPEN_READONLY
        : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
      console.error(`[INFO] Opening SQLite database at: ${this.dbPath} (${this.readonly ? 'readonly' : 'readwrite'})`);
      this.db = new sqlite3.Database(this.dbPath, openMode, async (err) => {
        if (err) {
          console.error(`[ERROR] SQLite connection error: ${err.message}`);
          reject(err);
        } else {
          console.error("[INFO] SQLite database opened successfully");
          // Load SpatiaLite extension
          const spatialitePath = findSpatialitePath();
          const afterExtension = async () => {
            // Attach additional databases (skip silently when file missing)
            await this.attachDatabaseIfExists('/Users/stevetrefethen/github/newchp/data/tiger.sqlite', 'tiger');
            await this.attachDatabaseIfExists('/Users/stevetrefethen/github/newchp/data/caltrans.sqlite', 'caltrans');
            await this.attachDatabaseIfExists('/Users/stevetrefethen/github/newchp/data/nextauth.sqlite', 'nextauth');
            resolve();
          };
          if (!spatialitePath) {
            console.error("[ERROR] SpatiaLite module not found. Install libsqlite3-mod-spatialite (Linux) or set SPATIALITE_PATH env var.");
            await afterExtension();
            return;
          }
          this.db!.loadExtension(spatialitePath, async (extErr) => {
            if (extErr) {
              console.error(`[ERROR] Failed to load SpatiaLite extension from ${spatialitePath}: ${extErr.message}`);
            } else {
              console.error(`[INFO] SpatiaLite extension loaded from ${spatialitePath}`);
            }
            await afterExtension();
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
   * Get database-specific query for listing tables
   */
  getListTablesQuery(): string {
    return "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
  }

  /**
   * Get database-specific query for describing a table
   * @param tableName Table name
   */
  getDescribeTableQuery(tableName: string): string {
    return `PRAGMA table_info(${tableName})`;
  }
}