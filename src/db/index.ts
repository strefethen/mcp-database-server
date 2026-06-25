import { DbAdapter, createDbAdapter } from './adapter.js';

// Store the active database adapter
let dbAdapter: DbAdapter | null = null;

/**
 * Initialize the database connection
 * @param connectionInfo Connection information object or SQLite path string
 * @param dbType Database type ('sqlite' or 'sqlserver')
 */
export async function initDatabase(connectionInfo: any, dbType: string = 'sqlite'): Promise<void> {
  try {
    // If connectionInfo is a string, assume it's a SQLite path
    if (typeof connectionInfo === 'string') {
      connectionInfo = { path: connectionInfo };
    } else if (connectionInfo && typeof connectionInfo === 'object' && 'sqlitePath' in connectionInfo) {
      // SQLite invocation with extra flags (e.g. readonly)
      connectionInfo = { path: connectionInfo.sqlitePath, readonly: connectionInfo.readonly };
    }

    // Create appropriate adapter based on database type
    dbAdapter = createDbAdapter(dbType, connectionInfo);
    
    // Initialize the connection
    await dbAdapter.init();
  } catch (error) {
    throw new Error(`Failed to initialize database: ${(error as Error).message}`);
  }
}

/**
 * Execute a SQL query and get all results
 * @param query SQL query to execute
 * @param params Query parameters
 * @returns Promise with query results
 */
export function dbAll(query: string, params: any[] = []): Promise<any[]> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.all(query, params);
}

/**
 * Execute a SQL query that modifies data
 * @param query SQL query to execute
 * @param params Query parameters
 * @returns Promise with result info
 */
export function dbRun(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.run(query, params);
}

/**
 * Execute multiple SQL statements
 * @param query SQL statements to execute
 * @returns Promise that resolves when execution completes
 */
export function dbExec(query: string): Promise<void> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.exec(query);
}

/**
 * Close the database connection
 */
export function closeDatabase(): Promise<void> {
  if (!dbAdapter) {
    return Promise.resolve();
  }
  return dbAdapter.close();
}

/**
 * Get database metadata
 */
export function getDatabaseMetadata(): { name: string, type: string, path?: string, server?: string, database?: string } {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.getMetadata();
}

/**
 * Check whether the active database connection is read-only.
 */
export function isDatabaseReadOnly(): boolean {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.isReadOnly();
}

/**
 * Attach an existing database file to the live connection (SQLite only).
 */
export function dbAttach(dbPath: string, alias: string): Promise<void> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  if (!dbAdapter.attachDatabaseExplicit) {
    throw new Error("ATTACH is only supported for SQLite databases");
  }
  return dbAdapter.attachDatabaseExplicit(dbPath, alias);
}

/**
 * Detach a previously attached database by alias (SQLite only).
 */
export function dbDetach(alias: string): Promise<void> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  if (!dbAdapter.detachDatabase) {
    throw new Error("DETACH is only supported for SQLite databases");
  }
  return dbAdapter.detachDatabase(alias);
}

/**
 * List databases visible on the connection — main plus attached (SQLite only).
 */
export function dbListDatabases(): Promise<Array<{ seq: number; name: string; file: string }>> {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  if (!dbAdapter.listDatabases) {
    throw new Error("Listing databases is only supported for SQLite databases");
  }
  return dbAdapter.listDatabases();
}

/**
 * Get database-specific query for listing tables.
 * @param includeSystem When true, include system/internal tables; default false.
 */
export function getListTablesQuery(includeSystem: boolean = false): string {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.getListTablesQuery(includeSystem);
}

/**
 * Get database-specific query for describing a table
 * @param tableName Table name
 */
export function getDescribeTableQuery(tableName: string): string {
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter.getDescribeTableQuery(tableName);
} 
