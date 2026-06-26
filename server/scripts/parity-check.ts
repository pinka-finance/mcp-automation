// Parity check — potvrdi da Node port Safe derivacije daje IDENTIČNE rezultate
// kao web dashboard. Referenca: ručno seedana dev kampanja (vidi
// mcp-automation/docs/seed-pinka-dev-campaign.md):
//
//   id        = 56855347-b1d2-4634-ae51-70e7e31d52fe
//   salt_nonce = 31487860511194942696430796988665369670642411186402705608686109232831602763406
//
// salt_nonce ne ovisi o mreži (čisti keccak256) → uvijek provjerljiv.
// Safe adresa ovisi o RPC-u → provjeri se samo ako je signer zadan.

import { saltFromCampaignId, predictSafeAddress } from "../src/lib/chain/safe.js";
import type { Address } from "viem";

const DEV_CAMPAIGN_ID = "56855347-b1d2-4634-ae51-70e7e31d52fe";
const EXPECTED_SALT =
  "31487860511194942696430796988665369670642411186402705608686109232831602763406";

let ok = true;

// 1) salt_nonce parity (offline, deterministički)
const salt = saltFromCampaignId(DEV_CAMPAIGN_ID);
const saltMatch = salt === EXPECTED_SALT;
console.log(`salt_nonce derivacija:`);
console.log(`  izračunato: ${salt}`);
console.log(`  očekivano:  ${EXPECTED_SALT}`);
console.log(`  ${saltMatch ? "✅ MATCH" : "❌ MISMATCH"}\n`);
ok &&= saltMatch;

// 2) Safe adresa (online) — samo ako je PARITY_SIGNER zadan u env-u
const signer = process.env.PARITY_SIGNER ?? process.env.PINKA_OWNER_SIGNER;
if (signer) {
  try {
    const addr = await predictSafeAddress(signer as Address, salt);
    console.log(`Safe adresa za signer ${signer}:`);
    console.log(`  ${addr}`);
    console.log(`  ℹ️  usporedi ručno s web dashboardom za isti (signer, id).\n`);
  } catch (err) {
    console.log(`Safe adresa: ⚠️  RPC greška: ${(err as Error).message}\n`);
  }
} else {
  console.log("Safe adresa: preskočeno (postavi PARITY_SIGNER da provjeriš online).\n");
}

console.log(ok ? "✅ PARITY OK" : "❌ PARITY FAILED");
process.exit(ok ? 0 : 1);
