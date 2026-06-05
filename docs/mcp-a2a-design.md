# Dizajn: MCP + A2A automatizacija kreiranja projekata na pinka.io

> Kako headless (bez browsera) kreirati `campaign` u `pinka_finance` shemi, izloženo kao
> **MCP tool** (interaktivno, Claude) i **A2A skill** (agent-to-agent). Analiza i blokeri:
> [`schema-analysis.md`](schema-analysis.md). Protokol-reference za A2A: `domovina-rag/docs/a2a/`.

---

## 1. Cilj i princip

Agent (ili Claude korisnik) kaže: *"Napravi crowdfund kampanju 'Obnova doma' s ciljem
5000 EUR, javnu, za epizodu `dQw4w9WgXcQ`."* → kampanja postoji u `draft` stanju, s
deriviranim per-campaign Gnosis Safe-om, spremna za aktivaciju — **bez browsera i bez ručnog
unosa**.

**Princip:** jedna autoritativna ulazna točka na backendu (`create_campaign` RPC), dvije
površine iznad nje (MCP + A2A), headless Safe derivacija sa strane. Nula dupliciranja logike.

```
   Claude (chat)                 Orkestrator-agent (domovina A2A)
        │ MCP tool                        │ A2A message/send (skillId=create_project)
        ▼                                 ▼
   ┌──────────────────────────────────────────────┐
   │   pinka-automation servis (Node/TS)          │
   │   • headless Safe derivacija (viem + Safe kit)│
   │   • auth (service_role ILI delegirani JWT)    │
   └───────────────────┬──────────────────────────┘
                       │ RPC: pinka_finance.create_campaign(...)
                       ▼
   ┌──────────────────────────────────────────────┐
   │  domovina-api (Supabase @ api.domovina.ai)   │
   │  • SECURITY DEFINER RPC: slug + validacija +  │
   │    atomski insert + campaign_subjects + safe  │
   └──────────────────────────────────────────────┘
```

---

## 2. Backend: novi RPC `pinka_finance.create_campaign`

**Zašto RPC, a ne direktan insert (kao app):** centralizira slug-generaciju, enum/iznos
validaciju, opcionalno vezivanje epizode (`campaign_subjects`) i Safe registraciju u **jedan
atomski, autoriziran poziv** koji svi klijenti (MCP, A2A, app, CLI) dijele. Rješava blokere
B2 i B5 iz [`schema-analysis.md`](schema-analysis.md).

Nova migracija: `domovina-api/supabase/migrations/2026XXXX_pinka_create_campaign.sql`

```sql
create or replace function pinka_finance.create_campaign(
  p_account_id            uuid,
  p_title                 text,
  p_type                  pinka_finance.campaign_type default 'donation',
  p_destination_address   text    default null,        -- derivirani Safe; NULL = greška ako nije guest-donation
  p_description           text    default null,
  p_goal_cents            bigint  default null,
  p_min_contribution_cents int    default 100,
  p_subject_type          text    default 'generic',
  p_subject_ref           text    default null,
  p_visibility            pinka_finance.campaign_visibility default 'private',
  p_youtube_channel_id    text    default null,
  p_metadata              jsonb   default '{}'::jsonb,
  p_slug                  text    default null          -- opc. eksplicitan; inače auto iz title
) returns table (id uuid, slug citext, destination_address text)
language plpgsql
security definer
set search_path = pinka_finance, public
as $$
declare
  v_slug   citext;
  v_base   text;
  v_id     uuid := gen_random_uuid();
  i        int := 0;
begin
  -- AUTORIZACIJA: caller mora biti account admin ILI verified channel owner
  if not (
    public.has_role_on_account(p_account_id, 'admin')
    or (p_youtube_channel_id is not null
        and pinka_finance.is_verified_channel_owner(p_youtube_channel_id))
  ) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- VALIDACIJA
  if coalesce(btrim(p_title), '') = '' then raise exception 'title_required'; end if;
  if p_goal_cents is not null and p_goal_cents <= 0 then raise exception 'goal_invalid'; end if;
  if p_min_contribution_cents <= 0 then raise exception 'min_contribution_invalid'; end if;
  if p_destination_address is null or p_destination_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'destination_invalid';
  end if;

  -- SLUG: eksplicitan ili auto iz title, s collision retry
  v_base := coalesce(nullif(p_slug, ''), pinka_finance.slugify(p_title)); -- vidi §2.1
  loop
    v_slug := case when i = 0 then v_base else left(v_base || '-' || (i+1), 62) end;
    begin
      insert into pinka_finance.campaigns
        (id, account_id, slug, type, title, description, goal_cents,
         min_contribution_cents, destination_address, subject_type, subject_ref,
         visibility, youtube_channel_id, state, metadata)
      values
        (v_id, p_account_id, v_slug, p_type, p_title, p_description, p_goal_cents,
         p_min_contribution_cents, p_destination_address, p_subject_type, p_subject_ref,
         p_visibility, p_youtube_channel_id, 'draft', coalesce(p_metadata, '{}'::jsonb));
      exit;  -- uspjeh
    exception when unique_violation then
      i := i + 1;
      if i >= 5 then raise exception 'slug_collision'; end if;
    end;
  end loop;

  -- opc. veži epizodu u campaign_subjects (ako je podcast_episode)
  if p_subject_type = 'podcast_episode' and p_subject_ref is not null then
    perform pinka_finance.attach_campaign_subject(v_id, 'podcast_episode', p_subject_ref);
  end if;

  return query select v_id, v_slug, p_destination_address;
end $$;

grant execute on function pinka_finance.create_campaign(
  uuid, text, pinka_finance.campaign_type, text, text, bigint, int, text, text,
  pinka_finance.campaign_visibility, text, jsonb, text
) to authenticated, service_role;
```

