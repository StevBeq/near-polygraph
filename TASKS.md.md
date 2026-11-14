# TASKS.md — Sequential Implementation Checklist for `near-polygraph`

Execute these phases strictly in order. Do **not** skip ahead to the next phase until the **Verification Gate** command for the current phase exits with code $0$.

---

## Phase 0: Workspace Scaffolding & License (10 mins)

- [x] **0.1.** Create the directory structure inside `near-polygraph/`:
  - `contracts/polygraph-gate/src`
  - `verifier/src`
  - `fixtures`
  - `web/src`
  - ` web/public/reports`
  - `scripts`
- [x] **0.2.** Create `LICENSE` (MIT License, required by Hackathon Rule Q-014).
- [x] **0.3.** Create `.gitignore` excluding `node_modules/`, `target/`, `dist/`, `.env`, `*.pem`, and `neardev/`.

**Verification Gate 0:**
```bash
ls -la LICENSE .gitignore contracts/polygraph-gate verifier fixtures web scripts
```

---

## Phase 1: Rust Smart Contract — `contracts/polygraph-gate` (90 mins)

- [x] **1.1.** Create `contracts/polygraph-gate/Cargo.toml` as specified in `ARCHITECTURE.md` Section 2.1 (`near-sdk = "5.5.0"`).
- [x] **1.2.** Implement `contracts/polygraph-gate/src/lib.rs`:
  - Define `ClaimStatus` (`Pending`, `Verified`, `Failed`, `ProposalCreationFailed`) and `Claim` struct.
  - Define `ProposalInput` and `ProposalKind::Transfer` matching Sputnik DAO v2 (`ext_sputnik_dao`).
  - Implement `new(verifier_account: AccountId) -> Self`.
  - Implement `#[payable] pub fn submit_claim(...) -> u64` requiring attached deposit $\ge 10^{23}\text{ yoctoNEAR}$ ($0.1\text{ NEAR}$).
  - Implement `pub fn attest(...) -> PromiseOrValue<bool>` restricted strictly to `self.verifier_account`:
    - If $\text{score\_bps} < \text{min\_score\_bps}$: set status to `Failed`, refund attached bond to `claim.submitter`, emit NEP-297 log `EVENT_JSON:{"standard":"polygraph","version":"1.0.0","event":"claim_rejected",...}`.
    - If $\text{score\_bps} \ge \text{min\_score\_bps}$: set status to `Verified`, emit NEP-297 log `claim_verified`, and invoke `ext_sputnik_dao::ext(claim.dao_account)` with `add_proposal` and callback `on_proposal_added`.
  - Implement `#[private] pub fn on_proposal_added(...)` handling `Ok(proposal_id)` and `Err(_)` (setting `ProposalCreationFailed` and refunding bond on error).
  - Implement view methods: `get_claim`, `list_claims`, `get_verifier`, `set_verifier`.
- [x] **1.3.** Write comprehensive unit tests inside `contracts/polygraph-gate/src/lib.rs` (`#[cfg(test)] mod tests`):
  - `test_submit_claim_requires_min_bond`: Panics if deposit $< 0.1\text{ NEAR}$.
  - `test_unauthorized_attest_panics`: Panics if caller $\ne \text{verifier\_account}$.
  - `test_sybil_claim_rejected`: Submitting a claim with $S_{\min} = 7000\text{ bps}$ and attesting $S = 1800\text{ bps}$ transitions status to `ClaimStatus::Failed`.
  - `test_organic_claim_verified`: Submitting a claim with $S_{\min} = 7000\text{ bps}$ and attesting $S = 8400\text{ bps}$ transitions status to `ClaimStatus::Verified` and attaches the 64-char `evidence_hash`.

**Verification Gate 1:**
```bash
cd contracts/polygraph-gate && cargo test -- --nocapture
```

---

## Phase 2: Deterministic Mainnet Fixtures — `fixtures/` (45 mins)

Create two deterministic, realistic contract telemetry snapshots conforming to `ContractActivitySnapshot` in `ARCHITECTURE.md` Section 4.1:

