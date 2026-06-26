// MCP Server factory — registrira pinka write/read toolove. Registry-driven
// (jedna TOOLS lista je izvor istine za ListTools i CallTool dispatch).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";

import type { Config } from "./config.js";
import { createServiceClient } from "./supabase.js";
import type { ToolDeps, JsonSchema } from "./tools/types.js";

import { ListCampaignsInput, listCampaignsJsonSchema, listCampaigns } from "./tools/list-campaigns.js";
import { GetCampaignInput, getCampaignJsonSchema, getCampaign } from "./tools/get-campaign.js";
import { ImportDomovinaInput, importDomovinaJsonSchema, importDomovina } from "./tools/import-domovina.js";
import { DeriveSafeInput, deriveSafeJsonSchema, deriveSafe } from "./tools/derive-safe.js";
import { CreateCampaignInput, createCampaignJsonSchema, createCampaign } from "./tools/create-campaign.js";
import { UpdateCampaignInput, updateCampaignJsonSchema, updateCampaign } from "./tools/update-campaign.js";
import { ListContributionsInput, listContributionsJsonSchema, listContributions } from "./tools/list-contributions.js";
import {
  SetEpisodesInput, setEpisodesJsonSchema, setEpisodes,
  AttachEpisodeInput, attachEpisodeJsonSchema, attachEpisode,
  DetachEpisodeInput, detachEpisodeJsonSchema, detachEpisode,
} from "./tools/episodes.js";

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  zod: ZodTypeAny;
  run: (args: unknown, deps: ToolDeps) => Promise<unknown>;
}

const TOOLS: ToolEntry[] = [
  {
    name: "pinka_list_campaigns",
    description:
      "Izlistaj pinka kampanje sa statistikama. Filteri: account ('me'|uuid|'all'), " +
      "state, channel (UC…), episode (YouTube videoId). Default account = tvoj.",
    inputSchema: listCampaignsJsonSchema,
    zod: ListCampaignsInput,
    run: (a, d) => listCampaigns(ListCampaignsInput.parse(a), d),
  },
  {
    name: "pinka_get_campaign",
    description: "Dohvati punu kampanju (+ campaign_stats + povezane epizode) po uuid-u ili slug-u.",
    inputSchema: getCampaignJsonSchema,
    zod: GetCampaignInput,
    run: (a, d) => getCampaign(GetCampaignInput.parse(a), d),
  },
  {
    name: "pinka_import_domovina",
    description:
      "Iz domovina.ai linka (/v/<id> ili /c/<slug>) izvuci CDN metapodatke i vrati " +
      "pinka.campaign.v1 NACRT (bez upisa u bazu). Proslijedi u pinka_create_campaign.",
    inputSchema: importDomovinaJsonSchema,
    zod: ImportDomovinaInput,
    run: (a, d) => importDomovina(ImportDomovinaInput.parse(a), d),
  },
  {
    name: "pinka_derive_safe",
    description:
      "Vrati counterfactual Gnosis Safe (destination_address) za campaign uuid (ili svjež). " +
      "Ništa se ne deploya. Treba PINKA_OWNER_SIGNER ili `signer` argument.",
    inputSchema: deriveSafeJsonSchema,
    zod: DeriveSafeInput,
    run: (a, d) => deriveSafe(DeriveSafeInput.parse(a), d),
  },
  {
    name: "pinka_create_campaign",
    description:
      "Kreiraj kampanju (idempotentno na `id`). Razriješi destinaciju (derive iz signera " +
      "ili PINKA_DEFAULT_DESTINATION), pozovi create_campaign RPC. Lands kao draft; " +
      "activate:true odmah aktivira. Vraća {id, slug}.",
    inputSchema: createCampaignJsonSchema,
    zod: CreateCampaignInput,
    run: (a, d) => createCampaign(CreateCampaignInput.parse(a), d),
  },
  {
    name: "pinka_update_campaign",
    description:
      "Uredi kampanju (title/description/goal/min/visibility/cover/recurrence/state/…). " +
      "patch.state='active' aktivira (uz guard: pravi Safe). Iznosi u €. Poštuje destination-lock.",
    inputSchema: updateCampaignJsonSchema,
    zod: UpdateCampaignInput,
    run: (a, d) => updateCampaign(UpdateCampaignInput.parse(a), d),
  },
  {
    name: "pinka_set_episodes",
    description:
      "Zamijeni CIJELI set epizoda (podcast_episode) kampanje. episode_ids = YouTube videoId-evi. " +
      "Epizoda već u drugoj kampanji → episode_taken.",
    inputSchema: setEpisodesJsonSchema,
    zod: SetEpisodesInput,
    run: (a, d) => setEpisodes(SetEpisodesInput.parse(a), d),
  },
  {
    name: "pinka_attach_episode",
    description: "Dodaj jednu epizodu/subjekt kampanji (default subject_type=podcast_episode).",
    inputSchema: attachEpisodeJsonSchema,
    zod: AttachEpisodeInput,
    run: (a, d) => attachEpisode(AttachEpisodeInput.parse(a), d),
  },
  {
    name: "pinka_detach_episode",
    description: "Ukloni jednu epizodu/subjekt iz kampanje.",
    inputSchema: detachEpisodeJsonSchema,
    zod: DetachEpisodeInput,
    run: (a, d) => detachEpisode(DetachEpisodeInput.parse(a), d),
  },
  {
    name: "pinka_list_contributions",
    description: "Javni zid donatora (public_contributions) za kampanju.",
    inputSchema: listContributionsJsonSchema,
    zod: ListContributionsInput,
    run: (a, d) => listContributions(ListContributionsInput.parse(a), d),
  },
];

export function createServer(config: Config): Server {
  const sb = createServiceClient(config);
  const deps: ToolDeps = { config, sb };

  const server = new Server(
    {
      name: config.serviceName,
      version: config.serviceVersion,
      title: "pinka.finance Campaign Admin MCP",
      websiteUrl: "https://pinka.io",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    const parsed = tool.zod.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `VALIDATION_ERROR: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          },
        ],
      };
    }
    try {
      const result = await tool.run(parsed.data, deps);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `${tool.name} failed: ${msg}` }] };
    }
  });

  return server;
}
