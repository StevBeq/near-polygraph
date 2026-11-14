# PRD.md — Product Requirements & MVP Scope Lock for `near-polygraph`

## 1. Problem Statement & Urgency

Ecosystem treasuries and DAOs on NEAR (powered by **Sputnik DAO** and **Trezu**) disburse millions of dollars in milestone-based grants. However, milestone verification is fundamentally broken:

1. **Screenshot & Vanity Metric Fraud:** Grantees claim *"Our contract `app.near` reached $500$ active users this month!"* and attach easily spoofed charts or raw transaction counts inflated by their own bot scripts.
2. **Council Audit Fatigue:** DAO council members do not have the time or tooling to inspect funding graphs, account creation timestamps, and call uniformity in raw archival RPC data before voting on a payout proposal.
3. **Passive Analytics:** Existing on-chain dashboards show historical wash-trading *after* the treasury money is gone, with zero enforcement power over the DAO payout pipeline.

## 2. The Solution: Polygraph

**Polygraph** is an **on-chain evidence gate for Sputnik DAO milestone payouts**. Instead of allowing grantees to submit unverified payout proposals directly to the DAO council, grantees submit a **traction claim** to the `polygraph-gate` smart contract specifying their target contract, a pinned block window $[B_{\text{start}}, B_{\text{end}}]$, and a required minimum organic score $S_{\min}$.

An off-chain deterministic verifier inspects the target contract's historical interactions, applies three Sybil-detection heuristics, generates a canonical JSON evidence report with a cryptographic digest ($\text{SHA-256}$), and attests the result back to `polygraph-gate`.

* **If Verified ($S \ge S_{\min}$):** `polygraph-gate` automatically executes a cross-contract call `add_proposal` (`Action::Transfer`) to the **Sputnik DAO** contract, embedding the $\text{SHA-256}$ evidence hash and report link directly into the DAO proposal description for council voting.
* **If Rejected ($S < S_{\min}$):** `polygraph-gate` marks the claim as `Failed`, blocks the proposal from ever reaching the Sputnik DAO queue, and records the Sybil evidence hash on-chain.

## 3. Honest Differentiation vs. Existing Projects

| Project | What It Audits | How Polygraph Differs |
| :--- | :--- | :--- |
| **Headcount** | Audits a list of **recipient wallets** in a batch payout to see if $40$ listed contributors are secretly controlled by $1$ person. | **Polygraph** audits a single grantee's **deployed smart contract traction claim** (whether the users interacting with `target_contract.near` are real users or a Sybil farm) before unlocking a milestone grant. |
| **CommonsOps** | General operations and proof-of-delivery workflow for community tasks. | **Polygraph** specifically computes deterministic on-chain Sybil heuristics ($H_1, H_2, H_3$) over pinned block windows and acts as an automated programmatic `add_proposal` gate for **Sputnik DAO**. |
| **Patch Fund / Proof of Ship** | Verifies off-chain GitHub PR merges or repository releases. | **Polygraph** verifies **on-chain usage quality and organic retention**, directly tying the `thesis` track (measuring real vs. bot activity on NEAR) to `social` and `security` enforcement. |

## 4. Target Hackathon Tracks

1. **`social` (Social Money — Core):** Builds programmable milestone enforcement directly on top of **Sputnik DAO** without reinventing the multisig—council members retain final voting power, while Polygraph filters out fraudulent milestone claims before they clutter the governance queue.
2. **`security` (AI Security & Defense — Core):** Protects DAO treasuries and autonomous grant agents from Sybil manipulation and wash-traded metrics via deterministic pre-proposal verification gates.
3. **`thesis` (Investment Thesis — Data Layer):** Answers a fundamental capital-allocation thesis for NEAR: *"Do ecosystem grants generate durable organic users or temporary Sybil spikes?"* using a reproducible, block-pinned verification model anyone can re-run.

## 5. Strict MVP Scope Lock (18-Hour Build Window)

### In-Scope (MUST Build)

* **1 Smart Contract (`contracts/polygraph-gate` in Rust):**
  * Stores milestone traction claims (`ClaimStatus`: `Pending`, `Verified`, `Failed`).
  * Exposes `submit_claim(...)`, `attest(...)` (restricted to `verifier_account`), and read methods `get_claim(claim_id)` and `list_claims()`.
  * Executes cross-contract `add_proposal` (`Action::Transfer`) on a real **Sputnik DAO v2** contract on NEAR Testnet when `score_bps >= min_score_bps`.
* **1 Deterministic Off-Chain Verifier CLI (`verifier/` in TypeScript):**
  * Supports `--offline --fixture <path>` (zero-config mode for automated AI judges) and `--rpc` (live NEAR Mainnet read-only mode).
  * Evaluates exactly 3 Sybil heuristics:
    1. $H_1$ (**Funder Clustering**): Collapses multiple caller accounts funded by the same parent wallet into $1$ effective user.
    2. $H_2$ (**Burner / Ephemeral Accounts**): Flags accounts created within $\Delta t \le 3600\text{ seconds}$ of their first call that only ever interact with `target_contract`.
    3. $H_3$ (**Temporal & Payload Uniformity**): Flags callers with identical method arguments/deposits or robotic inter-transaction intervals.
  * Outputs a canonical JSON file (sorted keys, deterministic formatting) and its $\text{SHA-256}$ hex digest.
