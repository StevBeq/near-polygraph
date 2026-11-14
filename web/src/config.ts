import type { DemoProofTx } from "./types";

export const TESTNET_RPC_URL =
  import.meta.env.VITE_NEAR_TESTNET_RPC || "https://rpc.testnet.near.org";

export const GATE_CONTRACT_ID =
  import.meta.env.VITE_GATE_CONTRACT_ID || "polygraph-gate-v1.testnet";

export const DAO_CONTRACT_ID =
  import.meta.env.VITE_DAO_CONTRACT_ID || "polygraph-dao-v1.sputnikv2.testnet";

export const NEARBLOCKS_TESTNET_URL = "https://testnet.nearblocks.io";

export interface ReportPreset {
  id: "sybil" | "organic";
  claimId: number;
  label: string;
  reportUrl: string;
  fixtureCliPath: string;
  outCliPath: string;
}

export const REPORT_PRESETS: ReportPreset[] = [
  {
    id: "sybil",
    claimId: 0,
    label: "Claim #0 · sybil-dex.near",
    reportUrl: "/reports/sybil-report.json",
    fixtureCliPath: "../fixtures/sybil-contract.json",
    outCliPath: "../web/public/reports/sybil-report.json",
  },
  {
    id: "organic",
    claimId: 1,
    label: "Claim #1 · organic-dapp.near",
    reportUrl: "/reports/organic-report.json",
    fixtureCliPath: "../fixtures/organic-contract.json",
    outCliPath: "../web/public/reports/organic-report.json",
  },
];

export const RECORDED_TESTNET_PROOFS: Record<number, DemoProofTx> = {
  0: {
    claimId: 0,
    submitTx: "2uxXgc11wEoKBAgk6j5twKVGK3Xq7rybh94VvdDszoBh",
    attestTx: "5popKuBBZHhiRYdMGdBVCSBVmtLwtSwYGLgmM7awsNfy",
    notes: "Sybil claim blocked (1800 bps < 7000 bps); 0.1 NEAR bond refunded; no DAO proposal created.",
  },
  1: {
    claimId: 1,
    submitTx: "FJewY4eJKw4av8jFVDt6v6Qvh4DrwGZAvU6kFeuZdBxg",
    attestTx: "3LH2Ai6TEBbpFgNpNzYVFP3SS48dHKzqvEK6wqdGUNzN",
    notes: "Organic claim verified (8400 bps >= 7000 bps); Sputnik DAO v2 Proposal #1 created on polygraph-dao-v1.sputnikv2.testnet.",
  },
};