### 2.1 Pomoćni `slugify` (DB-side)

Da slug bude konzistentan bez obzira na klijenta, dodaj malu `pinka_finance.slugify(text)`
(lowercase, ASCII fold, ne-alfanumerik → `-`, trim, max 62). Alternativa: klijent šalje
`p_slug`, a RPC samo rješava koliziju. (Preporuka: oboje — auto kad nije zadan.)

> **Napomena o migracijama:** init.sql se ne re-runa na postojećem deployu; nova migracija ide
> u `domovina-api/supabase/migrations/` i primjenjuje se preko `./scripts/db-migrate.sh`
> (vidi `domovina-api/README.md`).

---

## 3. Headless Safe derivacija (rješava B1)

`pinka-finance/app/lib/chain/safe.ts` je **čista determinstička logika** (viem + Safe
protocol-kit, view pozivi) i radi u Node-u. Automation servis je preuzme 1:1:

```ts
// mcp-automation/src/safe.ts  (port iz app/lib/chain/safe.ts — bez passkey dijela)
import Safe from "@safe-global/protocol-kit";
import { keccak256, toBytes, type Address } from "viem";

const GNOSIS_RPC = process.env.GNOSIS_RPC ?? "https://rpc.gnosischain.com";

export function saltFromCampaignId(campaignId: string): string {
  return BigInt(keccak256(toBytes(`pinka:campaign:${campaignId}`))).toString();
}

export async function predictSafeAddress(signer: Address, salt: string): Promise<Address> {
  const kit = await Safe.init({
    provider: GNOSIS_RPC,
    predictedSafe: {
      safeAccountConfig: { owners: [signer], threshold: 1 },
      safeDeploymentConfig: { saltNonce: salt, safeVersion: "1.4.1" },
    },
  });
  return (await kit.getAddress()) as Address;
}

export async function deriveCampaignSafe(signer: Address, campaignId: string) {
  const saltNonce = saltFromCampaignId(campaignId);
  const safeAddress = await predictSafeAddress(signer, saltNonce);
  return { signerAddress: signer, safeAddress, saltNonce };
}
```

**Tko je `signer`?** Dvije opcije:
- **(A) Automation signer** — jedna poznata EVM adresa kontrolirana ops-om (npr. server-managed
  EOA ili fiksni ecosystem signer). Sve automatski kreirane kampanje su 1/1 Safe owned by njega.
  Najjednostavnije; prikladno za "platforma kreira u ime kanala".
- **(B) Delegirani user signer** — ako agent radi u ime usera koji ima ecosystem wallet, proslijedi
  njegovu `signerAddress`. Safe je tada user-owned (kao u app flowu). Bolje za self-serve.

