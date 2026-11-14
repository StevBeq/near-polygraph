#!/usr/bin/env bash
set -euo pipefail

# Reproducible deployment script for near-polygraph on NEAR Testnet.
# Usage:
#   GATE_CONTRACT=my-gate.testnet VERIFIER_ACCOUNT=my-ops.testnet DAO_NAME=my-polygraph-dao bash scripts/deploy-testnet.sh

NETWORK="${NEAR_ENV:-testnet}"
GATE_CONTRACT="${GATE_CONTRACT:-polygraph-gate-v1.testnet}"
VERIFIER_ACCOUNT="${VERIFIER_ACCOUNT:-polygraph-ops-v1.testnet}"
DAO_NAME="${DAO_NAME:-polygraph-dao-v1}"
DAO_ACCOUNT="${DAO_ACCOUNT:-${DAO_NAME}.sputnikv2.testnet}"
WASM_PATH="contracts/polygraph-gate/target/near/polygraph_gate.wasm"

echo "=== [1/4] Building Polygraph Gate WASM ==="
(
  cd contracts/polygraph-gate
  cargo test
  cargo near build non-reproducible-wasm --no-abi
)

echo "=== [2/4] Deploying ${WASM_PATH} to ${GATE_CONTRACT} ==="
near deploy "${GATE_CONTRACT}" "${WASM_PATH}" --networkId "${NETWORK}"

echo "=== [3/4] Initializing ${GATE_CONTRACT} with verifier ${VERIFIER_ACCOUNT} ==="
near call "${GATE_CONTRACT}" new \
  "{\"verifier_account\":\"${VERIFIER_ACCOUNT}\"}" \
  --accountId "${GATE_CONTRACT}" \
  --networkId "${NETWORK}"

echo "=== [4/4] Creating Sputnik DAO v2 (${DAO_ACCOUNT}) & Configuring Gate Permission ==="
RAW_INIT=$(printf '{"config":{"name":"%s","purpose":"Evidence-gated Sputnik DAO v2 secured by near-polygraph","metadata":""},"policy":["%s"]}' "${DAO_NAME}" "${VERIFIER_ACCOUNT}")
INIT_B64=$(printf '%s' "${RAW_INIT}" | base64 | tr -d '\n')

near call sputnikv2.testnet create \
  "{\"name\":\"${DAO_NAME}\",\"args\":\"${INIT_B64}\"}" \
  --accountId "${VERIFIER_ACCOUNT}" \
  --amount 6 \
  --gas 150000000000000 \
  --networkId "${NETWORK}"

POLICY_PROPOSAL=$(cat <<EOF
{
  "proposal": {
    "description": "Configure Polygraph Gate role with transfer:AddProposal and 0.1 NEAR proposal bond",
    "kind": {
      "ChangePolicy": {
        "policy": {
          "roles": [
            {
              "name": "council",
              "kind": { "Group": ["${VERIFIER_ACCOUNT}"] },
              "permissions": ["*:*"],
              "vote_policy": {}
            },
            {
              "name": "gate",
              "kind": { "Group": ["${GATE_CONTRACT}"] },
              "permissions": ["transfer:AddProposal"],
              "vote_policy": {}
            }
          ],
          "default_vote_policy": {
            "weight_kind": "RoleWeight",
            "quorum": "0",
            "threshold": [1, 2]
          },
          "proposal_bond": "100000000000000000000000",
          "proposal_period": "604800000000000",
          "bounty_bond": "100000000000000000000000",
          "bounty_forgiveness_period": "86400000000000"
        }
      }
    }
  }
}
EOF
)

near call "${DAO_ACCOUNT}" add_proposal "${POLICY_PROPOSAL}" \
  --accountId "${VERIFIER_ACCOUNT}" \
  --amount 1 \
  --gas 150000000000000 \
  --networkId "${NETWORK}"

near call "${DAO_ACCOUNT}" act_proposal '{"id":0,"action":"VoteApprove"}' \
  --accountId "${VERIFIER_ACCOUNT}" \
  --gas 150000000000000 \
  --networkId "${NETWORK}"

echo "=== Deployment Complete ==="
echo "Gate Contract : ${GATE_CONTRACT}"
echo "Sputnik DAO   : ${DAO_ACCOUNT}"
echo "Verifier      : ${VERIFIER_ACCOUNT}"
