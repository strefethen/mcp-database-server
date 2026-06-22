#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import database utils
import { initDatabase, closeDatabase, getDatabaseMetadata } from './db/index.js';

// Import handlers
import { handleListResources, handleReadResource } from './handlers/resourceHandlers.js';
import { handleListTools, handleToolCall } from './handlers/toolHandlers.js';

// Setup a logger that uses stderr instead of stdout to avoid interfering with MCP communications
const logger = {
  log: (...args: any[]) => console.error('[INFO]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args),
  warn: (...args: any[]) => console.error('[WARN]', ...args),
  info: (...args: any[]) => console.error('[INFO]', ...args),
};

// Determine the SQLite file path early (first non-flag arg) so we can ship
// DB-specific query guidance to the client via the MCP `instructions` field.
const sqlitePathArg = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
const isChpV2 = /chp-v2\.sqlite$/.test(sqlitePathArg);

// Query-hygiene guidance surfaced to ANY connecting MCP client (e.g. Claude
// Desktop, which has no CLAUDE.md). Mirrors the rpi2 chpv2 rules so clients
// without the project context don't repeat the known query mistakes.
const chpV2Instructions = `This server is a READ-ONLY replica of the CHP incident database (chp-v2). Follow these rules for correct, reproducible results:

1. TIME / DATE WINDOWS (most common mistake): time lives in *_epoch columns (log_time_epoch, detail_time_epoch, unit_time_epoch) as TRUE UTC SECONDS. The host timezone is America/Los_Angeles (Pacific, DST-aware).
   - Build date-window bounds with the 'utc' modifier: strftime('%s','2026-06-19 00:00:00','utc'). NEVER write a bare strftime('%s','2026-06-19 00:00:00') — without 'utc' it parses the literal as UTC, so a Pacific "today/this-week/this-month" window silently starts ~7-8h early (5pm the prior day) and bleeds adjacent days in. No error, just wrong counts.
   - Filter on the RAW epoch column against integer bounds: WHERE log_time_epoch >= <lo> AND log_time_epoch < <hi>. Never wrap the column in datetime()/strftime()/date() inside WHERE — it forces a full scan of millions of rows.
   - Render/group in Pacific with datetime(log_time_epoch,'unixepoch','localtime').

2. H3 HEX VALUES: h3_r7/h3_r8/h3_r9 are 64-bit integers. NEVER paste an H3 value from a prior result back as a SQL literal (e.g. WHERE h3_r8 = 613221872680566800) — JSON/float round-trip corrupts the last 2-3 digits and silently matches ZERO rows. Reference the hex via a subquery/CTE: WHERE h3_r8 = (SELECT h3_r8 FROM top_hex).

3. IDENTIFY ATTRIBUTES BY CODED FIELDS, NOT FREE TEXT: use log_type_id, is_accident, involves_motorcycle, involves_bigrig, fire, area_id, district, route — never text-search the free-text 'detail' column (e.g. detail LIKE '%fatal%'), which mixes in negations/speculation and mis-counts. Fatalities = log_type_id IN (2,66). Collisions = is_accident = 1.

4. SPATIAL: geometry is SRID 4326 (lon/lat); geometry_3310 is SRID 3310 in METRES — use it for distances/buffers. Lead spatial filters with MBRIntersects (uses the R*Tree index) then refine with ST_Intersects.

5. FRESHNESS: this replica trails the source by ~90s and the current day/hour is partial — label the latest bucket as in-progress. Only SELECT/PRAGMA are allowed; EXPLAIN QUERY PLAN is rejected.`;

const genericInstructions = `Read-only SQLite database server. Only SELECT and PRAGMA statements are permitted. For date filtering on epoch/Unix-second columns, compare the raw column to integer bounds rather than wrapping it in datetime()/strftime() in WHERE, to keep indexes usable.`;

// Configure the server
const server = new Server(
  {
    name: "executeautomation/database-server",
    version: "1.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
    instructions: isChpV2 ? chpV2Instructions : genericInstructions,
  },
);

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  logger.error("Please provide database connection information");
  logger.error("Usage for SQLite: node index.js <database_file_path>");
  logger.error("Usage for SQL Server: node index.js --sqlserver --server <server> --database <database> [--user <user> --password <password>]");
  logger.error("Usage for PostgreSQL: node index.js --postgresql --host <host> --database <database> [--user <user> --password <password> --port <port>]");
  logger.error("Usage for MySQL: node index.js --mysql --host <host> --database <database> [--user <user> --password <password> --port <port>]");
  logger.error("Usage for MySQL with AWS IAM: node index.js --mysql --aws-iam-auth --host <rds-endpoint> --database <database> --user <aws-username> --aws-region <region>");
  process.exit(1);
}

