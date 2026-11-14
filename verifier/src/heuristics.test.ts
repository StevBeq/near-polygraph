import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateSnapshot, ContractActivitySnapshot } from "./heuristics.js";
import { hashCanonicalReport } from "./canonical.js";

test("sybil-contract fixture evaluates to 1800 bps and REJECTED deterministically", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../fixtures/sybil-contract.json"),
    "utf8"
  );
  const snapshot = JSON.parse(raw) as ContractActivitySnapshot;
  const r1 = hashCanonicalReport(evaluateSnapshot(snapshot));
  const r2 = hashCanonicalReport(evaluateSnapshot(snapshot));

  assert.equal(r1.evidenceHash, r2.evidenceHash);
  assert.equal(r1.evidenceHash.length, 64);
  assert.equal(r1.report.metrics.raw_users, 50);
  assert.equal(r1.report.metrics.effective_organic_users, 9);
  assert.equal(r1.report.metrics.sybil_discounted_users, 41);
  assert.equal(r1.report.metrics.score_bps, 1800);
  assert.equal(r1.report.metrics.verdict, "REJECTED");
  assert.equal(r1.report.heuristic_breakdown.h1_funder_clusters.length, 2);
});

test("organic-contract fixture evaluates to 8400 bps and VERIFIED deterministically", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../fixtures/organic-contract.json"),
    "utf8"
  );
  const snapshot = JSON.parse(raw) as ContractActivitySnapshot;
  const r1 = hashCanonicalReport(evaluateSnapshot(snapshot));
  const r2 = hashCanonicalReport(evaluateSnapshot(snapshot));

  assert.equal(r1.evidenceHash, r2.evidenceHash);
  assert.equal(r1.evidenceHash.length, 64);
  assert.equal(r1.report.metrics.raw_users, 50);
  assert.equal(r1.report.metrics.effective_organic_users, 42);
  assert.equal(r1.report.metrics.sybil_discounted_users, 8);
  assert.equal(r1.report.metrics.score_bps, 8400);
  assert.equal(r1.report.metrics.verdict, "VERIFIED");
  // Exchange allowlist funders must not produce H1 clusters
  const h1Funders = r1.report.heuristic_breakdown.h1_funder_clusters.map(
    (c) => c.funder_account_id
  );
  assert.ok(!h1Funders.includes("binancecold3.near"));
  assert.ok(!h1Funders.includes("okx.near"));
});

test("canonical key sorting invariance produces identical SHA-256 regardless of caller input order", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../fixtures/organic-contract.json"),
    "utf8"
  );
  const snapshotA = JSON.parse(raw) as ContractActivitySnapshot;
  const snapshotB: ContractActivitySnapshot = {
    ...snapshotA,
    callers: [...snapshotA.callers].reverse().map((caller) => ({
      ...caller,
      calls: [...caller.calls].reverse(),
    })),
  };

  const hashA = hashCanonicalReport(evaluateSnapshot(snapshotA)).evidenceHash;
  const hashB = hashCanonicalReport(evaluateSnapshot(snapshotB)).evidenceHash;
  assert.equal(hashA, hashB);
});
