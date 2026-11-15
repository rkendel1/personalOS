/**
 * delegation.set is not atomic (one grant, then the earlier grants revoked), so a run can stop
 * part-way and be retried. These tests drive feltkit/_delegation.ts `setGrants` against a grants store
 * that behaves as @authboundry/local does where it matters:
 *   - an identical grant still in force is returned as is, not made again;
 *   - list() shows only grants in force;
 *   - a revoke can be made to fail (the partial run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setGrants, type Grant, type Grants } from "../feltkit/_delegation.js";

function store(initial: Array<{ capabilities: string[]; expiresAt?: number | null }> = []) {
  let next = 0;
  const all: Array<Grant & { active: boolean }> = initial.map((g) => ({ id: `g${++next}`, capabilities: [...g.capabilities].sort(), expiresAt: g.expiresAt ?? null, active: true }));
  const calls = { grant: 0, revoke: [] as string[] };
  let failRevokeAt: number | null = null;
  const grants: Grants = {
    async list() {
      return all.filter((g) => g.active).map(({ id, capabilities, expiresAt }) => ({ id, capabilities, expiresAt }));
    },
    async grant({ capabilities, expiresAt }) {
      calls.grant += 1;
      const caps = [...new Set(capabilities)].sort();
      const exp = expiresAt ?? null;
      const current = all.find((g) => g.active && g.expiresAt === exp && g.capabilities.join(",") === caps.join(","));
      if (current) return { id: current.id, capabilities: current.capabilities, expiresAt: current.expiresAt };
      const made = { id: `g${++next}`, capabilities: caps, expiresAt: exp, active: true };
      all.push(made);
      return { id: made.id, capabilities: made.capabilities, expiresAt: made.expiresAt };
    },
    async revoke(id) {
      calls.revoke.push(id);
      if (failRevokeAt !== null && calls.revoke.length === failRevokeAt) throw new Error("authority unavailable");
      const g = all.find((x) => x.id === id);
      if (g) g.active = false;
    },
  };
  return { grants, calls, failRevokeOnCall: (n: number | null) => { failRevokeAt = n; }, inForce: () => grants.list() };
}
const caps = (gs: Grant[]) => gs.map((g) => [...g.capabilities].sort().join(",")).sort();

test("a retry where the new grant already exists keeps it and revokes only the earlier one", async () => {
  // State a partial run leaves: the new grant made, the old one not yet revoked.
  const s = store([{ capabilities: ["read"] }, { capabilities: ["read", "write"] }]);
  const result = await setGrants(s.grants, ["read", "write"], null);
  assert.deepEqual(result, { granted: ["read", "write"], changed: true });
  assert.deepEqual(caps(await s.inForce()), ["read,write"], "the grant now in force was revoked (the person is left with nothing)");
  assert.deepEqual(s.calls.revoke, ["g1"]);
});

test("a partial revoke, then a retry: the new capability is kept, every obsolete grant removed", async () => {
  const s = store([{ capabilities: ["read"] }, { capabilities: ["write"] }]);
  s.failRevokeOnCall(2); // the second revoke fails
  await assert.rejects(setGrants(s.grants, ["read", "research"], null), /authority unavailable/);
  assert.deepEqual(caps(await s.inForce()), ["read,research", "write"], "after the partial run: the new grant and one old one");
  s.failRevokeOnCall(null);
  const retry = await setGrants(s.grants, ["read", "research"], null);
  assert.deepEqual(retry, { granted: ["read", "research"], changed: true });
  assert.deepEqual(caps(await s.inForce()), ["read,research"], "the retry must keep the new grant and remove the obsolete one");
});

test("the newly granted capability is kept on first run, and obsolete grants are removed", async () => {
  const s = store([{ capabilities: ["read"] }]);
  const result = await setGrants(s.grants, ["write"], null);
  assert.deepEqual(result, { granted: ["write"], changed: true });
  assert.deepEqual(caps(await s.inForce()), ["write"]);
  assert.equal(s.calls.grant, 1);
});

test("granted and changed are accurate: already exactly that, nothing to clear, clear all, expiry changes", async () => {
  const same = store([{ capabilities: ["read", "write"] }]);
  assert.deepEqual(await setGrants(same.grants, ["write", "read"], null), { granted: ["write", "read"], changed: false });
  assert.equal(same.calls.grant + same.calls.revoke.length, 0, "no authority call when nothing changes");

  const none = store();
  assert.deepEqual(await setGrants(none.grants, [], null), { granted: [], changed: false });

  const clear = store([{ capabilities: ["read"] }, { capabilities: ["write"] }]);
  assert.deepEqual(await setGrants(clear.grants, [], null), { granted: [], changed: true });
  assert.deepEqual(await clear.inForce(), []);

  const expiry = store([{ capabilities: ["read"] }]);
  const until = Date.now() + 3_600_000;
  assert.deepEqual(await setGrants(expiry.grants, ["read"], until), { granted: ["read"], changed: true });
  const left = await expiry.inForce();
  assert.equal(left.length, 1);
  assert.equal(left[0]!.expiresAt, until, "the grant with the new expiry is the one kept");
});
