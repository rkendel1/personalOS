import { defineTool } from "eve/tools";
import { z } from "zod";

import { readContract } from "../lib/appport";

export default defineTool({
  description:
    "Reads one AppPort capability's contract: its description, required permissions, effect, and input and output JSON schemas.",
  inputSchema: z.object({ name: z.string().min(1) }),
  async execute({ name }, ctx) {
    const principalId = ctx.session.auth?.current?.principalId;
    if (principalId === undefined) return { error: "No authenticated caller." };
    return await readContract({ principalId }, name);
  },
});
