import { formatErrorResponse } from '../utils/formatUtils.js';
import { isDatabaseReadOnly } from '../db/index.js';

// Import all tool implementations
import { readQuery, writeQuery, exportQuery } from '../tools/queryTools.js';
import { createTable, alterTable, dropTable, listTables, describeTable } from '../tools/schemaTools.js';
import { appendInsight, listInsights } from '../tools/insightTools.js';
import { attachDatabase, detachDatabase, listDatabases } from '../tools/attachTools.js';

const MUTATION_TOOLS = new Set([
  "write_query",
  "create_table",
  "alter_table",
  "drop_table",
  "append_insight",
]);

/**
 * Handle listing available tools
 * @returns List of available tools
 */
export function handleListTools() {
  const tools = [
    {
      name: "read_query",
      description: "Execute SELECT queries to read data from the database",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "write_query",
      description: "Execute INSERT, UPDATE, or DELETE queries",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "create_table",
      description: "Create new tables in the database",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "alter_table",
      description: "Modify existing table schema (add columns, rename tables, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "drop_table",
      description: "Remove a table from the database with safety confirmation",
      inputSchema: {
        type: "object",
        properties: {
          table_name: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["table_name", "confirm"],
      },
    },
      {
        name: "export_query",
        description: "Export query results to various formats (CSV, JSON)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            format: { type: "string", enum: ["csv", "json"] },
          },
          required: ["query", "format"],
        },
      },
      {
        name: "list_tables",
        description: "Get a list of application tables in the database. By default, hides system tables (SQLite metadata, SpatiaLite catalog, RTree shadow tables, Litestream replication state). Pass include_system=true to see everything.",
        inputSchema: {
          type: "object",
          properties: {
            include_system: {
              type: "boolean",
              description: "If true, include internal/system tables in the result. Defaults to false.",
            },
          },
        },
      },
      {
        name: "describe_table",
        description: "View schema information for a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table_name: { type: "string" },
          },
          required: ["table_name"],
        },
      },
      {
        name: "append_insight",
        description: "Add a business insight to the memo",
        inputSchema: {
          type: "object",
          properties: {
            insight: { type: "string" },
          },
          required: ["insight"],
        },
      },
      {
        name: "list_insights",
        description: "List all business insights in the memo",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "attach_database",
        description: "Attach an existing SQLite database file (read-only) under an alias so its tables can be queried as alias.table",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to an existing SQLite database file" },
            alias: { type: "string", description: "Schema alias to reference the attached database by" },
          },
          required: ["path", "alias"],
        },
      },
      {
        name: "detach_database",
        description: "Detach a previously attached SQLite database by alias",
        inputSchema: {
          type: "object",
          properties: {
            alias: { type: "string", description: "Schema alias used when the database was attached" },
          },
          required: ["alias"],
        },
      },
      {
        name: "list_databases",
        description: "List databases visible on the connection: the main database plus any attached databases (PRAGMA database_list)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
  ];

  return {
    tools: isDatabaseReadOnly()
      ? tools.filter((tool) => !MUTATION_TOOLS.has(tool.name))
      : tools,
  };
}

/**
 * Handle tool call requests
 * @param name Name of the tool to call
 * @param args Arguments for the tool
 * @returns Tool execution result
 */
export async function handleToolCall(name: string, args: any) {
  try {
    if (isDatabaseReadOnly() && MUTATION_TOOLS.has(name)) {
      throw new Error(`Tool '${name}' is unavailable because the database connection is read-only`);
    }

    switch (name) {
      case "read_query":
        return await readQuery(args.query);
      
      case "write_query":
        return await writeQuery(args.query);
      
      case "create_table":
        return await createTable(args.query);
      
      case "alter_table":
        return await alterTable(args.query);
      
      case "drop_table":
        return await dropTable(args.table_name, args.confirm);
      
      case "export_query":
        return await exportQuery(args.query, args.format);
      
      case "list_tables":
        return await listTables(args.include_system === true);
      
      case "describe_table":
        return await describeTable(args.table_name);
      
      case "append_insight":
        return await appendInsight(args.insight);
      
      case "list_insights":
        return await listInsights();

      case "attach_database":
        return await attachDatabase(args.path, args.alias);

      case "detach_database":
        return await detachDatabase(args.alias);

      case "list_databases":
        return await listDatabases();

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return formatErrorResponse(error);
  }
} 
