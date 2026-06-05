# pinka.io — MCP + A2A automatizacija kreiranja projekata

> Dizajn i analiza: kako automatizirati **kreiranje projekata (kampanja)** na pinka.io
> preko **MCP** (agent → alat) i **A2A** (agent ↔ agent), bez browsera/wallet UI-a.
>
> Zaseban folder; ne dira `app/` ni `domovina-api/`. Analiza 2026-06-05.
> Povezano s A2A SSOT u `domovina-rag/docs/a2a/` (isti protokol, isti uzor Magisterium).

## Što je ovdje

| Dokument | Sadržaj |
|---|---|
| [`docs/schema-analysis.md`](docs/schema-analysis.md) | Detaljna analiza `pinka_finance` sheme + trenutni (browser) flow kreiranja + blokeri za automatizaciju |
| [`docs/mcp-a2a-design.md`](docs/mcp-a2a-design.md) | **Dizajn rješenja** — novi `create_campaign` RPC, headless Safe derivacija, MCP tool, A2A skill, auth, sigurnost, plan |
| [`docs/seed-pinka-dev-campaign.md`](docs/seed-pinka-dev-campaign.md) | **Runbook (izvedeno)** — ručni direktan SQL insert prve kampanje (donacije za razvoj Pinke) dok ne postoji RPC; placeholder Safe + koraci do objave |

## 60-sekundni sažetak

- **"Projekt" na pinka.io = `campaign`** u `pinka_finance` shemi (Supabase @ `api.domovina.ai`).
- **Trenutno** se kampanja stvara **samo u browseru**: DOMOVINA Wallet SDK (passkey) → derivacija
  per-campaign Gnosis Safe-a → direktan PostgREST `insert` u `pinka_finance.campaigns`
  (RLS traži `has_role_on_account(account_id, 'admin')`). **Nema RPC-a, nema MCP/A2A puta.**
- **Glavni blokeri automatizacije:** (1) Safe se derivira client-side iz passkey signera;
  (2) direktan insert sa slug-retry petljom je krhak; (3) auth je vezan na browser sesiju.
- **Rješenje (3 dijela):**
  1. **Backend:** novi `SECURITY DEFINER` RPC `pinka_finance.create_campaign(...)` — server-side slug,
     validacija, atomski insert. Jedinstvena ulazna točka za sve klijente.
  2. **Headless Safe:** `saltFromCampaignId` + `predictSafeAddress` rade u Node-u (viem + Safe
     protocol-kit) s **automation signerom** → nema browsera.
  3. **Površine:** MCP tool `create_pinka_project` (interaktivno, Claude) + A2A skill `create_project`
     (agent-to-agent, orkestrator delegira) — **oba zovu isti RPC**.
- **Tie-in s domovina-rag A2A:** A2A skill prati identične sheme iz `domovina-rag/docs/a2a/`
  (`message/send`, `skillId`, Task+artifacts). Domovina orkestrator može reći
  *"napravi crowdfund za epizodu X"* i pinka agent ga izvrši.

## Status

- [x] Analiza sheme + trenutnog flowa + blokera
- [x] Dizajn MCP + A2A automatizacije
- [x] **Prva kampanja seedana ručno** (donacije za razvoj Pinke) — draft+private, placeholder Safe; vidi runbook
- [ ] Derivaj Safe + objavi kampanju (ručno u dashboardu — gumb live od `pinka-app` `d15322b`)
- [ ] `create_campaign` RPC (zamjena za ručni insert) — [`docs/mcp-a2a-design.md`](docs/mcp-a2a-design.md) §2
- [ ] MCP tool + A2A skill povrh RPC-a — §9 checklist
