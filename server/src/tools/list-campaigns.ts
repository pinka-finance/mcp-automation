import { z } from "zod";
import type { ToolDeps, JsonSchema } from "./types.js";

const CAMPAIGN_COLS =
  "id, slug, type, title, state, visibility, destination_address, " +
  "subject_type, subject_ref, youtube_channel_id, goal_cents, " +
  "min_contribution_cents, currency, created_at, " +
  "campaign_stats(total_raised_cents, contribution_count, contributor_count)";

export const ListCampaignsInput = z.object({
  account: z
    .string()
    .optional()
    .describe('Account uuid, "me" (default — tvoj account) ili "all".'),
  state: z
    .enum(["draft", "active", "funded", "closed", "cancelled"])
    .optional()
    .describe("Filtriraj po stanju."),
  channel: z.string().optional().describe("youtube_channel_id anchor (UC…)."),
  episode: z.string().optional().describe("YouTube videoId — kampanja vezana na epizodu."),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListCampaignsArgs = z.infer<typeof ListCampaignsInput>;

export const listCampaignsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    account: { type: "string", description: 'uuid | "me" | "all"' },
    state: {
      type: "string",
      enum: ["draft", "active", "funded", "closed", "cancelled"],
    },
    channel: { type: "string", description: "youtube_channel_id (UC…)" },
    episode: { type: "string", description: "YouTube videoId" },
    limit: { type: "number", default: 50 },
  },
};

export async function listCampaigns(args: ListCampaignsArgs, deps: ToolDeps) {
  const { sb, config } = deps;

  // episode filter → razriješi campaign id-eve iz join tablice + legacy stupca
  let idFilter: string[] | null = null;
  if (args.episode) {
    const ids = new Set<string>();
    const { data: subs } = await sb
      .from("campaign_subjects")
      .select("campaign_id")
      .eq("subject_ref", args.episode);
    (subs ?? []).forEach((r) => ids.add((r as { campaign_id: string }).campaign_id));
    const { data: legacy } = await sb
      .from("campaigns")
      .select("id")
      .eq("subject_ref", args.episode);
    (legacy ?? []).forEach((r) => ids.add((r as { id: string }).id));
    idFilter = [...ids];
    if (idFilter.length === 0) return { count: 0, campaigns: [] };
  }

  let q = sb.from("campaigns").select(CAMPAIGN_COLS).is("deleted_at", null);

  const account = args.account ?? "me";
  if (account !== "all") {
    q = q.eq("account_id", account === "me" ? config.accountId : account);
  }
  if (args.state) q = q.eq("state", args.state);
  if (args.channel) q = q.eq("youtube_channel_id", args.channel);
  if (idFilter) q = q.in("id", idFilter);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (error) throw new Error(error.message);
  return { count: data?.length ?? 0, campaigns: data ?? [] };
}
