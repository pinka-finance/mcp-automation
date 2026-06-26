import { z } from "zod";
import type { ToolDeps, JsonSchema } from "./types.js";

// Linkanje epizoda ↔ kampanja preko campaign_subjects join tablice. NE koristimo
// SECURITY DEFINER RPC-eve (set_campaign_episodes/attach/detach) jer autoriziraju
// preko auth.uid() koji je NULL pod service_role → not_authorized. service_role
// ima direktan insert/update/delete grant na campaign_subjects; unique(subject_type,
// subject_ref) i dalje čuva "epizoda ≤ 1 kampanja" garanciju (vidi §6 plana).

async function assertCampaignExists(deps: ToolDeps, campaignId: string) {
  const { data } = await deps.sb
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new Error("campaign_not_found");
}

async function assertNotTaken(
  deps: ToolDeps,
  campaignId: string,
  subjectType: string,
  refs: string[],
) {
  if (refs.length === 0) return;
  const { data } = await deps.sb
    .from("campaign_subjects")
    .select("subject_ref, campaign_id")
    .eq("subject_type", subjectType)
    .in("subject_ref", refs)
    .neq("campaign_id", campaignId);
  if (data && data.length > 0) {
    const taken = data.map((r) => (r as { subject_ref: string }).subject_ref);
    throw new Error(`episode_taken: već u drugoj kampanji: ${taken.join(", ")}`);
  }
}

// ───────────────────────── set_episodes ─────────────────────────
export const SetEpisodesInput = z.object({
  campaign_id: z.string().uuid(),
  episode_ids: z.array(z.string().min(1).max(200)).describe("Cijeli set YouTube videoId-eva (zamjena)."),
});
export type SetEpisodesArgs = z.infer<typeof SetEpisodesInput>;
export const setEpisodesJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    campaign_id: { type: "string" },
    episode_ids: { type: "array", items: { type: "string" }, description: "YouTube videoId-evi" },
  },
  required: ["campaign_id", "episode_ids"],
};

export async function setEpisodes(args: SetEpisodesArgs, deps: ToolDeps) {
  const { sb } = deps;
  await assertCampaignExists(deps, args.campaign_id);
  const ids = [...new Set(args.episode_ids)];
  await assertNotTaken(deps, args.campaign_id, "podcast_episode", ids);

  // zamijeni cijeli set: obriši postojeće epizode ove kampanje, ubaci nove
  const { error: delErr } = await sb
    .from("campaign_subjects")
    .delete()
    .eq("campaign_id", args.campaign_id)
    .eq("subject_type", "podcast_episode");
  if (delErr) throw new Error(delErr.message);

  if (ids.length > 0) {
    const rows = ids.map((ref) => ({
      campaign_id: args.campaign_id,
      subject_type: "podcast_episode",
      subject_ref: ref,
    }));
    const { error: insErr } = await sb.from("campaign_subjects").insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  return { campaign_id: args.campaign_id, episodes: ids, count: ids.length };
}

// ───────────────────────── attach_episode ─────────────────────────
export const AttachEpisodeInput = z.object({
  campaign_id: z.string().uuid(),
  subject_ref: z.string().min(1).max(200).describe("YouTube videoId (ili drugi ref)."),
  subject_type: z.string().regex(/^[a-z0-9_]{1,40}$/).default("podcast_episode"),
});
export type AttachEpisodeArgs = z.infer<typeof AttachEpisodeInput>;
export const attachEpisodeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    campaign_id: { type: "string" },
    subject_ref: { type: "string", description: "YouTube videoId" },
    subject_type: { type: "string", default: "podcast_episode" },
  },
  required: ["campaign_id", "subject_ref"],
};

export async function attachEpisode(args: AttachEpisodeArgs, deps: ToolDeps) {
  const { sb } = deps;
  await assertCampaignExists(deps, args.campaign_id);
  await assertNotTaken(deps, args.campaign_id, args.subject_type, [args.subject_ref]);
  const { error } = await sb
    .from("campaign_subjects")
    .upsert(
      { campaign_id: args.campaign_id, subject_type: args.subject_type, subject_ref: args.subject_ref },
      { onConflict: "subject_type,subject_ref", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
  return { attached: true, campaign_id: args.campaign_id, subject_type: args.subject_type, subject_ref: args.subject_ref };
}

// ───────────────────────── detach_episode ─────────────────────────
export const DetachEpisodeInput = z.object({
  campaign_id: z.string().uuid(),
  subject_ref: z.string().min(1).max(200),
  subject_type: z.string().regex(/^[a-z0-9_]{1,40}$/).default("podcast_episode"),
});
export type DetachEpisodeArgs = z.infer<typeof DetachEpisodeInput>;
export const detachEpisodeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    campaign_id: { type: "string" },
    subject_ref: { type: "string" },
    subject_type: { type: "string", default: "podcast_episode" },
  },
  required: ["campaign_id", "subject_ref"],
};

export async function detachEpisode(args: DetachEpisodeArgs, deps: ToolDeps) {
  const { sb } = deps;
  const { error } = await sb
    .from("campaign_subjects")
    .delete()
    .eq("campaign_id", args.campaign_id)
    .eq("subject_type", args.subject_type)
    .eq("subject_ref", args.subject_ref);
  if (error) throw new Error(error.message);
  return { detached: true, campaign_id: args.campaign_id, subject_ref: args.subject_ref };
}
