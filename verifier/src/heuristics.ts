import {
  CanonicalEvidenceReport,
  FlaggedAccountReport,
  FunderClusterReport,
  HeuristicReason,
  canonicalizeReport,
} from "./canonical.js";

export interface CallRecord {
  tx_hash: string;
  block_height: number;
  timestamp_sec: number;
  method_name: string;
  args_hash: string;
  deposit_yocto: string;
}

export interface CallerRecord {
  account_id: string;
  funder_account_id: string;
  account_created_at_sec: number;
  first_call_at_sec: number;
  total_contracts_called: number;
  calls: CallRecord[];
}

export interface ContractActivitySnapshot {
  claim_id: number;
  target_contract: string;
  start_block: number;
  end_block: number;
  min_score_bps: number;
  known_exchange_funders: string[];
  callers: CallerRecord[];
}

const H1_MIN_CLUSTER_SIZE = 3;
const H2_MAX_AGE_SECONDS = 3600;
const H3_BATCH_MIN_CALLERS = 8;
const H3_BATCH_WINDOW_SECONDS = 300;
const H3_MIN_PERIODIC_CALLS = 3;
const H3_MAX_SIGMA_SECONDS = 2.0;

function sortLex(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function addReason(
  reasonsMap: Map<string, Set<HeuristicReason>>,
  accountId: string,
  reason: HeuristicReason
): void {
  let set = reasonsMap.get(accountId);
  if (!set) {
    set = new Set<HeuristicReason>();
    reasonsMap.set(accountId, set);
  }
  set.add(reason);
}

export function populationStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function evaluateSnapshot(
  snapshot: ContractActivitySnapshot
): CanonicalEvidenceReport {
  const uniqueCallersMap = new Map<string, CallerRecord>();
  for (const caller of snapshot.callers) {
    const existing = uniqueCallersMap.get(caller.account_id);
    if (!existing) {
      uniqueCallersMap.set(caller.account_id, {
        ...caller,
        calls: [...caller.calls],
      });
    } else {
      existing.calls.push(...caller.calls);
      existing.first_call_at_sec = Math.min(
        existing.first_call_at_sec,
        caller.first_call_at_sec
      );
      existing.total_contracts_called = Math.max(
        existing.total_contracts_called,
        caller.total_contracts_called
      );
    }
  }

  const callers = Array.from(uniqueCallersMap.values());
  const rawUsers = callers.length;
  const allowlist = new Set(snapshot.known_exchange_funders);
  const reasonsMap = new Map<string, Set<HeuristicReason>>();

  // H1: Funder Clustering (non-allowlisted funders with >= 3 funded callers)
  const byFunder = new Map<string, string[]>();
  for (const caller of callers) {
    const funder = caller.funder_account_id?.trim();
    if (!funder || allowlist.has(funder)) {
      continue;
    }
    const members = byFunder.get(funder);
    if (members) {
      members.push(caller.account_id);
    } else {
      byFunder.set(funder, [caller.account_id]);
    }
  }

  const h1Clusters: FunderClusterReport[] = [];
  for (const [funderId, members] of byFunder.entries()) {
    if (members.length < H1_MIN_CLUSTER_SIZE) continue;
    const sorted = [...members].sort(sortLex);
    const retained = sorted[0];
    const discounted = sorted.slice(1);
    for (const acc of discounted) {
      addReason(reasonsMap, acc, "H1_FUNDER_CLUSTER");
    }
    h1Clusters.push({
      funder_account_id: funderId,
      total_funded_callers: sorted.length,
      retained_account: retained,
      discounted_accounts: discounted,
    });
  }

  // H2: Ephemeral / Disposable Burner Accounts
  const h2Flagged = new Set<string>();
  for (const caller of callers) {
    const accountAgeAtFirstCall =
      caller.first_call_at_sec - caller.account_created_at_sec;
    if (
      accountAgeAtFirstCall <= H2_MAX_AGE_SECONDS &&
      caller.total_contracts_called === 1
    ) {
      h2Flagged.add(caller.account_id);
      addReason(reasonsMap, caller.account_id, "H2_EPHEMERAL_BURNER");
    }
  }

  // H3: Payload & Temporal Uniformity
  const h3Flagged = new Set<string>();

  // Condition 1: >= 8 distinct callers sharing identical non-empty args_hash & deposit_yocto within <= 300s
  interface BatchEvent {
    account_id: string;
    timestamp_sec: number;
  }
  const byPayload = new Map<string, BatchEvent[]>();
  for (const caller of callers) {
    for (const call of caller.calls) {
      if (!call.args_hash || call.args_hash.trim().length === 0) continue;
      const key = `${call.args_hash}\u0000${call.deposit_yocto}`;
      const list = byPayload.get(key);
      const evt: BatchEvent = {
        account_id: caller.account_id,
        timestamp_sec: call.timestamp_sec,
      };
      if (list) {
        list.push(evt);
      } else {
        byPayload.set(key, [evt]);
      }
    }
  }

  for (const events of byPayload.values()) {
    if (events.length < H3_BATCH_MIN_CALLERS) continue;
    events.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    const activeCounts = new Map<string, number>();
    let left = 0;

    for (let right = 0; right < events.length; right++) {
      const rightAcc = events[right].account_id;
      activeCounts.set(rightAcc, (activeCounts.get(rightAcc) ?? 0) + 1);

      while (
        events[right].timestamp_sec - events[left].timestamp_sec >
        H3_BATCH_WINDOW_SECONDS
      ) {
        const leftAcc = events[left].account_id;
        const nextCount = (activeCounts.get(leftAcc) ?? 1) - 1;
        if (nextCount <= 0) {
          activeCounts.delete(leftAcc);
        } else {
          activeCounts.set(leftAcc, nextCount);
        }
        left++;
      }

      if (activeCounts.size >= H3_BATCH_MIN_CALLERS) {
        for (const acc of activeCounts.keys()) {
          h3Flagged.add(acc);
          addReason(reasonsMap, acc, "H3_ROBOTIC_UNIFORMITY");
        }
      }
    }
  }

  // Condition 2: m >= 3 calls with robotic inter-arrival periodicity sigma <= 2.0s
  for (const caller of callers) {
    if (caller.calls.length < H3_MIN_PERIODIC_CALLS) continue;
    const timestamps = caller.calls
      .map((c) => c.timestamp_sec)
      .sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 0; i < timestamps.length - 1; i++) {
      deltas.push(timestamps[i + 1] - timestamps[i]);
    }
    const sigma = populationStdDev(deltas);
    if (sigma <= H3_MAX_SIGMA_SECONDS) {
      h3Flagged.add(caller.account_id);
      addReason(reasonsMap, caller.account_id, "H3_ROBOTIC_UNIFORMITY");
    }
  }

  const sybilDiscountedUsers = reasonsMap.size;
  const effectiveOrganicUsers = rawUsers - sybilDiscountedUsers;
  const scoreBps =
    rawUsers === 0
      ? 0
      : Math.floor((effectiveOrganicUsers / rawUsers) * 10000);
  const verdict: "VERIFIED" | "REJECTED" =
    scoreBps >= snapshot.min_score_bps ? "VERIFIED" : "REJECTED";

  const flaggedAccounts: FlaggedAccountReport[] = Array.from(
    reasonsMap.entries()
  ).map(([account_id, reasons]) => ({
    account_id,
    reasons: Array.from(reasons),
  }));

  return canonicalizeReport({
    schema_version: "polygraph-evidence-v1",
    claim_id: snapshot.claim_id,
    target_contract: snapshot.target_contract,
    block_window: {
      start_block: snapshot.start_block,
      end_block: snapshot.end_block,
    },
    thresholds: {
      min_score_bps: snapshot.min_score_bps,
    },
    metrics: {
      raw_users: rawUsers,
      effective_organic_users: effectiveOrganicUsers,
      sybil_discounted_users: sybilDiscountedUsers,
      score_bps: scoreBps,
      verdict,
    },
    heuristic_breakdown: {
      h1_funder_clusters: h1Clusters,
      h2_ephemeral_burners: Array.from(h2Flagged),
      h3_uniformity_flagged: Array.from(h3Flagged),
    },
    flagged_accounts: flaggedAccounts,
  });
}
