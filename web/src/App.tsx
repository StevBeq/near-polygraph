import { useEffect, useMemo, useState } from "react";
import {
  DAO_CONTRACT_ID,
  GATE_CONTRACT_ID,
  NEARBLOCKS_TESTNET_URL,
  RECORDED_TESTNET_PROOFS,
  REPORT_PRESETS,
} from "./config";
import { fetchDaoProposal, fetchOnChainClaims } from "./nearRpc";
import type {
  DaoProposal,
  EvidenceReportArtifact,
  HeuristicReason,
  OnChainClaim,
} from "./types";

type ReasonFilter = "ALL" | HeuristicReason;

const REASON_LABELS: Record<HeuristicReason, string> = {
  H1_FUNDER_CLUSTER: "H1 Funder Cluster",
  H2_EPHEMERAL_BURNER: "H2 Ephemeral Burner",
  H3_ROBOTIC_UNIFORMITY: "H3 Robotic Uniformity",
};

function formatNearYocto(yocto: string): string {
  try {
    const val = BigInt(yocto);
    const whole = val / 10n ** 24n;
    const frac = (val % 10n ** 24n) / 10n ** 22n;
    return `${whole}.${frac.toString().padStart(2, "0")} NEAR`;
  } catch {
    return yocto;
  }
}

