import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Address } from "viem";
import { deriveCampaignSafeFromSigner } from "../lib/chain/safe.js";
import { ADDRESS_RE } from "../lib/chain/constants.js";
import type { ToolDeps, JsonSchema } from "./types.js";

export const DeriveSafeInput = z.object({
  campaign_id: z
    .string()
    .uuid()
    .optional()
    .describe("Campaign uuid; izostavi za svjež uuid (preview prije kreiranja)."),
  signer: z
    .string()
    .regex(ADDRESS_RE)
    .optional()
    .describe("Override 0x signer; inače PINKA_OWNER_SIGNER iz env-a."),
});
export type DeriveSafeArgs = z.infer<typeof DeriveSafeInput>;

export const deriveSafeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    campaign_id: { type: "string", description: "Campaign uuid (opc.; inače svjež)." },
    signer: { type: "string", description: "Override 0x signer (opc.)." },
  },
};

export async function deriveSafe(args: DeriveSafeArgs, deps: ToolDeps) {
  const signer = args.signer ?? deps.config.ownerSigner;
  if (!signer) {
    throw new Error(
      "Nema signera: postavi PINKA_OWNER_SIGNER ili predaj `signer` argument.",
    );
  }
  const campaignId = args.campaign_id ?? randomUUID();
  const { signerAddress, safeAddress, saltNonce } =
    await deriveCampaignSafeFromSigner(signer as Address, campaignId);
  return {
    campaign_id: campaignId,
    signer_address: signerAddress,
    salt_nonce: saltNonce,
    safe_address: safeAddress,
    safe_version: "1.4.1",
    note: "Counterfactual Safe (nije deployan; 0 gasa). Deploya se lijeno na prvoj isplati.",
  };
}
