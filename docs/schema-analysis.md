# Analiza: `pinka_finance` shema + trenutni flow kreiranja projekta

> Izvori: `domovina-api/supabase/migrations/` (shema), `pinka-finance/app/` (frontend flow).
> Datum: 2026-06-05. Sve file:line reference su iz tih repoa.

---

## 1. Što je "projekt" na pinka.io

**Projekt = `campaign`** u PostgreSQL shemi `pinka_finance` (self-hosted Supabase @ `api.domovina.ai`).

pinka.finance je generička group-funding platforma: **donacije, crowdfunding, tokenizacija,
ulaznice i nekretnine = isti data model**. Jezgra:

```
campaign (ono što se financira)
  └─ contributions (novac unutra)   ─ opc. uz tier (reward/ticket/token tranche)
       └─ token_position (što doprinositelj sad drži)
  └─ payout (novac van: IBAN/0x)
  └─ campaign_stats (denormalizirani cache)
  └─ yield_position (opc. Aave v3 prinos na Gnosis)
```

Plaćanje: fiat (SEPA Instant) → Monerium EURe → **per-campaign Gnosis Safe**, ili direktni
on-chain EURe transfer. Rail živi u `pay.domovina.ai` (Cloudflare); domenski model u Postgresu.

---

## 2. Tablica `campaigns` — definicija projekta

`domovina-api/supabase/migrations/20260530120100_pinka_finance_schema.sql:71-102`

**Obavezna polja za kreiranje** (NOT NULL bez defaulta ili s poslovnim značenjem):

| Polje | Tip | Default | Napomena |
|---|---|---|---|
| `account_id` | uuid | — | **FK → public.accounts**; vlasnik. Obavezno. |
| `slug` | citext UNIQUE | — | URL-safe, **immutable** (trigger guard). Format `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`. |
| `type` | campaign_type | `donation` | `donation\|crowdfund\|tokenization\|tickets\|realestate` |
| `title` | text | — | Obavezno. |
| `destination_address` | text | — | **Gnosis Safe adresa** (counterfactual ili deployan). Obavezno. |
| `chain` | text | `gnosis` | Immutable. |
| `currency` | text | `eur` | |
| `min_contribution_cents` | int | `100` | > 0 |
| `state` | campaign_state | `draft` | `draft\|active\|funded\|closed\|cancelled` |
| `visibility` | campaign_visibility | `private` | `private\|unlisted\|public` |

**Opcionalna ali tipična:** `description`, `goal_cents` (NULL = open-ended), `subject_type`
/`subject_ref` (npr. `podcast_episode` + YouTube ID), `cover_image_url`, `starts_at`/`ends_at`,
`youtube_channel_id` (channel-owner admin), `metadata` jsonb (drži `{safe:{…}, yield:{enabled}}`).

**Auto/triggeri pri insertu:**
- `created_at`/`updated_at` → `now()`.
- `trg_campaign_created` (AFTER INSERT) → kreira `campaign_stats` red (0/0/0).
- `trg_campaigns_slug_guard` (BEFORE UPDATE) → slug immutable nakon kreiranja.

**Enumi** (`…schema.sql:28-68`):
`campaign_type`, `campaign_state`, `campaign_visibility`, `tier_kind`, `contribution_state`,
`position_status`, `payout_state`.

---

## 3. FK ovisnosti za kreiranje

1. **`public.accounts`** (obavezno, `account_id`) — `20260520120100_core_identity.sql:44-66`.
   Mora postojati, ne smije biti soft-deleted. Vlasnik je user u `auth.users` (1:1 personal
   account) ili organizacija (N:M `accounts_memberships`).
2. **`domovina_ai.channel_claims`** (opcionalno, ako se postavlja `youtube_channel_id`) —
   user mora biti `status='verified'` AND `role='primary'` (`20260603130000`).
3. **`public.identity_verifications`** (KYC) — **ne** pri kreiranju kampanje, nego snapshot pri
   doprinosu (`contributor_verified`) i gate pri payoutu (`kyc_verified`).

---

## 4. RLS — tko smije kreirati

`20260530120200_pinka_finance_rls.sql`

- **campaigns INSERT:** zahtijeva `has_role_on_account(account_id, 'admin')`.
- **campaigns UPDATE:** isto + `deleted_at IS NULL`; prošireno (`20260603130000`) i na
  `is_verified_channel_owner(youtube_channel_id)`.
- **campaigns DELETE:** `has_role_on_account(account_id, 'owner')` (soft-delete preko `deleted_at`).
- **service_role:** zaobilazi RLS (puni grantovi).

Grantovi: `GRANT insert,update,delete ON campaigns,campaign_tiers TO authenticated, service_role`.