export default function App() {
  const [selectedId, setSelectedId] = useState<"sybil" | "organic">("sybil");
  const [reports, setReports] = useState<
    Partial<Record<"sybil" | "organic", EvidenceReportArtifact>>
  >({});
  const [reportError, setReportError] = useState<string | null>(null);
  const [onChainClaims, setOnChainClaims] = useState<OnChainClaim[]>([]);
  const [daoProposals, setDaoProposals] = useState<Record<number, DaoProposal>>({});
  const [rpcState, setRpcState] = useState<{
    mode: "loading" | "live" | "fallback";
    blockHeight: number | null;
    note: string;
  }>({
    mode: "loading",
    blockHeight: null,
    note: "Querying NEAR Testnet RPC...",
  });
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("ALL");
  const [copiedCli, setCopiedCli] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all(
      REPORT_PRESETS.map(async (preset) => {
        const res = await fetch(preset.reportUrl);
        if (!res.ok) {
          throw new Error(`Failed to load ${preset.reportUrl} (${res.status})`);
        }
        return [preset.id, (await res.json()) as EvidenceReportArtifact] as const;
      })
    )
      .then((entries) => {
        if (!active) return;
        const map: Partial<Record<"sybil" | "organic", EvidenceReportArtifact>> = {};
        for (const [id, data] of entries) {
          map[id] = data;
        }
        setReports(map);
      })
      .catch((err) => {
        if (!active) return;
        setReportError(err instanceof Error ? err.message : String(err));
      });

    fetchOnChainClaims()
      .then(async ({ claims, blockHeight }) => {
        if (!active) return;
        setOnChainClaims(claims);
        setRpcState({
          mode: "live",
          blockHeight,
          note: `Live NEAR Testnet RPC · ${GATE_CONTRACT_ID}${blockHeight ? ` (#${blockHeight})` : ""}`,
        });

        const proposalIds = claims
          .map((c) => c.dao_proposal_id)
          .filter((id): id is number => id !== null && id !== undefined);

        if (proposalIds.length > 0) {
          const settled = await Promise.allSettled(
            proposalIds.map(async (id) => [id, await fetchDaoProposal(id)] as const)
          );
          if (!active) return;
          const map: Record<number, DaoProposal> = {};
          for (const res of settled) {
            if (res.status === "fulfilled") {
              map[res.value[0]] = res.value[1];
            }
          }
          setDaoProposals(map);
        }
      })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        setRpcState({
          mode: "fallback",
          blockHeight: null,
          note: `Offline / Snapshot Fallback (${msg})`,
        });
      });

    return () => {
      active = false;
    };
  }, []);

  const activePreset =
    REPORT_PRESETS.find((p) => p.id === selectedId) ?? REPORT_PRESETS[0];
  const activeReport = reports[selectedId];

  const matchingChainClaim = useMemo(() => {
    if (!activeReport) return undefined;
    return onChainClaims.find((c) => c.claim_id === activeReport.claim_id);
  }, [onChainClaims, activeReport]);

  const matchingDaoProposal =
    matchingChainClaim?.dao_proposal_id != null
      ? daoProposals[matchingChainClaim.dao_proposal_id]
      : undefined;

  const filteredFlagged = useMemo(() => {
    if (!activeReport) return [];
    if (reasonFilter === "ALL") return activeReport.flagged_accounts;
    return activeReport.flagged_accounts.filter((item) =>
      item.reasons.includes(reasonFilter)
    );
  }, [activeReport, reasonFilter]);

  const cliCommand = `npm run verify:${activePreset.id}`;

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopiedCli(true);
      setTimeout(() => setCopiedCli(false), 1800);
    } catch {
      setCopiedCli(false);
    }
  };

  const scorePct = activeReport
    ? Math.min(100, Math.max(0, activeReport.metrics.score_bps / 100))
    : 0;
  const thresholdPct = activeReport
    ? Math.min(100, Math.max(0, activeReport.thresholds.min_score_bps / 100))
    : 70;
  const isVerified = activeReport?.metrics.verdict === "VERIFIED";

  const onChainHashMatches =
    Boolean(matchingChainClaim?.evidence_hash) &&
    Boolean(activeReport?.evidence_hash) &&
    matchingChainClaim?.evidence_hash === activeReport?.evidence_hash;

  const proofTx = activeReport
    ? RECORDED_TESTNET_PROOFS[activeReport.claim_id]
    : undefined;

  return (
    <main className="shell">
      <header className="header">
        <div>
          <div className="brand-eyebrow">
            near-polygraph · Sputnik DAO v2 Pre-Proposal Evidence Gate
          </div>
          <h1 className="brand-title">Polygraph Evidence Explorer</h1>
          <p className="brand-subtitle">
            Read-only cryptographic interrogation dashboard verifying grantee
            target-contract organic traction before unlocking on-chain Sputnik DAO{" "}
            <code>add_proposal</code> transfers.
          </p>
        </div>
        <div className="header-meta">
          <span
            className={`pill ${
              rpcState.mode === "live"
                ? "pill-verified"
                : rpcState.mode === "fallback"
                  ? "pill-warn"
                  : "pill-sky"
            }`}
          >
            {rpcState.note}
          </span>
          <div className="links-row">
            <a
              href={`${NEARBLOCKS_TESTNET_URL}/address/${GATE_CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              Gate: {GATE_CONTRACT_ID}
            </a>
            <a
              href={`${NEARBLOCKS_TESTNET_URL}/address/${DAO_CONTRACT_ID}`}
              target="_blank"
              rel="noreferrer"
            >
              DAO: {DAO_CONTRACT_ID}
            </a>
          </div>
        </div>
      </header>

      <section className="switcher" aria-label="Claim report switcher">
        {REPORT_PRESETS.map((preset) => {
          const rep = reports[preset.id];
          const isSelected = preset.id === selectedId;
          const activeClass = isSelected
            ? preset.id === "organic"
              ? "active-verified"
              : "active-rejected"
            : "";
          const badgeClass =
            rep?.metrics.verdict === "VERIFIED"
              ? "pill-verified"
              : "pill-rejected";
          return (
            <button
              key={preset.id}
              type="button"
              className={`switcher-btn ${activeClass}`}
              onClick={() => {
                setSelectedId(preset.id);
                setReasonFilter("ALL");
              }}
            >
              <div>
                <div className="switcher-title">{preset.label}</div>
                <div className="switcher-sub tabular">
                  {rep
                    ? `Blocks [${rep.block_window.start_block}..${rep.block_window.end_block}] · ${rep.metrics.raw_users} → ${rep.metrics.effective_organic_users} users`
                    : "Loading canonical report..."}
                </div>
              </div>
              <span className={`pill ${badgeClass}`}>
                {rep ? `${rep.metrics.score_bps} bps · ${rep.metrics.verdict}` : "..."}
              </span>
            </button>
          );
        })}
      </section>

      {reportError && (
        <section className="panel">
          <strong>Report Load Error:</strong> {reportError}
        </section>
      )}

      {activeReport && (
        <>
          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">
                Organic Traction Scorecard — Claim #{activeReport.claim_id} (
                <code>{activeReport.target_contract}</code>)
              </h2>
              <span
                className={`pill ${
                  isVerified ? "pill-verified" : "pill-rejected"
                }`}
              >
                {isVerified
                  ? "GATE PASSED → DAO PROPOSAL UNLOCKED"
                  : "GATE BLOCKED → DAO PROPOSAL PREVENTED"}
              </span>
            </div>

            <div className="scorecard-top">
              <div>
                <div
                  className="score-big tabular"
                  style={{
                    color: isVerified ? "var(--emerald)" : "var(--crimson)",
                  }}
                >
                  {activeReport.metrics.score_bps} bps
                </div>
                <div className="score-caption tabular">
                  {(activeReport.metrics.score_bps / 100).toFixed(2)}% Effective
                  Organic Ratio vs{" "}
                  <strong>{activeReport.thresholds.min_score_bps} bps</strong> (
                  {(activeReport.thresholds.min_score_bps / 100).toFixed(0)}%) DAO
                  Threshold
                </div>
              </div>

              <div style={{ paddingTop: "18px" }}>
                <div className="gauge-track">
                  <div
                    className="gauge-fill"
                    style={{
                      width: `${scorePct}%`,
                      background: isVerified
                        ? "linear-gradient(90deg, #059669, #10b981)"
                        : "linear-gradient(90deg, #b91c1c, #ef4444)",
                    }}
                  />
                  <div
                    className="gauge-threshold"
                    style={{ left: `${thresholdPct}%` }}
                  >
                    <span className="gauge-threshold-label">
                      DAO Min: {activeReport.thresholds.min_score_bps} bps
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Raw Unique Callers</div>
                <div className="stat-value tabular">
                  {activeReport.metrics.raw_users}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Effective Organic Users</div>
                <div
                  className="stat-value tabular"
                  style={{ color: "var(--emerald)" }}
                >
                  {activeReport.metrics.effective_organic_users}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Sybil Discounted</div>
                <div
                  className="stat-value tabular"
                  style={{ color: "var(--crimson)" }}
                >
                  {activeReport.metrics.sybil_discounted_users}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">On-Chain / DAO Outcome</div>
                <div className="stat-value tabular" style={{ fontSize: "15px" }}>
                  {matchingChainClaim
                    ? matchingChainClaim.dao_proposal_id !== null
                      ? `${matchingChainClaim.status} (Proposal #${matchingChainClaim.dao_proposal_id})`
                      : `${matchingChainClaim.status} (No Proposal)`
                    : isVerified
                      ? "Proposal Eligible (Passed Gate)"
                      : "Blocked Before DAO Call"}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">
                Sybil Interrogation Breakdown (H1 · H2 · H3)
              </h2>
              <span className="pill">
                CEX Allowlist Preserved: binancecold3.near, okx.near, testnet
              </span>
            </div>

            <div className="heuristics-grid">
              <div className="heuristic-card">
                <div className="heuristic-head">
                  <span className="heuristic-name">H1 · Funder Clustering</span>
                  <span className="pill">
                    {activeReport.heuristic_breakdown.h1_funder_clusters.length}{" "}
                    clusters
                  </span>
                </div>
                <p className="heuristic-desc">
                  Groups callers funded by the same non-exchange parent wallet (|Cf|
                  ≥ 3), retaining 1 representative account and discounting all
                  redundant clones.
                </p>
              </div>

              <div className="heuristic-card">
                <div className="heuristic-head">
                  <span className="heuristic-name">H2 · Ephemeral Burners</span>
                  <span className="pill">
                    {
                      activeReport.heuristic_breakdown.h2_ephemeral_burners
                        .length
                    }{" "}
                    flagged
                  </span>
                </div>
                <p className="heuristic-desc">
                  Flags disposable wallets created ≤ 3600s before first contract
                  call with total_contracts_called = 1.
                </p>
              </div>

              <div className="heuristic-card">
                <div className="heuristic-head">
                  <span className="heuristic-name">
                    H3 · Robotic Uniformity
                  </span>
                  <span className="pill">
                    {
                      activeReport.heuristic_breakdown.h3_uniformity_flagged
                        .length
                    }{" "}
                    flagged
                  </span>
                </div>
                <p className="heuristic-desc">
                  Flags ≥ 8 callers sending identical non-empty calldata + deposit
                  within 300s, or m ≥ 3 calls with inter-arrival σ ≤ 2.0s.
                </p>
              </div>
            </div>

            <h3
              style={{
                fontSize: "13px",
                margin: "18px 0 8px",
                color: "var(--text-secondary)",
              }}
            >
              Non-Exchange Funder Clusters (|Cf| ≥ 3)
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Parent Funder</th>
                    <th>Funded Callers</th>
                    <th>Retained Representative</th>
                    <th>Discounted Clones</th>
                  </tr>
                </thead>
                <tbody>
                  {activeReport.heuristic_breakdown.h1_funder_clusters.map(
                    (cluster) => (
                      <tr key={cluster.funder_account_id}>
                        <td className="mono">{cluster.funder_account_id}</td>
                        <td className="mono tabular">
                          {cluster.total_funded_callers}
                        </td>
                        <td
                          className="mono"
                          style={{ color: "var(--emerald)" }}
                        >
                          {cluster.retained_account}
                        </td>
                        <td>
                          <div className="tag-list">
                            {cluster.discounted_accounts
                              .slice(0, 6)
                              .map((acc) => (
                                <span key={acc} className="tag">
                                  {acc}
                                </span>
                              ))}
                            {cluster.discounted_accounts.length > 6 && (
                              <span className="tag">
                                +{cluster.discounted_accounts.length - 6} more (
                                {cluster.discounted_accounts.length} total)
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>

            <div className="panel-header" style={{ marginTop: "20px", marginBottom: "8px" }}>
              <h3
                style={{
                  fontSize: "13px",
                  margin: 0,
                  color: "var(--text-secondary)",
                }}
              >
                Discounted Accounts Ledger ({filteredFlagged.length})
              </h3>
              <div className="filter-row">
                {(
                  [
                    "ALL",
                    "H1_FUNDER_CLUSTER",
                    "H2_EPHEMERAL_BURNER",
                    "H3_ROBOTIC_UNIFORMITY",
                  ] as ReasonFilter[]
                ).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`filter-btn ${
                      reasonFilter === filter ? "active" : ""
                    }`}
                    onClick={() => setReasonFilter(filter)}
                  >
                    {filter === "ALL" ? "ALL" : REASON_LABELS[filter]}
                  </button>
                ))}
              </div>
            </div>

            <div className="table-wrap scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>Caller Account</th>
                    <th>Matched Sybil Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFlagged.map((item) => (
                    <tr key={item.account_id}>
                      <td className="mono">{item.account_id}</td>
                      <td>
                        <div className="tag-list">
                          {item.reasons.map((r) => (
                            <span key={r} className="tag">
                              {REASON_LABELS[r]}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">
                Deterministic SHA-256 Attestation & Testnet State
              </h2>
              {matchingChainClaim && (
                <span
                  className={`pill ${
                    onChainHashMatches ? "pill-verified" : "pill-warn"
                  }`}
                >
                  {onChainHashMatches
                    ? "ON-CHAIN HASH MATCH VERIFIED"
                    : "HASH PENDING / MISMATCH"}
                </span>
              )}
            </div>

            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <div className="stat-label" style={{ marginBottom: "6px" }}>
                  Canonical Evidence Report SHA-256 ({activeReport.schema_version})
                </div>
                <div className="hash-box">{activeReport.evidence_hash}</div>
              </div>

              {matchingChainClaim && (
                <div className="stats-grid" style={{ marginTop: 0 }}>
                  <div className="stat-card">
                    <div className="stat-label">On-Chain Submitter</div>
                    <div className="mono" style={{ fontSize: "12px", marginTop: "4px" }}>
                      {matchingChainClaim.submitter}
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Payout Recipient</div>
                    <div className="mono" style={{ fontSize: "12px", marginTop: "4px" }}>
                      {matchingChainClaim.recipient}
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Requested Payout / Bond</div>
                    <div className="mono tabular" style={{ fontSize: "12px", marginTop: "4px" }}>
                      {formatNearYocto(matchingChainClaim.requested_amount)} /{" "}
                      {formatNearYocto(matchingChainClaim.attached_bond)}
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Attested On-Chain Hash</div>
                    <div
                      className="mono"
                      style={{
                        fontSize: "11px",
                        marginTop: "4px",
                        wordBreak: "break-all",
                      }}
                    >
                      {matchingChainClaim.evidence_hash ?? "None"}
                    </div>
                  </div>
                </div>
              )}

              {matchingDaoProposal && (
                <div className="stat-card">
                  <div className="panel-header" style={{ marginBottom: "8px" }}>
                    <span className="stat-label">
                      Live Sputnik DAO v2 Proposal #{matchingDaoProposal.id} (
                      {DAO_CONTRACT_ID})
                    </span>
                    <span className="pill pill-verified">
                      Status: {matchingDaoProposal.status}
                    </span>
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      display: "grid",
                      gap: "4px",
                    }}
                  >
                    <div>
                      <strong>Proposer:</strong> {matchingDaoProposal.proposer}
                    </div>
                    {matchingDaoProposal.kind?.Transfer && (
                      <div>
                        <strong>Action::Transfer:</strong>{" "}
                        {formatNearYocto(
                          matchingDaoProposal.kind.Transfer.amount
                        )}{" "}
                        → {matchingDaoProposal.kind.Transfer.receiver_id}
                      </div>
                    )}
                    <div style={{ wordBreak: "break-word" }}>
                      <strong>Proposal Description:</strong>{" "}
                      {matchingDaoProposal.description}
                    </div>
                  </div>
                </div>
              )}

              {proofTx && (
                <div className="links-row">
                  <a
                    href={`${NEARBLOCKS_TESTNET_URL}/txns/${proofTx.submitTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View submit_claim Tx on NearBlocks ↗
                  </a>
                  <a
                    href={`${NEARBLOCKS_TESTNET_URL}/txns/${proofTx.attestTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View attest + DAO Callback Tx on NearBlocks ↗
                  </a>
                </div>
              )}

              <div>
                <div className="stat-label" style={{ marginBottom: "6px" }}>
                  Re-Verify Evidence Hash Locally (Zero API Keys Required)
                </div>
                <div className="cli-box">
                  <code className="cli-code">{cliCommand}</code>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={handleCopyCli}
                  >
                    {copiedCli ? "Copied" : "Copy CLI"}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
