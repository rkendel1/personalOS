import { execFileSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanEnv, root } from "./support.mjs";

export const SCRIPTED_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  defaultTools: false,
  model: mockModel({
    modelId: "work-script",
    provider: "acceptance",
    respond: ({ lastUserMessage, toolResults }) => {
      if (String(lastUserMessage).includes("FAIL")) throw new Error("scripted model failure");
      // A model call that never answers: a turn that makes no progress.
      if (String(lastUserMessage).includes("[hang]")) return new Promise(() => undefined);
      if (String(lastUserMessage).includes("[approval]"))
        return toolResults.length === 0
          ? { toolCalls: [{ name: "await_approval", input: {} }] }
          : "Approved.";
      const reserve = /Reserve (\\d+) of (\\S+)/u.exec(String(lastUserMessage));
      if (reserve !== null) {
        const calls = String(lastUserMessage).includes("[repeat]") ? 2 : 1;
        if (toolResults.length < calls)
          return {
            toolCalls: [
              {
                name: "appport_invoke",
                input: { input: { quantity: Number(reserve[1]), sku: reserve[2] }, name: "catalog.reserve" },
              },
            ],
          };
        return "Reserved: " + JSON.stringify(toolResults.map((entry) => entry.output));
      }
      const invoke = /Invoke (\\S+) with (\\{.*\\})/u.exec(String(lastUserMessage));
      if (invoke !== null) {
        const calls = String(lastUserMessage).includes("[repeat]") ? 2 : 1;
        if (toolResults.length < calls)
          return { toolCalls: [{ name: "appport_invoke", input: { input: JSON.parse(invoke[2]), name: invoke[1] } }] };
        return "Result: " + JSON.stringify(toolResults.at(-1)?.output);
      }
      const listing = /List via (\\S+)/u.exec(String(lastUserMessage));
      if (listing !== null) {
        if (toolResults.length === 0)
          return { toolCalls: [{ name: "appport_invoke", input: { input: {}, name: listing[1] } }] };
        return "Listed: " + JSON.stringify(toolResults.at(-1)?.output);
      }
      const apply = /Apply (\\S+) via (\\S+)/u.exec(String(lastUserMessage));
      if (apply !== null) {
        const message = String(lastUserMessage);
        const tokens = apply[1].split(",");
        const plan = message.includes("[repeat]")
          ? [{ token: tokens[0] }, { token: tokens[0] }]
          : message.includes("[conflict]")
            ? [
                { operationKey: "step-1", token: tokens[0] },
                { operationKey: "step-1", token: tokens[0] + "-changed" },
              ]
            : message.includes("[invalid]")
              ? [{ token: 5 }, { token: 5 }]
              : tokens.map((token) => ({ token }));
        const step = plan[toolResults.length];
        if (step === undefined) return "Results: " + JSON.stringify(toolResults.map((entry) => entry.output));
        const call = { input: { token: step.token }, name: apply[2] };
        if (step.operationKey !== undefined) call.operationKey = step.operationKey;
        return { toolCalls: [{ name: "appport_invoke", input: call }] };
      }
      const sku = /SKU (\\S+)/u.exec(String(lastUserMessage))?.[1];
      if (sku === undefined) return "No SKU was given.";
      if (toolResults.length === 0)
        return { toolCalls: [{ name: "appport_invoke", input: { name: "catalog.lookup", input: { sku } } }] };
      return "AppPort answered: " + JSON.stringify(toolResults.at(-1)?.output);
    },
  }),
});
`;

const FIXTURE_FAULTS = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FaultPoint = "work.accepted" | "operation.prepared" | "invocation.record" | "checkpoint.final";

export interface FaultContext {
  readonly objective: string;
  readonly workId: string;
}

export async function fault(point: FaultPoint, context: FaultContext): Promise<void> {
  const crash = context.objective.includes("[crash:" + point + "]");
  const fail = context.objective.includes("[fail:" + point + "]");
  if (!crash && !fail) return;
  const fired = join(dirname(process.env.APPPORT_AGENT_WORK_DIR ?? "."), "faults-fired");
  mkdirSync(fired, { recursive: true });
  const marker = join(fired, context.workId + "-" + point);
  if (existsSync(marker)) return;
  writeFileSync(marker, new Date().toISOString());
  if (crash) process.kill(process.pid, "SIGKILL");
  throw new Error("injected fault at " + point);
}
`;

const FIXTURE_APPROVAL_TOOL = `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Waits until a person approves.",
  inputSchema: z.object({}),
  async execute() {
    return { approved: true };
  },
});
`;

export function buildScriptedAgent(fixture) {
  rmSync(fixture, { force: true, recursive: true });
  cpSync(join(root, "agent"), join(fixture, "agent"), { recursive: true });
  writeFileSync(join(fixture, "agent/agent.ts"), SCRIPTED_AGENT);
  writeFileSync(join(fixture, "agent/lib/faults.ts"), FIXTURE_FAULTS);
  writeFileSync(join(fixture, "agent/tools/await_approval.ts"), FIXTURE_APPROVAL_TOOL);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      dependencies: { eve: "workspace:*" },
      name: "appport-agent-acceptance",
      private: true,
      type: "module",
    }),
  );
  execFileSync(join(root, "node_modules/.bin/eve"), ["build"], {
    cwd: fixture,
    env: cleanEnv({ EVE_MODEL_CATALOG: "bundled" }),
    stdio: "ignore",
  });
}
