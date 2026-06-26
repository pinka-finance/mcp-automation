# Per-campaign Safe — vlasništvo, uplate/isplate i prenosivost u Safe klijente

> Odgovara na pitanje: *je li per-campaign Safe dodatni sloj komplikacije, i može
> li ga korisnik jednostavno importati u **wallet.domovina.ai** ili **Safe Mobile
> app** i normalno raditi uplate/isplate kao s bilo kojim multisig Safe-om — radi
> li to već ili treba dorada?*
>
> Datum: 2026-06-26 (REV 2 — ispravljeno nakon uvida da je `recoveryOwner`
> korisnikov EOA). Izvori: `app/lib/chain/{safe,passkey,walletSdk,safeApp}.ts`,
> `pay.domovina.ai/wallet/src/lib/{accounts,bootstrap,paperWallet,registry,recover}.ts`,
> `app/docs/wallet-campaign-account-handoff.md` (ADR 0011/0012/0013). Veže se na
> [`mcp-pinka-remote-plan.md`](mcp-pinka-remote-plan.md) §5.

---

## 1. Kratki odgovor (TL;DR) — ISPRAVAK

**Da, tvoja intuicija je točna:** wallet-native račun je **1-of-2 `[passkeySigner,
recoveryOwner]`**, gdje je `recoveryOwner` **korisnikov bootstrap EOA** = standardni
12-riječni BIP39 seed koji korisnik backupira (ADR 0012). Threshold = 1, pa **taj EOA
sam potpisuje**. `paperWallet.ts` doslovno upućuje: *uvezi seed u Safe Mobile /
app.safe.global / MetaMask kao potpisnika i učitaj Safe po adresi.*

| Radnja | Status | Bitna kvaka |
|---|---|---|
| **Uplata** (primanje EURe) | ✅ radi odmah | Safe je samo adresa; counterfactual prima ERC-20 |
| **Import EOA seeda u Safe Mobile + isplata** — Safe je **1-of-2** (wallet-native) | ✅ **radi po dizajnu** | recoveryOwner = korisnikov BIP39 seed; threshold 1 → potpisuje sam (nakon što je Safe deployan) |
| **Isto, ali Safe je _legacy 1-of-1_** (što pinka/MCP danas deriviraju) | ❌ / 🟠 | 1-of-1 nema EOA ownera — nema što importati; isplata samo `/recover` |
| **Pinka kampanje danas su 1-of-2?** | ❌ **još ne** | pinka derivira legacy 1-of-1; wallet-native handoff (`dw_create_account`) je **pending** |
| **Wallet-native računi (npr. tvoji "računi" u DOMOVINA walletu) danas su 1-of-2?** | ✅ da | `deriveAccount` već radi 1-of-2; mehanizam je živ |

**Sažeto:** mehanizam koji opisuješ **postoji i radi danas** — za **wallet-native
1-of-2 račune**. Jedino što fali: **pinka kampanje se još kuju kao legacy 1-of-1**,
a ne kao 1-of-2. Kad kampanjski Safe postane 1-of-2 (signer + tvoj recovery EOA),
uvoz seeda u Safe Mobile i isplata rade točno kako si zamislio.

---

## 2. Vlasnički model (ADR 0011/0012/0013)

```mermaid
flowchart TD
    BOOT["Bootstrap identiteta:<br/>generira se 12-riječni BIP39 seed (EOA)"] --> RO["recoveryOwner = taj EOA<br/>(korisnik ga backupira — paper wallet)"]
    BOOT --> PK["passkey signer (WebAuthn, RP domovina.ai)"]

    RO --> ACC["Wallet-native derived račun:<br/>1-of-2 [passkeySigner, recoveryOwner], threshold 1"]
    PK --> ACC
    ACC --> USE1["Potpis A: passkey u DOMOVINA walletu (Face ID + relay)"]
    ACC --> USE2["Potpis B: recoveryOwner EOA seed u<br/>Safe Mobile / app.safe.global / MetaMask"]

    LEG["Legacy račun (pinka danas):<br/>1-of-1 [passkeySigner] — NEMA EOA ownera"] --> ONLY["samo passkey; isplata preko /recover"]

    classDef good fill:#dcfce7,stroke:#16a34a;
    classDef warn fill:#fef9c3,stroke:#ca8a04;
    class USE1,USE2 good;
    class LEG,ONLY warn;
```

