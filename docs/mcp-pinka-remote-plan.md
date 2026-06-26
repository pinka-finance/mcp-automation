# `mcp.pinka.io` — remote, multi-user, deploy na Coolify (vizualni plan)

> **Vizija:** korisnik koji se autentificira na **pinka.io** istim credentialima može
> (a) ručno kroz pinka.io UI kreirati i administrirati kampanje, ILI (b) spojiti
> **mcp.pinka.io** na Claude Desktop i raditi to programski — **na istom identitetu,
> kroz iste RLS/KYC zaštite**. Deploy na **Coolify**, kao `mcp.domovina.ai`.
>
> Status: **dizajn (potvrđene ključne odluke), čeka implementaciju.** Datum: 2026-06-26.
> Nadograđuje [`mcp-pinka-implementation-plan.md`](mcp-pinka-implementation-plan.md)
> (v0: lokalni stdio + service_role) i ostvaruje "ciljni model" iz
> [`auth-design.md`](auth-design.md) (impersonirani Supabase JWT).

---

## 1. Od v0 (lokalni) do v1 (remote) — što se mijenja

| | v0 (sagrađeno: `server/`) | v1 (ovaj plan) |
|---|---|---|
| Transport | lokalni **stdio** | remote **Streamable HTTP** (Express) |
| Host | tvoj laptop | **Coolify** (Docker), `mcp.pinka.io` |
| Auth | `service_role` (god-mode) | **OAuth 2.1 consent → impersonirani user JWT** |
| Identitet | hardkodiran `PINKA_ACCOUNT_ID` | **iz tvoje pinka.io prijave** (auth.uid()) |
| RLS/KYC | zaobiđeno | **nativno se primjenjuje** (kao u UI-u) |
| Tko može | samo ti, lokalno | **bilo koji ulogirani+KYC pinka.io korisnik** |
| Episode linking | direktni `campaign_subjects` write | **pravi DEFINER RPC-evi** (auth.uid() sad postoji) |
| Write guard | klijentski mirror | **pravi trigger radi** (auth.role()='authenticated') |
| Safe signer | env signer / default | **per-account ecosystem signer** iz baze |

**Velika sigurnosna pobjeda:** v1 **nema `service_role`** na serveru. Sve ide kroz
identitet korisnika; MCP ne može ništa što korisnik ne bi mogao i sam u UI-u.

> v0 ostaje koristan kao lokalni dev/solo alat; v1 je produkcijski multi-user put.
> Codebase se refaktorira da podržava **oba transporta** (kao `domovina-rag/services/mcp`).

---

## 2. Arhitektura (komponente)

```mermaid
flowchart TB
    subgraph Claude["Claude Desktop / claude.ai / Claude Code"]
        CC["Connector: mcp.pinka.io"]
    end

    subgraph PinkaUI["pinka.io (Cloudflare Pages SPA)"]
        UI["Dashboard: kreiraj/uredi kampanju (ručno)"]
        CONSENT["🆕 /mcp/authorize — consent stranica<br/>(čita postojeću Supabase sesiju)"]
        WC["Wallet connect (DOMOVINA SDK)"]
    end

    subgraph MCP["🆕 mcp.pinka.io (Coolify / Docker, Express)"]
        OAUTH["OAuth 2.1 + DCR<br/>(opaque tokeni u PG)"]
        MAP["mcp_token ↔ supabase_user_id + account_id"]
        MINT["JWT minter (HS256)<br/>per-call ~60s user JWT"]
        TOOLS["10 toolova (per-user supabase-js)"]
    end

    subgraph BE["api.domovina.ai — self-hosted Supabase"]
        PGREST["PostgREST + RLS/KYC"]
        GOTRUE["GoTrue (verifikacija)"]
        PG[("pinka_finance + public.accounts<br/>+ account_signers + pinka_mcp.oauth_*")]
    end

    CC -- "Streamable HTTP + Bearer (OAuth)" --> OAUTH
    CC -. "connect: redirect na consent" .-> CONSENT
    CONSENT -- "dokaz identiteta (Supabase access_token)" --> OAUTH
    OAUTH --> MAP --> MINT
    TOOLS -- "Bearer = impersonirani JWT" --> PGREST
    MINT -. "potpisan SERVICE_PASSWORD_JWT" .-> TOOLS
    OAUTH -. "verify token" .-> GOTRUE
    PGREST --> PG
    UI --> PGREST
    WC -- "spremi ecosystem signer" --> PGREST

    classDef new fill:#dcfce7,stroke:#16a34a,stroke-width:2px;
    class MCP,OAUTH,MAP,MINT,TOOLS,CONSENT new;
```

