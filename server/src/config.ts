// Env config loader — fail-fast na startupu (zrcali domovina-rag/services/mcp).
// Učitava .env iz cwd-a ako postoji (Node 22 process.loadEnvFile), pa pročita
// process.env. Spawn iz Claude Desktopa predaje env kroz "env" blok configa;
// .env je za lokalni dev / skripte.

import { ADDRESS_RE } from "./lib/chain/constants.js";

try {
  (process as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  /* nema .env — env dolazi iz okoline */
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Default pinka account za pisanje (gmail personal — dashboard-vidljiv). */
  accountId: string;
  /** Opc. 0x signer → pali per-kampanja Safe derivaciju. */
  ownerSigner: string | null;
  /** Opc. 0x Safe koji kontroliraš → fallback destinacija. */
  defaultDestination: string | null;
  gnosisRpc: string;
  serviceName: string;
  serviceVersion: string;
}

function validAddr(name: string, v: string | undefined): string | null {
  if (!v) return null;
  if (!ADDRESS_RE.test(v)) {
    throw new Error(`${name} mora biti 0x + 40 hex znamenki, dobiveno: ${v}`);
  }
  return v;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: optional("SUPABASE_URL", "https://api.domovina.ai"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    // gmail personal account (stepanic.matija@gmail.com) — vidi seed runbook.
    accountId: optional("PINKA_ACCOUNT_ID", "6a9bc134-9a03-435c-a7f7-7ecc324e0393"),
    ownerSigner: validAddr("PINKA_OWNER_SIGNER", process.env.PINKA_OWNER_SIGNER),
    defaultDestination: validAddr(
      "PINKA_DEFAULT_DESTINATION",
      process.env.PINKA_DEFAULT_DESTINATION,
    ),
    gnosisRpc: optional("GNOSIS_RPC", "https://rpc.gnosischain.com"),
    serviceName: "pinka-mcp",
    serviceVersion: "0.1.0",
  };
}
