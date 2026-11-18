import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { decide } = await import("../agent/lib/reconcile.ts");

const original = { binding: "sha256:b", key: "op_1" };
const committed = (operation = original) => ({
  kind: "committed",
  operation,
  receipt: "res_1",
  reported: { ok: 1 },
});
const present = { evidence: "held", kind: "present" };
const absent = { evidence: "none", kind: "absent" };
const unavailable = { kind: "unavailable", reason: "down" };

describe("decide: Stack-Agent's reconciliation table (chip-agent-state/src/reconcile.rs)", () => {
  const rows = [
    ["committed, this key and binding, effect present", committed(), present, "completed"],
    ["committed, effect absent", committed(), absent, "indeterminate"],
    ["committed, effect unreadable", committed(), unavailable, "indeterminate"],
    ["committed, no business check", committed(), undefined, "indeterminate"],
    [
      "committed for another key",
      committed({ binding: "sha256:b", key: "op_2" }),
      present,
      "indeterminate",
    ],
    [
      "committed for another binding",
      committed({ binding: "sha256:x", key: "op_1" }),
      present,
      "indeterminate",
    ],
    [
      "not applied and barred, effect absent",
      { barred: true, basis: "fenced", kind: "not_applied" },
      absent,
      "not_executed",
    ],
    [
      "not applied and barred, effect present",
      { barred: true, basis: "fenced", kind: "not_applied" },
      present,
      "indeterminate",
    ],
    [
      "not applied and barred, effect unreadable",
      { barred: true, basis: "fenced", kind: "not_applied" },
      unavailable,
      "indeterminate",
    ],
    [
      "not applied, not barred",
      { barred: false, basis: "no record", kind: "not_applied" },
      absent,
      "indeterminate",
    ],
    ["unknown", { kind: "unknown", reason: "timeout" }, present, "indeterminate"],
  ];
  for (const [name, status, check, expected] of rows) {
    it(name, () => assert.equal(decide(original, status, check).kind, expected));
  }
});