- [x] **2.1.** Create `fixtures/sybil-contract.json` (`claim_id: 0`, `target_contract: "sybil-dex.near"`, `start_block: 131000000`, `end_block: 131050000`, `min_score_bps: 7000`):
  - Total unique callers: $N_{\text{raw}} = 50$.
  - Configure callers so that:
    - $22$ accounts are funded by `"bot-master-alpha.near"` ($H_1$ retains $1$, discounts $21$).
    - $15$ accounts are funded by `"sybil-faucet-99.near"` ($H_1$ retains $1$, discounts $14$).
    - $6$ additional accounts are ephemeral burners ($\Delta t \le 600\text{ seconds}$, $\text{total\_contracts\_called} = 1$, triggering $H_2$) or exhibit robotic periodicity ($\sigma_{\Delta t} \le 2.0\text{ seconds}$, triggering $H_3$).
    - Exactly $9$ callers remain as effective organic users ($N_{\text{eff}} = 9$, $S_{\text{bps}} = 1800\text{ bps} < 7000\text{ bps} \rightarrow \text{REJECTED}$).
- [x] **2.2.** Create `fixtures/organic-contract.json` (`claim_id: 1`, `target_contract: "organic-dapp.near"`, `start_block: 131000000`, `end_block: 131050000`, `min_score_bps: 7000`):
  - Total unique callers: $N_{\text{raw}} = 50$.
  - Include callers funded by allowlisted exchanges (`"binancecold3.near"`, `"okx.near"`) to prove the exchange allowlist prevents false positives under $H_1$.
  - Include $8$ discounted accounts across $H_1, H_2, H_3$ so that $N_{\text{eff}} = 42$ ($S_{\text{bps}} = 8400\text{ bps} \ge 7000\text{ bps} \rightarrow \text{VERIFIED}$).

**Verification Gate 2:**
```bash
node -e "
const s = require('./fixtures/sybil-contract.json');
const o = require('./fixtures/organic-contract.json');
if (s.callers.length !== 50 || o.callers.length !== 50) process.exit(1);
console.log('Fixtures valid: 50 callers each.');
"
```

---

## Phase 3: Off-Chain TypeScript Verifier CLI — `verifier/` (90 mins)

- [x] **3.1.** Initialize `verifier/package.json` and `verifier/tsconfig.json` (`typescript`, `tsx`, `@types/node`).
- [x] **3.2.** Implement `verifier/src/heuristics.ts`:
  - Exact mathematical evaluation of $H_1$ (Funder Clustering with exchange allowlist), $H_2$ (Ephemeral Burners with $\Delta t \le 3600\text{ s}$ and $\text{total\_contracts\_called} = 1$), and $H_3$ (Payload batching $\ge 8$ callers or $\sigma_{\Delta t} \le 2.0\text{ s}$).
  - Compute $N_{\text{raw}}$, $N_{\text{eff}}$, and $S_{\text{bps}} = \lfloor (N_{\text{eff}} / N_{\text{raw}}) \times 10000 \rfloor$.
- [x] **3.3.** Implement `verifier/src/canonical.ts`:
  - Recursively sort all object keys and string arrays lexicographically.
  - Compute `evidence_hash` using `crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex')`.
- [x] **3.4.** Implement `verifier/src/rpc.ts`:
  - Read-only fetcher querying NEAR Mainnet RPC / FastNEAR / Pikespeak or archival endpoint for a target contract and block window, normalizing output into `ContractActivitySnapshot`.
- [x] **3.5.** Implement `verifier/src/index.ts` CLI entrypoint:
  - Support `--offline --fixture <path> [--out <report.json>]`
  - Support `--rpc --contract <account> --start-block <n> --end-block <n> --min-score <bps>`
  - Print a structured summary table (`raw_users`, `effective_organic_users`, `score_bps`, `verdict`, `evidence_hash`, and the exact `near call ... attest` command).
  - Automatically write `/web/public/reports/sybil-report.json` and `/web/public/reports/organic-report.json` when `--out` is passed.

**Verification Gate 3 (Must Match Exact Expected Scores):**
```bash
cd verifier && npm install
npm run verify -- --offline --fixture ../fixtures/sybil-contract.json --out ../web/public/reports/sybil-report.json
npm run verify -- --offline --fixture ../fixtures/organic-contract.json --out ../web/public/reports/organic-report.json
```

---

## Phase 4: Read-Only Evidence Explorer — `web/` (90 mins)

