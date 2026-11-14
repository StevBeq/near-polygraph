#!/usr/bin/env bash
set -euo pipefail

# Reproducible end-to-end demo script against NEAR Testnet.
# Runs the deterministic verifier on both fixtures and submits/attests Claim #0 (Sybil) and Claim #1 (Organic).

NETWORK="${NEAR_ENV:-testnet}"
GATE_CONTRACT="${GATE_CONTRACT:-polygraph-gate-v1.testnet}"
DAO_ACCOUNT="${DAO_ACCOUNT:-polygraph-dao-v1.sputnikv2.testnet}"
SUBMITTER="${SUBMITTER:-polygraph-grantee-v1.testnet}"
VERIFIER="${VERIFIER:-polygraph-ops-v1.testnet}"

echo "=== [1/4] Generating Deterministic Verifier Digests ==="
SYBIL_OUT=$(cd verifier && npm run --silent verify -- --offline --fixture ../fixtures/sybil-contract.json --json)
SYBIL_SCORE=$(printf '%s' "${SYBIL_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.score_bps);')
SYBIL_RAW=$(printf '%s' "${SYBIL_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.raw_users);')
SYBIL_EFF=$(printf '%s' "${SYBIL_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.effective_organic_users);')
SYBIL_HASH=$(printf '%s' "${SYBIL_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.evidence_hash);')

ORGANIC_OUT=$(cd verifier && npm run --silent verify -- --offline --fixture ../fixtures/organic-contract.json --json)
ORGANIC_SCORE=$(printf '%s' "${ORGANIC_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.score_bps);')
ORGANIC_RAW=$(printf '%s' "${ORGANIC_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.raw_users);')
ORGANIC_EFF=$(printf '%s' "${ORGANIC_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.report.metrics.effective_organic_users);')
ORGANIC_HASH=$(printf '%s' "${ORGANIC_OUT}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.evidence_hash);')

echo "Sybil   -> score=${SYBIL_SCORE} bps (${SYBIL_EFF}/${SYBIL_RAW}), sha256=${SYBIL_HASH}"
echo "Organic -> score=${ORGANIC_SCORE} bps (${ORGANIC_EFF}/${ORGANIC_RAW}), sha256=${ORGANIC_HASH}"

echo "=== [2/4] Flow A: Sybil Claim Submission & Gate Blocking ==="
CLAIM_SYBIL=$(near call "${GATE_CONTRACT}" submit_claim \
  "{\"dao_account\":\"${DAO_ACCOUNT}\",\"recipient\":\"${SUBMITTER}\",\"target_contract\":\"sybil-dex.near\",\"start_block\":130000000,\"end_block\":130050000,\"min_score_bps\":7000,\"requested_amount\":\"5000000000000000000000000\"}" \
  --accountId "${SUBMITTER}" --amount 0.1 --gas 50000000000000 --networkId "${NETWORK}" | tail -n 1 | tr -d '[:space:]')
echo "Submitted Sybil Claim ID: ${CLAIM_SYBIL}"

near call "${GATE_CONTRACT}" attest \
  "{\"claim_id\":${CLAIM_SYBIL},\"score_bps\":${SYBIL_SCORE},\"raw_users\":${SYBIL_RAW},\"effective_users\":${SYBIL_EFF},\"evidence_hash\":\"${SYBIL_HASH}\"}" \
  --accountId "${VERIFIER}" --gas 150000000000000 --networkId "${NETWORK}"

echo "=== [3/4] Flow B: Organic Claim Submission & Sputnik DAO Proposal Creation ==="
CLAIM_ORGANIC=$(near call "${GATE_CONTRACT}" submit_claim \
  "{\"dao_account\":\"${DAO_ACCOUNT}\",\"recipient\":\"${SUBMITTER}\",\"target_contract\":\"organic-dapp.near\",\"start_block\":131000000,\"end_block\":131050000,\"min_score_bps\":7000,\"requested_amount\":\"10000000000000000000000000\"}" \
  --accountId "${SUBMITTER}" --amount 0.1 --gas 50000000000000 --networkId "${NETWORK}" | tail -n 1 | tr -d '[:space:]')
echo "Submitted Organic Claim ID: ${CLAIM_ORGANIC}"

near call "${GATE_CONTRACT}" attest \
  "{\"claim_id\":${CLAIM_ORGANIC},\"score_bps\":${ORGANIC_SCORE},\"raw_users\":${ORGANIC_RAW},\"effective_users\":${ORGANIC_EFF},\"evidence_hash\":\"${ORGANIC_HASH}\"}" \
  --accountId "${VERIFIER}" --gas 150000000000000 --networkId "${NETWORK}"

echo "=== [4/4] Inspecting On-Chain State ==="
near view "${GATE_CONTRACT}" get_claim "{\"claim_id\":${CLAIM_SYBIL}}" --networkId "${NETWORK}"
near view "${GATE_CONTRACT}" get_claim "{\"claim_id\":${CLAIM_ORGANIC}}" --networkId "${NETWORK}"
near view "${DAO_ACCOUNT}" get_last_proposal_id '{}' --networkId "${NETWORK}"
