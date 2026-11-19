/**
 * Connections: the person's own accounts Anywhere Aide works with (email, calendar). Two separate
 * things, both the person's, both shown in Settings → Connections:
 *
 *   connection  their Google account, connected through FeltKit (OAuth with PKCE, `owner: "person"`):
 *               FeltKit keeps the grant, renews and revokes it; the app never sees a token.
 *   authority   what they allow Anywhere Aide to do with it (mail.read, mail.send, calendar.read,
 *               calendar.write), granted in AuthBoundry to its executor and decided at every call.
 *
 * Connecting grants that connection's capabilities, in the same step, because the button says so;
 * disconnecting withdraws them. Each can be changed on its own afterwards. A send or a new event is
 * still proposed and approved one at a time in the chat.
 */
import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { setGrants } from "./_delegation.js";

export const CONNECTIONS = {
  mail: { name: "Email", provider: "Gmail", capabilities: { "mail.read": "Read your email (sender, subject, snippet)", "mail.send": "Send email you approve" } },
  calendar: { name: "Calendar", provider: "Google Calendar", capabilities: { "calendar.read": "See your calendar", "calendar.write": "Add events you approve" } },
} as const;
export type ConnectionId = keyof typeof CONNECTIONS;
/** Every capability a connection can be granted (AuthBoundry; feltkit/app.ts operations' `authority`). */
export const CONNECTION_CAPABILITIES = Object.values(CONNECTIONS).flatMap((c) => Object.keys(c.capabilities));
const ID = s.enum(["mail", "calendar"] as const);

type GrantsApi = Parameters<typeof setGrants>[0];
const grantsOf = (ctx: { authority: { grants: unknown } }) => ctx.authority.grants as GrantsApi;

/** The executor grants now in force: capabilities and the expiry they share (null when none or unknown). */
async function inForce(grants: GrantsApi): Promise<{ capabilities: Set<string>; expiresAt: number | null }> {
  const mine = (await grants.list()).filter((g) => (g.agent ?? null) === null);
  return { capabilities: new Set(mine.flatMap((g) => g.capabilities)), expiresAt: mine[0]?.expiresAt ?? null };
}

/** Add or withdraw capabilities, keeping every other grant the person made to Anywhere Aide as it is. */
async function changeGrants(ctx: { authority: { grants: unknown } }, add: string[], remove: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const grants = grantsOf(ctx);
    const now = await inForce(grants);
    for (const c of add) now.capabilities.add(c);
    for (const c of remove) now.capabilities.delete(c);
    await setGrants(grants, [...now.capabilities], now.expiresAt);
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "UNAVAILABLE" || code === "FAILED_PRECONDITION") return { ok: false, reason: (error as Error).message };
    throw error;
  }
}

/** Each connection: connected or not, and what the person allows done with it. Never a token. */
export const list = app.action({
  access: "connections.read",
  handler: async (ctx) => {
    const states = new Map((await ctx.integrations.connections.list()).map((c) => [c.integration, c]));
    let granted: Set<string> | null = null;
    let reason: string | null = null;
    try {
      granted = (await inForce(grantsOf(ctx))).capabilities;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "UNAVAILABLE" && code !== "FAILED_PRECONDITION" && code !== "SETUP_FAILED") throw error;
      reason = (error as Error).message;
    }
    return {
      grantsAvailable: granted !== null,
      grantsReason: reason,
      connections: (Object.keys(CONNECTIONS) as ConnectionId[]).map((id) => {
        const c = states.get(id);
        return {
          id,
          name: CONNECTIONS[id].name,
          provider: CONNECTIONS[id].provider,
          state: (c?.state ?? "not_connected") as "not_connected" | "connected" | "reconnect_required",
          connectedAt: c?.connectedAt ?? null,
          problem: c?.failure?.message ?? null,
          capabilities: Object.entries(CONNECTIONS[id].capabilities).map(([capability, label]) => ({ id: capability, label, granted: granted?.has(capability) ?? false })),
        };
      }),
    };
  },
});

/**
 * Start connecting: grants that connection's capabilities, then returns Google's page to open. If this
 * server has no Google client configured, it says exactly that instead (nothing is granted).
 */
export const connect = app.action({
  access: "connections.write",
  args: { id: ID },
  handler: async (ctx, { id }) => {
    let started: { url: string; expiresAt: string };
    try {
      started = await ctx.integrations.connections.connect(id);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === "CONFIGURATION" || e.code === "FAILED_PRECONDITION" || e.code === "CUSTODY_READ_ONLY")
        return { url: null, configured: false as const, reason: `${CONNECTIONS[id].provider} isn't set up on this server yet: ${e.message ?? e.code}`, grant: null };
      throw error;
    }
    const grant = await changeGrants(ctx, Object.keys(CONNECTIONS[id].capabilities), []);
    return { url: started.url, configured: true as const, reason: null, grant: grant.ok ? null : grant.reason };
  },
});

/** Disconnect: Google is asked to revoke the tokens, FeltKit forgets them, and the capabilities are withdrawn. */
export const disconnect = app.action({
  access: "connections.write",
  args: { id: ID },
  handler: async (ctx, { id }) => {
    const done = await ctx.integrations.connections.disconnect(id);
    const grant = await changeGrants(ctx, [], Object.keys(CONNECTIONS[id].capabilities));
    return { ...done, grant: grant.ok ? null : grant.reason };
  },
});

/** Allow or withdraw one capability of a connection, leaving every other grant as it is. */
export const allow = app.action({
  access: "connections.write",
  args: { capability: s.string({ maxLength: 60 }), allowed: s.boolean() },
  handler: async (ctx, { capability, allowed }) => {
    if (!CONNECTION_CAPABILITIES.includes(capability)) fail("INVALID_ARGUMENT", `Not a connection capability: ${capability}`);
    const r = await changeGrants(ctx, allowed ? [capability] : [], allowed ? [] : [capability]);
    if (!r.ok) fail("FAILED_PRECONDITION", r.reason);
    return { capability, allowed };
  },
});
