# ADR-0001: Autentifikacija za `create_campaign` preko MCP/A2A

- **Status:** Prihvaćeno (dizajn). Implementacija odgođena.
- **Datum:** 2026-06-06
- **Kontekst repo:** `mcp-automation` (dizajn), `domovina-api` (RPC + Supabase), `mcp.domovina.ai` (postojeći read-only MCP)
- **Povezano:** [`mcp-a2a-design.md`](mcp-a2a-design.md) §2/§6, [`schema-analysis.md`](schema-analysis.md) §4, [`seed-pinka-dev-campaign.md`](seed-pinka-dev-campaign.md)

---

## 1. Problem

Želimo `pinka_finance.create_campaign(...)` RPC pozvati iz **Claude Code-a kao MCP skilla**
(i kasnije A2A skilla) tako da baza **zna pod kojim korisnikom** operacija ide — da
`has_role_on_account` i RLS rade nativno, a audit bude točan.

**Dva odvojena auth svijeta:**

| | Postojeći MCP (`mcp.domovina.ai`) | pinka_finance (Supabase @ api.domovina.ai) |
|---|---|---|
| Auth | vlastiti OAuth 2.1 + DCR (`services/mcp/src/auth.ts`), **auto-approve, anoniman** | Supabase GoTrue, `auth.uid()` |
| Token | MCP-ov vlastiti opaque token (u MCP PG-u) | Supabase JWT (`sub` = user uuid) |
| Scope danas | **samo čita ClickHouse** (podcast korpus) | RLS/SECURITY DEFINER traže `auth.uid()` |

**Potvrđeno (izvor istine):** `public.has_role_on_account(account, role)` je
`security definer stable` i provjerava **isključivo `auth.uid()`**:
`primary_owner_user_id = auth.uid()` (owner uvijek prolazi) OR membership red
(`domovina-api/supabase/migrations/20260520120300_triggers_functions.sql:209`).
→ Personal account owner prolazi **bez** membership reda (potvrđeno: vlasnički personal
accounti imaju 0 membership redova).

**Posljedica:** cijeli problem se svodi na — *kako poziv MCP toola nosi pravi Supabase
JWT da `auth.uid()` vrati pravog korisnika.* MCP-ov vlastiti token **nije** Supabase JWT,
a auto-approve flow korisnika nikad ni ne autenticira protiv Supabasea.

---

## 2. Odluke

### Odluka A — Zaseban "pinka write" MCP (NE bolaj na podcast MCP)
`mcp.domovina.ai` **ostaje read-only** (podcast korpus, ClickHouse). Write operacije
(`create_pinka_project`, kasnije `add_tier`, `activate`…) idu na **zaseban pinka MCP
servis** (iz ovog repoa), s vlastitim OAuth scopeom `pinka:write` i vlastitim
Supabase-bridge auth-om. Razlozi: odvojen blast-radius, odvojen audit/rate-limit, čist
read/write separation, neovisan deploy.

### Odluka B — Supabase je upstream IdP za pinka write MCP
Pri OAuth consentu (kad čovjek spaja konektor u Claude Code-u) **utvrđuje se identitet
JEDNOM**: authorize endpoint NE auto-approva, nego preusmjeri na DOMOVINA/Supabase login
(Certilia eID / magic-link / Google). Rezultat: mapping `mcp_token ↔ supabase_user_id`.
Dalje svaki tool-call te sesije implicitno nosi taj identitet.

### Odluka C — Ciljni model = impersonirani Supabase JWT (Faza B); interim = service_role + actor (Faza A)
 Vidi §3. Faza A je brzi most dok Faza B ne sazrije.

---

## 3. Razmotreni modeli

### Model 1 (CILJ) — Impersonirani Supabase JWT
Lanac:
```
1. Claude Code → Connect → OAuth authorize na pinka MCP
2. authorize → Supabase login (Certilia/magic-link/Google) na api.domovina.ai
3. MCP spremi: mcp_token ↔ supabase_user_id (+ odabrani account_id)
4. tool call create_pinka_project → MCP resolva supabase_user_id iz mcp_tokena
5. MCP mintira KRATKOTRAJNI Supabase JWT (sub=user_id, role=authenticated, aud=authenticated,
   exp≈60s), potpisan Supabase JWT secretom → Bearer na supabase-js klijentu
6. .rpc("create_campaign", …) → u bazi auth.uid() = pravi user
   → has_role_on_account radi nativno, RLS svugdje, audit točan
```
- **Prednost:** nema "trusted assertion" — JWT **jest** identitet; ista pravila kao u appu.
- **Cijena:** MCP mora držati **Supabase JWT secret** (može impersonirati bilo koga →
  jak secret, samo u serveru) + Supabase login u authorize flowu.