Dva načina (`bootstrap.ts`):
- **'swap'** → owners=`[passkey]` (1-of-1, EOA uklonjen) — *legacy, passkey-only*.
- **'add'** → owners=`[passkey, EOA]` (1-of-2) — *"12-riječni EOA mnemonic postaje
  MetaMask / app.safe.global-kompatibilan"*. Ovo je put koji daje prenosivost.

Svi derivirani računi identiteta **dijele isti recoveryOwner** → korisnik backupira
**JEDAN** ključ koji kontrolira sve (ADR 0013, Decision 2). Address derivacija treba
samo **javne adrese** `[signer, recoveryOwner]` + saltNonce — **ne treba seed**.

---

## 3. Uplata (deposit) — radi danas, bez importa

```mermaid
sequenceDiagram
    autonumber
    participant Donor as Donator
    participant Rail as pay.domovina.ai (rail)
    participant Safe as per-campaign Safe (adresa)
    Donor->>Rail: SEPA / EURe uplata (QR / link)
    Rail->>Safe: forward EURe na destination_address
    Note over Safe: counterfactual — ne mora biti deployan da primi
```

---

## 4. Isplata (withdrawal) — tko može potpisati

```mermaid
flowchart TD
    W["Isplata (execTransaction; Safe se prvi put i deploya)"] --> Q{"Koji owner set?"}
    Q -->|"1-of-2 [passkey, recoveryOwner]"| OK2["✅ DVA puta:<br/>(a) passkey u DOMOVINA walletu<br/>(b) recoveryOwner EOA seed u bilo kojem Safe klijentu"]
    Q -->|"legacy 1-of-1 [passkey]"| L["🟠 samo passkey; izvan walleta samo /recover"]
    Q -->|"host Safe (unutar Safe{Wallet})"| H["✅ potpisuje host Safe"]

    classDef good fill:#dcfce7,stroke:#16a34a;
    classDef warn fill:#fef9c3,stroke:#ca8a04;
    class OK2,H good;
    class L warn;
```

---

## 5. "Import u Safe Mobile i normalno raditi" — po klijentu

```mermaid
flowchart TB
    subgraph s12["per-campaign Safe = 1-of-2 (wallet-native)"]
        A1["DOMOVINA wallet → ✅ listan, saldo, isplata (passkey)"]
        A2["Safe Mobile / app.safe.global / MetaMask →<br/>✅ uvezi recoveryOwner seed kao signer,<br/>učitaj Safe po adresi, potpiši (threshold 1)<br/>⚠️ Safe mora biti deployan (1. isplata ga deploya)"]
    end
    subgraph s11["per-campaign Safe = legacy 1-of-1 (pinka danas)"]
        B1["DOMOVINA wallet → 🟠 /recover"]
        B2["Safe Mobile → ❌ nema EOA ownera za uvoz"]
    end

    classDef good fill:#dcfce7,stroke:#16a34a;
    classDef warn fill:#fef9c3,stroke:#ca8a04;
    classDef bad fill:#fee2e2,stroke:#dc2626;
    class A1,A2 good;
    class B1 warn;
    class B2 bad;
```

> Jedina nijansa za generički Safe klijent: učitavanje Safe-a "po adresi" traži da je
> **deployan** (ima on-chain kod). Counterfactual Safe se deploya na prvoj isplati
> (relay) — nakon toga ga Safe Mobile vidi i EOA potpisuje normalno.

---

## 6. Što treba doraditi (manje nego što se činilo)