---

## 3. Connect flow (jednokratno, kod spajanja konektora)

Cilj: utvrditi identitet JEDNOM, bez novog logina (korisnik je već ulogiran na
pinka.io), pa mapirati `mcp_token ↔ supabase_user_id`.

```mermaid
sequenceDiagram
    autonumber
    participant U as Korisnik (browser)
    participant CD as Claude Desktop
    participant M as mcp.pinka.io
    participant P as pinka.io /mcp/authorize
    participant G as GoTrue (Supabase)

    CD->>M: OAuth authorize (Connect konektora)
    M-->>CD: redirect na pinka.io/mcp/authorize?mcp_challenge=…
    CD->>P: otvori consent stranicu (browser)
    Note over P: čita POSTOJEĆU Supabase sesiju<br/>(isti origin kao pinka.io login)
    alt nije ulogiran
        P->>G: login (passkey / Certilia / Google / email)
    end
    P->>U: "Dopusti Claudeu upravljanje kampanjama kao <ti>?<br/>account: [personal ▾]"
    U->>P: Dopusti
    P->>M: callback(mcp_challenge, Supabase access_token, account_id)
    M->>G: verificiraj access_token (sub = user_id)
    G-->>M: valjan ✓ (user_id)
    M->>M: spremi mapping mcp_token ↔ user_id + account_id
    M-->>CD: authorization code → exchange → MCP access token (opaque)
    Note over CD,M: dalje svaki tool-call nosi taj mcp_token
```

---

## 4. Per-call impersonacija (svaki tool poziv)

```mermaid
sequenceDiagram
    autonumber
    participant CD as Claude Desktop
    participant M as mcp.pinka.io
    participant DB as PostgREST (RLS)

    CD->>M: tools/call pinka_create_campaign (Bearer mcp_token)
    M->>M: verify mcp_token → user_id + account_id
    M->>M: mint 60s JWT { sub:user_id, role:"authenticated", aud:"authenticated" }<br/>(HS256, SERVICE_PASSWORD_JWT)
    M->>M: razriješi Safe iz account_signers[account_id] (vidi §5)
    M->>DB: rpc create_campaign(...) — Authorization: Bearer <impersonirani JWT>
    Note over DB: auth.uid() = user_id →<br/>RLS: has_role_on_account(admin) ∧ is_identity_verified()<br/>write guard trigger se okida (authenticated)
    DB-->>M: { id, slug }
    M->>DB: rpc set_campaign_episodes(id, [ytId])  ← sad RADI (auth.uid() ≠ null)
    M-->>CD: rezultat
```

**Posljedice (vs v0):** episode-linking koristi prave DEFINER RPC-eve; write guard
trigger stvarno radi (nema klijentskog mirrora); KYC i admin-role se provjeravaju
serverski. MCP ne može pisati na tuđi account ni bez KYC-a — isto kao UI.

---

## 5. Safe = per-account ecosystem signer (UI/MCP zamjenjivost)

Per-campaign Safe se derivira iz **stabilnog ecosystem signera korisnika**. Taj 0x se
spremi kad korisnik poveže DOMOVINA wallet u pinka.io UI; MCP ga čita i derivira bez
browsera/passkey.

