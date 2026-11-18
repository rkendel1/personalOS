import { defineTool } from "eve/tools";
import { z } from "zod";

import { listCapabilities } from "../lib/appport";

export default defineTool({
  description:
    "Lists the AppPort capabilities this assistant can see, with whether each one is read-only and invocable here.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const principalId = ctx.session.auth?.current?.principalId;
    if (principalId === undefined) return { error: "No authenticated caller." };
    return { capabilities: await listCapabilities({ principalId }) };
  },
});
