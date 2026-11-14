# ARCHITECTURE.md — Technical Specification & Schemas for `near-polygraph`

This document defines the exact data structures, smart contract interfaces, mathematical heuristics, and JSON schemas for `near-polygraph`. Follow these specifications strictly during implementation.

---

## 1. System Topology & Network Separation

Because NEAR smart contracts execute inside a deterministic WebAssembly (Wasm) runtime and cannot query historical blocks or archival RPCs directly, `near-polygraph` separates **historical telemetry analysis (off-chain)** from **payout gate enforcement (on-chain)**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. DATA SOURCE (NEAR Mainnet Read-Only / Local Deterministic Fixtures)     │
│    - Historical transactions on target contract in block window [B_0, B_1] │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. OFF-CHAIN VERIFIER CLI (`verifier/` — TypeScript / Node.js)             │
│    - Evaluates Heuristics H1 (Funder Cluster), H2 (Burner), H3 (Uniformity)│
│    - Outputs Canonical JSON Report (sorted keys) + SHA-256 hex digest      │
│    - Submits `attest(claim_id, score_bps, ...)` via Testnet RPC            │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. POLYGRAPH GATE CONTRACT (`contracts/polygraph-gate` — NEAR Testnet)     │
│    - Stores Claim state (`Pending` -> `Verified` or `Failed`)              │
│    - If score_bps < min_score_bps: Marks `Failed`, refunds DAO bond        │
│    - If score_bps >= min_score_bps: Marks `Verified`, triggers XCC         │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │ Cross-Contract Call (`add_proposal`)
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 4. SPUTNIK DAO V2 CONTRACT (`*.sputnikv2.testnet` — NEAR Testnet)          │
│    - Receives `Action::Transfer` proposal with SHA-256 hash in description │
│    - Council members verify hash & vote to execute milestone payout        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Smart Contract Specification (`contracts/polygraph-gate`)

### 2.1 Crate & Dependencies (`Cargo.toml`)

Use `near-sdk` version `5.5.0` (or compatible `5.x` release) with `serde` and `serde_json`:

```toml
[package]
name = "polygraph-gate"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
near-sdk = { version = "5.5.0", features = ["legacy"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[dev-dependencies]
near-sdk = { version = "5.5.0", features = ["unit-testing"] }
```

### 2.2 On-Chain State Structures (`src/lib.rs`)

```rust
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    env, ext_contract, log, near_bindgen, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

pub const MIN_PROPOSAL_BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR in yoctoNEAR
pub const GAS_FOR_ADD_PROPOSAL: Gas = Gas::from_tgas(30);
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum ClaimStatus {
    Pending,
    Verified,
    Failed,
    ProposalCreationFailed,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Claim {
    pub claim_id: u64,
    pub submitter: AccountId,
    pub dao_account: AccountId,
    pub recipient: AccountId,
    pub target_contract: String,
    pub start_block: u64,
    pub end_block: u64,
    pub min_score_bps: u16,
    pub requested_amount: U128,
    pub attached_bond: U128,
    pub status: ClaimStatus,
    pub score_bps: Option<u16>,
    pub raw_users: Option<u32>,
    pub effective_users: Option<u32>,
    pub evidence_hash: Option<String>,
    pub dao_proposal_id: Option<u64>,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct PolygraphGate {
    pub owner_id: AccountId,
    pub verifier_account: AccountId,
    pub next_claim_id: u64,
    pub claims: UnorderedMap<u64, Claim>,
}
```

### 2.3 Contract Methods & Access Control

1. **`#[init] pub fn new(verifier_account: AccountId) -> Self`**
   * Initializes `owner_id = env::predecessor_account_id()`, `verifier_account`, `next_claim_id = 0`, and an empty `UnorderedMap`.

2. **`#[payable] pub fn submit_claim(...) -> u64`**
   * **Parameters:**
     * `dao_account: AccountId`
     * `recipient: AccountId`
     * `target_contract: String`
     * `start_block: u64`
     * `end_block: u64`
     * `min_score_bps: u16`
     * `requested_amount: U128`
   * **Validation:**
     * Assert $0 < \text{min\_score\_bps} \le 10000$.
     * Assert $\text{start\_block} < \text{end\_block}$.
     * Assert `env::attached_deposit().as_yoctonear() >= MIN_PROPOSAL_BOND` ($10^{23}\text{ yoctoNEAR} = 0.1\text{ NEAR}$) so the contract holds the bond required to forward to Sputnik DAO if verified.
   * **Effect:** Stores `Claim` with `ClaimStatus::Pending`, increments `next_claim_id`, emits NEP-297 event `claim_submitted`, and returns `claim_id`.

