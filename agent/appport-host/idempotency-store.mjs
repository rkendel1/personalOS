import { createHash, randomUUID } from "node:crypto";

import { createFeltDB } from "@feltdb/core";

const COLLECTION = "idempotency";
const CLAIM_ATTEMPTS = 5;

const idOf = (key) => createHash("sha256").update(key).digest("hex");

function definedFields(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

function asEntry(row) {
  const base = definedFields({
    capability: row.capability,
    claimedAt: row.claimedAt,
    expiresAt: row.expiresAt,
    key: row.key,
    principalId: row.principalId,
    requestDigest: row.requestDigest,
    requestId: row.requestId,
    sessionId: row.sessionId,
    version: row.version,
  });
  if (row.status === "completed")
    return { ...base, response: row.response, storedAt: row.storedAt };
  return { ...base, status: "in-progress" };
}

export function createDurableIdempotencyStore({ fault = async () => {}, path }) {
  const owner = randomUUID();
  const db = createFeltDB({ namespace: "appport-idempotency", path });
  const rows = db.collection(COLLECTION);

  async function claim(entry) {
    const id = idOf(entry.key);
    const row = definedFields({
      ...entry,
      owner,
      response: null,
      status: "in-progress",
      updatedAt: new Date().toISOString(),
    });
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const current = await rows.get(id);
      if (current === null) {
        try {
          await rows.insert(row, id, { requireAbsent: true });
        } catch (error) {
          if ((await rows.get(id)) === null) throw error;
          continue;
        }
        await fault("claimed", entry);
        return "claimed";
      }
      if (current.status !== "released") return asEntry(current);
      const replaced = await rows.updateIfVersion(id, current.__version, row);
      if (replaced.updated) {
        await fault("claimed", entry);
        return "claimed";
      }
    }
    throw new Error(`Could not claim idempotency key after ${CLAIM_ATTEMPTS} attempts.`);
  }

  async function set(record) {
    await fault("completing", record);
    const id = idOf(record.key);
    const current = await rows.get(id);
    const row = definedFields({
      ...record,
      owner,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    if (current === null) {
      await rows.insert(row, id, { requireAbsent: true });
      return;
    }
    const ownClaim = current.status === "in-progress" && current.requestId === record.requestId;
    if (!ownClaim && current.status !== "released") {
      throw new Error(`Idempotency key is held by request ${current.requestId}; not overwritten.`);
    }
    const written = await rows.updateIfVersion(id, current.__version, row);
    if (!written.updated) throw new Error("Idempotency record changed while completing.");
  }

  async function release({ key, requestId }) {
    const id = idOf(key);
    const current = await rows.get(id);
    if (current === null || current.status !== "in-progress" || current.requestId !== requestId)
      return;
    await rows.updateIfVersion(id, current.__version, {
      status: "released",
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    async close() {
      await db.close?.();
    },
    claim,
    async findByRequestId(requestId) {
      const [row] = await rows.find({ requestId });
      return row === undefined || row.status === "released" ? undefined : asEntry(row);
    },
    async get(key) {
      const row = await rows.get(idOf(key));
      return row !== null && row.status === "completed" ? asEntry(row) : undefined;
    },
    owner,
    release,
    set,
  };
}
