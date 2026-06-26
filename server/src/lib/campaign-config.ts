import { z } from "zod";

// "pinka.campaign.v1" — prijenosni format konfiguracije kampanje. Port
// app/lib/campaign-config.ts whitelist + validacijskih pravila, ali kao zod
// schema (MCP prima strukturirani objekt, ne zalijepljeni tekst). Iznosi su u
// EURIMA (kao AI/CDN format); konverzija u cente s istim bounds-ovima kao
// create_campaign RPC. SAMO whitelistana content polja — destinacija/metadata/
// state se NIKAD ne postavljaju kroz config (vidi §6 implementacijskog plana).

export const CONFIG_VERSION = "pinka.campaign.v1";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const todayISO = (): string => new Date().toISOString().slice(0, 10);

const LocationSchema = z
  .object({
    name: z.string().trim().max(160).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .refine((l) => (l.latitude == null) === (l.longitude == null), {
    message: "latitude i longitude moraju biti oboje zadani ili oboje izostavljeni",
  })
  .refine((l) => l.name != null || l.latitude != null, {
    message: "location mora imati barem name ili koordinate",
  });

// Content whitelist. Sva polja osim title su opcionalna; defaulti se primjenjuju
// pri mapiranju u RPC, ne ovdje (da update patch može slati samo dirana polja).
export const CampaignConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).optional(),
    title: z.string().trim().min(3).max(160),
    type: z
      .enum(["donation", "crowdfund", "tokenization", "tickets", "realestate"])
      .optional(),
    description: z.string().max(20000).optional(),
    goal_eur: z.number().positive().nullable().optional(),
    min_contribution_eur: z.number().positive().optional(),
    visibility: z.enum(["public", "unlisted", "private"]).optional(),
    recurrence: z.enum(["none", "monthly", "quarterly", "yearly"]).optional(),
    recurrence_anchor_day: z.number().int().min(1).max(31).nullable().optional(),
    location: LocationSchema.nullable().optional(),
    starts_at: z
      .string()
      .refine(isValidDate, "starts_at mora biti YYYY-MM-DD")
      .nullable()
      .optional(),
    ends_at: z
      .string()
      .refine(isValidDate, "ends_at mora biti YYYY-MM-DD")
      .refine((s) => s > todayISO(), "ends_at mora biti u budućnosti")
      .nullable()
      .optional(),
    subject_type: z
      .string()
      .regex(/^[a-z0-9_]{1,40}$/, "subject_type ~ ^[a-z0-9_]{1,40}$")
      .optional(),
    subject_ref: z.string().trim().min(1).max(200).nullable().optional(),
    cover_image_url: z
      .string()
      .regex(/^https:\/\//i, "cover_image_url mora počinjati s https://")
      .max(1000)
      .nullable()
      .optional(),
    youtube_channel_id: z
      .string()
      .regex(/^UC[0-9A-Za-z_-]{22}$/, "youtube_channel_id ~ ^UC…{22}$")
      .nullable()
      .optional(),
  })
  .strict(); // nepoznata polja → greška (anti-injection)

export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;

// eur → centi s istim zaokruživanjem i bounds-ovima kao create_campaign RPC.
function goalCents(goalEur: number | null | undefined): number | null {
  if (goalEur == null) return null;
  const c = Math.round(goalEur * 100);
  if (c < 100 || c > 10_000_000_000) {
    throw new Error(`invalid_goal: ${goalEur} € izvan raspona 1…100000000`);
  }
  return c;
}
function minCents(minEur: number | undefined): number {
  if (minEur == null) return 100;
  const c = Math.round(minEur * 100);
  if (c < 1 || c > 1_000_000) {
    throw new Error(`invalid_min_contribution: ${minEur} € izvan raspona 0.01…10000`);
  }
  return c;
}

export interface CreateCampaignRpcParams {
  p_title: string;
  p_type: string;
  p_description: string | null;
  p_goal_cents: number | null;
  p_min_contribution_cents: number;
  p_subject_type: string;
  p_subject_ref: string | null;
  p_visibility: string;
  p_recurrence: string;
  p_recurrence_anchor_day: number | null;
  p_latitude: number | null;
  p_longitude: number | null;
  p_location_name: string | null;
  p_cover_image_url: string | null;
  p_starts_at: string | null;
  p_ends_at: string | null;
}

/// Validirani config → create_campaign RPC parametri (bez id/account/destination/
/// metadata — to tool slaže oko ovoga). Baca s 'invalid_*' kodom ako iznos ispadne
/// iz raspona nakon konverzije u cente.
export function configToRpcParams(cfg: CampaignConfig): CreateCampaignRpcParams {
  const goal = goalCents(cfg.goal_eur);
  const min = minCents(cfg.min_contribution_eur);
  if (goal != null && min > goal) {
    throw new Error("min_exceeds_goal: min_contribution > goal");
  }
  const recurrence = cfg.recurrence ?? "none";
  const anchor =
    recurrence === "monthly" ? cfg.recurrence_anchor_day ?? null : null;
  return {
    p_title: cfg.title.trim(),
    p_type: cfg.type ?? "donation",
    p_description: cfg.description?.trim() || null,
    p_goal_cents: goal,
    p_min_contribution_cents: min,
    p_subject_type: cfg.subject_type ?? "generic",
    p_subject_ref: cfg.subject_ref?.trim() || null,
    p_visibility: cfg.visibility ?? "private",
    p_recurrence: recurrence,
    p_recurrence_anchor_day: anchor,
    p_latitude: cfg.location?.latitude ?? null,
    p_longitude: cfg.location?.longitude ?? null,
    p_location_name: cfg.location?.name?.trim() || null,
    p_cover_image_url: cfg.cover_image_url ?? null,
    p_starts_at: cfg.starts_at ?? null,
    p_ends_at: cfg.ends_at ?? null,
  };
}
