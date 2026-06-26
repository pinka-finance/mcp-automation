import { CONFIG_VERSION } from "./campaign-config.js";

// Port app/lib/domovina-import.ts — prefill kampanje iz javnih CDN JSON-a za
// domovina.ai /v/<id> (epizoda) ili /c/<slug> (kanal). Rezultat je
// pinka.campaign.v1 nacrt (objekt), BEZ upisa u bazu. Node 22 ima globalni fetch.

export type DomovinaRef =
  | { kind: "episode"; id: string }
  | { kind: "channel"; slug: string; channelId: string };

const URL_RE = /(?:https?:\/\/)?(?:www\.)?domovina\.ai\/(v|c)\/([A-Za-z0-9_-]+)/;

export function parseDomovinaUrl(text: string): DomovinaRef | null {
  const m = text.trim().match(URL_RE);
  if (!m || !m[1] || !m[2]) return null;
  if (m[1] === "v") return { kind: "episode", id: m[2] };
  return { kind: "channel", slug: m[2], channelId: m[2].replace(/-/g, "_") };
}

const CDN = "https://cdn.domovina.ai";

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

async function episodeConfig(id: string): Promise<Record<string, unknown>> {
  const summaryDoc = await getJson(`${CDN}/data/${id}/summary.json`);
  const s = (summaryDoc?.summary ?? null) as Record<string, unknown> | null;

  let title = "";
  let body = "";
  if (s) {
    title = String(s.title_hr || (summaryDoc?.source as Record<string, unknown>)?.title || "");
    const abstract = String(s.abstract_hr ?? "");
    const points = Array.isArray(s.key_points)
      ? (s.key_points as unknown[]).map((p) => `• ${String(p)}`).join("\n")
      : "";
    body = [abstract, points].filter(Boolean).join("\n\n");
  } else {
    const info = await getJson(`${CDN}/data/${id}/info.json`);
    if (!info) throw new Error("domovina_not_found");
    title = String(info.title ?? "");
    body = String(info.description ?? "");
  }
  if (!title) throw new Error("domovina_not_found");

  const config: Record<string, unknown> = {
    version: CONFIG_VERSION,
    title: clip(`Podrži epizodu: ${title}`, 160),
    type: "donation",
    description: clip(`${body}\n\nEpizoda: https://domovina.ai/v/${id}`.trim(), 20000),
    visibility: "public",
    recurrence: "none",
    subject_type: "podcast_episode",
    subject_ref: id,
  };
  const thumb = `${CDN}/images/${id}/thumbnail.png`;
  if (await urlExists(thumb)) config.cover_image_url = thumb;
  return config;
}

async function channelConfig(
  slug: string,
  channelId: string,
): Promise<Record<string, unknown>> {
  const d = await getJson(`${CDN}/channels/data/${channelId}.json`);
  if (!d || !d.name) throw new Error("domovina_not_found");
  const name = String(d.name);
  const desc = String(d.description ?? "").trim();
  const videoCount = Number(d.video_count ?? 0);
  const body =
    desc ||
    `Redovita podrška kanalu ${name} na domovina.ai${videoCount ? ` (${videoCount} epizoda)` : ""}. Svaka članarina ide izravno autorima.`;

  const config: Record<string, unknown> = {
    version: CONFIG_VERSION,
    title: clip(`Podrži kanal ${name}`, 160),
    type: "donation",
    description: clip(`${body}\n\nKanal: https://domovina.ai/c/${slug}`, 20000),
    visibility: "public",
    recurrence: "monthly",
    subject_type: "channel",
    subject_ref: channelId,
  };
  const cover = typeof d.avatar_cover === "string" ? d.avatar_cover.split("?")[0] : null;
  if (cover && /^https:\/\//.test(cover)) config.cover_image_url = cover;
  return config;
}

export async function fetchDomovinaConfig(
  ref: DomovinaRef,
): Promise<Record<string, unknown>> {
  return ref.kind === "episode"
    ? episodeConfig(ref.id)
    : channelConfig(ref.slug, ref.channelId);
}
