import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashCanonicalReport } from "./canonical.js";
import { ContractActivitySnapshot, evaluateSnapshot } from "./heuristics.js";
import { DEFAULT_MAINNET_RPC, fetchContractActivityFromRpc } from "./rpc.js";

interface CliArgs {
  mode: "offline" | "rpc";
  fixture?: string;
  fallbackFixture?: string;
  out?: string;
  contract?: string;
  claimId: number;
  startBlock?: number;
  endBlock?: number;
  minScoreBps: number;
  rpcUrl: string;
  maxBlocks: number;
  jsonOnly: boolean;
}

function printUsage(): void {
  console.log(`polygraph-verifier (near-polygraph off-chain Sybil engine)

Usage:
  Offline deterministic fixture verification:
    npm run verify -- --offline --fixture ../fixtures/sybil-contract.json [--out ../web/public/reports/sybil-report.json]

  Read-only NEAR Mainnet RPC inspection:
    npm run verify -- --rpc --contract wrap.near --start-block <H1> --end-block <H2> --min-score 7000
    (alias: --live supported identically to --rpc)

Options:
  --offline                   Evaluate a deterministic JSON snapshot (zero network calls)
  --rpc | --live              Query NEAR Mainnet JSON-RPC read-only
  --fixture <path>            Path to ContractActivitySnapshot JSON (required for --offline)
  --fallback-fixture <path>   Optional offline snapshot if public RPC blocks/times out
  --out <path>                Write canonical report JSON (+ evidence_hash) to disk
  --contract <account_id>     Target NEAR Mainnet contract account for --rpc/--live
  --claim-id <number>         Claim ID metadata for --rpc/--live (default: 0)
  --start-block <height>      Pinned start block height for --rpc/--live
  --end-block <height>        Pinned end block height for --rpc/--live
  --min-score <bps>           DAO threshold in basis points (default: 7000)
  --rpc-url <url>             Override NEAR RPC endpoint (default: ${DEFAULT_MAINNET_RPC})
  --max-blocks <n>            Max blocks scanned directly via raw RPC (default: 10)
  --json                      Print single compact JSON envelope to stdout
  -h, --help                  Show this help message
`);
}

function parseIntArg(flag: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`Invalid integer for ${flag}: ${value ?? "<missing>"}`);
  }
  return Number.parseInt(value, 10);
}

