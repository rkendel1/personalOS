import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  defaultTools: false,
  model: anthropic(process.env.APPPORT_AGENT_MODEL ?? "claude-sonnet-5"),
});
