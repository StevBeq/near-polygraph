import { GATE_CONTRACT_ID, TESTNET_RPC_URL } from "./config";
import type { OnChainClaim } from "./types";

interface RpcCallFunctionResult {
  result?: number[];
  block_height?: number;
}

interface JsonRpcBody<T> {
  result?: T;
  error?: {
    message?: string;
    data?: unknown;
  };
}

function toBase64Json(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeByteArray(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export async function fetchOnChainClaims(
  contractId = GATE_CONTRACT_ID,
  rpcUrl = TESTNET_RPC_URL
): Promise<{ claims: OnChainClaim[]; blockHeight: number | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "polygraph-web",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: "list_claims",
          args_base64: toBase64Json({ from_index: 0, limit: 20 }),
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
    }

    const body = (await res.json()) as JsonRpcBody<RpcCallFunctionResult>;
    if (body.error || !body.result?.result) {
      throw new Error(
        body.error?.message || `No contract response for ${contractId}`
      );
    }

    const rawText = decodeByteArray(body.result.result);
    const claims = JSON.parse(rawText) as OnChainClaim[];
    return {
      claims,
      blockHeight: body.result.block_height ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
