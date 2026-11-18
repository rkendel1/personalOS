import { startInventoryHost } from "./host.mjs";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

const host = await startInventoryHost({
  adminSecret: required("AUTHBOUNDRY_ADMIN_SECRET"),
  agentCredentialFile: required("APPPORT_AGENT_CREDENTIAL_FILE"),
  authorityLogger: console,
  dataDir: process.env.APPPORT_HOST_DATA_DIR ?? ".appport-host",
  host: process.env.APPPORT_HOST ?? "127.0.0.1",
  port: Number(process.env.APPPORT_PORT ?? 4317),
  provenanceFile: process.env.APPPORT_PROVENANCE_FILE ?? "appport-provenance.jsonl",
});
console.log(`[appport] inventory listening at ${host.url}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void host.close().then(() => process.exit(0)));
}
