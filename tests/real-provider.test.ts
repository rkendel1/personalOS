/**
 * The acceptance conversation against a real model: OpenAI's gpt-4.1-mini through Vercel AI Gateway
 * (OpenAI-compatible; FeltKit's "custom" provider) when AI_GATEWAY_API_KEY is set, else OpenAI with
 * OPENAI_API_KEY. The key goes to FeltKit's credential custody as FELTKIT_CREDENTIAL_<ID> and is
 * checked to appear in no record. Skipped, with the reason, when no key is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { clockFor } from "../feltkit/_clock.js";
import { addDays } from "../feltkit/_dates.js";

const ZONE = "America/New_York";
const REAL = process.env.AI_GATEWAY_API_KEY
  ? { variable: "FELTKIT_CREDENTIAL_AI_GATEWAY", key: process.env.AI_GATEWAY_API_KEY, selection: { provider: "custom", model: process.env.PERSONALOS_TEST_MODEL ?? "openai/gpt-4.1-mini", endpoint: "https://ai-gateway.vercel.sh/v1", credentialRef: "credential-ref:ai-gateway" } }
  : process.env.OPENAI_API_KEY
    ? { variable: "FELTKIT_CREDENTIAL_OPENAI", key: process.env.OPENAI_API_KEY, selection: { provider: "openai", model: process.env.PERSONALOS_TEST_MODEL ?? "gpt-4.1-mini", credentialRef: "credential-ref:openai" } }
    : null;

test("real model: the acceptance conversation", { skip: REAL ? false : "no AI_GATEWAY_API_KEY or OPENAI_API_KEY", timeout: 120_000 }, async () => {
  process.env[REAL!.variable] = REAL!.key;
  const t = await createTestApp();
  const ada = { id: "ada", type: "user" as const, roles: ["owner", "admin"] };
  try {
    await t.runtime.services.asPrincipal(ada as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, ...REAL!.selection }, v));
    const clock = clockFor(ZONE);
    await t.as("ada").mutation(api.tasks.create, { title: "Pending project review", due: clock.today, priority: "high" });
    await t.as("ada").mutation(api.tasks.create, { title: "Water the plants" });
    const deltas: string[] = [];
    const out = await t.as("ada").action(api.turn.turn, { text: "Remind me to follow up with John tomorrow at 10am, and tell me what else I should prioritize.", clientId: "real-acceptance-1" }, { context: { timeZone: ZONE, locale: "en-US" }, onEvent: (e) => e.type === "delta" && deltas.push(String(e.text)) });
    assert.equal(out.mode, "model", out.reason);
    const reply = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: out.conversationId })).at(-1)!;
    console.log(`  reply (${reply.agent!.model}, ${deltas.length} deltas): ${reply.text.replace(/\n+/g, " ")}`);
    assert.ok(deltas.length > 1, "the reply streamed in pieces");
    assert.match(reply.text, /project review/i, "the analysis names the outstanding priority");
    assert.doesNotMatch(reply.text, /\b(I('ve| have) (created|set|scheduled)|is (now )?(set|scheduled|created))\b/i, "it does not claim the reminder exists");
    const create = reply.agent!.proposals.find((p) => p.capability === "tasks.create");
    assert.ok(create, `a reminder was proposed: ${JSON.stringify(reply.agent!.proposals)}`);
    assert.equal(create!.state, "proposed");
    assert.match(String(create!.input.title), /john/i);
    assert.equal(create!.input.due, addDays(clock.today, 1));
    assert.equal(create!.input.time, "10:00");
    assert.equal((await t.as("ada").query(api.tasks.list, { status: "open" })).some((x) => /john/i.test(x.title)), false, "nothing ran before approval");

    await t.runtime.agent.approveOwn(create!.taskId, create!.actionId, ada);
    const reminder = (await t.as("ada").query(api.tasks.list, { status: "open" })).find((x) => /john/i.test(x.title))!;
    assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(reminder.remindAt!)), "10:00");

    const records = JSON.stringify(await t.runtime.agent.generations(create!.taskId, ada)) + JSON.stringify(await t.runtime.agent.get(create!.taskId, ada)) + JSON.stringify(reply);
    assert.equal(records.includes(REAL!.key!), false, "the key is in no record");
    const record = (await t.runtime.agent.generations(create!.taskId, ada))[0]!.content;
    assert.deepEqual([record.state, record.model!.provider, record.model!.model], ["completed", REAL!.selection.provider, REAL!.selection.model]);
    assert.ok(record.usage!.outputTokens! > 0);
  } finally {
    await t.close();
    delete process.env[REAL!.variable];
  }
});
