import SafeDefault from "@safe-global/protocol-kit";
import { keccak256, toBytes, type Address } from "viem";
import { GNOSIS_RPC } from "./constants.js";

// protocol-kit je dual ESM/CJS; types ga modeliraju kao CJS pa default import
// (interop) ispadne namespace umjesto klase. Runtime (.mjs build) daje pravu
// Safe klasu sa statičkim init — castamo na minimalni init potpis.
type SafeInit = (config: {
  provider: string;
  predictedSafe: {
    safeAccountConfig: { owners: string[]; threshold: number };
    safeDeploymentConfig: { saltNonce: string; safeVersion: string };
  };
}) => Promise<{ getAddress(): Promise<string> }>;
const Safe = SafeDefault as unknown as { init: SafeInit };

// Counterfactual Safe derivacija — port app/lib/chain/safe.ts (bez WebAuthn
// signer-proxy grane, jer MCP-u predajemo VEĆ razriješenu signer adresu kroz
// PINKA_OWNER_SIGNER). Ništa se ne deploya (0 gasa); Safe se inicijalizira
// on-chain lijeno na prvoj isplati. Salt + parametri MORAJU biti identični webu
// da adrese odgovaraju onome što bi relay kasnije deployao.

/// uint256 saltNonce (kao decimalni string) deterministički iz campaign id-a.
export function saltFromCampaignId(campaignId: string): string {
  return BigInt(keccak256(toBytes(`pinka:campaign:${campaignId}`))).toString();
}

/// Predvidi counterfactual Safe 1/1 vlasništva signerAddress sa zadanim saltom.
export async function predictSafeAddress(
  signerAddress: Address,
  saltNonce: string,
): Promise<Address> {
  const kit = await Safe.init({
    provider: GNOSIS_RPC,
    predictedSafe: {
      safeAccountConfig: { owners: [signerAddress], threshold: 1 },
      safeDeploymentConfig: { saltNonce, safeVersion: "1.4.1" },
    },
  });
  return (await kit.getAddress()) as Address;
}

export interface CampaignSafe {
  signerAddress: Address;
  safeAddress: Address;
  saltNonce: string;
}

/// Puna per-kampanja derivacija iz poznatog signera.
export async function deriveCampaignSafeFromSigner(
  signerAddress: Address,
  campaignId: string,
): Promise<CampaignSafe> {
  const saltNonce = saltFromCampaignId(campaignId);
  const safeAddress = await predictSafeAddress(signerAddress, saltNonce);
  return { signerAddress, safeAddress, saltNonce };
}
