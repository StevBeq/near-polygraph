# AGENTS.md — Antigravity Operational Spec for `near-polygraph`

You are operating inside **Antigravity** to build **Polygraph** (`near-polygraph`) for the **NEAR Hackathon** (Deadline: `2026-11-14T23:59:00Z`). Read this file completely before generating or modifying any code.

---

## 1. Project Identity & Core Differentiation

- **Project Name:** Polygraph
- **Root Folder / Repo Name:** `near-polygraph`
- **Target Tracks:** `social`, `security` (Core), and `thesis` (Data/Evidence layer)
- **One-Line Pitch:** An evidence-gated milestone payout protocol for Sputnik DAO that interrogates a grantee's on-chain contract traction for Sybil/wash-trading activity before allowing a payout proposal on-chain.
- **Strict Differentiation (DO NOT VIOLATE):**
  - Unlike **Headcount** (which checks whether a list of payout recipient wallets belong to the same person) or **CommonsOps** (general verifiable operations), **Polygraph audits the grantee's target smart contract traction claim** (e.g., *"Our deployed contract `dapp.near` reached $N$ organic active users in block window $[B_{\text{start}}, B_{\text{end}}]$"*).
  - Polygraph **does not bypass DAO voting**. It acts as an automated pre-proposal security gate: if the claim passes the minimum organic score ($S \ge S_{\min}$), the Gate contract automatically calls `add_proposal` (`Action::Transfer`) on Sputnik DAO with the SHA-256 evidence hash attached so council members only vote on verified milestones.

---

## 2. Document Reading Order

Before implementing any module, read the workspace specifications in this exact order:
1. `HACKATHON.md` — Official hackathon rules, submission API contract, and hard prohibitions.
2. `AGENTS.md` (this file) — Workspace structure, architectural constraints, and agent guardrails.
3. `PRD.md` — Product scope lock, user flow, and "do X - see Y" evaluation criteria.
4. `ARCHITECTURE.md` — Rust smart contract state/methods, Sputnik DAO cross-contract interface, TypeScript verifier heuristics, and JSON schemas.
5. `TASKS.md` — Step-by-step build and verification checklist.

---

## 3. Repository & Folder Structure

Maintain this exact monorepo layout inside `near-polygraph/`:

```text
near-polygraph/
├── HACKATHON.md                # Official NEAR Hackathon instructions
├── AGENTS.md                   # Antigravity agent rules & context
├── PRD.md                      # Product requirements & MVP scope lock
├── ARCHITECTURE.md             # Technical specification & schemas
├── TASKS.md                    # Sequential implementation checklist
├── README.md                   # Machine-readable "do X - see Y" guide for judges
├── LICENSE                     # MIT License (Required by Q-014)
├── contracts/
│   └── polygraph-gate/         # Rust smart contract (near-sdk 5.x)
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs
├── verifier/                   # Off-chain TypeScript CLI verifier & Sybil engine
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # CLI entrypoint (--offline and --rpc modes)
│       ├── heuristics.ts       # 3 deterministic Sybil heuristics
│       ├── canonical.ts        # Canonical JSON serializer + SHA-256 hasher
│       └── rpc.ts              # Mainnet archival/indexer fetcher
├── fixtures/                   # Deterministic Mainnet snapshots for offline screening
│   ├── organic-contract.json   # Clean dApp activity fixture (Passes gate)
│   └── sybil-contract.json     # Wash-traded / bot-farmed fixture (Blocked by gate)
├── web/                        # Single-page Read-Only Evidence Dashboard
│   ├── package.json
│   └── src/                    # Displays score, Sybil clusters, SHA-256 & DAO status
└── scripts/                    # Reproducible CLI demo scripts for testnet
    ├── deploy-testnet.sh
    └── run-demo.sh
```

---

## 4. Non-Negotiable Architectural Constraints

1. **Off-Chain Analysis, On-Chain Attestation:**
   - NEAR smart contracts **cannot** read historical block activity or call archival RPCs directly.
   - All transaction history inspection happens off-chain in `verifier/` pinned to an explicit block range ($[B_{\text{start}}, B_{\text{end}}]$) on **NEAR Mainnet** (or deterministic fixtures).
   - The smart contract (`contracts/polygraph-gate`) runs on **NEAR Testnet** (eligible across all tracks per Q-010), stores claims, accepts attestations from the authorized `verifier_account`, and triggers cross-contract calls to Sputnik DAO on Testnet.
2. **Mandatory `--offline` Mode for AI Screening (Q-017):**
   - **Claude Code** and **Codex** screen every submission automatically before human judges review it.
   - The verifier CLI **must** support `npm run verify -- --offline --fixture ../fixtures/sybil-contract.json` and `npm run verify -- --offline --fixture ../fixtures/organic-contract.json` with **zero API keys or network dependencies**, producing deterministic output and an exact SHA-256 hash every run.
3. **Three Deterministic Heuristics Only (No Scope Creep):**
   - **H1 — Funder Clustering ($H_1$):** Group accounts funded by the same parent account into a single effective entity.
   - **H2 — Ephemeral / Burner Accounts ($H_2$):** Flag accounts created shortly before their first interaction that exclusively call the target contract.
   - **H3 — Action Uniformity ($H_3$):** Flag accounts exhibiting identical call arguments, deposit amounts, or robotic timestamp intervals.
   - Calculate Effective Organic Ratio in basis points ($\text{score\_bps} \in [0, 10000]$).
4. **No Wallet Integration in UI:**
   - Do **not** waste time integrating `@near-wallet-selector` in `web/`.
   - All state-mutating actions (`submit_claim`, `attest`) are driven via CLI (`near-cli-rs` / `verifier` script), while `web/` is a fast, read-only Evidence Explorer that renders the canonical JSON report and queries the Testnet contract state via public RPC.

---

## 5. Hard Safety Rules (From `HACKATHON.md`)

- **NEVER** send a POST request to `https://nearhackathon.com/api/applications` without first printing the complete JSON payload and receiving an explicit confirmation from the human.
- **NEVER** commit `.env` files, private keys, seed phrases, or API keys to the repository.
- **NEVER** deploy contracts to NEAR Mainnet or spend Mainnet tokens. All contract deployments and Sputnik DAO interactions happen strictly on **NEAR Testnet** (`https://rpc.testnet.near.org`).
- **NEVER** push to GitHub, change repository visibility, or post on X without explicit human instruction.
- **Keep Code Simple & Auditable:** Write clean, well-tested Rust (`cargo test` must pass 100%) and strict TypeScript so automated screening agents can build and verify the repository in under 3 minutes.