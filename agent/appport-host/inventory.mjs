import { createHash } from "node:crypto";

import { createFeltDB } from "@feltdb/core";

const ITEMS = "items";
const RESERVATIONS = "reservations";
const ATTEMPTS = 5;

export const reservationIdFor = (scopedKey) =>
  `res_${createHash("sha256").update(scopedKey).digest("hex").slice(0, 40)}`;

const plain = (row) => {
  if (row === null || row === undefined) return null;
  const { __version, id: _id, ...rest } = row;
  return rest;
};

export class InventoryRefusal extends Error {
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export async function openInventory({ path, seed }) {
  const db = createFeltDB({ namespace: "inventory", path });
  const items = db.collection(ITEMS);
  const reservations = db.collection(RESERVATIONS);
  for (const item of seed) {
    if ((await items.get(item.sku)) !== null) continue;
    try {
      await items.insert({ ...item, reserved: 0 }, item.sku, { requireAbsent: true });
    } catch (error) {
      if ((await items.get(item.sku)) === null) throw error;
    }
  }

  async function reserve(request) {
    const id = reservationIdFor(request.scopedKey);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const existing = await reservations.get(id);
      if (existing !== null) {
        if (existing.sku !== request.sku || existing.quantity !== request.quantity)
          throw new InventoryRefusal(
            "CONFLICT",
            "IDEMPOTENCY_KEY_REUSED",
            "This key reserved something else.",
          );
        return plain(existing);
      }
      const item = await items.get(request.sku);
      if (item === null)
        throw new InventoryRefusal(
          "NOT_FOUND",
          "UNKNOWN_SKU",
          `No catalog item has SKU ${request.sku}.`,
        );
      if (item.quantity < request.quantity)
        throw new InventoryRefusal(
          "INVALID_REQUEST",
          "INSUFFICIENT_STOCK",
          `Only ${item.quantity} units of ${request.sku} are available.`,
        );
      const reservation = {
        agent: request.agent,
        created_at: new Date().toISOString(),
        delegation_id: request.delegationId,
        idempotency_key: request.idempotencyKey,
        principal: request.principal,
        quantity: request.quantity,
        request_id: request.requestId,
        reservation_id: id,
        scoped_key: request.scopedKey,
        sku: request.sku,
        status: "held",
      };
      try {
        await db.transaction((tx) => {
          tx.collection(ITEMS).set(
            request.sku,
            {
              name: item.name,
              quantity: item.quantity - request.quantity,
              reserved: item.reserved + request.quantity,
              sku: item.sku,
            },
            { ifVersion: item.__version },
          );
          tx.collection(RESERVATIONS).insert(reservation, id, { requireAbsent: true });
        });
        return reservation;
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
      }
    }
    throw new Error("unreachable");
  }

  async function release(reservationId) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const reservation = await reservations.get(reservationId);
      if (reservation === null || reservation.status !== "held") return plain(reservation);
      const item = await items.get(reservation.sku);
      try {
        await db.transaction((tx) => {
          tx.collection(ITEMS).set(
            item.sku,
            {
              name: item.name,
              quantity: item.quantity + reservation.quantity,
              reserved: item.reserved - reservation.quantity,
              sku: item.sku,
            },
            { ifVersion: item.__version },
          );
          tx.collection(RESERVATIONS).set(
            reservationId,
            { ...plain(reservation), released_at: new Date().toISOString(), status: "released" },
            { ifVersion: reservation.__version },
          );
        });
        return plain(await reservations.get(reservationId));
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
      }
    }
    throw new Error("unreachable");
  }

  return {
    async close() {
      await db.close?.();
    },
    item: async (sku) => plain(await items.get(sku)),
    release,
    reservation: async (scopedKey) => plain(await reservations.get(reservationIdFor(scopedKey))),
    reserve,
  };
}
