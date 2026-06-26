import { z } from "zod";
import { isSafeSet, ADDRESS_RE } from "../lib/chain/constants.js";
import type { ToolDeps, JsonSchema } from "./types.js";

// Patch je podskup content polja koja se SMIJU mijenjati nakon kreiranja.
// slug/account_id/id se NE diraju (slug ima immutability guard trigger). Iznosi
// u € → centi. state='active' ide kroz guard mirror (vidi §6 plana) jer se
// serverski campaigns_write_guard NE okida za service_role.
const PatchSchema = z
  .object({
    title: z.string().trim().min(3).max(160).optional(),
    description: z.string().max(20000).nullable().optional(),
    goal_eur: z.number().positive().nullable().optional(),
    min_contribution_eur: z.number().positive().optional(),
    visibility: z.enum(["public", "unlisted", "private"]).optional(),
    cover_image_url: z.string().regex(/^https:\/\//i).max(1000).nullable().optional(),
    recurrence: z.enum(["none", "monthly", "quarterly", "yearly"]).optional(),
    recurrence_anchor_day: z.number().int().min(1).max(31).nullable().optional(),
    state: z.enum(["draft", "active", "funded", "closed", "cancelled"]).optional(),
    youtube_channel_id: z.string().regex(/^UC[0-9A-Za-z_-]{22}$/).nullable().optional(),
    location_name: z.string().max(160).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    starts_at: z.string().nullable().optional(),
    ends_at: z.string().nullable().optional(),
    subject_type: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
    subject_ref: z.string().trim().max(200).nullable().optional(),
    destination_address: z.string().regex(ADDRESS_RE).optional(),
  })
  .strict();

export const UpdateCampaignInput = z.object({
  id: z.string().uuid().describe("Campaign uuid."),
  patch: PatchSchema.describe("Polja za izmjenu (iznosi u €)."),
});
export type UpdateCampaignArgs = z.infer<typeof UpdateCampaignInput>;

export const updateCampaignJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Campaign uuid" },
    patch: {
      type: "object",
      description:
        "title, description, goal_eur, min_contribution_eur, visibility, cover_image_url, " +
        "recurrence, recurrence_anchor_day, state, youtube_channel_id, location_name, " +
        "latitude, longitude, starts_at, ends_at, subject_type, subject_ref, destination_address",
    },
  },
  required: ["id", "patch"],
};

function eurToCents(eur: number, lo: number, hi: number, label: string): number {
  const c = Math.round(eur * 100);
  if (c < lo || c > hi) throw new Error(`${label}: ${eur} € izvan raspona`);
  return c;
}

export async function updateCampaign(args: UpdateCampaignArgs, deps: ToolDeps) {
  const { sb } = deps;
  const p = args.patch;

  // trenutno stanje (za guard mirror)
  const { data: current, error: curErr } = await sb
    .from("campaigns")
    .select("id, destination_address, state, deleted_at")
    .eq("id", args.id)
    .maybeSingle();
  if (curErr) throw new Error(curErr.message);
  if (!current) throw new Error("campaign_not_found");
  const cur = current as { destination_address: string; state: string; deleted_at: string | null };
  if (cur.deleted_at) throw new Error("campaign_deleted");

  // build update objekt
  const upd: Record<string, unknown> = {};
  if (p.title !== undefined) upd.title = p.title.trim();
  if (p.description !== undefined) upd.description = p.description?.trim() || null;
  if (p.goal_eur !== undefined)
    upd.goal_cents = p.goal_eur == null ? null : eurToCents(p.goal_eur, 100, 10_000_000_000, "invalid_goal");
  if (p.min_contribution_eur !== undefined)
    upd.min_contribution_cents = eurToCents(p.min_contribution_eur, 1, 1_000_000, "invalid_min_contribution");
  if (p.visibility !== undefined) upd.visibility = p.visibility;
  if (p.cover_image_url !== undefined) upd.cover_image_url = p.cover_image_url;
  if (p.recurrence !== undefined) upd.recurrence = p.recurrence;
  if (p.recurrence_anchor_day !== undefined) upd.recurrence_anchor_day = p.recurrence_anchor_day;
  if (p.state !== undefined) upd.state = p.state;
  if (p.youtube_channel_id !== undefined) upd.youtube_channel_id = p.youtube_channel_id;
  if (p.location_name !== undefined) upd.location_name = p.location_name;
  if (p.latitude !== undefined) upd.latitude = p.latitude;
  if (p.longitude !== undefined) upd.longitude = p.longitude;
  if (p.starts_at !== undefined) upd.starts_at = p.starts_at;
  if (p.ends_at !== undefined) upd.ends_at = p.ends_at;
  if (p.subject_type !== undefined) upd.subject_type = p.subject_type;
  if (p.subject_ref !== undefined) upd.subject_ref = p.subject_ref?.trim() || null;
  if (p.destination_address !== undefined) upd.destination_address = p.destination_address;

  if (Object.keys(upd).length === 0) throw new Error("Prazan patch.");

  // ── guard mirror (service_role zaobilazi trigger; repliciramo zaštite) ──────
  // 1) destination-lock: promjena adrese nakon prve PLAĆENE uplate je zabranjena
  if (p.destination_address !== undefined && p.destination_address !== cur.destination_address) {
    const { count } = await sb
      .from("contributions")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", args.id)
      .eq("state", "paid");
    if ((count ?? 0) > 0) {
      throw new Error("campaign_destination_locked: adresa zaključana nakon prve uplate.");
    }
  }
  // 2) aktivacija bez pravog Safe-a → donacije na nultu adresu (spaljene)
  if (p.state === "active") {
    const effectiveDest = (upd.destination_address as string) ?? cur.destination_address;
    if (!isSafeSet(effectiveDest)) {
      throw new Error("campaign_destination_missing: ne mogu aktivirati bez pravog Safe-a.");
    }
  }

  const { data, error } = await sb
    .from("campaigns")
    .update(upd)
    .eq("id", args.id)
    .select("id, slug, state, visibility, destination_address, updated_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { updated: true, fields: Object.keys(upd), campaign: data };
}