Metadata koji ide u `p_metadata.safe` (mirror app shape, `app/dashboard/new/page.tsx:111-119`):
```jsonc
{ "safe": { "signer_address": "0x…", "salt_nonce": "…", "safe_version": "1.4.1",
            "source": "automation" } }
```

> **Bitno:** `campaignId` (UUID) MORA biti generiran **prije** derivacije i proslijeđen kao
> `id` u insert (RPC `create_campaign` interno generira `v_id` — pa ili RPC vrati `id` i Safe se
> derivira **nakon** insert-a iz vraćenog id-a, ILI klijent generira UUID i šalje ga kao
> `p_slug`-stil parametar). **Preporuka:** klijent generira `campaignId`, derivira Safe, šalje
> oboje (`id` + `destination_address`) — dodaj `p_id uuid` parametar u RPC da salt↔id ostanu vezani.

---

## 4. MCP površina — tool `create_pinka_project`

Interaktivni put (Claude korisnik conversationally kreira projekt). Novi mali MCP servis
`mcp-automation/` (ili dodatak postojećem domovina MCP-u). Tool:

```jsonc
{
  "name": "create_pinka_project",
  "description": "Kreira novi projekt (kampanju) na pinka.io. Derivira per-campaign Gnosis Safe i sprema kao draft.",
  "inputSchema": {
    "type": "object",
    "required": ["account_id", "title", "type"],
    "properties": {
      "account_id": { "type": "string", "description": "UUID pinka accounta (vlasnik). Caller mora imati admin rolu." },
      "title": { "type": "string", "minLength": 1 },
      "type": { "enum": ["donation","crowdfund","tokenization","tickets","realestate"] },
      "description": { "type": "string" },
      "goal_eur": { "type": "number", "description": "Cilj u EUR (pretvara se u cents). Izostavi za open-ended donaciju." },
      "min_contribution_eur": { "type": "number", "default": 1 },
      "visibility": { "enum": ["private","unlisted","public"], "default": "private" },
      "subject_type": { "type": "string", "default": "generic" },
      "subject_ref": { "type": "string", "description": "npr. YouTube ID kad je subject_type=podcast_episode" },
      "youtube_channel_id": { "type": "string" },
      "signer_address": { "type": "string", "description": "Opc. EVM adresa vlasnika Safe-a; inače automation signer." }
    }
  }
}
```

Handler (pseudo):
```ts
async function createPinkaProject(args) {
  const campaignId = randomUUID();
  const signer = args.signer_address ?? AUTOMATION_SIGNER;
  const { safeAddress, saltNonce } = await deriveCampaignSafe(signer, campaignId);
  const { data, error } = await supabase.rpc("create_campaign", {
    p_id: campaignId,
    p_account_id: args.account_id,
    p_title: args.title,
    p_type: args.type,
    p_destination_address: safeAddress,
    p_description: args.description ?? null,
    p_goal_cents: args.goal_eur != null ? Math.round(args.goal_eur * 100) : null,
    p_min_contribution_cents: Math.round((args.min_contribution_eur ?? 1) * 100),
    p_subject_type: args.subject_type ?? "generic",
    p_subject_ref: args.subject_ref ?? null,
    p_visibility: args.visibility ?? "private",
    p_youtube_channel_id: args.youtube_channel_id ?? null,
    p_metadata: { safe: { signer_address: signer, salt_nonce: saltNonce, safe_version: "1.4.1", source: "automation" } },
  }, { schema: "pinka_finance" });
  if (error) throw error;
  const row = data[0];
  return { id: row.id, slug: row.slug, url: `https://app.pinka.finance/c/${row.slug}`,
           destination_address: safeAddress, state: "draft" };
}
```

**Komplementarni MCP alati** (isti backend): `list_pinka_projects(account_id)`,
`get_pinka_project(id|slug)`, `add_pinka_tier(...)` (`campaign_tiers`),
`activate_pinka_project(id)` (`update state→active`), `set_pinka_visibility(id, vis)`.

---

## 5. A2A površina — skill `create_project`

Agent-to-agent put. Prati **isti A2A wire shape** kao domovina-rag (`domovina-rag/docs/a2a/
protocol-reference.md` §7): JSON-RPC `message/send`, skill biran preko `message.metadata.skillId`,
odgovor = `completed` Task s artifacts.

**Agent Card** (`https://pinka.finance/.well-known/agent-card.json`) deklarira skill:
```jsonc
{ "id": "create_project", "name": "Kreiraj pinka projekt",
  "description": "Kreira kampanju (donation/crowdfund/tokenization/tickets/realestate) s deriviranim Safe-om.",
  "tags": ["pinka","funding","campaign","create"],
  "examples": ["Napravi crowdfund 'Obnova doma' cilj 5000 EUR javno za epizodu dQw4w9WgXcQ"] }
```

