/**
 * stack-ui is the published release: @stack-ui/core, react and tokens from npm, pinned to one exact version,
 * resolved from the registry with an integrity hash that npm checks on every install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("stack-ui is one published release, pinned, from the registry", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const versions = ["tokens", "core", "react"].map((name) => {
    const pinned = manifest.dependencies[`@stack-ui/${name}`];
    assert.match(pinned, /^\d+\.\d+\.\d+$/, `@stack-ui/${name} is pinned to an exact version`);
    const entry = lock.packages[`node_modules/@stack-ui/${name}`];
    assert.equal(entry?.version, pinned, `the lockfile resolves @stack-ui/${name} to ${pinned}`);
    assert.match(String(entry?.resolved), /^https:\/\/registry\.npmjs\.org\//, "from the registry, not a local copy");
    assert.match(String(entry?.integrity), /^sha512-/, "with an integrity hash npm checks on install");
    return pinned;
  });
  assert.equal(new Set(versions).size, 1, `one release: ${versions.join(", ")}`);
});
