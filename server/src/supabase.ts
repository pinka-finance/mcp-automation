import { createClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

// service_role klijent nad pinka_finance shemom. service_role ZAOBILAZI RLS i
// BEFORE INSERT/UPDATE guard trigger (taj se okida samo za auth.role()=
// 'authenticated'). God-mode → ključ ostaje lokalno, nikad u repo/log.
//
// Korištenje: db(config).from("campaigns")… ili .rpc("create_campaign", …).
// supabase-js .schema() postavlja Accept-Profile / Content-Profile zaglavlja.

export const SCHEMA = "pinka_finance";

export function createServiceClient(config: Config) {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: SCHEMA },
  });
}

// Tip klijenta (schema=pinka_finance) — koristi se kroz ToolDeps.sb.
export type Db = ReturnType<typeof createServiceClient>;