**Poziv** (orkestrator → pinka A2A server):
```jsonc
POST https://pinka.finance/api/v1/a2a
Authorization: Bearer $TOKEN
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": {
    "role": "user", "messageId": "m1", "kind": "message",
    "parts": [
      { "kind": "text", "text": "Napravi crowdfund 'Obnova doma' cilj 5000 EUR za epizodu dQw4w9WgXcQ" },
      { "kind": "data", "data": {                      // strukturirani parametri (preferirano)
          "account_id": "…", "type": "crowdfund", "title": "Obnova doma",
          "goal_eur": 5000, "visibility": "public",
          "subject_type": "podcast_episode", "subject_ref": "dQw4w9WgXcQ" } }
    ],
    "metadata": { "skillId": "create_project" }
  }}
}
```

**Odgovor** (completed Task):
```jsonc
{ "jsonrpc": "2.0", "id": 1, "result": {
  "id": "task_…", "contextId": "ctx_…", "kind": "task",
  "status": { "state": "completed", "timestamp": "2026-06-05T12:00:00Z" },
  "artifacts": [{ "artifactId": "art_…", "name": "create_project_response",
    "parts": [
      { "kind": "text", "text": "Kampanja 'Obnova doma' kreirana (draft). URL: https://app.pinka.finance/c/obnova-doma" },
      { "kind": "data", "data": { "id": "…", "slug": "obnova-doma",
          "url": "https://app.pinka.finance/c/obnova-doma",
          "destination_address": "0x…", "state": "draft" } }
    ] }]
}}
```

Skill handler interno zove **istu** `createPinkaProject()` funkciju kao MCP tool (§4) → jedna
implementacija, dvije površine. Ovo je identičan pattern kao domovina-rag A2A skills
(`domovina-rag/docs/a2a/build-guide.md` §3).

---

## 6. Auth / identitet za automatizaciju (rješava B3, B4)

Tri modela, biraj po use-caseu:

| Model | Kako | Kad |
|---|---|---|
| **service_role** | Automation servis drži Supabase `service_role` ključ; zaobilazi RLS. RPC `create_campaign` i dalje provjerava `has_role_on_account` interno (jer je SECURITY DEFINER, `auth.uid()` je NULL pod service_role → **moraš proslijediti `p_account_id` eksplicitno i preskočiti auth granu za service_role**). | Platforma kreira u ime kanala (trusted ops). |
| **Delegirani user JWT** | Agent dobije korisnikov Supabase access token (OAuth/eID/magic-link), šalje ga kao Bearer; RPC vidi `auth.uid()` i enforce-a admin rolu. | Self-serve: agent radi u ime ulogiranog usera. |
| **Dedicirani automation account** | Kreiraj `accounts` red "Automation", daj mu admin membership na ciljane accounte; servis se autenticira kao taj user. | Granularan audit po automation identitetu. |

**Preporuka:** za prvi MVP **service_role** + eksplicitan `p_account_id` (uz dodatnu provjeru da
account postoji i nije deleted). Za javni self-serve kasnije **delegirani JWT** s `auth.uid()`
enforcementom (tada RPC auth grana iz §2 radi kako je napisana).

> Sigurnost: service_role ključ NIKAD u repo/klijent; samo u automation servis env (kao i ostali
> domovina secrets preko Coolify, vidi domovina-rag memory o secrets modelu).

---

## 7. End-to-end primjer (agent flow)

1. **Domovina orkestrator-agent** (iz `domovina-rag/docs/a2a/` vizije) zaključi da epizoda
   treba donation kampanju.
2. → A2A `message/send` skillId=`create_project` na pinka A2A server (data part s parametrima).
3. **pinka A2A server:** generira `campaignId`, derivira Safe headlessly (§3), zove
   `create_campaign` RPC (§2) sa service_role.
