/**
 * The vendored stack-ui packages are an unmodified release: every file matches vendor/stack-ui/SHA256SUMS,
 * which is the release's own manifest (stack-ui releases/<version>/packages.SHA256SUMS), and the three
 * packages carry one version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VENDOR = join(import.meta.dirname, "..", "vendor", "stack-ui");

test("vendored stack-ui matches its checksums and is one release", () => {
  const lines = readFileSync(join(VENDOR, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const [digest, file] = line.split(/\s+/);
    const actual = createHash("sha256").update(readFileSync(join(VENDOR, file!))).digest("hex");
    assert.equal(actual, digest, `${file} was modified`);
  }
  const versions = ["tokens", "core", "react"].map((p) => JSON.parse(readFileSync(join(VENDOR, p, "package.json"), "utf8")).version);
  assert.equal(new Set(versions).size, 1, `one release: ${versions.join(", ")}`);
  assert.equal(versions[0], "0.8.1");
});
