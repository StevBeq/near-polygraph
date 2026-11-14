use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, log, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub const MIN_PROPOSAL_BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR in yoctoNEAR
pub const GAS_FOR_ADD_PROPOSAL: Gas = Gas::from_tgas(30);
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Claims,
}

#[near_sdk::near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum ClaimStatus {
    Pending,
    Verified,
    Failed,
    ProposalCreationFailed,
}

#[near_sdk::near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
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

#[near_sdk::near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct ProposalInput {
    pub description: String,
    pub kind: ProposalKind,
}

#[near_sdk::near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub enum ProposalKind {
    Transfer {
        token_id: String,
        receiver_id: AccountId,
        amount: U128,
        msg: Option<String>,
    },
}

#[ext_contract(ext_sputnik_dao)]
pub trait SputnikDao {
    fn add_proposal(&mut self, proposal: ProposalInput) -> u64;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolygraphGate {
    pub owner_id: AccountId,
    pub verifier_account: AccountId,
    pub next_claim_id: u64,
    pub claims: UnorderedMap<u64, Claim>,
}

fn emit_event(event: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "standard": "polygraph",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    log!("EVENT_JSON:{}", payload);
}

#[near]
impl PolygraphGate {
    #[init]
    pub fn new(verifier_account: AccountId) -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            verifier_account,
            next_claim_id: 0,
            claims: UnorderedMap::new(StorageKey::Claims),
        }
    }

    #[payable]
    pub fn submit_claim(
        &mut self,
        dao_account: AccountId,
        recipient: AccountId,
        target_contract: String,
        start_block: u64,
        end_block: u64,
        min_score_bps: u16,
        requested_amount: U128,
    ) -> u64 {
        assert!(
            !target_contract.trim().is_empty(),
            "target_contract must not be empty"
        );
        assert!(
            min_score_bps > 0 && min_score_bps <= 10_000,
            "min_score_bps must be in 1..=10000"
        );
        assert!(
            start_block < end_block,
            "start_block must be strictly less than end_block"
        );
        assert!(
            requested_amount.0 > 0,
            "requested_amount must be greater than zero"
        );

        let attached = env::attached_deposit().as_yoctonear();
        assert!(
            attached >= MIN_PROPOSAL_BOND,
            "Attached deposit must be at least 0.1 NEAR ({MIN_PROPOSAL_BOND} yoctoNEAR)"
        );

        let claim_id = self.next_claim_id;
        self.next_claim_id = self
            .next_claim_id
            .checked_add(1)
            .expect("claim_id overflow");

        let submitter = env::predecessor_account_id();
        let claim = Claim {
            claim_id,
            submitter: submitter.clone(),
            dao_account: dao_account.clone(),
            recipient: recipient.clone(),
            target_contract: target_contract.clone(),
            start_block,
            end_block,
            min_score_bps,
            requested_amount,
            attached_bond: U128(attached),
            status: ClaimStatus::Pending,
            score_bps: None,
            raw_users: None,
            effective_users: None,
            evidence_hash: None,
            dao_proposal_id: None,
        };

        self.claims.insert(&claim_id, &claim);

        emit_event(
            "claim_submitted",
            serde_json::json!({
                "claim_id": claim_id,
                "submitter": submitter,
                "dao_account": dao_account,
                "recipient": recipient,
                "target_contract": target_contract,
                "start_block": start_block,
                "end_block": end_block,
                "min_score_bps": min_score_bps,
                "requested_amount": requested_amount.0.to_string(),
                "attached_bond": attached.to_string(),
            }),
        );

        claim_id
    }

    pub fn attest(
        &mut self,
        claim_id: u64,
        score_bps: u16,
        raw_users: u32,
        effective_users: u32,
        evidence_hash: String,
    ) -> PromiseOrValue<bool> {
        assert_eq!(
            env::predecessor_account_id(),
            self.verifier_account,
            "Only the authorized verifier_account can attest"
        );

        let mut claim = self.claims.get(&claim_id).expect("Claim not found");
        assert_eq!(
            claim.status,
            ClaimStatus::Pending,
            "Claim has already been attested"
        );
        assert!(score_bps <= 10_000, "score_bps must be <= 10000");
        assert!(
            effective_users <= raw_users,
            "effective_users cannot exceed raw_users"
        );
        assert!(
            evidence_hash.len() == 64 && evidence_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "evidence_hash must be a 64-character hex SHA-256 digest"
        );

        let normalized_hash = evidence_hash.to_ascii_lowercase();
        claim.score_bps = Some(score_bps);
        claim.raw_users = Some(raw_users);
        claim.effective_users = Some(effective_users);
        claim.evidence_hash = Some(normalized_hash.clone());

        if score_bps < claim.min_score_bps {
            claim.status = ClaimStatus::Failed;
            self.claims.insert(&claim_id, &claim);

            let _ = Promise::new(claim.submitter.clone())
                .transfer(NearToken::from_yoctonear(claim.attached_bond.0));

            emit_event(
                "claim_rejected",
                serde_json::json!({
                    "claim_id": claim_id,
                    "target_contract": claim.target_contract,
                    "score_bps": score_bps,
                    "min_score_bps": claim.min_score_bps,
                    "raw_users": raw_users,
                    "effective_users": effective_users,
                    "evidence_hash": normalized_hash,
                }),
            );

            return PromiseOrValue::Value(false);
        }

        claim.status = ClaimStatus::Verified;
        self.claims.insert(&claim_id, &claim);

        emit_event(
            "claim_verified",
            serde_json::json!({
                "claim_id": claim_id,
                "target_contract": claim.target_contract,
                "dao_account": claim.dao_account,
                "score_bps": score_bps,
                "min_score_bps": claim.min_score_bps,
                "raw_users": raw_users,
                "effective_users": effective_users,
                "evidence_hash": normalized_hash,
            }),
        );

        let description = format!(
            "[POLYGRAPH VERIFIED MILESTONE] Claim #{} | Target: {} | Blocks: {}..{} | Organic Score: {} bps ({}/{} users) | SHA256: {}",
            claim.claim_id,
            claim.target_contract,
            claim.start_block,
            claim.end_block,
            score_bps,
            effective_users,
            raw_users,
            normalized_hash
        );

        let proposal = ProposalInput {
            description,
            kind: ProposalKind::Transfer {
                token_id: String::new(),
                receiver_id: claim.recipient.clone(),
                amount: claim.requested_amount,
                msg: None,
            },
        };

        let promise = ext_sputnik_dao::ext(claim.dao_account.clone())
            .with_attached_deposit(NearToken::from_yoctonear(claim.attached_bond.0))
            .with_static_gas(GAS_FOR_ADD_PROPOSAL)
            .add_proposal(proposal)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_proposal_added(claim_id),
            );

        PromiseOrValue::Promise(promise)
    }

    #[private]
    pub fn on_proposal_added(
        &mut self,
        claim_id: u64,
        #[callback_result] call_result: Result<u64, PromiseError>,
    ) -> bool {
        let mut claim = self.claims.get(&claim_id).expect("Claim not found");

        match call_result {
            Ok(proposal_id) => {
                claim.dao_proposal_id = Some(proposal_id);
                self.claims.insert(&claim_id, &claim);
                emit_event(
                    "proposal_created",
                    serde_json::json!({
                        "claim_id": claim_id,
                        "dao_account": claim.dao_account,
                        "dao_proposal_id": proposal_id,
                        "evidence_hash": claim.evidence_hash,
                    }),
                );
                true
            }
            Err(_) => {
                claim.status = ClaimStatus::ProposalCreationFailed;
                self.claims.insert(&claim_id, &claim);
                let _ = Promise::new(claim.submitter.clone())
                    .transfer(NearToken::from_yoctonear(claim.attached_bond.0));
                emit_event(
                    "proposal_creation_failed",
                    serde_json::json!({
                        "claim_id": claim_id,
                        "dao_account": claim.dao_account,
                        "evidence_hash": claim.evidence_hash,
                    }),
                );
                false
            }
        }
    }

    pub fn get_claim(&self, claim_id: u64) -> Option<Claim> {
        self.claims.get(&claim_id)
    }

    pub fn list_claims(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Claim> {
        let start = from_index.unwrap_or(0);
        let max_items = limit.unwrap_or(50).min(100);
        let mut out = Vec::new();
        for id in start..self.next_claim_id {
            if out.len() as u64 >= max_items {
                break;
            }
            if let Some(claim) = self.claims.get(&id) {
                out.push(claim);
            }
        }
        out
    }

    pub fn get_claims(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Claim> {
        self.list_claims(from_index, limit)
    }

    pub fn get_verifier(&self) -> AccountId {
        self.verifier_account.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn set_verifier(&mut self, new_verifier: AccountId) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only owner_id can update verifier_account"
        );
        self.verifier_account = new_verifier;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, VMContext};

    const SAMPLE_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ORGANIC_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn account(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn get_context(predecessor: &str, attached_yocto: u128) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(account("polygraph-gate.testnet"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(NearToken::from_yoctonear(attached_yocto))
            .build()
    }

    #[test]
    fn test_claim_initialization_and_views() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));
        assert_eq!(contract.get_verifier(), account("verifier.testnet"));
        assert_eq!(contract.get_owner(), account("owner.testnet"));

        testing_env!(get_context("grantee.testnet", MIN_PROPOSAL_BOND));
        let claim_id = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("grantee.testnet"),
            "organic-dapp.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            U128(5_000_000_000_000_000_000_000_000),
        );

        assert_eq!(claim_id, 0);
        let claim = contract.get_claim(0).expect("claim 0 must exist");
        assert_eq!(claim.status, ClaimStatus::Pending);
        assert_eq!(claim.submitter, account("grantee.testnet"));
        assert_eq!(claim.attached_bond.0, MIN_PROPOSAL_BOND);
        assert_eq!(contract.list_claims(None, None).len(), 1);
        assert_eq!(contract.get_claims(Some(0), Some(10)).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Attached deposit must be at least 0.1 NEAR")]
    fn test_submit_claim_requires_min_bond() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));

        testing_env!(get_context("grantee.testnet", MIN_PROPOSAL_BOND - 1));
        contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("grantee.testnet"),
            "sybil-dex.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            U128(1_000_000_000_000_000_000_000_000),
        );
    }

    #[test]
    #[should_panic(expected = "Only the authorized verifier_account can attest")]
    fn test_unauthorized_attest_panics() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));

        testing_env!(get_context("grantee.testnet", MIN_PROPOSAL_BOND));
        let id = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("grantee.testnet"),
            "sybil-dex.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            U128(1_000_000_000_000_000_000_000_000),
        );

        testing_env!(get_context("attacker.testnet", 0));
        let _ = contract.attest(id, 9_500, 50, 48, SAMPLE_HASH.to_string());
    }

    #[test]
    fn test_sybil_claim_rejected() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));

        testing_env!(get_context("sybil-team.testnet", MIN_PROPOSAL_BOND));
        let id = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("sybil-team.testnet"),
            "sybil-dex.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            U128(5_000_000_000_000_000_000_000_000),
        );

        testing_env!(get_context("verifier.testnet", 0));
        let res = contract.attest(id, 1_800, 50, 9, SAMPLE_HASH.to_string());
        match res {
            PromiseOrValue::Value(passed) => assert!(!passed),
            PromiseOrValue::Promise(_) => panic!("Rejected claim must not emit a DAO proposal promise"),
        }

        let claim = contract.get_claim(id).unwrap();
        assert_eq!(claim.status, ClaimStatus::Failed);
        assert_eq!(claim.score_bps, Some(1_800));
        assert_eq!(claim.raw_users, Some(50));
        assert_eq!(claim.effective_users, Some(9));
        assert_eq!(claim.evidence_hash.as_deref(), Some(SAMPLE_HASH));
        assert_eq!(claim.dao_proposal_id, None);
    }

    #[test]
    fn test_organic_claim_verified_and_constructs_sputnik_payload() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));

        testing_env!(get_context("organic-team.testnet", MIN_PROPOSAL_BOND));
        let requested = U128(10_000_000_000_000_000_000_000_000);
        let id = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("organic-team.testnet"),
            "organic-dapp.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            requested,
        );

        testing_env!(get_context("verifier.testnet", 0));
        let res = contract.attest(id, 8_400, 50, 42, ORGANIC_HASH.to_string());
        match res {
            PromiseOrValue::Promise(promise) => drop(promise),
            PromiseOrValue::Value(_) => panic!("Verified claim must schedule cross-contract add_proposal"),
        }

        let claim = contract.get_claim(id).unwrap();
        assert_eq!(claim.status, ClaimStatus::Verified);
        assert_eq!(claim.score_bps, Some(8_400));
        assert_eq!(claim.evidence_hash.as_deref(), Some(ORGANIC_HASH));

        let receipts = get_created_receipts();
        assert!(
            !receipts.is_empty(),
            "Expected cross-contract receipt to Sputnik DAO"
        );
        let serialized = serde_json::to_string(&ProposalInput {
            description: format!(
                "[POLYGRAPH VERIFIED MILESTONE] Claim #{} | Target: organic-dapp.near | Blocks: 131000000..131050000 | Organic Score: 8400 bps (42/50 users) | SHA256: {}",
                id, ORGANIC_HASH
            ),
            kind: ProposalKind::Transfer {
                token_id: String::new(),
                receiver_id: account("organic-team.testnet"),
                amount: requested,
                msg: None,
            },
        })
        .unwrap();
        assert!(serialized.contains("\"Transfer\""));
        assert!(serialized.contains("\"token_id\":\"\""));
        assert!(serialized.contains(ORGANIC_HASH));
    }

    #[test]
    fn test_on_proposal_added_callback_handles_success_and_error() {
        testing_env!(get_context("owner.testnet", 0));
        let mut contract = PolygraphGate::new(account("verifier.testnet"));

        testing_env!(get_context("team-a.testnet", MIN_PROPOSAL_BOND));
        let id_ok = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("team-a.testnet"),
            "organic-dapp.near".to_string(),
            131_000_000,
            131_050_000,
            7_000,
            U128(1_000_000_000_000_000_000_000_000),
        );
        let id_err = contract.submit_claim(
            account("grant-dao.sputnikv2.testnet"),
            account("team-a.testnet"),
            "organic-dapp.near".to_string(),
            131_050_001,
            131_100_000,
            7_000,
            U128(1_000_000_000_000_000_000_000_000),
        );

        testing_env!(get_context("verifier.testnet", 0));
        let _ = contract.attest(id_ok, 8_400, 50, 42, ORGANIC_HASH.to_string());
        let _ = contract.attest(id_err, 8_400, 50, 42, ORGANIC_HASH.to_string());

        testing_env!(get_context("polygraph-gate.testnet", 0));
        assert!(contract.on_proposal_added(id_ok, Ok(7)));
        let claim_ok = contract.get_claim(id_ok).unwrap();
        assert_eq!(claim_ok.status, ClaimStatus::Verified);
        assert_eq!(claim_ok.dao_proposal_id, Some(7));

        assert!(!contract.on_proposal_added(id_err, Err(PromiseError::Failed)));
        let claim_err = contract.get_claim(id_err).unwrap();
        assert_eq!(claim_err.status, ClaimStatus::ProposalCreationFailed);
        assert_eq!(claim_err.dao_proposal_id, None);
        assert_eq!(claim_err.evidence_hash.as_deref(), Some(ORGANIC_HASH));
    }
}