- [x] **4.1.** Scaffold Vite + React + TypeScript in `web/` (no wallet selector dependencies).
- [x] **4.2.** Build the Evidence Explorer UI in `web/src/App.tsx`:
  - **Header:** Polygraph branding, network badge (`Mainnet Telemetry -> Testnet Sputnik DAO Gate`), and live RPC connection status.
  - **Claim Selector Tabs:**
    - Tab 1: **Claim #0 — `sybil-dex.near`** (`REJECTED` | $1800\text{ bps}$ vs. $7000\text{ bps}$ threshold).
    - Tab 2: **Claim #1 — `organic-dapp.near`** (`VERIFIED` | $8400\text{ bps}$ vs. $7000\text{ bps}$ threshold).
  - **Metric Cards:** Raw Callers ($N_{\text{raw}}$), Sybil Discounted ($\vert{}U_{\text{sybil}}\vert{}$), Effective Organic Users ($N_{\text{eff}}$), and Final Organic Score ($S_{\text{bps}}$).
  - **Heuristic Interrogation Breakdown:**
    - $H_1$ Funder Cluster cards showing parent funder wallet, total funded bots, retained account, and discounted clones.
    - $H_2$ Ephemeral Burner list and $H_3$ Robotic Uniformity flags.
  - **Sputnik DAO Gate & Cryptographic Proof Panel:**
    - Displays the 64-char $\text{SHA-256}$ `evidence_hash`, block window $[B_{\text{start}}, B_{\text{end}}]$, Sputnik DAO proposal outcome (`Proposal Blocked & Bond Refunded` vs. `Sputnik DAO Transfer Proposal Created`), and the one-line `npm run verify` command for council members to reproduce the hash locally.
  - **Live Testnet RPC Query:** Fetch `list_claims` from `https://rpc.testnet.near.org` if `VITE_GATE_CONTRACT_ID` is configured, falling back cleanly to the generated report JSONs.

**Verification Gate 4:**
```bash
cd web && npm install && npm run build
```

---

## Phase 5: Testnet Deployment & Reproducible Demo Scripts — `scripts/` (60 mins)

- [x] **5.1.** Create `scripts/deploy-testnet.sh`:
  - Compiles `contracts/polygraph-gate` to WebAssembly (`cargo near build` or `cargo build --target wasm32-unknown-unknown --release`).
  - Deploys to a NEAR Testnet subaccount or dev account and calls `new({"verifier_account": "<verifier.testnet>"})`.
- [x] **5.2.** Create `scripts/run-demo.sh`:
  - Submits Claim #0 (`sybil-dex.near`, $S_{\min} = 7000$) with $0.1\text{ NEAR}$ deposit.
  - Runs the verifier CLI on `fixtures/sybil-contract.json` and calls `attest` with $S = 1800\text{ bps}$ -> shows on-chain status `Failed`.
  - Submits Claim #1 (`organic-dapp.near`, $S_{\min} = 7000$) with $0.1\text{ NEAR}$ deposit.
  - Runs the verifier CLI on `fixtures/organic-contract.json` and calls `attest` with $S = 8400\text{ bps}$ -> shows on-chain status `Verified` and triggers the cross-contract `add_proposal` call.

**Verification Gate 5:**
```bash
bash -n scripts/deploy-testnet.sh && bash -n scripts/run-demo.sh
```

---

## Phase 6: Judge-Ready `README.md` (30 mins)

- [x] **6.1.** Write `README.md` optimized for both **Claude Code / Codex** automated screening (Q-017) and human judges:
  1. **Problem & What Polygraph Does** (3-sentence executive summary).
  2. **How Polygraph Differs** (Explicit comparison table vs. `Headcount` and `CommonsOps`).
  3. **Quickstart: "Do X — See Y" in 4 Commands** (Exact commands from `PRD.md` Section 7 with expected terminal output and $\text{SHA-256}$ hashes).
  4. **Architecture & Heuristic Math** ($H_1, H_2, H_3$ summary + Off-chain Mainnet Analysis -> On-chain Testnet Sputnik DAO Gate diagram).
  5. **Testnet Deployment Details** (Contract Account ID, Sputnik DAO Target ID, Example Transaction Hashes).
  6. **Honest Trust Assumptions & Limitations** (Trusted attester mitigated by reproducible block-pinned $\text{SHA-256}$ hashes; exchange allowlist for $H_1$; Mainnet data vs. Testnet execution).
  7. **Hackathon Window Disclosure** (Confirming $100\%$ of code was written within the hackathon window).