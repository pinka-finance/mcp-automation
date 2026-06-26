import { z } from "zod";
import type { ToolDeps, JsonSchema } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FULL_COLS =
  "id, slug, type, title, description, state, visibility, " +
  "destination_address, chain, subject_type, subject_ref, youtube_channel_id, " +
  "goal_cents, min_contribution_cents, currency, cover_image_url, " +
  "recurrence, recurrence_anchor_day, latitude, longitude, location_name, " +
  "starts_at, ends_at, account_id, metadata, created_at, updated_at, " +
  "campaign_stats(total_raised_cents, contribution_count, contributor_count, last_contribution_at)";

export const GetCampaignInput = z.object({
  id_or_slug: z.string().describe("Campaign uuid ili slug."),
});
export type GetCampaignArgs = z.infer<typeof GetCampaignInput>;

export const getCampaignJsonSchema: JsonSchema = {
  type: "object",
  properties: { id_or_slug: { type: "string", description: "uuid ili slug" } },
  required: ["id_or_slug"],
};

export async function getCampaign(args: GetCampaignArgs, deps: ToolDeps) {
  const { sb } = deps;
  const isUuid = UUID_RE.test(args.id_or_slug);
  const { data, error } = await sb
    .from("campaigns")
    .select(FULL_COLS)
    .eq(isUuid ? "id" : "slug", args.id_or_slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { found: false };

  const campaignId = (data as unknown as { id: string }).id;
  const { data: subjects } = await sb
    .from("campaign_subjects")
    .select("subject_type, subject_ref, created_at")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });

  return { found: true, campaign: data, episodes: subjects ?? [] };
}