→ **Za automatizaciju:** klijent treba ili (a) **service_role** ključ (zaobilazi RLS), ili
(b) **user JWT** s admin članstvom na ciljanom `account_id`.

---

## 5. Trenutni flow kreiranja (browser, wallet-driven)

Dvostupanjski, u `pinka-finance/app`:

**Korak 1 — Wallet + Safe derivacija** (`app/dashboard/new/page.tsx:57-119`)
- `connectWallet()` (`lib/chain/walletSdk.ts`) → DOMOVINA Wallet SDK iframe (passkey/ecosystem
  identitet) → `{ signerAddress, safeAddress }`.
- Klijent generira **campaignId (UUID)** i derivira per-campaign Safe:
  - `saltNonce = keccak256("pinka:campaign:{campaignId}")` (`lib/chain/safe.ts:54-56`)
  - `predictSafeAddress(signer, salt)` — Safe protocol-kit, owners=[signer], threshold=1,
    safeVersion `1.4.1` (`lib/chain/safe.ts:60-73`). **Counterfactual** (0 gas, deploya se lazy).
- Safe metadata se sprema u `campaigns.metadata.safe` (`new/page.tsx:111-119`).

**Korak 2 — Forma + insert** (`components/dashboard/campaign-form.tsx`, `lib/dashboard.ts:138-171`)
- `createCampaign(input)` radi **direktan PostgREST insert** u `pinka_finance.campaigns`:
  ```ts
  sb.schema("pinka_finance").from("campaigns").insert({
    id: input.id,                         // = campaignId (veže Safe salt)
    account_id, slug, type, title, description, goal_cents,
    min_contribution_cents, destination_address,   // = derivirani Safe
    subject_type, subject_ref, visibility,
    state: "draft", metadata,
  }).select("id").single()
  ```
- **Slug:** generiran client-side `slugify(title)`, s **retry petljom** na unique violation
  (kod 23505) → `-2`, `-3`, do 4 pokušaja, inače `slug_collision` (`lib/dashboard.ts:140-170`).

**Auth** (`lib/auth.tsx`, `lib/supabase.ts`): Supabase anon key + RLS; identitet preko Certilia
eID (KYC) / magic-link / anonimna sesija. `NEXT_PUBLIC_SUPABASE_URL=https://api.domovina.ai`.

---

## 6. Blokeri za automatizaciju (i zašto)

| # | Bloker | Zašto smeta agentu/headless klijentu |
|---|---|---|
| B1 | **Safe se derivira u browseru** iz passkey signera (WebAuthn) | Agent nema passkey/iframe; treba headless signer + headless derivacija |
| B2 | **Direktan insert + slug-retry u klijentu** | Logika (slug, validacija) je u frontendu; svaki novi klijent (MCP/A2A) bi je duplicirao i mogao divergirati |
| B3 | **Auth vezan na browser sesiju** (anon/eID/magic-link) | Agentu treba service identitet ili delegirani token, ne interaktivni login |
| B4 | **`account_id` se pretpostavlja poznatim** (iz sesije) | Automatizacija mora razriješiti/odabrati account (i admin rolu) eksplicitno |
| B5 | **Nema atomske validacije** (tip enum, goal>0, destination format) na DB ulazu | RLS provjerava samo rolu; sadržajna validacija je u UI-u → automatizacija je može preskočiti |

**Ključ koji otključava sve:** `lib/chain/safe.ts` doslovno kaže *"mirrors
pay.domovina.ai/wallet/src/lib/safe.ts"* — derivacija je **čisto deterministička**
(`viem` + `@safe-global/protocol-kit`, RPC view pozivi), pa **radi i u Node-u bez browsera**.
To rješava B1: treba samo **automation signer adresa** (poznata EVM adresa) + isti salt.

---

## 7. Postojeće programske točke (za reuse)

- **Edge funkcije** (`domovina-api/supabase/functions/`): `pinka-contribute`, `pinka-webhook`,
  `pinka-onchain-ingest/-confirm` — ali **nijedna ne kreira kampanju** (sve su contribution/rail).
- **RPC-evi** (`…rpcs.sql`, `…campaign_admin.sql`): `create_contribution`, `mark_contribution_paid`,
  `request_payout`, `set_campaign_episodes`, `set_campaign_yield`, `active_campaign_for_subject`,
  `is_verified_channel_owner` — **nema `create_campaign`**. To je glavni nedostajući komad.
- **Helperi:** `public.has_role_on_account(account_id, role)`, `public.is_account_member(account_id)`
  — koristi ih novi RPC za autorizaciju.

→ Zaključak: backend već ima cijeli contribution/payout/yield RPC sloj; **fali samo
`create_campaign` RPC** i headless Safe modul da bi kreiranje bilo automatizabilno. Dizajn u
[`mcp-a2a-design.md`](mcp-a2a-design.md).