```mermaid
flowchart TD
    GOAL["Cilj: per-campaign Safe = normalan multisig,<br/>uplate + isplate, importabilan u Safe Mobile"]
    GOAL --> FIX["JEDINA dorada: pinka kampanje kovati kao<br/>wallet-native 1-of-2 (signer + recoveryOwner),<br/>umjesto legacy 1-of-1"]
    FIX --> P1["pinka.io UI: dovrši dw_create_account handoff<br/>(pinka strana shippana, WALLET strana pending)"]
    FIX --> P2["ILI: deriviraj 1-of-2 server-side iz JAVNIH adresa<br/>(signer + recoveryOwner) — vidi §7 (put za MCP)"]

    classDef good fill:#dcfce7,stroke:#16a34a;
    class FIX,P1,P2 good;
```

Prenosivost u Safe Mobile **NE traži novi sloj** — wallet-native 1-of-2 *već* ima
korisnikov EOA kao drugog ownera. Treba samo da kampanjski Safe bude 1-of-2, ne 1-of-1.

---

## 7. Implikacija za remote MCP — sad bolja vijest

Adresa 1-of-2 Safe-a ovisi samo o **javnim adresama** `[signerAddress, recoveryOwner]`
+ saltNonce. Oboje su **pohranjeni u backend registry-ju** (`/api/wallets`:
`signer_address`, `recovery_owner`). Dakle **MCP može server-side derivirati i
registrirati ispravan wallet-native 1-of-2 kampanjski Safe — bez browsera, passkey-a
ili seeda** (seed treba tek za POTPIS isplate, koji radi korisnik kasnije).

```mermaid
flowchart TD
    M["MCP pinka_create_campaign (bez browsera)"] --> R["pročitaj (signer_address, recovery_owner)<br/>iz wallet backend registry-ja po korisniku"]
    R --> D["deriviraj 1-of-2 [signer, recoveryOwner] @ salt=campaign<br/>(predictSafeAddressForOwners — samo javne adrese)"]
    D --> REG["registriraj račun u wallet backend<br/>(/api/wallets/{cred}/accounts) → vidljiv u walletu"]
    REG --> DEST["destination_address = taj Safe (wallet-native, 1-of-2)"]
    DEST --> SIGN["isplata kasnije: passkey (wallet) ILI recoveryOwner seed (Safe Mobile)"]

    classDef good fill:#dcfce7,stroke:#16a34a;
    class D,REG,DEST,SIGN good;
```

**Ovo zamjenjuje §5 remote plana:** umjesto "pohrani signer → MCP derivira 1-of-1",
ide **"pročitaj (signer, recoveryOwner) iz registry-ja → MCP derivira+registrira
1-of-2"**. Rezultat: MCP-kreirane kampanje su odmah pun wallet-native račun —
uplate, isplate (passkey ili EOA seed), recovery, cross-device, importabilne u Safe
Mobile. Bez orphan 1-of-1.

> Preduvjet: backend registry mora izložiti read `(signer_address, recovery_owner)`
> po korisniku/identitetu MCP-u (interni endpoint ili direktan PG read). To je mala
> dorada na rail/registry backendu.

---

## 8. Sažetak (REV 2)

- **Uplate rade danas.**
- **Prenosivost u Safe Mobile RADI po dizajnu — za 1-of-2 račune.** recoveryOwner je
  korisnikov BIP39 seed (1-of-2, threshold 1); paper wallet doslovno upućuje na uvoz
  u Safe Mobile / app.safe.global / MetaMask. Jedini uvjet: Safe deployan (1. isplata).
- **Jedina dorada:** pinka kampanje kovati kao **wallet-native 1-of-2**, ne legacy
  1-of-1. (wallet `dw_create_account` strana je pending; ALI MCP to može i server-side.)
- **MCP**: derivira+registrira 1-of-2 iz javnih adresa `(signer, recoveryOwner)` iz
  registry-ja → kampanjski Safe je odmah pun, prenosiv, recoverable račun.