// Parse arguments to determine database type and connection info
let dbType = 'sqlite';
let connectionInfo: any = null;

// Check if using SQL Server
if (args.includes('--sqlserver')) {
  dbType = 'sqlserver';
  connectionInfo = {
    server: '',
    database: '',
    user: undefined,
    password: undefined
  };
  
  // Parse SQL Server connection parameters
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && i + 1 < args.length) {
      connectionInfo.server = args[i + 1];
    } else if (args[i] === '--database' && i + 1 < args.length) {
      connectionInfo.database = args[i + 1];
    } else if (args[i] === '--user' && i + 1 < args.length) {
      connectionInfo.user = args[i + 1];
    } else if (args[i] === '--password' && i + 1 < args.length) {
      connectionInfo.password = args[i + 1];
    } else if (args[i] === '--port' && i + 1 < args.length) {
      connectionInfo.port = parseInt(args[i + 1], 10);
    }
  }
  
  // Validate SQL Server connection info
  if (!connectionInfo.server || !connectionInfo.database) {
    logger.error("Error: SQL Server requires --server and --database parameters");
    process.exit(1);
  }
} 
// Check if using PostgreSQL
else if (args.includes('--postgresql') || args.includes('--postgres')) {
  dbType = 'postgresql';
  connectionInfo = {
    host: '',
    database: '',
    user: undefined,
    password: undefined,
    port: undefined,
    ssl: undefined,
    connectionTimeout: undefined
  };
  
  // Parse PostgreSQL connection parameters
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && i + 1 < args.length) {
      connectionInfo.host = args[i + 1];
    } else if (args[i] === '--database' && i + 1 < args.length) {
      connectionInfo.database = args[i + 1];
    } else if (args[i] === '--user' && i + 1 < args.length) {
      connectionInfo.user = args[i + 1];
    } else if (args[i] === '--password' && i + 1 < args.length) {
      connectionInfo.password = args[i + 1];
    } else if (args[i] === '--port' && i + 1 < args.length) {
      connectionInfo.port = parseInt(args[i + 1], 10);
    } else if (args[i] === '--ssl' && i + 1 < args.length) {
      connectionInfo.ssl = args[i + 1] === 'true';
    } else if (args[i] === '--connection-timeout' && i + 1 < args.length) {
      connectionInfo.connectionTimeout = parseInt(args[i + 1], 10);
    }
  }
  
  // Validate PostgreSQL connection info
  if (!connectionInfo.host || !connectionInfo.database) {
    logger.error("Error: PostgreSQL requires --host and --database parameters");
    process.exit(1);
  }
}
// Check if using MySQL
else if (args.includes('--mysql')) {
  dbType = 'mysql';
  connectionInfo = {
    host: '',
    database: '',
    user: undefined,
    password: undefined,
    port: undefined,
    ssl: undefined,
    connectionTimeout: undefined,
    awsIamAuth: false,
    awsRegion: undefined
  };
  // Parse MySQL connection parameters
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && i + 1 < args.length) {
      connectionInfo.host = args[i + 1];
    } else if (args[i] === '--database' && i + 1 < args.length) {
      connectionInfo.database = args[i + 1];
    } else if (args[i] === '--user' && i + 1 < args.length) {
      connectionInfo.user = args[i + 1];
    } else if (args[i] === '--password' && i + 1 < args.length) {
      connectionInfo.password = args[i + 1];
    } else if (args[i] === '--port' && i + 1 < args.length) {
      connectionInfo.port = parseInt(args[i + 1], 10);
    } else if (args[i] === '--ssl' && i + 1 < args.length) {
      const sslVal = args[i + 1];
      if (sslVal === 'true') connectionInfo.ssl = true;
      else if (sslVal === 'false') connectionInfo.ssl = false;
      else connectionInfo.ssl = sslVal;
    } else if (args[i] === '--connection-timeout' && i + 1 < args.length) {
      connectionInfo.connectionTimeout = parseInt(args[i + 1], 10);
    } else if (args[i] === '--aws-iam-auth') {
      connectionInfo.awsIamAuth = true;
    } else if (args[i] === '--aws-region' && i + 1 < args.length) {
      connectionInfo.awsRegion = args[i + 1];
    }
  }
  // Validate MySQL connection info
  if (!connectionInfo.host || !connectionInfo.database) {
    logger.error("Error: MySQL requires --host and --database parameters");
    process.exit(1);
  }
  
  // Additional validation for AWS IAM authentication
  if (connectionInfo.awsIamAuth) {
    if (!connectionInfo.user) {
      logger.error("Error: AWS IAM authentication requires --user parameter");
      process.exit(1);
    }
    if (!connectionInfo.awsRegion) {
      logger.error("Error: AWS IAM authentication requires --aws-region parameter");
      process.exit(1);
    }
    // Automatically enable SSL for AWS IAM authentication (required)
    connectionInfo.ssl = true;
    logger.info("AWS IAM authentication enabled - SSL automatically configured");
  }
} else {
  // SQLite mode (default)
  dbType = 'sqlite';
  // First non-flag argument is the SQLite file path; --readonly opens read-only
  const sqlitePath = args.find(a => !a.startsWith('--'));
  if (!sqlitePath) {
    logger.error("Error: SQLite mode requires a database file path");
    process.exit(1);
  }
  const readonly = args.includes('--readonly');
  connectionInfo = { sqlitePath, readonly };
  logger.info(`Using SQLite database at path: ${sqlitePath}${readonly ? ' (readonly)' : ''}`);
}

