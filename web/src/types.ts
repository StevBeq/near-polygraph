export type HeuristicReason =
  | "H1_FUNDER_CLUSTER"
  | "H2_EPHEMERAL_BURNER"
  | "H3_ROBOTIC_UNIFORMITY";

export interface FunderClusterReport {
  funder_account_id: string;
  total_funded_callers: number;
  retained_account: string;
  discounted_accounts: string[];
}

export interface FlaggedAccountReport {
  account_id: string;
  reasons: HeuristicReason[];
}

export interface EvidenceReportArtifact {
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
    h1_funder_clusters: FunderClusterReport[];
    h2_ephemeral_burners: string[];
    h3_uniformity_flagged: string[];
  };
  flagged_accounts: FlaggedAccountReport[];
  evidence_hash: string;
}

export type OnChainClaimStatus =
  | "Pending"
  | "Verified"
  | "Failed"
  | "ProposalCreationFailed";

export interface OnChainClaim {
  claim_id: number;
  submitter: string;
  dao_account: string;
  recipient: string;
  target_contract: string;
  start_block: number;
  end_block: number;
  min_score_bps: number;
  requested_amount: string;
  attached_bond: string;
  status: OnChainClaimStatus;
  score_bps: number | null;
  raw_users: number | null;
  effective_users: number | null;
  evidence_hash: string | null;
  dao_proposal_id: number | null;
}

export interface DemoProofTx {
  claimId: number;
  submitTx: string;
  attestTx: string;
  notes: string;
}
