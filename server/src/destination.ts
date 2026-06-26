import type { Address } from "viem";
import type { Config } from "./config.js";
import { deriveCampaignSafeFromSigner } from "./lib/chain/safe.js";

// Razrješenje destination_address za kampanju ("podrži oba" — vidi §5 plana):
//   1. PINKA_OWNER_SIGNER zadan → deriviraj per-kampanja counterfactual Safe
//   2. inače PINKA_DEFAULT_DESTINATION → fiksni Safe koji kontroliraš
//   3. inače → greška (create_campaign ionako traži valjani 0x)

export interface ResolvedDestination {
  address: string;
  /** ide u metadata.safe (jedini ključ koji create_campaign whitelista). */
  safe: Record<string, unknown>;
  source: "derived" | "default";
}

export async function resolveDestination(
  config: Config,
  campaignId: string,
): Promise<ResolvedDestination> {
  if (config.ownerSigner) {
    const { signerAddress, safeAddress, saltNonce } =
      await deriveCampaignSafeFromSigner(config.ownerSigner as Address, campaignId);
    return {
      address: safeAddress,
      source: "derived",
      safe: {
        signer_address: signerAddress,
        salt_nonce: saltNonce,
        safe_version: "1.4.1",
        source: "mcp",
      },
    };
  }
  if (config.defaultDestination) {
    return {
      address: config.defaultDestination,
      source: "default",
      safe: { address: config.defaultDestination, source: "mcp-default" },
    };
  }
  throw new Error(
    "Nema destinacije: postavi PINKA_OWNER_SIGNER (per-kampanja derivacija) ili " +
      "PINKA_DEFAULT_DESTINATION (fiksni Safe).",
  );
}
