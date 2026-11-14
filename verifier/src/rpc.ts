import { createHash } from "node:crypto";
import type {
  CallRecord,
  CallerRecord,
  ContractActivitySnapshot,
} from "./heuristics.js";

export const DEFAULT_MAINNET_RPC = "https://rpc.mainnet.near.org";
export const DEFAULT_ARCHIVAL_MAINNET_RPC =
  "https://archival-rpc.mainnet.near.org";
export const DEFAULT_EXCHANGE_FUNDERS = [
  "binancecold3.near",
  "okx.near",
  "testnet",
];

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: string | number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface RpcBlockResult {
  header: {
    height: number;
    timestamp_nanosec: string;
  };
  chunks: Array<{
    chunk_hash: string;
    shard_id: number;
  }>;
}

interface RpcFunctionCallAction {
  FunctionCall: {
    method_name: string;
    args: string;
    deposit: string;
    gas: number;
  };
}

interface RpcTransaction {
  signer_id: string;
  receiver_id: string;
  hash: string;
  actions: Array<RpcFunctionCallAction | Record<string, unknown>>;
}

interface RpcChunkResult {
  transactions?: RpcTransaction[];
}

export interface RpcFetchOptions {
  claimId: number;
  targetContract: string;
  startBlock?: number;
  endBlock?: number;
  minScoreBps: number;
  rpcUrl?: string;
  maxBlocks?: number;
  timeoutMs?: number;
}

export interface RpcFetchResult {
  snapshot: ContractActivitySnapshot;
  rpcUsed: string;
  blocksScanned: number;
  notes: string[];
}

export async function jsonRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown,
  timeoutMs = 10000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "polygraph-verifier",
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
    }
    const payload = (await res.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(
        `RPC error from ${rpcUrl}: ${payload.error.message ?? JSON.stringify(payload.error)}`
      );
    }
    if (payload.result === undefined) {
      throw new Error(`Empty RPC result from ${rpcUrl}`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRpcWithFallback<T>(
  urls: string[],
  method: string,
  params: unknown,
  timeoutMs = 10000
): Promise<{ result: T; rpcUrl: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const result = await jsonRpcCall<T>(url, method, params, timeoutMs);
      return { result, rpcUrl: url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${msg}`);
    }
  }
  throw new Error(`All NEAR RPC endpoints failed: ${errors.join(" | ")}`);
}

export async function fetchContractActivityFromRpc(
  opts: RpcFetchOptions
): Promise<RpcFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const maxBlocks = opts.maxBlocks ?? 10;
  const candidateUrls = Array.from(
    new Set(
      opts.rpcUrl
        ? [opts.rpcUrl, DEFAULT_MAINNET_RPC, DEFAULT_ARCHIVAL_MAINNET_RPC]
        : [DEFAULT_MAINNET_RPC, DEFAULT_ARCHIVAL_MAINNET_RPC]
    )
  );
  const notes: string[] = [];

  // 1. Verify contract account exists on the target network (read-only)
  const { rpcUrl: primaryRpc } = await jsonRpcWithFallback<Record<string, unknown>>(
    candidateUrls,
    "query",
    {
      request_type: "view_account",
      finality: "final",
      account_id: opts.targetContract,
    },
    timeoutMs
  );

  // 2. Determine pinned block window
  const finalBlock = await jsonRpcCall<RpcBlockResult>(
    primaryRpc,
    "block",
    { finality: "final" },
    timeoutMs
  );

  const endBlock = opts.endBlock ?? finalBlock.header.height;
  const rawStartBlock = opts.startBlock ?? Math.max(0, endBlock - 4);
  if (rawStartBlock > endBlock) {
    throw new Error(
      `Invalid block window: start_block (${rawStartBlock}) > end_block (${endBlock})`
    );
  }

  const totalRequested = endBlock - rawStartBlock + 1;
  let scanStart = rawStartBlock;
  if (totalRequested > maxBlocks) {
    scanStart = endBlock - maxBlocks + 1;
    notes.push(
      `Requested window (${totalRequested} blocks) exceeds raw JSON-RPC scan cap (${maxBlocks} blocks); scanned most recent pinned slice [${scanStart}, ${endBlock}] and preserved declared claim window [${rawStartBlock}, ${endBlock}].`
    );
  }

  const callerMap = new Map<string, CallerRecord>();
  let blocksScanned = 0;

  for (let height = scanStart; height <= endBlock; height++) {
    const { result: block } = await jsonRpcWithFallback<RpcBlockResult>(
      [primaryRpc, DEFAULT_ARCHIVAL_MAINNET_RPC],
      "block",
      { block_id: height },
      timeoutMs
    );
    blocksScanned++;
    const timestampSec = Math.floor(
      Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n)
    );

    const chunkResults = await Promise.all(
      block.chunks.map(async (chunkRef) => {
        try {
          const { result } = await jsonRpcWithFallback<RpcChunkResult>(
            [primaryRpc, DEFAULT_ARCHIVAL_MAINNET_RPC],
            "chunk",
            { chunk_id: chunkRef.chunk_hash },
            timeoutMs
          );
          return result;
        } catch {
          return { transactions: [] } as RpcChunkResult;
        }
      })
    );

    for (const chunk of chunkResults) {
      for (const tx of chunk.transactions ?? []) {
        if (tx.receiver_id !== opts.targetContract) continue;
        for (const action of tx.actions) {
          if (!("FunctionCall" in action)) continue;
          const fn = (action as RpcFunctionCallAction).FunctionCall;
          const argsHash = createHash("sha256")
            .update(Buffer.from(fn.args ?? "", "base64"))
            .digest("hex");

          const callRec: CallRecord = {
            tx_hash: tx.hash,
            block_height: height,
            timestamp_sec: timestampSec,
            method_name: fn.method_name,
            args_hash: `sha256:${argsHash}`,
            deposit_yocto: fn.deposit ?? "0",
          };

          const existing = callerMap.get(tx.signer_id);
          if (!existing) {
            // Raw JSON-RPC does not index historical parent funder or creation block;
            // assign unique synthetic unknown funder so H1 never false-positives on unindexed callers.
            callerMap.set(tx.signer_id, {
              account_id: tx.signer_id,
              funder_account_id: `unindexed:${tx.signer_id}`,
              account_created_at_sec: 0,
              first_call_at_sec: timestampSec,
              total_contracts_called: 2,
              calls: [callRec],
            });
          } else {
            existing.calls.push(callRec);
            existing.first_call_at_sec = Math.min(
              existing.first_call_at_sec,
              timestampSec
            );
          }
        }
      }
    }
  }

  notes.push(
    `Raw NEAR JSON-RPC read-only scan inspects blocks/chunks without an off-chain SQL account-creation indexer; callers discovered in RPC mode are protected against H1/H2 false positives unless backed by indexer telemetry.`
  );

  return {
    snapshot: {
      claim_id: opts.claimId,
      target_contract: opts.targetContract,
      start_block: rawStartBlock,
      end_block: endBlock,
      min_score_bps: opts.minScoreBps,
      known_exchange_funders: [...DEFAULT_EXCHANGE_FUNDERS],
      callers: Array.from(callerMap.values()),
    },
    rpcUsed: primaryRpc,
    blocksScanned,
    notes,
  };
}
