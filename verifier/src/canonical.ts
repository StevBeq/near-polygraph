import { createHash } from "node:crypto";

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
    h1_funder_clusters: FunderClusterReport[];
    h2_ephemeral_burners: string[];
    h3_uniformity_flagged: string[];
  };
  flagged_accounts: FlaggedAccountReport[];
}

function sortLex(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sortObjectKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeysDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(sortLex)) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = sortObjectKeysDeep(entry);
      }
    }
    return sorted as T;
  }
  return value;
}

export function canonicalizeReport(
  report: CanonicalEvidenceReport
): CanonicalEvidenceReport {
  return {
    schema_version: report.schema_version,
    claim_id: report.claim_id,
    target_contract: report.target_contract,
    block_window: {
      start_block: report.block_window.start_block,
      end_block: report.block_window.end_block,
    },
    thresholds: {
      min_score_bps: report.thresholds.min_score_bps,
    },
    metrics: {
      raw_users: report.metrics.raw_users,
      effective_organic_users: report.metrics.effective_organic_users,
      sybil_discounted_users: report.metrics.sybil_discounted_users,
      score_bps: report.metrics.score_bps,
      verdict: report.metrics.verdict,
    },
    heuristic_breakdown: {
      h1_funder_clusters: report.heuristic_breakdown.h1_funder_clusters
        .map((cluster) => ({
          funder_account_id: cluster.funder_account_id,
          total_funded_callers: cluster.total_funded_callers,
          retained_account: cluster.retained_account,
          discounted_accounts: [...cluster.discounted_accounts].sort(sortLex),
        }))
        .sort((a, b) => sortLex(a.funder_account_id, b.funder_account_id)),
      h2_ephemeral_burners: [
        ...report.heuristic_breakdown.h2_ephemeral_burners,
      ].sort(sortLex),
      h3_uniformity_flagged: [
        ...report.heuristic_breakdown.h3_uniformity_flagged,
      ].sort(sortLex),
    },
    flagged_accounts: report.flagged_accounts
      .map((item) => ({
        account_id: item.account_id,
        reasons: [...item.reasons].sort(sortLex) as HeuristicReason[],
      }))
      .sort((a, b) => sortLex(a.account_id, b.account_id)),
  };
}

export function serializeCanonicalReport(
  report: CanonicalEvidenceReport
): string {
  const normalized = canonicalizeReport(report);
  const keySorted = sortObjectKeysDeep(normalized);
  return JSON.stringify(keySorted);
}

export function hashCanonicalReport(report: CanonicalEvidenceReport): {
  report: CanonicalEvidenceReport;
  canonicalJson: string;
  evidenceHash: string;
} {
  const normalized = canonicalizeReport(report);
  const canonicalJson = JSON.stringify(sortObjectKeysDeep(normalized));
  const evidenceHash = createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex");

  return {
    report: normalized,
    canonicalJson,
    evidenceHash,
  };
}
