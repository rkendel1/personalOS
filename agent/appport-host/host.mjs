import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startLocalAuthority } from "@authboundry/local";
import { AppPortError, createApplication, createServer, defineCapability, s } from "@appport/sdk";
import { serve } from "@appport/sdk/node";

import { createDurableIdempotencyStore } from "./idempotency-store.mjs";
import { InventoryRefusal, openInventory } from "./inventory.mjs";

export const APPLICATION_ID = "inventory";
export const AGENT_ID = "agent:appport-agent";
const here = (file) => new URL(file, import.meta.url);

function readSecret(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

function writeSecret(file, value) {
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

function sameSecret(presented, held) {
  if (typeof presented !== "string" || typeof held !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(held);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startInventoryHost({
  extraCapabilities = [],
  extraPermissions = [],
  idempotencyFault,
  adminSecret,
  agentCredentialFile,
  authorityLogger,
  dataDir,
  host = "127.0.0.1",
  port = 4317,
  provenanceFile,
}) {
  const permissions = ["catalog.read", "catalog.reserve", ...extraPermissions];
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const checkCredentialFile = join(dataDir, "check-credential");
  const record = (entry) =>
    appendFileSync(
      provenanceFile,
      `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
    );

  const idempotency = createDurableIdempotencyStore({
    fault: idempotencyFault,
    path: join(dataDir, "idempotency"),
  });
  const inventory = await openInventory({
    path: join(dataDir, "inventory"),
    seed: JSON.parse(readFileSync(here("./catalog.json"), "utf8")).items,
  });

  const authority = await startLocalAuthority({
    adminSecret,
    agents: [
      {
        capabilities: permissions,
        credential: readSecret(agentCredentialFile),
        id: AGENT_ID,
        name: "eve AppPort agent",
        onCredential: (secret) => writeSecret(agentCredentialFile, secret),
      },
    ],
    application: { capabilities: permissions, id: APPLICATION_ID, name: "Inventory" },
    checkCredential: readSecret(checkCredentialFile),
    dataDir: join(dataDir, "authority"),
    executor: { id: `agent:${APPLICATION_ID}`, name: "Inventory" },
    ...(authorityLogger ? { logger: authorityLogger } : {}),
  });
  if (authority.issuedCheckCredential) writeSecret(checkCredentialFile, authority.checkCredential);
  if (authority.registeredAgents[0].issuedAgentCredential)
    writeSecret(agentCredentialFile, authority.registeredAgents[0].agentCredential);

  const delegatedAuthority = {
    name: "authboundry",
    async authorize({ capability, principal, requestId, required, session }) {
      if (required.length === 0) return { allowed: true };
      const agent = principal?.attributes?.agent;
      if (principal === undefined || agent !== AGENT_ID)
        return { allowed: false, code: "UNAUTHORIZED", reason: "No proven agent." };
      const decisions = [];
      for (const permission of required) {
        const answer = await authority.check(permission, principal.id, { agent }).catch((error) => {
          record({
            capability: capability.name,
            error: error.message,
            kind: "authorization",
            onBehalfOf: principal.id,
            agent,
            requestId,
            decision: "unavailable",
          });
          throw new AppPortError("INTERNAL_ERROR", "The delegation authority is unavailable.");
        });
        const body = answer.body ?? {};
        record({
          agent: body.executor?.principal_id ?? agent,
          authority: { application: APPLICATION_ID, kind: "authboundry", tenant: authority.tenant },
          capability: capability.name,
          decision: body.decision ?? `http_${answer.status}`,
          decisionId: body.decision_id ?? null,
          delegationId: body.delegation_id ?? null,
          kind: "authorization",
          onBehalfOf: principal.id,
          permission,
          reason: body.reason ?? null,
          requestId,
        });
        if (answer.status !== 200 || body.decision !== "allow")
          return {
            allowed: false,
            code: "FORBIDDEN",
            reason: body.reason ?? `authority answered ${answer.status}`,
          };
        decisions.push(body);
      }
      return {
        allowed: true,
        decision: {
          authorizer: "authboundry",
          capability,
          decisionId: decisions[0].decision_id,
          evidenceId: decisions[0].delegation_id,
          principalId: principal.id,
          sessionId: session?.id,
        },
      };
    },
  };

  const catalogLookup = defineCapability({
    name: "catalog.lookup",
    version: 1,
    description: "Reads one catalog item by SKU. Read-only.",
    effect: "observation",
    authorization: ["catalog.read"],
    input: s.object({ sku: s.string() }),
    output: s.object({ sku: s.string(), name: s.string(), quantity: s.integer() }),
    async handler({ sku }, ctx) {
      record({
        capability: "catalog.lookup",
        delegationId: ctx.authorizationDecision?.evidenceId ?? null,
        kind: "execution",
        onBehalfOf: ctx.principal?.id ?? null,
        requestId: ctx.requestId,
      });
      const item = await inventory.item(sku);
      if (item === null) throw new Error(`No catalog item has SKU ${sku}.`);
      return { name: item.name, quantity: item.quantity, sku: item.sku };
    },
  });

  const scopedKey = (ctx, key) => `${ctx.session?.id ?? "anonymous"}|catalog.reserve@1|${key}`;

  const catalogReserve = defineCapability({
    name: "catalog.reserve",
    version: 1,
    description:
      "Reserves units of one catalog item for the requesting person; the reserved units are no longer available. Requires an idempotencyKey: one key reserves at most once.",
    effect: "consequential",
    idempotency: "supported",
    authorization: ["catalog.reserve"],
    input: s.object({ quantity: s.integer(), sku: s.string() }),
    output: s.object({
      quantity: s.integer(),
      remaining: s.integer(),
      reservation_id: s.string(),
      sku: s.string(),
    }),
    async handler({ quantity, sku }, ctx) {
      if (ctx.idempotencyKey === undefined)
        throw new AppPortError("INVALID_REQUEST", "catalog.reserve requires an idempotencyKey.", {
          details: { reason: "IDEMPOTENCY_KEY_REQUIRED" },
        });
      if (!Number.isInteger(quantity) || quantity < 1)
        throw new AppPortError("INVALID_INPUT", "quantity must be a positive integer.");
      let reservation;
      try {
        reservation = await inventory.reserve({
          agent: ctx.principal?.attributes?.agent ?? null,
          delegationId: ctx.authorizationDecision?.evidenceId ?? null,
          idempotencyKey: ctx.idempotencyKey,
          principal: ctx.principal?.id ?? null,
          quantity,
          requestId: ctx.requestId,
          scopedKey: scopedKey(ctx, ctx.idempotencyKey),
          sku,
        });
      } catch (error) {
        if (error instanceof InventoryRefusal)
          throw new AppPortError(error.code, error.message, { details: { reason: error.reason } });
        throw error;
      }
      record({
        capability: "catalog.reserve",
        delegationId: reservation.delegation_id,
        kind: "execution",
        onBehalfOf: reservation.principal,
        requestId: ctx.requestId,
        reservationId: reservation.reservation_id,
      });
      const item = await inventory.item(sku);
      return {
        quantity: reservation.quantity,
        remaining: item.quantity,
        reservation_id: reservation.reservation_id,
        sku: reservation.sku,
      };
    },
  });

  const catalogReservation = defineCapability({
    name: "catalog.reservation",
    version: 1,
    description:
      "Reports, for one idempotency key of the caller, whether catalog.reserve applied it and whether the reservation is held. Read-only; it never reserves.",
    effect: "observation",
    authorization: ["catalog.read"],
    input: s.object({ key: s.string() }),
    output: s.unknown(),
    async handler({ key }, ctx) {
      const reservation = await inventory.reservation(scopedKey(ctx, key));
      if (reservation === null) {
        return {
          business: { evidence: "no reservation exists for this key", kind: "absent" },
          status: {
            barred: false,
            basis: "no reservation was recorded for this key",
            kind: "not_applied",
          },
        };
      }
      const item = await inventory.item(reservation.sku);
      const held =
        reservation.status === "held" && item !== null && item.reserved >= reservation.quantity;
      return {
        business: held
          ? {
              evidence: `${reservation.quantity} of ${reservation.sku} held as ${reservation.reservation_id}; ${item.reserved} reserved in total`,
              kind: "present",
            }
          : {
              evidence: `reservation ${reservation.reservation_id} is ${reservation.status}`,
              kind: "absent",
            },
        status: {
          kind: "committed",
          operation: {
            input: { quantity: reservation.quantity, sku: reservation.sku },
            key: reservation.idempotency_key,
          },
          receipt: reservation.reservation_id,
          reported: {
            quantity: reservation.quantity,
            remaining: item?.quantity ?? null,
            reservation_id: reservation.reservation_id,
            sku: reservation.sku,
          },
        },
      };
    },
  });

  const application = createApplication({
    application: { id: APPLICATION_ID, name: "Inventory", version: "1.0.0" },
    authorizer: delegatedAuthority,
    capabilities: [catalogLookup, catalogReserve, catalogReservation, ...extraCapabilities],
    idempotency,
    mode: "production",
    telemetry: { record: (entry) => record({ ...entry, kind: "request" }) },
  });

  const server = createServer({
    application,
    authenticate({ headers }) {
      const presented = /^Bearer (.+)$/u.exec(headers?.authorization ?? "")?.[1];
      const onBehalfOf = headers?.["x-appport-on-behalf-of"];
      if (!sameSecret(presented, authority.agentCredentialOf(AGENT_ID))) return {};
      if (typeof onBehalfOf !== "string" || onBehalfOf.length === 0) return {};
      const principal = { attributes: { agent: AGENT_ID }, id: onBehalfOf, type: "user" };
      const session = {
        applicationId: APPLICATION_ID,
        createdAt: new Date().toISOString(),
        id: `agent_${createHash("sha256").update(`${AGENT_ID}\n${onBehalfOf}`).digest("hex").slice(0, 32)}`,
        principal,
      };
      return { principal, session };
    },
  });

  const running = await serve({ host, port, server, websocket: false });
  return {
    authority,
    idempotency,
    inventory,
    async close() {
      await running.close();
      await authority.close();
      await idempotency.close();
      await inventory.close();
    },
    url: running.url,
  };
}
