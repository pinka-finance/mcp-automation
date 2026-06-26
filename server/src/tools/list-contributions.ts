import { z } from "zod";
import type { ToolDeps, JsonSchema } from "./types.js";

export const ListContributionsInput = z.object({
  campaign_id: z.string().uuid().describe("Campaign uuid."),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListContributionsArgs = z.infer<typeof ListContributionsInput>;

export const listContributionsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    campaign_id: { type: "string", description: "Campaign uuid" },
    limit: { type: "number", default: 50 },
  },
  required: ["campaign_id"],
};

/// Javni "zid donatora" (public_contributions view: samo paid, ne-anonimni,
/// javne kampanje). Za privatni/puni uvid trebao bi contributions tablicu, no
/// zid je dovoljan za pregled.
export async function listContributions(
  args: ListContributionsArgs,
  deps: ToolDeps,
) {
  const { sb } = deps;
  const { data, error } = await sb
    .from("public_contributions")
    .select("*")
    .eq("campaign_id", args.campaign_id)
    .order("amount_cents", { ascending: false })
    .limit(args.limit);
  if (error) throw new Error(error.message);
  return { count: data?.length ?? 0, contributions: data ?? [] };
}