3. **`pub fn attest(...) -> PromiseOrValue<bool>`**
   * **Parameters:**
     * `claim_id: u64`
     * `score_bps: u16`
     * `raw_users: u32`
     * `effective_users: u32`
     * `evidence_hash: String`
   * **Validation:**
     * Assert `env::predecessor_account_id() == self.verifier_account` (strict access control).
     * Assert `claim.status == ClaimStatus::Pending`.
     * Assert `score_bps <= 10000` and `evidence_hash.len() == 64` (valid hex $\text{SHA-256}$).
   * **Decision Branching:**
     * **Branch A ($\text{score\_bps} < \text{claim.min\_score\_bps}$):**
       * Updates `claim.status = ClaimStatus::Failed`, saves metrics and `evidence_hash`.
       * Refunds `claim.attached_bond` back to `claim.submitter` via `Promise::new(claim.submitter).transfer(...)`.
       * Emits NEP-297 event `claim_rejected` and returns `PromiseOrValue::Value(false)`.
     * **Branch B ($\text{score\_bps} \ge \text{claim.min\_score\_bps}$):**
       * Updates `claim.status = ClaimStatus::Verified`, saves metrics and `evidence_hash`.
       * Emits NEP-297 event `claim_verified`.
       * Initiates a cross-contract call to `claim.dao_account` calling `add_proposal` with `NearToken::from_yoctonear(claim.attached_bond.0)` and `GAS_FOR_ADD_PROPOSAL`, chained with `.then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_proposal_added(claim_id))`.

4. **`#[private] pub fn on_proposal_added(&mut self, claim_id: u64, #[callback_result] call_result: Result<u64, PromiseError>) -> bool`**
   * If `Ok(proposal_id)`: sets `claim.dao_proposal_id = Some(proposal_id)`, saves `claim`, logs `proposal_created`, returns `true`.
   * If `Err(_)`: sets `claim.status = ClaimStatus::ProposalCreationFailed` (keeps `evidence_hash` on-chain so the state remains auditable) and refunds `attached_bond` to `claim.submitter`, returns `false`.

5. **Read-Only View Methods:**
   * `pub fn get_claim(&self, claim_id: u64) -> Option<Claim>`
   * `pub fn list_claims(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Claim>`
   * `pub fn get_verifier(&self) -> AccountId`
   * `pub fn set_verifier(&mut self, new_verifier: AccountId)` (Restricted to `owner_id`).

---

## 3. Sputnik DAO v2 Cross-Contract Interface

Sputnik DAO v2 contracts expect the following JSON structure for `add_proposal`:

```rust
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalInput {
    pub description: String,
    pub kind: ProposalKind,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum ProposalKind {
    Transfer {
        token_id: String, // "" for native NEAR
        receiver_id: AccountId,
        amount: U128,
        msg: Option<String>,
    },
}

#[ext_contract(ext_sputnik_dao)]
pub trait SputnikDao {
    fn add_proposal(&mut self, proposal: ProposalInput) -> u64;
}
```

### 3.1 Formatted Proposal Description

When `polygraph-gate` calls `add_proposal`, it formats `description` deterministically so DAO council members and UI explorers can parse it:

```text
[POLYGRAPH VERIFIED MILESTONE] Claim #1 | Target: organic-dapp.near | Blocks: 131000000..131050000 | Organic Score: 8400 bps (42/50 users) | SHA256: <64_char_hex_hash>
```

### 3.2 Sputnik DAO Permission Prerequisite

In Sputnik DAO v2, an external contract (`polygraph-gate.testnet`) can call `add_proposal` if either:
1. The DAO policy grants the `all` role permission `*:AddProposal` or `transfer:AddProposal` (default on many Sputnik v2 test DAOs), **OR**
2. The DAO council adds `polygraph-gate.testnet` to a dedicated role `"Gate"` with permission `transfer:AddProposal`.

For the hackathon testnet deployment (`scripts/deploy-testnet.sh`), we also include a lightweight `mock-sputnik-dao` fallback mode or configure a real Sputnik v2 instance with `AddProposal` open to `polygraph-gate.testnet` and bond set to $0.1\text{ NEAR}$ ($10^{23}\text{ yoctoNEAR}$).

---

## 4. Off-Chain Verifier & Mathematical Formulation (`verifier/`)

