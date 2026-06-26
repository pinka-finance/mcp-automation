import { defineChain } from "viem";

// Gnosis chain + Safe konstante. Zrcali app/lib/chain/constants.ts tako da su
// izvedene Safe adrese identične kroz cijeli stack (web dashboard, relay, MCP).

export const GNOSIS_CHAIN_ID = 100;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** 0x + 40 hex znamenki. */
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** true ako je destination_address stvarni Safe (nije null/prazno/nulta adresa). */
export function isSafeSet(addr: string | null | undefined): boolean {
  return !!addr && ADDRESS_RE.test(addr) && addr.toLowerCase() !== ZERO_ADDRESS;
}

export const GNOSIS_RPC =
  process.env.GNOSIS_RPC ?? "https://rpc.gnosischain.com";

export const gnosis = defineChain({
  id: GNOSIS_CHAIN_ID,
  name: "Gnosis",
  nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
  rpcUrls: { default: { http: [GNOSIS_RPC] } },
  blockExplorers: {
    default: { name: "Gnosisscan", url: "https://gnosisscan.io" },
  },
});