* **2 Realistic Fixtures (`fixtures/`):**
  * `organic-contract.json`: Snapshot of genuine multi-user contract activity ($S = 8400\text{ bps}$ / $84.0\%$, **PASSES** threshold $S_{\min} = 7000\text{ bps}$).
  * `sybil-contract.json`: Snapshot of a wash-traded grant milestone where $50$ callers are funded by $2$ wallets ($S = 1800\text{ bps}$ / $18.0\%$, **FAILS** threshold $S_{\min} = 7000\text{ bps}$).
* **1 Read-Only Web Evidence Explorer (`web/`):**
  * Single-page dashboard (no wallet login required) that loads the canonical evidence report and queries `polygraph-gate` on NEAR Testnet via public RPC.
  * Displays the Organic Score gauge, Funder Cluster breakdown, flagged Sybil accounts, the $\text{SHA-256}$ verification command, and the resulting Sputnik DAO proposal status.

### Out-of-Scope (DO NOT Build)

* **NO** `@near-wallet-selector` or browser wallet popups in the frontend.
* **NO** zero-knowledge proofs (ZK) or custom indexers; use deterministic $\text{SHA-256}$ canonical report hashing so any observer can re-run the CLI on the same block range and verify the exact hash.
* **NO** bypassing Sputnik DAO governance; Polygraph creates the `Transfer` proposal, and the DAO council still votes to approve execution.
* **NO** more than 1 claim schema; focus 100% on **Contract Organic Traction Claims**.

## 6. End-to-End User & System Flow

```
[1. Grantee]
   │ Calls `submit_claim(dao_account, recipient, target_contract, start_block, end_block, min_score_bps, requested_amount)`
   ▼
[2. Polygraph Gate Contract (NEAR Testnet)]
   │ Saves Claim #id with status = Pending (holds attached proposal bond)
   ▼
[3. Polygraph Verifier CLI (TypeScript Off-Chain)]
   │ Fetches transactions for `target_contract` in [start_block, end_block] (Mainnet RPC or Offline Fixture)
   │ Computes H1 (Funder Clusters), H2 (Burners), H3 (Uniformity) -> score_bps + canonical JSON + SHA-256 hash
   │ Calls `attest(claim_id, score_bps, effective_users, raw_users, evidence_hash)` on Gate Contract
   ▼
[4. Polygraph Gate Contract Decision]
   ├── If score_bps < min_score_bps:
   │     Status -> Failed. Proposal is BLOCKED. Bond refunded to Grantee.
   └── If score_bps >= min_score_bps:
         Status -> Verified.
         Cross-contract call -> `sputnik-dao.testnet::add_proposal({ Transfer, description: "...SHA-256..." })`
```

## 7. Machine-Readable "Do X — See Y" Verification Criteria (For AI Judges)

The final build and `README.md` must guarantee that automated screening agents (Claude Code / Codex) can run these exact 4 steps locally without credentials:

1. **Do Step 1 (Run Smart Contract Unit Tests):**
   * Run: `cd contracts/polygraph-gate && cargo test`
   * **See:** All unit tests pass, proving:
     * Unauthorized accounts cannot call `attest`.
     * A claim with $S = 1800 < 7000$ transitions to `Failed` and emits no DAO proposal.
     * A claim with $S = 8400 \ge 7000$ transitions to `Verified` and constructs the Sputnik DAO `add_proposal` payload.
2. **Do Step 2 (Verify a Sybil-Manipulated Milestone Offline):**
   * Run: `cd verifier && npm run verify -- --offline --fixture ../fixtures/sybil-contract.json`
   * **See:** CLI outputs `raw_users: 50`, `effective_organic_users: 9`, `score_bps: 1800` ($18.0\%$), verdict `REJECTED (Below 7000 bps threshold)`, and prints a deterministic $\text{SHA-256}$ hash.
3. **Do Step 3 (Verify an Organic Milestone Offline):**
   * Run: `cd verifier && npm run verify -- --offline --fixture ../fixtures/organic-contract.json`
   * **See:** CLI outputs `raw_users: 50`, `effective_organic_users: 42`, `score_bps: 8400` ($84.0\%$), verdict `VERIFIED (Meets 7000 bps threshold)`, and prints a deterministic $\text{SHA-256}$ hash.
4. **Do Step 4 (Inspect Live Testnet State & Evidence Dashboard):**
   * Run: `cd web && npm run dev` (or open deployed URL)
   * **See:** Side-by-side comparison of Claim #0 (`Failed` / Blocked Sybil Farm) vs. Claim #1 (`Verified` / Forwarded to Sputnik DAO Testnet with matching on-chain `evidence_hash`).

## 8. Explicit Trust Assumptions & Limitations (Must State in README)

1. **Trusted Attester with Public Reproducibility:** In this MVP, `polygraph-gate` trusts the designated `verifier_account` to submit `attest(...)`. To mitigate centralization, every attestation commits an immutable `evidence_hash` ($\text{SHA-256}$) and pinned block window $[B_{\text{start}}, B_{\text{end}}]$ on-chain. Any DAO council member can re-run the open-source CLI against that block window to verify the exact hash before voting `Approve` in Sputnik DAO.
2. **Heuristic False Positives:** Centralized exchange (CEX) hot wallets that fund multiple real users can trigger Heuristic $H_1$ (Funder Clustering). The verifier maintains a configurable allowlist of known NEAR exchange/faucet accounts (`binancecold3.near`, `testnet`, etc.) so legitimate users funded via exchanges are not penalized as Sybil clones.
3. **Mainnet Data, Testnet Execution:** Because real Sybil and wash-trading patterns exist on **NEAR Mainnet**, the analytical engine inspects Mainnet contract telemetry (read-only), while the `polygraph-gate` contract and **Sputnik DAO** proposal execution run on **NEAR Testnet** (per Hackathon Rule Q-010).