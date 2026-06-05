# Runbook: ručno seedanje kampanje u bazu (interim, do `create_campaign` RPC-a)

> Stvarno izvedeni proces kreiranja prve kampanje **programski/direktnim insertom** u
> `pinka_finance.campaigns`, dok ne postoji `create_campaign` RPC (vidi
> [`mcp-a2a-design.md`](mcp-a2a-design.md) §2). Ovo je privremeni put — **direktan SQL
> insert preko service_role-a** (psql kao postgres superuser, zaobilazi RLS).

## Što je kreirano (2026-06-06)

| Polje | Vrijednost |
|---|---|
| `id` | `56855347-b1d2-4634-ae51-70e7e31d52fe` |
| `account_id` | `6a9bc134-9a03-435c-a7f7-7ecc324e0393` (personal account `stepanic.matija@gmail.com`) |
| `slug` | `razvoj-pinka-finance` |
| `type` | `donation` |
| `title` | Razvoj Pinka Finance — 100% open-source P2P crowdfunding |
| `goal_cents` | `null` (open-ended donacije) |
| `min_contribution_cents` | `100` |
| `destination_address` | `0x0000…0000` (**PLACEHOLDER** — Safe se derivira u dashboardu) |
| `state` / `visibility` | `draft` / `private` |
| `metadata.safe` | `{ salt_nonce: 31487…3406, safe_version: "1.4.1", source: "automation", pending: true }` |

`salt_nonce` je deterministički iz `id`: `keccak256("pinka:campaign:{id}")` (decimalno).

## Zašto draft + placeholder

- `campaigns.destination_address` je `NOT NULL` ali **nema CHECK na format** → `0x0…0` prolazi.
- `create_contribution` baca `campaign_not_active` za sve osim `state='active'` → u `draft`
  novac fizički ne može ući, pa je placeholder bezopasan.
- **NIKAD ne aktivirati s placeholderom** — on-chain donacija na `0x0` se spali. Prvo Safe, pa `active`.
- Per-campaign Safe ovisi o passkey signeru (Google/Apple) → mora se derivirati client-side;
  zato draft sad, Safe prije objave. Vidi [`schema-analysis.md`](schema-analysis.md) §6 (blokeri).

## Kako je izvedeno (reproducibilno)

DB pristup ide preko `domovina-api` repo skripte (SSH → `docker exec psql`):

```bash
cd /Users/ms/git/domovinatv/domovina-api
# pinaj container da auto-detekcija (koja sama radi ssh) ne pojede heredoc stdin:
export COOLIFY_DB_CONTAINER=supabase-db-<id>
./scripts/db-psql.sh --stdin <<'SQL'
insert into pinka_finance.campaigns
  (id, account_id, slug, type, title, description, goal_cents,
   min_contribution_cents, currency, destination_address, chain,
   subject_type, visibility, state, metadata)
values
  ('56855347-b1d2-4634-ae51-70e7e31d52fe',
   '6a9bc134-9a03-435c-a7f7-7ecc324e0393',
   'razvoj-pinka-finance',
   'donation',
   'Razvoj Pinka Finance — 100% open-source P2P crowdfunding',
   'Donacije za razvoj Pinka Finance platforme — 100% open-source P2P crowdfunding. Sredstva idu u razvoj, infrastrukturu i održavanje. Cijeli kod je javno dostupan.',
   null, 100, 'eur',
   '0x0000000000000000000000000000000000000000',
   'gnosis', 'generic', 'private', 'draft',
   '{"safe":{"salt_nonce":"31487860511194942696430796988665369670642411186402705608686109232831602763406","safe_version":"1.4.1","source":"automation","pending":true}}'::jsonb)
on conflict (slug) do nothing;
SQL
```

Rezultat: `INSERT 0 1`. Trigger `trg_campaign_created` automatski stvori `campaign_stats` red (0/0/0).

> **account_id izbor:** kampanja je stavljena na **gmail personal account**
> (`6a9bc134…`) da bude vidljiva u dashboardu kad se uloguješ kao `stepanic.matija@gmail.com`.
> Dashboard lista kampanje preko `account_id = getMyAccountId()` (personal account ulogiranog
> usera) — ako je `account_id` tuđeg identiteta, kampanja se NE vidi u dashboardu. Vidi
> [[lessons-pinka-identity-mismatch]] obrazac (dvije Supabase identitete = dva accounta).

## Preostali koraci (ručno, u dashboardu) prije objave

1. Uloguj se na https://pinka.io/dashboard kao `stepanic.matija@gmail.com`.
2. Otvori kampanju → tab **Uredi** → panel **"Safe kampanje (custody)"** →
   **"Deriviraj Safe iz passkey-a"** (Google/Apple passkey). To izračuna Safe iz
   `(signer, id)` i upiše pravi `destination_address` + `metadata.safe`
   (gumb dodan u `pinka-app` commit `d15322b`; vidi [`schema-analysis.md`](schema-analysis.md)).
3. Provjeri da `destination_address` više nije `0x0…0`.
4. Postavi `visibility = public` i klikni **Aktiviraj** (`state → active`).

## Što slijedi (zamjena za ovaj ručni put)

- `pinka_finance.create_campaign(...)` SECURITY DEFINER RPC (dizajn u
  [`mcp-a2a-design.md`](mcp-a2a-design.md) §2) → server-side slug + validacija + atomski insert.
- Seed skripta u ovom repou koja zove RPC (ili insert) bez ručnog psql-a.
- MCP tool `create_pinka_project` + A2A skill `create_project` povrh RPC-a.