### 4.1 Input Fixture / Snapshot Schema (`FixtureData`)

Both `--offline` mode (`fixtures/*.json`) and `--rpc` mode normalize contract telemetry into this exact TypeScript interface before running heuristics:

```typescript
export interface CallRecord {
  tx_hash: string;
  block_height: number;
  timestamp_sec: number;
  method_name: string;
  args_hash: string;       // SHA-256 or normalized string of method arguments
  deposit_yocto: string;
}

export interface CallerRecord {
  account_id: string;
  funder_account_id: string;        // Parent account that funded initial NEAR creation
  account_created_at_sec: number;   // Block timestamp of account creation
  first_call_at_sec: number;        // Timestamp of first call to target_contract
  total_contracts_called: number;   // Distinct contracts ever called by this account
  calls: CallRecord[];
}

export interface ContractActivitySnapshot {
  claim_id: number;
  target_contract: string;
  start_block: number;
  end_block: number;
  min_score_bps: number;
  known_exchange_funders: string[]; // Allowlist (e.g., ["binancecold3.near", "okx.near", "testnet"])
  callers: CallerRecord[];
}
```

### 4.2 Mathematical Definition of the 3 Sybil Heuristics

Let $U = \{u_1, u_2, \dots, u_N\}$ be the set of unique caller accounts interacting with `target_contract` within block window $[B_{\text{start}}, B_{\text{end}}]$, where $N_{\text{raw}} = |U|$.

#### Heuristic 1 ($H_1$ — Funder Clustering)
Let $f(u)$ be the parent `funder_account_id` of caller $u$, and let $E_{\text{allow}}$ be the allowlist of known exchange/faucet accounts (`known_exchange_funders`).
For every funder $f \notin E_{\text{allow}}$, define the cluster of callers funded by $f$:
$$C_f = \{ u \in U \mid f(u) = f \}$$
If $|C_f| \ge 3$ (three or more callers funded by the same non-exchange parent wallet):
* Sort the accounts in $C_f$ lexicographically: $(u_{(1)}, u_{(2)}, \dots, u_{(k)})$.
* Retain $u_{(1)}$ as the single representative entity for that funder, and flag all remaining $|C_f| - 1$ accounts $\{u_{(2)}, \dots, u_{(k)}\}$ as redundant Sybil clones:
$$S_{H_1} = \bigcup_{\substack{f \notin E_{\text{allow}} \\ |C_f| \ge 3}} \{ u_{(2)}, \dots, u_{(|C_f|)} \}$$

#### Heuristic 2 ($H_2$ — Ephemeral / Burner Accounts)
A caller $u \in U$ is flagged as a single-purpose burner account if it was created within $3600\text{ seconds}$ ($1\text{ hour}$) prior to its first call to `target_contract` **and** has never interacted with any other contract on NEAR ($\text{total\_contracts\_called}(u) = 1$):
$$S_{H_2} = \{ u \in U \mid (t_{\text{first\_call}}(u) - t_{\text{created}}(u)) \le 3600 \;\land\; \text{total\_contracts\_called}(u) = 1 \}$$

#### Heuristic 3 ($H_3$ — Payload & Temporal Uniformity)
Define the primary call signature of caller $u$ as the tuple of their first call's method, argument digest, and attached deposit:
$$\text{sig}(u) = (\text{method\_name}_1(u), \text{args\_hash}_1(u), \text{deposit\_yocto}_1(u))$$
 additionally, for any caller with $m \ge 3$ calls at ordered timestamps $t_1 < t_2 < \dots < t_m$, let $\Delta t_i = t_{i+1} - t_i$ and let $\sigma_{\Delta t}(u)$ be the population standard deviation of $\{\Delta t_1, \dots, \Delta t_{m-1}\}$:
$$\mu_{\Delta t} = \frac{1}{m-1}\sum_{i=1}^{m-1} \Delta t_i, \quad \sigma_{\Delta t}(u) = \sqrt{\frac{1}{m-1}\sum_{i=1}^{m-1} (\Delta t_i - \mu_{\Delta t})^2}$$
A caller $u \in U$ is flagged for robotic uniformity if **either**:
1. They belong to a batch of $\ge 8$ callers sharing an identical non-empty `args_hash` and `deposit_yocto` within the same $300\text{-second}$ window, **or**
2. They execute $m \ge 3$ calls with robotic periodicity $\sigma_{\Delta t}(u) \le 2.0\text{ seconds}$.

Let $S_{H_3}$ be the set of callers satisfying condition (1) or (2).