4. RPC: autorizira, generira slug, atomski insert (`draft`), veže epizodu (`campaign_subjects`),
   vrati `{id, slug, destination_address}`.
5. Server vrati completed Task s URL-om i Safe adresom.
6. (opc.) Orkestrator dalje pozove `activate_pinka_project` (state→active) ili `add_pinka_tier`.

Rezultat: kampanja živa, deep-link `app.pinka.finance/c/{slug}`, "Podrži ovu epizodu" panel se
veže preko `active_campaign_for_subject('podcast_episode', [ytId])`.

---

## 8. Sigurnost i rubni slučajevi

- **Autorizacija:** RPC je jedina write-točka; enforce admin/channel-owner. Service_role grana
  mora eksplicitno provjeriti postojanje accounta (jer zaobilazi RLS).
- **Idempotentnost:** `slug` UNIQUE + retry; opcionalno (subject_type, subject_ref) UNIQUE
  (`campaign_subjects`) sprječava dvije kampanje na istu epizodu (`episode_taken`).
- **Safe konzistentnost:** salt = `keccak256("pinka:campaign:{id}")` — id MORA biti isti koji ide
  u insert (proslijedi `p_id`), inače `destination_address` ne odgovara budućem deployu.
- **KYC:** kreiranje kampanje NE traži KYC; **payout** traži (`request_payout` gate). Automatizacija
  kreiranja je sigurna; automatizacija isplate bi trebala dodatne gate-ove.
- **Validacija enuma/iznosa:** u RPC-u (§2), ne oslanjaj se na klijenta (B5).
- **Rate limiting / audit:** ako se montira na A2A, reuse rate-limit + audit obrazac iz
  domovina-rag MCP-a (`rate-limit.ts`, `oauth_audit_log`).

---

## 9. Plan implementacije (checklist)

**Backend (domovina-api):**
- [ ] 1. Migracija `pinka_finance.slugify(text)` (§2.1)
- [ ] 2. Migracija `pinka_finance.create_campaign(...)` RPC + grant (§2), dodaj `p_id uuid`
- [ ] 3. (opc.) `create_campaign` service_role grana koja preskače `auth.uid()` provjeru uz
      eksplicitnu account-exists validaciju (§6)
- [ ] 4. Primijeni preko `./scripts/db-migrate.sh`; smoke test RPC-a iz `psql`/PostgREST

**Automation servis (ovaj folder → `mcp-automation/src/`):**
- [ ] 5. `safe.ts` — port headless derivacije (§3); ovisnosti `@safe-global/protocol-kit`, `viem`
- [ ] 6. `supabase.ts` — klijent sa service_role (ili delegirani JWT mode)
- [ ] 7. `create-project.ts` — zajednička `createPinkaProject()` (§4 handler)
- [ ] 8. **MCP server** — registriraj `create_pinka_project` (+ list/get/activate/add_tier)
- [ ] 9. **A2A server** — Agent Card + `message/send` (skillId=`create_project`), prati
      `domovina-rag/docs/a2a/build-guide.md` shape
- [ ] 10. e2e: kreiraj test kampanju protiv staging Supabase, provjeri da app dashboard vidi draft

**Integracija:**
- [ ] 11. Dodaj pinka Agent Card u domovina orkestrator-agent registry (discovery)
- [ ] 12. (opc.) `recommended_companions` cross-link domovina ↔ pinka MCP

**Procjena:** backend RPC = S, headless Safe = S (port postojećeg), MCP+A2A glue = M.
Najveći rizik: Safe protocol-kit u Node runtime-u (testirati da `Safe.init` predictedSafe radi
bez browser providera) i service_role auth grana u SECURITY DEFINER kontekstu.

---

## 10. Odluke za potvrditi (prije koda)

1. **Signer model:** automation signer (A) ili delegirani user signer (B)? → utječe na vlasništvo Safe-a.
2. **Auth model:** service_role MVP ili odmah delegirani JWT? → §6.
3. **Gdje živi servis:** zaseban `mcp-automation/` servis vs dodatak postojećem domovina MCP-u?
4. **`p_id` u RPC:** dodati eksplicitan `p_id uuid` da salt↔id ostanu vezani (preporučeno) — da/ne.
5. **Aktivacija:** kreiranje ostavlja `draft`; tko/kad flipa `active` (agent korak ili ljudski review)?