```mermaid
flowchart TD
    subgraph UI["pinka.io UI (jednom)"]
        A["Wallet connect → dobije signerAddress (ecosystem)"]
        B["upsert_account_signer(account_id, signer_address)"]
    end
    A --> B --> T[("🆕 pinka_finance.account_signers<br/>account_id PK, signer_address,<br/>ecosystem_safe?, source, updated_at")]

    subgraph MCPcreate["MCP pinka_create_campaign"]
        C["dohvati account_signers[account_id]"]
        D{"signer postoji?"}
        E["deriveCampaignSafeFromSigner(signer, id)<br/>= destination_address (user-owned)"]
        F["kreiraj kao DRAFT bez aktivacije<br/>+ poruka: poveži wallet u UI"]
    end
    T --> C --> D
    D -- da --> E
    D -- ne --> F

    classDef new fill:#dcfce7,stroke:#16a34a,stroke-width:2px;
    class T new;
```

**Backend dodatak (mala migracija):** `pinka_finance.account_signers` + RPC
`upsert_account_signer(p_signer_address)` (SECURITY DEFINER; piše za `auth.uid()`-ov
account) + read grant. pinka.io wallet-connect zove RPC. Time su UI i MCP **potpuno
zamjenjivi** — oba deriviraju isti Safe iz istog signera.

---

## 6. Sigurnosni / autorizacijski model

```mermaid
flowchart TB
    JWT["impersonirani user JWT (60s)"] --> RLS["RLS / KYC / guard"]
    RLS --> OK1["✅ create_campaign: ako admin na vlastitom accountu I is_identity_verified()"]
    RLS --> OK2["✅ update/episodes: kroz vlasništvo accounta (ili verified channel owner)"]
    RLS --> BAD1["⛔ kreiranje bez KYC-a → RLS odbija (42501) — isto kao UI"]
    RLS --> BAD2["⛔ pisanje na TUĐI account → has_role_on_account false"]

    subgraph custody["Secret custody"]
        S1["SERVICE_PASSWORD_JWT samo u MCP env (Coolify)"]
        S2["NEMA service_role na serveru"]
        S3["mcp tokeni opaque (SHA-256 u PG); TTL + GC"]
        S4["consent NIJE auto-approve → pravi pinka.io login"]
    end

    classDef bad fill:#fee2e2,stroke:#dc2626;
    classDef good fill:#dcfce7,stroke:#16a34a;
    class BAD1,BAD2 bad;
    class OK1,OK2 good;
```

- **JWT secret** je root-of-trust cijelog Supabasea i ionako živi na istoj Coolify
  infri; na MCP-u: kratki TTL, per-call mint, nikad u log. Rotabilan.
- **Blast-radius manji nego v0**: nema god-mode service_role ključa; sve je gated
  korisnikovim identitetom i KYC-om.
- **Scope** `pinka:write`, per-user **rate-limit** i **audit** (reuse domovina obrazac).

---

## 7. OAuth state + deploy (Coolify, uzor `mcp.domovina.ai`)

```mermaid
flowchart LR
    subgraph repo["mcp-automation/server (refaktor)"]
        IDX["index.ts: transport stdio|http"]
        HTTP["http.ts: Express + Streamable + bearer + rate-limit + audit"]
        AUTH["auth.ts: PgOAuthProvider (opaque) + consent/callback"]
        IMP["impersonate.ts: HS256 minter (jose)"]
        SBF["supabase.ts: per-call user klijent"]
    end
    subgraph coolify["Coolify"]
        DOCK["Dockerfile node:22-alpine<br/>/health, EXPOSE 3000, MCP_TRANSPORT=http"]
        DNS["mcp.pinka.io → Let's Encrypt"]
    end
    PG[("api.domovina.ai Postgres<br/>schema pinka_mcp.oauth_*")]

    IDX --> HTTP --> AUTH --> PG
    HTTP --> IMP --> SBF
    DOCK --> DNS
```

- **OAuth tablice**: port `domovina-rag/infra/postgres/migrations/001_oauth_tables.sql`
  u **schema `pinka_mcp`** na **istom** Supabase Postgresu (raw `pg` Pool; odvojeno od
  PostgREST app puta). Jedna baza, manje pokretnih dijelova.
- **Dockerfile + Coolify**: 1:1 obrazac iz `docs/coolify-mcp-application.md` (Dockerfile
  buildpack, base dir `/server`, attach na Supabase/coolify network, env u UI, domena
  `mcp.pinka.io`, healthcheck `/health`).
