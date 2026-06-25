import { dbAttach, dbDetach, dbListDatabases } from '../db/index.js';
import { formatSuccessResponse } from '../utils/formatUtils.js';

/**
 * Attach an existing SQLite database file to the live connection so its
 * tables can be queried via the chosen alias (e.g. SELECT * FROM alias.table).
 * @param path Path to an existing SQLite database file
 * @param alias Schema alias to reference the attached database by
 * @returns Confirmation with the alias used
 */
export async function attachDatabase(path: string, alias: string) {
  try {
    await dbAttach(path, alias);
    return formatSuccessResponse({ attached: true, alias, path });
  } catch (error: any) {
    throw new Error(`Attach Error: ${error.message}`);
  }
}

/**
 * Detach a previously attached database by alias.
 * @param alias Schema alias used when the database was attached
 * @returns Confirmation with the alias detached
 */
export async function detachDatabase(alias: string) {
  try {
    await dbDetach(alias);
    return formatSuccessResponse({ detached: true, alias });
  } catch (error: any) {
    throw new Error(`Detach Error: ${error.message}`);
  }
}

/**
 * List the databases visible on the connection (main database plus any
 * attached databases), as reported by PRAGMA database_list.
 * @returns Array of { seq, name, file } rows
 */
export async function listDatabases() {
  try {
    const result = await dbListDatabases();
    return formatSuccessResponse(result);
  } catch (error: any) {
    throw new Error(`List Databases Error: ${error.message}`);
  }
}
