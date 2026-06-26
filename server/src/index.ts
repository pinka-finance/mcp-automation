#!/usr/bin/env node
// mcp.pinka.io — entry point. Lokalni stdio transport (Claude Desktop / Claude
// Code spawnaju ovaj proces kroz mcp config). Logovi idu na STDERR jer stdout
// nosi MCP JSON-RPC protokol. HTTP/OAuth transport (promocija na remote) dodaje
// se kasnije po uzoru na domovina-rag/services/mcp/src/index.ts.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  console.error(
    `[pinka-mcp] v${config.serviceVersion} → stdio (account=${config.accountId}, ` +
      `dest=${config.ownerSigner ? "derive" : config.defaultDestination ? "default" : "NONE"})`,
  );
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[pinka-mcp] fatal:", err);
  process.exit(1);
});