Skica mintanja (HS256 Supabase access token):
```ts
import { SignJWT } from "jose";
const token = await new SignJWT({ role: "authenticated" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(supabaseUserId)            // → auth.uid()
  .setAudience("authenticated")
  .setIssuedAt().setExpirationTime("60s")
  .sign(new TextEncoder().encode(SUPABASE_JWT_SECRET));
const sb = createClient(SUPABASE_URL, ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${token}` } },
});
await sb.schema("pinka_finance").rpc("create_campaign", { /* … */ });
```

### Model 2 (INTERIM) — service_role + eksplicitni actor
- MCP drži `service_role` ključ; `create_campaign(p_actor_user_id, …)` provjerava
  `has_role_on_account`-ekvivalent protiv **asertiranog** `p_actor_user_id` (jer pod
  service_role `auth.uid()` je NULL).
- **Prednost:** brzo, ne treba JWT secret ni login bridge.
- **Cijena:** MCP-u se **vjeruje** da govori istinu o akteru (trusted boundary). Audit bilježi
  asertiranog actora, ne kriptografski dokazan.

### Model 3 (ODBAČEN za MCP) — token passthrough
Korisnik ručno donosi svoj Supabase access token kao input toola. Nativni `auth.uid()`, ali
JWT istekne za ~1h i UX u Claude Code-u je loš (paste/refresh). Korisno samo za skripte/CLI.

---

## 4. RPC dizajn (podržava obje faze)

`pinka_finance.create_campaign(...)` SECURITY DEFINER (puni potpis u
[`mcp-a2a-design.md`](mcp-a2a-design.md) §2), s autorizacijskom granom:

```sql
-- Faza B: poziv nosi user JWT → auth.uid() je pravi
if auth.uid() is not null then
  if not public.has_role_on_account(p_account_id, 'admin') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
-- Faza A: service_role (auth.uid() NULL) → autoriziraj asertiranog actora
elsif p_actor_user_id is not null then
  if not exists (
    select 1 from public.accounts a
    where a.id = p_account_id and a.deleted_at is null
      and (a.primary_owner_user_id = p_actor_user_id
           or exists (select 1 from public.accounts_memberships m
                      where m.account_id = a.id and m.user_id = p_actor_user_id
                        and m.account_role in ('owner','admin')))
  ) then raise exception 'not_authorized' using errcode = '42501'; end if;
else
  raise exception 'no_identity';
end if;
```
> Napomena: `has_role_on_account` interno već koristi `auth.uid()`, pa ga u Fazi A (service_role)
> ne možemo iskoristiti — zato eksplicitna provjera `primary_owner_user_id`/membership s `p_actor_user_id`.

---

## 5. Account linking (obavezno) + multi-identitet gotcha

Korisnik ima **više identiteta** (vidjeli smo uživo: `matija.stepanic@toptal.com` je
posjedovao kampanju, a login je bio `stepanic.matija@gmail.com` → dva Supabase usera, dva
personal accounta, kampanja nevidljiva u dashboardu). Zato pri linkanju korisnik **mora
odabrati koji pinka account** MCP koristi (ili default personal account ulogiranog usera).

Mapping tablica (u MCP-ovom store-u ili Supabaseu):
```
mcp_account_links(
  subject text,              -- MCP OAuth subject / client+user
  supabase_user_id uuid,     -- iz Supabase logina (korak 2)
  account_id uuid,           -- odabrani pinka account za pisanje
  created_at, last_used_at
)
```

---

## 6. Sigurnost

- **JWT secret custody (Model 1):** samo u pinka write MCP serveru (env, nikad repo/klijent).
  Kompromitacija = impersonacija bilo koga → tretirati kao najjači secret; rotabilan.
- **Scope izolacija:** `pinka:write` scope odvojen od podcast read MCP-a; consent eksplicitno
  traži write dopuštenje.
- **Kratak TTL JWT-a** (≈60s) — mintaj per-call, ne drži dugovječne user tokene.
- **Audit:** svaki write logiraj (actor supabase_user_id, account_id, akcija) — reuse `oauth_audit_log`
  obrazac iz `services/mcp/src/auth.ts`.
- **Rate-limit:** per linkani user/client (reuse `rate-limit.ts`).
- **KYC:** kreiranje kampanje ne traži KYC; **payout** traži — write MCP NE smije raditi payout bez dodatnih gate-ova.

---

## 7. Posljedice

- Novi servis: **pinka write MCP** (u `mcp-automation/`), scope `pinka:write`, Supabase-bridge auth.
- Backend: `create_campaign` RPC s dual autorizacijom (§4) + (Faza A) `p_actor_user_id` param.
- Novi authorize flow s Supabase loginom (Faza B) — NE auto-approve za write scope.
- `mcp.domovina.ai` ostaje netaknut (read-only).

## 8. Sljedeći koraci (kad krene implementacija)

1. `create_campaign` RPC (Faza A grana prvo) + migracija u `domovina-api`.
2. Account-link flow + `mcp_account_links` (interim: ručni link / dashboard "Spoji MCP").
3. pinka write MCP servis skeleton: tool `create_pinka_project` → service_role + `p_actor_user_id`.
4. Faza B: Supabase login u authorize + impersonirani JWT; ukloni service_role write put.
5. A2A skill `create_project` povrh istog (dijeli auth).

---

### Sažetak odluke
**Zaseban pinka write MCP**; **Supabase upstream IdP**; **ciljni model = impersonirani
Supabase JWT** (native `auth.uid()`), **interim = service_role + asertirani actor**.
Identitet se utvrđuje pri OAuth consentu, nosi se per-sesijskim MCP tokenom, i pretvara u
Supabase JWT po pozivu. Podcast MCP ostaje read-only.
