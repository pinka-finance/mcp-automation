import type { Config } from "../config.js";
import type { Db } from "../supabase.js";

// Zajednički deps koje server.ts injecta u svaki tool impl.
export interface ToolDeps {
  config: Config;
  sb: Db; // service_role klijent, default schema = pinka_finance
}

// JSON Schema tip — ručno pisani inputSchema (kao u domovina-rag MCP-u).
export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};
