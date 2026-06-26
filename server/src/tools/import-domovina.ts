import { z } from "zod";
import { parseDomovinaUrl, fetchDomovinaConfig } from "../lib/domovina-import.js";
import type { ToolDeps, JsonSchema } from "./types.js";

export const ImportDomovinaInput = z.object({
  url: z
    .string()
    .describe("domovina.ai link: /v/<youtubeId> (epizoda) ili /c/<slug> (kanal)."),
});
export type ImportDomovinaArgs = z.infer<typeof ImportDomovinaInput>;

export const importDomovinaJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "domovina.ai /v/<id> ili /c/<slug> link.",
    },
  },
  required: ["url"],
};

/// Vrati pinka.campaign.v1 nacrt iz CDN metapodataka. BEZ upisa u bazu —
/// proslijedi rezultat u pinka_create_campaign (po želji nakon dorade teksta).
export async function importDomovina(args: ImportDomovinaArgs, _deps: ToolDeps) {
  const ref = parseDomovinaUrl(args.url);
  if (!ref) {
    throw new Error(
      `Nevaljan domovina.ai link: ${args.url} (očekujem /v/<id> ili /c/<slug>).`,
    );
  }
  const config = await fetchDomovinaConfig(ref);
  return {
    ref,
    config,
    hint:
      "Nacrt (nije spremljen). Doradi naslov/opis pa pozovi pinka_create_campaign s ovim configom.",
  };
}
