import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CampaignConfigSchema,
  configToRpcParams,
} from "../lib/campaign-config.js";
import { isSafeSet } from "../lib/chain/constants.js";
import { resolveDestination } from "../destination.js";
import type { ToolDeps, JsonSchema } from "./types.js";

// Input = pinka.campaign.v1 content + operativna polja (id/account/activate).
export const CreateCampaignInput = CampaignConfigSchema.extend({
  id: z.string().uuid().optional().describe("Stabilni client uuid (idempotencija). Inače svjež."),
  account_id: z.string().uuid().optional().describe("Pinka account; default PINKA_ACCOUNT_ID."),
  activate: z
    .boolean()
    .optional()
    .describe("Odmah aktiviraj (state=active) nakon kreiranja. Default false (ostaje draft)."),
});
export type CreateCampaignArgs = z.infer<typeof CreateCampaignInput>;

export const createCampaignJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "3–160 znakova (obavezno)." },
    type: {
      type: "string",
      enum: ["donation", "crowdfund", "tokenization", "tickets", "realestate"],
      description: "Default donation.",
    },
    description: { type: "string", description: "Glavni tekst, ≤20000." },
    goal_eur: { type: ["number", "null"], description: "Cilj u € (1…100000000) ili null = open-ended." },
    min_contribution_eur: { type: "number", description: "Min uplata u € (default 1)." },
    visibility: { type: "string", enum: ["public", "unlisted", "private"], description: "Default private." },
    recurrence: { type: "string", enum: ["none", "monthly", "quarterly", "yearly"], description: "Default none." },
    recurrence_anchor_day: { type: ["number", "null"], description: "Samo monthly: 1–31." },
    location: {
      type: ["object", "null"],
      description: "{ name?, latitude?, longitude? } — samo uz fizičku lokaciju.",
    },
    starts_at: { type: ["string", "null"], description: "YYYY-MM-DD." },
    ends_at: { type: ["string", "null"], description: "YYYY-MM-DD (budućnost)." },
    subject_type: { type: "string", description: 'npr. "podcast_episode" (default generic).' },
    subject_ref: { type: ["string", "null"], description: "YouTube videoId uz podcast_episode." },
    cover_image_url: { type: ["string", "null"], description: "https URL." },
    youtube_channel_id: { type: ["string", "null"], description: "Anchor kanal UC… (postavi se nakon kreiranja)." },
    id: { type: "string", description: "Client uuid za idempotenciju (opc.)." },
    account_id: { type: "string", description: "Pinka account (opc.; default env)." },
    activate: { type: "boolean", description: "Odmah aktiviraj (default false)." },
  },
  required: ["title"],
};

export async function createCampaign(args: CreateCampaignArgs, deps: ToolDeps) {
  const { sb, config } = deps;
  const campaignId = args.id ?? randomUUID();
  const accountId = args.account_id ?? config.accountId;

  const rpc = configToRpcParams(args); // baca invalid_* na lošem iznosu
  const dest = await resolveDestination(config, campaignId);

  const { data, error } = await sb.rpc("create_campaign", {
    p_id: campaignId,
    p_account_id: accountId,
    p_destination_address: dest.address,
    p_metadata: { safe: dest.safe },
    ...rpc,
  });
  if (error) throw new Error(`create_campaign: ${error.message}`);

  const result = data as { id: string; slug: string; existing: boolean };

  // youtube_channel_id anchor — create_campaign RPC ga ne prima, postavi PATCH-om.
  if (args.youtube_channel_id && !result.existing) {
    const { error: chErr } = await sb
      .from("campaigns")
      .update({ youtube_channel_id: args.youtube_channel_id })
      .eq("id", result.id);
    if (chErr) throw new Error(`set youtube_channel_id: ${chErr.message}`);
  }

  let activated = false;
  if (args.activate && !result.existing) {
    if (!isSafeSet(dest.address)) {
      throw new Error(
        "Ne mogu aktivirati: destinacija je nulta/nevaljana adresa (donacije bi se spalile).",
      );
    }
    const { error: actErr } = await sb
      .from("campaigns")
      .update({ state: "active" })
      .eq("id", result.id);
    if (actErr) throw new Error(`activate: ${actErr.message}`);
    activated = true;
  }

  return {
    id: result.id,
    slug: result.slug,
    existing: result.existing,
    account_id: accountId,
    destination_address: dest.address,
    destination_source: dest.source,
    state: activated ? "active" : "draft",
    url: `https://pinka.io/c/${result.slug}`,
    note: result.existing
      ? "Postojeća kampanja (idempotentni retry s istim id)."
      : activated
        ? "Kreirana i aktivirana."
        : "Kreirana kao draft. Poveži epizode pa pinka_update_campaign({state:'active'}).",
  };
}