- **Env (v1)**: `MCP_TRANSPORT=http`, `MCP_PORT`, `MCP_PUBLIC_BASE_URL=https://mcp.pinka.io`,
  `MCP_OAUTH_PG_URL` (Supabase Postgres), `SUPABASE_URL`, `SUPABASE_JWT_SECRET`
  (=SERVICE_PASSWORD_JWT), `SUPABASE_ANON_KEY`, `PINKA_CONSENT_URL=https://pinka.io/mcp/authorize`,
  rate-limit + GC varijable. **Bez** `SUPABASE_SERVICE_ROLE_KEY`.

---

## 8. Toolovi (v1 promjene vs v0)

| Tool | Promjena u v1 |
|---|---|
| **(novo)** `pinka_whoami` | prikaže spojeni identitet: user, account, KYC status, ima li ecosystem signer |
| `pinka_create_campaign` | account iz JWT identiteta (ne env); Safe iz `account_signers`; RLS/KYC nativno; bez ručnog metadata.safe hacka |
| `pinka_update_campaign` | bez guard-mirrora (pravi trigger radi); i dalje defenzivne provjere |
| `pinka_set_episodes` / attach / detach | **pravi DEFINER RPC-evi** (`set_campaign_episodes`, …) umjesto direktnog writea |
| `pinka_list_campaigns` | default filter = tvoj account (iz identiteta), ne env |
| ostali (`get`, `import_domovina`, `derive_safe`, `list_contributions`) | logika ista; klijent = per-user |

Sva tool **logika i validacija** (`lib/campaign-config.ts`, `lib/domovina-import.ts`,
`lib/chain/safe.ts`) se **reusa iz v0** netaknuta.

---

## 9. Plan izvedbe (faze)

1. **Backend (domovina-api migracija):** `pinka_finance.account_signers` + RPC
   `upsert_account_signer` + read grant. (KYC/RLS/account model već postoje.)
2. **pinka.io UI:** (a) wallet-connect zove `upsert_account_signer`; (b) nova ruta
   `/mcp/authorize` — consent stranica (čita Supabase sesiju, bira account, šalje dokaz MCP-u).
3. **MCP auth jezgra:** OAuth PG store (`pinka_mcp.oauth_*`), `PgOAuthProvider`
   (port iz domovina), custom **consent/callback** (NE auto-approve), `impersonate.ts` (jose HS256), per-call user klijent.
4. **HTTP transport:** Express + Streamable HTTP + bearer + rate-limit + audit (port iz domovina), `index.ts` bira `stdio|http`.
5. **Toolovi refaktor:** per-user klijent, account iz identiteta, pravi episode RPC-evi, Safe iz `account_signers`, `pinka_whoami`.
6. **Dockerfile + Coolify:** image, env, network, domena `mcp.pinka.io`, DNS, healthcheck, deploy.
7. **E2E:** spoji konektor iz Claude Desktopa kao stvarni KYC-ani korisnik → kreiraj+aktiviraj kampanju → potvrdi karticu na domovina.ai; provjeri da ne-KYC korisnik biva odbijen.

---

## 10. Otvorena pitanja za kasnije (ne blokiraju početak)

- **Account izbor** kad korisnik ima više identiteta/accounta (poznata zamka) — consent
  stranica nudi padajući izbornik; default personal account ulogiranog usera.
- **A2A skill** `create_project` povrh istog (dijeli auth) — odgođeno (vidi `mcp-a2a-design.md`).
- **Rotacija JWT secreta** — uskladiti s domovina-api rotacijom.

---

### Sažetak odluke

Remote **Streamable HTTP** MCP na **Coolify** (`mcp.pinka.io`), **bez service_role**.
OAuth consent na **pinka.io** (postojeća sesija) → mapping na Supabase user → per-call
**impersonirani 60s JWT** → writeovi kroz **RLS/KYC** nativno. Safe se derivira iz
**per-account ecosystem signera** (UI ga puni, MCP čita) → UI i MCP **potpuno
zamjenjivi**. Sva v0 tool-logika se reusa; novi su samo auth/transport/deploy sloj +
mala `account_signers` migracija.
