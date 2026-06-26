// End-to-end test za pinka MCP toolove protiv ŽIVOG backenda.
//
//   Faza A (uvijek, bez DB upisa): import_domovina + derive_safe (live CDN/RPC).
//   Faza B (--write, treba service_role): create draft → set epizodu → activate →
//           verificiraj active_campaign_for_subject → ponudi brisanje test kampanje.
//
// Pokretanje:
//   npm run e2e              # samo Faza A (sigurno, ništa se ne piše)
//   npm run e2e -- --write   # + Faza B (piše u prod; traži potvrdu za brisanje)
//
// Cilj Faze B: kampanja za epizodu b-nls1ck8EE (kanal UCXXhnehl2pss0uYdfLRDtyw)
// → kartica se pojavi u domovina.ai /v/b-nls1ck8EE.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config.js";
import { createServiceClient } from "../src/supabase.js";
import { importDomovina } from "../src/tools/import-domovina.js";
import { deriveSafe } from "../src/tools/derive-safe.js";
import { createCampaign } from "../src/tools/create-campaign.js";
import { setEpisodes } from "../src/tools/episodes.js";
import { updateCampaign } from "../src/tools/update-campaign.js";
import type { ToolDeps } from "../src/tools/types.js";

const EPISODE = "b-nls1ck8EE";
const CHANNEL = "UCXXhnehl2pss0uYdfLRDtyw";
const WRITE = process.argv.includes("--write");

function log(title: string, obj: unknown) {
  console.log(`\n── ${title} ──`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const config = loadConfig();
  const sb = createServiceClient(config);
  const deps: ToolDeps = { config, sb };

  // ── Faza A: read-only (CDN + Safe derivacija) ──────────────────────────────
  console.log("═══ Faza A: read-only (bez DB upisa) ═══");
  const imported = await importDomovina({ url: `https://domovina.ai/v/${EPISODE}` }, deps);
  log("pinka_import_domovina", imported);

  if (config.ownerSigner) {
    const safe = await deriveSafe({}, deps);
    log("pinka_derive_safe", safe);
  } else {
    console.log("\n(derive_safe preskočen — nema PINKA_OWNER_SIGNER; koristit će se default destinacija)");
  }

  if (!WRITE) {
    console.log("\n✅ Faza A gotova. Za puni e2e (piše u prod): npm run e2e -- --write");
    return;
  }

  // ── Faza B: pun lifecycle ──────────────────────────────────────────────────
  console.log("\n═══ Faza B: create → link → activate → verify (PIŠE U PROD) ═══");
  const id = randomUUID();

  const created = await createCampaign(
    {
      id,
      title: `E2E test — podrška epizodi ${EPISODE}`,
      type: "donation",
      description: "Automatski e2e test kampanja (pinka MCP). Smije se obrisati.",
      goal_eur: 5000,
      visibility: "public",
      subject_type: "podcast_episode",
      subject_ref: EPISODE,
      youtube_channel_id: CHANNEL,
    },
    deps,
  );
  log("pinka_create_campaign", created);

  const linked = await setEpisodes({ campaign_id: created.id, episode_ids: [EPISODE] }, deps);
  log("pinka_set_episodes", linked);

  const activated = await updateCampaign(
    { id: created.id, patch: { state: "active", visibility: "public" } },
    deps,
  );
  log("pinka_update_campaign (activate)", activated);

  // verifikacija — ono što domovina.ai čita
  const { data: verify, error: vErr } = await sb.rpc("active_campaign_for_subject", {
    p_subject_type: "podcast_episode",
    p_subject_refs: [EPISODE],
  });
  if (vErr) throw new Error(`active_campaign_for_subject: ${vErr.message}`);
  log("active_campaign_for_subject('podcast_episode', [EPISODE])", verify);

  const found = Array.isArray(verify) && verify.some((c: { id: string }) => c.id === created.id);
  console.log(
    found
      ? `\n✅ VERIFICIRANO — kampanja ${created.slug} se sad prikazuje na domovina.ai/v/${EPISODE}`
      : `\n❌ Kampanja NIJE vraćena iz active_campaign_for_subject — provjeri state/visibility/destination.`,
  );

  // ponudi brisanje
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\nObrisati test kampanju ${created.id}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans === "y" || ans === "yes") {
    // hard delete (test artefakt) — campaign_subjects/stats kaskadno padaju
    await sb.from("campaign_subjects").delete().eq("campaign_id", created.id);
    const { error: delErr } = await sb.from("campaigns").delete().eq("id", created.id);
    if (delErr) console.log(`Brisanje nije uspjelo (možda ima paid uplata): ${delErr.message}`);
    else console.log("🗑️  Obrisano.");
  } else {
    console.log(`Zadržano. Slug: ${created.slug} → https://pinka.io/c/${created.slug}`);
  }
}

main().catch((err) => {
  console.error("\n❌ e2e fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