#### Combined Effective Organic Score ($S_{\text{bps}}$)
The combined set of discounted Sybil/manipulated accounts is the union across all three heuristics:
$$U_{\text{sybil}} = S_{H_1} \cup S_{H_2} \cup S_{H_3}$$
The number of effective organic users is:
$$N_{\text{eff}} = |U \setminus U_{\text{sybil}}| = N_{\text{raw}} - |U_{\text{sybil}}|$$
The final Organic Score in basis points ($100\text{ bps} = 1.00\%$) is:
$$S_{\text{bps}} = \begin{cases} 0 & \text{if } N_{\text{raw}} = 0 \\ \left\lfloor \dfrac{N_{\text{eff}}}{N_{\text{raw}}} \times 10000 \right\rfloor & \text{if } N_{\text{raw}} > 0 \end{cases}$$

---

## 5. Canonical JSON Report & SHA-256 Hashing (`canonical.ts`)

To guarantee that any DAO council member or automated judge running `verifier` on Linux, macOS, or Windows produces the **exact same `evidence_hash`**, the report object must follow this structure and canonicalization algorithm:

### 5.1 Canonical Evidence Report Schema

```typescript
export interface CanonicalEvidenceReport {
  schema_version: "polygraph-evidence-v1";
  claim_id: number;
  target_contract: string;
  block_window: {
    start_block: number;
    end_block: number;
  };
  thresholds: {
    min_score_bps: number;
  };
  metrics: {
    raw_users: number;
    effective_organic_users: number;
    sybil_discounted_users: number;
    score_bps: number;
    verdict: "VERIFIED" | "REJECTED";
  };
  heuristic_breakdown: {
    h1_funder_clusters: Array<{
      funder_account_id: string;
      total_funded_callers: number;
      retained_account: string;
      discounted_accounts: string[];
    }>;
    h2_ephemeral_burners: string[];
    h3_uniformity_flagged: string[];
  };
  flagged_accounts: Array<{
    account_id: string;
    reasons: Array<"H1_FUNDER_CLUSTER" | "H2_EPHEMERAL_BURNER" | "H3_ROBOTIC_UNIFORMITY">;
  }>;
}
```

### 5.2 Deterministic Hashing Algorithm

1. Sort all string arrays (`discounted_accounts`, `h2_ephemeral_burners`, `h3_uniformity_flagged`, `reasons`) lexicographically (`Array.prototype.sort()`).
2. Sort `h1_funder_clusters` by `funder_account_id` and `flagged_accounts` by `account_id`.
3. Recursively sort all object keys lexicographically at every nesting level.
4. Serialize the sorted object using `JSON.stringify(sortedObj)` with **no whitespace** (compact canonical form).
5. Compute the $\text{SHA-256}$ digest of the UTF-8 string using Node's built-in `crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex')`.

---

## 6. Read-Only Evidence Explorer (`web/`)

To maximize reliability and speed within the hackathon window:

* **Stack:** Vite + React + TypeScript + Tailwind CSS (or clean modern CSS variables).
* **Zero Wallet Dependency:** Do not import `@near-wallet-selector`.
* **Data Sources:**
  1. Loads the pre-generated canonical evidence JSON reports from `/reports/sybil-report.json` and `/reports/organic-report.json` (generated by `verifier`).
  2. Performs a live JSON-RPC `query` (`call_function` -> `list_claims`) to `https://rpc.testnet.near.org` to display the live on-chain state of `polygraph-gate` on NEAR Testnet (with graceful fallback to the local snapshot if the viewer is offline).
* **Core UI Panels:**
  1. **Claim Switcher:** Toggle between **Claim #0 (`sybil-dex.near` — Blocked / $1800\text{ bps}$)** and **Claim #1 (`organic-dapp.near` — Verified / $8400\text{ bps}$)**.
  2. **Organic Traction Scorecard:** Visual progress bar comparing `score_bps` against `min_score_bps` ($7000\text{ bps}$), raw vs. effective users ($50 \rightarrow 9$ vs. $50 \rightarrow 42$).
  3. **Sybil Interrogation Breakdown ($H_1, H_2, H_3$):** Visual cluster cards showing which parent wallet funded multiple bot accounts and why specific accounts were discounted.
  4. **On-Chain Proof & Re-Run Drawer:** Displays the 64-character $\text{SHA-256}$ `evidence_hash`, the Sputnik DAO proposal status (`Blocked` vs. `Proposal #ID Created`), and a copyable one-line CLI command for council members to re-verify the hash locally.