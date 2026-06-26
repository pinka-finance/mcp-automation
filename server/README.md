# pinka MCP (`mcp.pinka.io`)

Lokalni **stdio** MCP server za kreiranje i uređivanje [pinka.finance](https://pinka.io)
kampanja izravno iz Claude Desktopa / Claude Codea — preko dijeljenog Supabasea
(`api.domovina.ai`, schema `pinka_finance`).

Osobni admin alat. Zrcali strukturu `domovina-rag/services/mcp` (Node
`@modelcontextprotocol/sdk`). Dizajn + dijagrami:
[`../docs/mcp-pinka-implementation-plan.md`](../docs/mcp-pinka-implementation-plan.md).

## Zašto bez passkey/potpisa

`destination_address` kampanje je **counterfactual** Gnosis Safe (CREATE2 predikcija) —
nije deployan i ništa se ne potpisuje pri kreiranju. Safe se deploya lijeno na prvoj
isplati (potpisuje relay, ne ti). Zato je create/edit kampanje **čisti Supabase
RPC/REST**. Potpisivanje vrijedi samo za **isplate** (izvan dosega ovog alata).

## Setup

```bash
cd server
npm install
cp .env.example .env     # popuni SUPABASE_SERVICE_ROLE_KEY + destinaciju
npm run parity           # potvrdi da Safe derivacija odgovara webu (offline)
npm run smoke            # potvrdi da server lista 10 toolova (ne treba bazu)
npm run build            # → dist/ (za produkcijski mcp config)
```

## Env varijable

| Var | Default | Svrha |
|---|---|---|
| `SUPABASE_URL` | `https://api.domovina.ai` | backend |
| `SUPABASE_SERVICE_ROLE_KEY` | — (**required**) | god-mode write; **samo lokalno** |
| `PINKA_ACCOUNT_ID` | `6a9bc134-…` (gmail personal) | account na koji se piše |
| `PINKA_OWNER_SIGNER` | (opc.) | 0x signer → per-kampanja Safe derivacija |
| `PINKA_DEFAULT_DESTINATION` | (opc.) | 0x Safe koji kontroliraš → fallback destinacija |
| `GNOSIS_RPC` | `https://rpc.gnosischain.com` | Safe predikcija (read-only) |

Postavi **bar jedno** od `PINKA_OWNER_SIGNER` / `PINKA_DEFAULT_DESTINATION` (inače
`pinka_create_campaign` nema kamo usmjeriti sredstva).

## Dodavanje u Claude

**Claude Code:**

```bash
npm run build   # u server/
claude mcp add pinka \
  --env SUPABASE_SERVICE_ROLE_KEY=… \
  --env PINKA_DEFAULT_DESTINATION=0x… \
  -- node /Users/ms/git/pinka-finance/mcp-automation/server/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pinka": {
      "command": "node",
      "args": ["/Users/ms/git/pinka-finance/mcp-automation/server/dist/index.js"],
      "env": {
        "SUPABASE_SERVICE_ROLE_KEY": "…",
        "PINKA_DEFAULT_DESTINATION": "0x…"
      }
    }
  }
}
```

> Dev varijanta bez builda: `"command": "npx", "args": ["tsx", "…/server/src/index.ts"]`.

## Toolovi

| Tool | Što radi |
|---|---|
| `pinka_list_campaigns` | lista kampanja + stats (filter account/state/channel/episode) |
| `pinka_get_campaign` | puna kampanja + stats + povezane epizode (uuid ili slug) |
| `pinka_import_domovina` | domovina.ai link → `pinka.campaign.v1` nacrt (bez upisa) |
| `pinka_derive_safe` | counterfactual Safe za campaign id (ili svjež uuid) |
| `pinka_create_campaign` | kreiraj (idempotentno na `id`); razriješi destinaciju; vrati `{id, slug}` |
| `pinka_update_campaign` | uredi/aktiviraj (iznosi u €; guard mirror za state/lock) |
| `pinka_set_episodes` | zamijeni cijeli set epizoda kampanje |
| `pinka_attach_episode` / `pinka_detach_episode` | dodaj/ukloni jednu epizodu |
| `pinka_list_contributions` | javni zid donatora |

Tipičan tok: `import_domovina` → (po želji doradi tekst) → `create_campaign` →
`set_episodes` → `update_campaign({state:"active"})` → kartica se pojavi u
domovina.ai aplikaciji.

## Test (e2e)

```bash
npm run e2e              # Faza A: import + derive (live CDN/RPC, ništa se ne piše)
npm run e2e -- --write   # + Faza B: create→link→activate→verify u produ, pa ponudi brisanje
```

Faza B kreira kampanju za epizodu `b-nls1ck8EE` (kanal `UCXXhnehl2pss0uYdfLRDtyw`),
aktivira je i provjeri da `active_campaign_for_subject('podcast_episode',['b-nls1ck8EE'])`
vrati kampanju (→ kartica na `domovina.ai/v/b-nls1ck8EE`), pa pita briše li se.

## Sigurnost

- `service_role` = **potpuni bypass RLS-a i KYC-a**. Nikad u repo/log/remote; `.env`
  je gitignored. Ako ikad promoviraš na remote HTTP — endpoint MORA biti bearer-gated.
- Trigger `campaigns_write_guard` se **ne okida** za service_role → MCP sam replicira
  zaštite (destination-lock nakon prve uplate, zabrana aktivacije bez pravog Safe-a).
- Linkanje epizoda ide **direktnim `campaign_subjects` write-om** (DEFINER RPC-evi traže
  `auth.uid()` koji je NULL pod service_role). `unique(subject_type,subject_ref)` i dalje
  jamči "epizoda ≤ 1 kampanja".
- Svi inputi se validiraju zod schemom (`pinka.campaign.v1` whitelist) — bez proizvoljnih
  stupaca. `create_campaign` je idempotentan; `existing:true` se jasno vraća.