// Set up request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return await handleListResources();
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return await handleReadResource(request.params.uri);
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return handleListTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await handleToolCall(request.params.name, request.params.arguments);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
});

// Exit if the parent closes stdin (e.g. Claude Code exits or crashes).
// Without this, the SDK's stdio transport can hot-loop on a closed pipe
// and starve the event loop, leaving the process pegged at 100% CPU.
process.stdin.on('end', () => {
  logger.info('stdin closed by parent — shutting down');
  closeDatabase().finally(() => process.exit(0));
});
process.stdin.on('close', () => process.exit(0));

// Watchdog: if we get reparented to init (PPID 1), the parent died.
const originalPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== originalPpid && process.ppid === 1) {
    logger.error('Parent process died — exiting');
    process.exit(0);
  }
}, 30_000).unref();

// Add global error handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/**
 * Start the server
 */
async function runServer() {
  try {
    logger.info(`Initializing ${dbType} database...`);
    if (dbType === 'sqlite') {
      logger.info(`Database path: ${connectionInfo.sqlitePath}`);
    } else if (dbType === 'sqlserver') {
      logger.info(`Server: ${connectionInfo.server}, Database: ${connectionInfo.database}`);
    } else if (dbType === 'postgresql') {
      logger.info(`Host: ${connectionInfo.host}, Database: ${connectionInfo.database}`);
    } else if (dbType === 'mysql') {
      logger.info(`Host: ${connectionInfo.host}, Database: ${connectionInfo.database}`);
    }
    
    // Initialize the database
    await initDatabase(connectionInfo, dbType);
    
    const dbInfo = getDatabaseMetadata();
    logger.info(`Connected to ${dbInfo.name} database`);
    
    logger.info('Starting MCP server...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger.info('Server running. Press Ctrl+C to exit.');
  } catch (error) {
    logger.error("Failed to initialize:", error);
    process.exit(1);
  }
}

// Start the server
runServer().catch(error => {
  logger.error("Server initialization failed:", error);
  process.exit(1);
}); 