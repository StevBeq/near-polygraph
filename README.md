# Polygraph (`near-polygraph`)

> **Evidence-gated milestone security protocol for Sputnik DAO v2 on NEAR.** Interrogates a grantee's claimed target smart contract traction for Sybil farms, ephemeral burner wallets, and wash-trading uniformity *before* allowing an on-chain payout proposal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NEAR Testnet](https://img.shields.io/badge/NEAR-testnet-00EC97)](https://testnet.nearblocks.io/address/polygraph-gate-v1.testnet)
[![Sputnik DAO v2](https://img.shields.io/badge/Sputnik%20DAO%20v2-polygraph--dao--v1.sputnikv2.testnet-38bdf8)](https://testnet.nearblocks.io/address/polygraph-dao-v1.sputnikv2.testnet)

**Target Hackathon Tracks:** `social` · `security` · `thesis`

---

## 1. Problem & Executive Summary

Grant DAOs on NEAR frequently receive milestone payout requests claiming *"Our deployed contract reached N organic active users"*, yet Sputnik DAO council members lack an automated, reproducible way to verify whether those callers were genuine humans or a single Sybil operator running dozens of funded burner accounts.

**Polygraph** inserts an evidence-gated smart contract (`polygraph-gate`) in front of Sputnik DAO `add_proposal`. A deterministic off-chain verifier inspects contract telemetry across a pinned block window $[B_{\text{start}}, B_{\text{end}}]$ using three heuristic tests ($H_1, H_2, H_3$), serializes a sorted canonical JSON report into a reproducible $\text{SHA-256}$ `evidence_hash`, and attests the score on-chain—automatically blocking Sybil-dominated claims while forwarding verified claims (with the $\text{SHA-256}$ hash attached) to Sputnik DAO council voting.

---

## 2. How Polygraph Differs

| Project | Audit Target | Mechanism | Role in Governance |
| :--- | :--- | :--- | :--- |
| **Headcount** | List of **payout recipient wallets** | Checks if multiple grant recipients belong to one entity | Deduplicates grant applicants |
| **CommonsOps** | Contributor **off-chain PR / ops work** | Records verifiable work artifacts for payouts | Operational accountability |
| **Polygraph (`near-polygraph`)** | **Grantee's deployed target smart contract traction** (`target_contract` in $[B_{\text{start}}, B_{\text{end}}]$) | Applies $H_1$ Funder Clustering, $H_2$ Ephemeral Burners, and $H_3$ Uniformity with deterministic $\text{SHA-256}$ attestation | Pre-proposal security gate blocking spam `Action::Transfer` proposals without replacing DAO council voting |

---

## 3. Architecture

```text
  Grantee Team                    Polygraph Gate Contract                Sputnik DAO v2
 (polygraph-grantee-v1.testnet)  (polygraph-gate-v1.testnet)        (polygraph-dao-v1.sputnikv2.testnet)
       |                                    |                                        |
       | 1. submit_claim(dao, target,       |                                        |
       |    blocks, min_score=7000)         |                                        |
       |    + >= 0.1 NEAR bond              |                                        |
       +----------------------------------->| [Status: Pending]                      |
                                            |                                        |
  Off-Chain Verifier CLI (verifier/)        |                                        |
  - Mainnet Telemetry (read-only RPC /      |                                        |
    deterministic snapshot)                 |                                        |
  - Heuristics: H1, H2, H3                  |                                        |
  - Canonical Key-Sorted JSON -> SHA-256    |                                        |
       |                                    |                                        |
       | 2. attest(claim_id, score_bps,     |                                        |
       |    raw, eff, evidence_hash)        |                                        |
       |    [Authorized verifier_account]   |                                        |
       +----------------------------------->|                                        |
                                            |-- score < min_score (1800 < 7000) ---> | [Claim #0 Blocked]
                                            |   Status = Failed, Refund 0.1 NEAR     | NO proposal added
                                            |                                        |
                                            |-- score >= min_score (8400 >= 7000) -> | [Claim #1 Passed]
                                            |   add_proposal(Transfer, SHA-256) ---->| Proposal #1 Created
                                            |   <-- callback: on_proposal_added() ---| (InProgress for Council Vote)
```

### Mathematical Formulation ($H_1, H_2, H_3$)

1. **$H_1$ — Funder Clustering:** For every `funder_account_id` not in `known_exchange_funders` (`binancecold3.near`, `okx.near`, `testnet`) that funded $|C_f| \ge 3$ callers, sort accounts lexicographically, retain the first representative $u_{(1)}$, and discount the remaining $|C_f| - 1$ clones (`H1_FUNDER_CLUSTER`).
2. **$H_2$ — Ephemeral / Burner Accounts:** Flag callers created $\le 3600\text{ seconds}$ prior to their first call to `target_contract` whose total lifetime contract count is `total_contracts_called == 1` (`H2_EPHEMERAL_BURNER`).
3. **$H_3$ — Payload & Temporal Uniformity:** Flag callers belonging to a batch of $\ge 8$ distinct accounts submitting identical non-empty `args_hash` + `deposit_yocto` within a $300\text{ s}$ window, **or** executing $m \ge 3$ calls with inter-arrival population standard deviation $\sigma_{\Delta t} \le 2.0\text{ s}$ (`H3_ROBOTIC_UNIFORMITY`).
4. **Effective Organic Score:**
   $$U_{\text{sybil}} = S_{H_1} \cup S_{H_2} \cup S_{H_3}, \qquad N_{\text{eff}} = N_{\text{raw}} - |U_{\text{sybil}}|, \qquad S_{\text{bps}} = \left\lfloor \frac{N_{\text{eff}}}{N_{\text{raw}}} \times 10000 \right\rfloor$$

---

## 4. Reproducible "Do X → See Y" Verification Steps

Every command below is run from the repository root (`near-polygraph/`) and requires **zero API keys** for offline and Testnet RPC checks.

### Test 1 — Offline Verifier: Sybil Claim Blocked (`1800 bps < 7000 bps`)

```bash
cd verifier && npm install && npm run verify -- --offline --fixture ../fixtures/sybil-contract.json --out ../web/public/reports/sybil-report.json
```

*Cross-shell note (PowerShell 5/7):* PowerShell strips standalone `--` in `npm run ... -- ...`; run `npx tsx src/index.ts --offline --fixture ../fixtures/sybil-contract.json --out ../web/public/reports/sybil-report.json` in PowerShell or Git Bash.

**Expected Output (`exit 0`, deterministic across repeated runs):**
```text
Raw Callers      : 50
Effective Organic: 9
Sybil Discounted : 41
Organic Score    : 1800 bps (18.00%)
DAO Threshold    : 7000 bps
Verdict          : REJECTED
H1 Clusters (>=3): 2
  - bot-master-alpha.near: funded=22, kept=alpha-bot-01.near, discounted=21
  - sybil-faucet-99.near: funded=15, kept=sybil-99-01.near, discounted=14
H2 Burners       : 13
H3 Uniformity    : 11
SHA-256 Evidence : ac50bb6476c351e4f57bc74ef3b2a61c3a5f5dc3f759d5ce2fdc77e9f4ec095b
```

### Test 2 — Offline Verifier: Organic Claim Verified (`8400 bps >= 7000 bps`)

```bash
cd verifier && npm run verify -- --offline --fixture ../fixtures/organic-contract.json --out ../web/public/reports/organic-report.json
```

**Expected Output (`exit 0`, exchange allowlist callers `binancecold3.near` & `okx.near` preserved):**
```text
Raw Callers      : 50
Effective Organic: 42
Sybil Discounted : 8
Organic Score    : 8400 bps (84.00%)
DAO Threshold    : 7000 bps
Verdict          : VERIFIED
H1 Clusters (>=3): 1
  - qa-team-funder.near: funded=4, kept=qa-wallet-01.near, discounted=3
H2 Burners       : 3
H3 Uniformity    : 2
SHA-256 Evidence : 0609a83b307659e798213649391a6fa52275df5998f56babcce6076d911e6b13
```

Run the TypeScript verifier typecheck & determinism tests (`3/3` pass) and optional read-only Mainnet RPC inspection:
```bash
cd verifier && npm run typecheck && npm test
npm run verify -- --rpc --contract wrap.near --max-blocks 2
```

### Test 3 — Rust Smart Contract Unit Tests & WASM Build (`contracts/polygraph-gate`)

```bash
cd contracts/polygraph-gate && cargo test -- --nocapture && cargo near build non-reproducible-wasm --no-abi
```

*Note on Windows hosts:* `near-sdk = "=5.30.1"` uses `aws-lc-sys` under its host `unit-testing` dev-dependency, which requires `nasm.exe` on `PATH` when compiling test binaries on Windows MSVC. On Linux/macOS it compiles natively without extra setup.

**Expected Output:**
- `test result: ok. 6 passed; 0 failed` (`test_claim_initialization_and_views`, `test_submit_claim_requires_min_bond`, `test_unauthorized_attest_panics`, `test_sybil_claim_rejected`, `test_organic_claim_verified_and_constructs_sputnik_payload`, `test_on_proposal_added_callback_handles_success_and_error`).
- Builds `contracts/polygraph-gate/target/near/polygraph_gate.wasm` (`159,294` bytes, SHA-256 `d920714965ccce1050272ac5dbf401b842cfec609e02da1205d1009138cfb7fc`).

### Test 4 — Live NEAR Testnet RPC Inspection (Zero Install / Zero Credentials)

Query the live deployed Gate contract (`polygraph-gate-v1.testnet`) and live Sputnik DAO v2 contract (`polygraph-dao-v1.sputnikv2.testnet`):

```bash
# 1. Inspect both on-chain claims (Claim #0 Failed vs Claim #1 Verified) on polygraph-gate-v1.testnet
curl -s https://rpc.testnet.near.org -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"claims","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"polygraph-gate-v1.testnet","method_name":"list_claims","args_base64":"eyJmcm9tX2luZGV4IjowLCJsaW1pdCI6MTB9"}}' \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify(JSON.parse(Buffer.from(r.result.result).toString("utf8")),null,2))'

# 2. Inspect Sputnik DAO v2 proposals created on polygraph-dao-v1.sputnikv2.testnet
curl -s https://rpc.testnet.near.org -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"dao","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"polygraph-dao-v1.sputnikv2.testnet","method_name":"get_proposals","args_base64":"eyJmcm9tX2luZGV4IjowLCJsaW1pdCI6MTB9"}}' \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify(JSON.parse(Buffer.from(r.result.result).toString("utf8")),null,2))'
```

Or using `near-cli`:
```bash
near view polygraph-gate-v1.testnet get_claim '{"claim_id":0}' --networkId testnet
near view polygraph-gate-v1.testnet get_claim '{"claim_id":1}' --networkId testnet
near view polygraph-dao-v1.sputnikv2.testnet get_proposal '{"id":1}' --networkId testnet
```

**Expected On-Chain Result:**
- `claim_id: 0` (`sybil-dex.near`): `status: "Failed"`, `score_bps: 1800`, `evidence_hash: "ac50bb6476c351e4f57bc74ef3b2a61c3a5f5dc3f759d5ce2fdc77e9f4ec095b"`, `dao_proposal_id: null`.
- `claim_id: 1` (`organic-dapp.near`): `status: "Verified"`, `score_bps: 8400`, `evidence_hash: "0609a83b307659e798213649391a6fa52275df5998f56babcce6076d911e6b13"`, `dao_proposal_id: 1`.
- Sputnik DAO Proposal #1 (`proposer: "polygraph-gate-v1.testnet"`): `Action::Transfer` to `polygraph-grantee-v1.testnet` for `10000000000000000000000000` yoctoNEAR (`10 NEAR`), description `[POLYGRAPH VERIFIED MILESTONE] Claim #1 | Target: organic-dapp.near | Blocks: 131000000..131050000 | Organic Score: 8400 bps (42/50 users) | SHA256: 0609a83b307659e798213649391a6fa52275df5998f56babcce6076d911e6b13`.

### Test 5 — Read-Only Evidence Explorer (`web/`)

```bash
cd web && npm install && npm run build && npm run preview
```

Opens the zero-wallet-login Evidence Explorer rendering Claim #0 vs Claim #1 scorecards, $H_1 / H_2 / H_3$ breakdowns, Funding Cluster table, full SHA-256 verification badge matched live against `polygraph-gate-v1.testnet`, and NearBlocks Testnet links.

---

## 5. Live NEAR Testnet Deployment & On-Chain Proof

| Artifact / Step | Account / Tx ID | Explorer Link |
| :--- | :--- | :--- |
| **Polygraph Gate Contract** | `polygraph-gate-v1.testnet` | [View Account](https://testnet.nearblocks.io/address/polygraph-gate-v1.testnet) |
| **Sputnik DAO v2 Instance** | `polygraph-dao-v1.sputnikv2.testnet` | [View Account](https://testnet.nearblocks.io/address/polygraph-dao-v1.sputnikv2.testnet) |
| **Verifier / DAO Council** | `polygraph-ops-v1.testnet` | [View Account](https://testnet.nearblocks.io/address/polygraph-ops-v1.testnet) |
| **Grantee Submitter / Recipient** | `polygraph-grantee-v1.testnet` | [View Account](https://testnet.nearblocks.io/address/polygraph-grantee-v1.testnet) |
| **Deploy `polygraph_gate.wasm`** | `8rAQEFK4wL1Y9N6hA1iyPsh2Ub9pCUr645oja4M8CgUZ` | [Tx](https://testnet.nearblocks.io/txns/8rAQEFK4wL1Y9N6hA1iyPsh2Ub9pCUr645oja4M8CgUZ) |
| **Initialize Gate (`new`)** | `oDbmEEXtno2vYU38xkWsKMzYJ76Bu8JXG5rWgeMyft6` | [Tx](https://testnet.nearblocks.io/txns/oDbmEEXtno2vYU38xkWsKMzYJ76Bu8JXG5rWgeMyft6) |
| **Create Sputnik DAO v2** | `BnVeePHWHsdLj9ZStSBELupaWHMHjTgVE3FzfC8ifo5m` | [Tx](https://testnet.nearblocks.io/txns/BnVeePHWHsdLj9ZStSBELupaWHMHjTgVE3FzfC8ifo5m) |
| **Configure `gate` Role (`ChangePolicy`)** | `8FpHSFcW3JBg969fwKDFeq4NRHYuoUDD3ftDLTqxdVDC` | [Tx](https://testnet.nearblocks.io/txns/8FpHSFcW3JBg969fwKDFeq4NRHYuoUDD3ftDLTqxdVDC) |
| **Approve `gate` Role (`VoteApprove`)** | `E9782yM8ATxjR5cvNcnSRbfG57zJqK4vH2n2apFuYWGt` | [Tx](https://testnet.nearblocks.io/txns/E9782yM8ATxjR5cvNcnSRbfG57zJqK4vH2n2apFuYWGt) |
| **Claim #0 `submit_claim` (`sybil-dex.near`)** | `2uxXgc11wEoKBAgk6j5twKVGK3Xq7rybh94VvdDszoBh` | [Tx](https://testnet.nearblocks.io/txns/2uxXgc11wEoKBAgk6j5twKVGK3Xq7rybh94VvdDszoBh) |
| **Claim #0 `attest` → `Failed` (Blocked)** | `5popKuBBZHhiRYdMGdBVCSBVmtLwtSwYGLgmM7awsNfy` | [Tx](https://testnet.nearblocks.io/txns/5popKuBBZHhiRYdMGdBVCSBVmtLwtSwYGLgmM7awsNfy) |
| **Claim #1 `submit_claim` (`organic-dapp.near`)** | `FJewY4eJKw4av8jFVDt6v6Qvh4DrwGZAvU6kFeuZdBxg` | [Tx](https://testnet.nearblocks.io/txns/FJewY4eJKw4av8jFVDt6v6Qvh4DrwGZAvU6kFeuZdBxg) |
| **Claim #1 `attest` → `Verified` + DAO Proposal #1** | `3LH2Ai6TEBbpFgNpNzYVFP3SS48dHKzqvEK6wqdGUNzN` | [Tx](https://testnet.nearblocks.io/txns/3LH2Ai6TEBbpFgNpNzYVFP3SS48dHKzqvEK6wqdGUNzN) |

---

## 6. Honest Architecture & Security Trade-Offs

1. **Off-Chain Interrogation vs. On-Chain Historical Execution:** NEAR WASM contracts cannot read historical archival blocks or walk parent `CreateAccount` funding graphs across chain state. Polygraph therefore executes heuristic interrogation off-chain over a pinned block window $[B_{\text{start}}, B_{\text{end}}]$ and stores the canonical $\text{SHA-256}$ `evidence_hash` on-chain. Any council member or judge can re-run `verifier` over the exact snapshot to confirm zero tampering before voting.
2. **Mainnet Read-Only Telemetry + Testnet Gate Execution:** In compliance with Hackathon Rule Q-010, Mainnet RPC (`https://rpc.mainnet.near.org`) is queried strictly read-only, while all smart-contract deployments and Sputnik DAO v2 cross-contract proposals run on NEAR Testnet (`polygraph-gate-v1.testnet` and `polygraph-dao-v1.sputnikv2.testnet`).
3. **Raw JSON-RPC Scan vs. Historical Indexer Boundary:** Standard NEAR JSON-RPC (`block`/`chunk` queries) inspects short pinned block ranges directly, but does not expose reverse `CreateAccount` provenance without a SQL/Lake indexer; therefore `rpc.ts` protects unindexed RPC callers against false-positive $H_1/H_2$ penalties and caps direct block scans (`--max-blocks`), while full provenance heuristics operate on indexed telemetry snapshots (`fixtures/*.json`).
4. **Gate Does Not Bypass DAO Voting:** Passing $S \ge S_{\min}$ only authorizes `polygraph-gate-v1.testnet` (via Sputnik DAO's `"gate"` role `transfer:AddProposal`) to create a proposal (`status: "InProgress"`). Sputnik DAO council members retain full manual approval/rejection custody over treasury funds.
5. **Known Heuristic Evasion Boundaries:** Sophisticated Sybils funding each wallet individually from separate centralized exchange withdrawals (`known_exchange_funders`) and randomizing call intervals/arguments above thresholds can evade $H_1$–$H_3$. Polygraph raises coordination costs and surfaces high-signal clusters cleanly rather than claiming unbreakable proof-of-personhood.

---

## 7. Repository Structure

```text
near-polygraph/
├── LICENSE                        # MIT License (Hackathon Rule Q-014)
├── README.md                      # Documentation & reproducible audit guide
├── HACKATHON.md                   # Hackathon submission contract & safety rules
├── AGENTS.md                      # Architectural guardrails
├── PRD.md                         # Product requirements & scope lock
├── ARCHITECTURE.md                # State/method specs & mathematical formulations
├── TASKS.md.md                    # Sequential implementation checklist
├── contracts/
│   └── polygraph-gate/            # Rust smart contract (near-sdk = "=5.30.1")
│       ├── Cargo.toml
│       └── src/lib.rs
├── fixtures/
│   ├── sybil-contract.json        # Deterministic Sybil snapshot (1800 bps -> Blocked)
│   └── organic-contract.json      # Deterministic Organic snapshot (8400 bps -> Verified)
├── verifier/                      # Deterministic TypeScript CLI & Sybil engine
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts               # CLI entrypoint (--offline and --rpc / --live)
│       ├── heuristics.ts          # H1, H2, H3 evaluation engine
│       ├── heuristics.test.ts     # Deterministic SHA-256 & score unit tests
│       ├── canonical.ts           # Lexicographic sort + SHA-256 hashing
│       └── rpc.ts                 # Read-only NEAR Mainnet JSON-RPC client
├── web/                           # Read-only React + Vite Evidence Explorer
│   ├── package.json
│   ├── public/reports/            # Pre-generated canonical JSON artifacts
│   └── src/
│       ├── App.tsx
│       ├── config.ts
│       ├── nearRpc.ts
│       ├── styles.css
│       └── types.ts
└── scripts/
    ├── deploy-testnet.sh          # Reproducible WASM build, deploy & Sputnik DAO config
    └── run-demo.sh                # Reproducible Claim #0 & Claim #1 Testnet demo flow
```

---

## 8. Mandatory Hackathon Disclosures

- **Clean-Room Creation (Rules Q-001 / Q-003):** 100% of source code, fixtures, tests, and deployment scripts in `near-polygraph` were written from scratch during the official NEAR Hackathon window (`2026-11-01` to `2026-11-14`).
- **Open-Source Dependencies & AI Tooling (Rule Q-005):**
  - *Smart Contract:* `near-sdk` `=5.30.1`, `serde` `1.0`, `serde_json` `1.0`, compiled targeting `sputnikv2.testnet`.
  - *Verifier:* Native Node.js `node:crypto`, `node:fs`, `fetch` (zero runtime npm packages); `typescript` `^5.7.2`, `tsx` `^4.19.2`, `@types/node` `^22.10.0` in devDependencies.
  - *Web Explorer:* `react` `^18.3.1`, `react-dom` `^18.3.1`, `vite` `^6.0.3`, `typescript` `^5.7.2` (zero wallet selector packages).
  - *AI Tooling Disclosure:* Antigravity / Gemini / Claude agents assisted with code authoring, build troubleshooting, and verification checks. All heuristic evaluations (`H1`–`H3`), canonical SHA-256 digests, and on-chain Sputnik DAO gating logic are purely deterministic with zero AI inference at runtime.
- **Dual Submission Mutual Disclosure (Rule Q-015):** The author submitted one other independent entry to NEAR Hackathon 2026: **[Proof-of-Grudge](https://github.com/StevBeq/Proof-Of-Grudge)** (`pog-mw835qrr-1c82b2-vault.testnet`, tracks: `open`, `defi` — an adversarial dead-man's switch on NEAR Testnet with Chain Signatures MPC to Ethereum Sepolia). `near-polygraph` and `Proof-of-Grudge` share zero source code, zero smart contracts, and address unrelated problem domains.

---

## 9. License

[MIT](LICENSE)