function parseArgs(argv: string[]): CliArgs {
  let mode: "offline" | "rpc" | undefined;
  let fixture: string | undefined;
  let fallbackFixture: string | undefined;
  let out: string | undefined;
  let contract: string | undefined;
  let claimId = 0;
  let startBlock: number | undefined;
  let endBlock: number | undefined;
  let minScoreBps = 7000;
  let rpcUrl = DEFAULT_MAINNET_RPC;
  let maxBlocks = 10;
  let jsonOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "--offline") {
      mode = "offline";
    } else if (arg === "--rpc" || arg === "--live") {
      mode = "rpc";
    } else if (arg === "--fixture") {
      fixture = argv[++i];
    } else if (arg === "--fallback-fixture") {
      fallbackFixture = argv[++i];
    } else if (arg === "--out") {
      out = argv[++i];
    } else if (arg === "--contract") {
      contract = argv[++i];
    } else if (arg === "--claim-id") {
      claimId = parseIntArg("--claim-id", argv[++i]);
    } else if (arg === "--start-block") {
      startBlock = parseIntArg("--start-block", argv[++i]);
    } else if (arg === "--end-block") {
      endBlock = parseIntArg("--end-block", argv[++i]);
    } else if (arg === "--min-score") {
      minScoreBps = parseIntArg("--min-score", argv[++i]);
    } else if (arg === "--rpc-url") {
      rpcUrl = argv[++i] ?? DEFAULT_MAINNET_RPC;
    } else if (arg === "--max-blocks") {
      maxBlocks = parseIntArg("--max-blocks", argv[++i]);
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (!arg.startsWith("-") && arg.endsWith(".json")) {
      // PowerShell strips `--` in `npm run verify -- ...`, turning flag values into positionals
      if (!fixture) {
        fixture = arg;
        mode = mode ?? "offline";
      } else if (!out) {
        out = arg;
      } else {
        throw new Error(`Unexpected JSON positional argument: ${arg}`);
      }
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (process.env.npm_config_offline === "true" && !mode) {
    mode = "offline";
  }

  if (!mode) {
    mode = fixture ? "offline" : "rpc";
  }

  if (mode === "offline" && !fixture) {
    throw new Error("--offline mode requires --fixture <path>");
  }
  if (mode === "rpc" && !contract) {
    throw new Error("--rpc / --live mode requires --contract <account_id>");
  }

  return {
    mode,
    fixture,
    fallbackFixture,
    out,
    contract,
    claimId,
    startBlock,
    endBlock,
    minScoreBps,
    rpcUrl,
    maxBlocks,
    jsonOnly,
  };
}

function loadSnapshotFromFile(filePath: string): ContractActivitySnapshot {
  const absPath = resolve(process.cwd(), filePath);
  const raw = readFileSync(absPath, "utf8");
  const parsed = JSON.parse(raw) as ContractActivitySnapshot;
  if (
    typeof parsed.claim_id !== "number" ||
    typeof parsed.target_contract !== "string" ||
    !Array.isArray(parsed.callers)
  ) {
    throw new Error(`Invalid ContractActivitySnapshot JSON at ${absPath}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let snapshot: ContractActivitySnapshot;
  const runtimeNotes: string[] = [];
  let sourceLabel = "offline-fixture";

  if (args.mode === "offline") {
    snapshot = loadSnapshotFromFile(args.fixture!);
    sourceLabel = `offline:${args.fixture}`;
  } else {
    try {
      const rpcRes = await fetchContractActivityFromRpc({
        claimId: args.claimId,
        targetContract: args.contract!,
        startBlock: args.startBlock,
        endBlock: args.endBlock,
        minScoreBps: args.minScoreBps,
        rpcUrl: args.rpcUrl,
        maxBlocks: args.maxBlocks,
      });
      snapshot = rpcRes.snapshot;
      sourceLabel = `rpc:${rpcRes.rpcUsed} (${rpcRes.blocksScanned} blocks scanned)`;
      runtimeNotes.push(...rpcRes.notes);
    } catch (err) {
      if (args.fallbackFixture) {
        const msg = err instanceof Error ? err.message : String(err);
        runtimeNotes.push(
          `RPC unavailable (${msg}); fell back to offline snapshot ${args.fallbackFixture}`
        );
        snapshot = loadSnapshotFromFile(args.fallbackFixture);
        sourceLabel = `fallback-offline:${args.fallbackFixture}`;
      } else {
        throw err;
      }
    }
  }

  const rawReport = evaluateSnapshot(snapshot);
  const { report, canonicalJson, evidenceHash } = hashCanonicalReport(rawReport);

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    // Store canonical report alongside top-level verification metadata for web/inspector convenience.
    // Note: evidence_hash is always the SHA-256 of the pure CanonicalEvidenceReport (canonical_report).
    const artifact = {
      ...report,
      evidence_hash: evidenceHash,
    };
    writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(
      JSON.stringify({
        source: sourceLabel,
        evidence_hash: evidenceHash,
        canonical_bytes: Buffer.byteLength(canonicalJson, "utf8"),
        report,
        notes: runtimeNotes,
      })
    );
    return;
  }

  console.log("=== POLYGRAPH OFF-CHAIN VERIFIER ===");
  console.log(`Source           : ${sourceLabel}`);
  console.log(`Claim ID         : #${report.claim_id}`);
  console.log(`Target Contract  : ${report.target_contract}`);
  console.log(
    `Block Window     : [${report.block_window.start_block}, ${report.block_window.end_block}]`
  );
  console.log(`Raw Callers      : ${report.metrics.raw_users}`);
  console.log(`Effective Organic: ${report.metrics.effective_organic_users}`);
  console.log(`Sybil Discounted : ${report.metrics.sybil_discounted_users}`);
  console.log(
    `Organic Score    : ${report.metrics.score_bps} bps (${(report.metrics.score_bps / 100).toFixed(2)}%)`
  );
  console.log(`DAO Threshold    : ${report.thresholds.min_score_bps} bps`);
  console.log(`Verdict          : ${report.metrics.verdict}`);
  console.log(
    `H1 Clusters (>=3): ${report.heuristic_breakdown.h1_funder_clusters.length}`
  );
  for (const cluster of report.heuristic_breakdown.h1_funder_clusters) {
    console.log(
      `  - ${cluster.funder_account_id}: funded=${cluster.total_funded_callers}, kept=${cluster.retained_account}, discounted=${cluster.discounted_accounts.length}`
    );
  }
  console.log(
    `H2 Burners       : ${report.heuristic_breakdown.h2_ephemeral_burners.length}`
  );
  console.log(
    `H3 Uniformity    : ${report.heuristic_breakdown.h3_uniformity_flagged.length}`
  );
  console.log(`SHA-256 Evidence : ${evidenceHash}`);
  const attestArgs = JSON.stringify({
    claim_id: report.claim_id,
    score_bps: report.metrics.score_bps,
    raw_users: report.metrics.raw_users,
    effective_users: report.metrics.effective_organic_users,
    evidence_hash: evidenceHash,
  });
  console.log(
    `Attest CLI Cmd   : near call polygraph-gate-v1.testnet attest '${attestArgs}' --accountId polygraph-ops-v1.testnet --gas 150000000000000 --networkId testnet`
  );
  if (args.out) {
    console.log(`Saved Report     : ${args.out}`);
  }
  for (const note of runtimeNotes) {
    console.log(`Note             : ${note}`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[polygraph-verifier] ERROR: ${message}`);
  process.exit(1);
});
