import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createFeltDB } from "@feltdb/core";

import { cleanEnv, groupAlive, startProcess, stop, waitFor } from "./support.mjs";

export function hostProcess({ env = {}, port, scratch }) {
  const files = {
    authorityPid: join(scratch, "authority.pid"),
    credential: join(scratch, "agent-credential"),
    crashPlan: join(scratch, "crash-plan"),
    dataDir: join(scratch, "host"),
    effects: join(scratch, "effects.log"),
    grants: join(scratch, "grants.json"),
    provenance: join(scratch, "provenance.jsonl"),
  };
  let current;

  async function start(extra = {}) {
    current = await startProcess(
      process.execPath,
      ["test/probe-host.mjs"],
      cleanEnv({
        APPPORT_AGENT_CREDENTIAL_FILE: files.credential,
        APPPORT_HOST_DATA_DIR: files.dataDir,
        APPPORT_PORT: String(port),
        APPPORT_PROVENANCE_FILE: files.provenance,
        AUTHBOUNDRY_ADMIN_SECRET: "probe-host-authority-admin-secret-0123456789",
        PROBE_AUTHORITY_PID_FILE: files.authorityPid,
        PROBE_CRASH_FILE: files.crashPlan,
        PROBE_EFFECTS_FILE: files.effects,
        PROBE_GRANTS_FILE: files.grants,
        ...env,
        ...extra,
      }),
      /\[probe-host\] owner (\S+) listening at/u,
    );
    return current;
  }

  async function terminate() {
    if (current !== undefined) await stop(current.child);
    if (existsSync(files.authorityPid)) {
      const authority = Number(readFileSync(files.authorityPid, "utf8"));
      if (groupAlive(authority)) process.kill(-authority, "SIGKILL");
      await waitFor(() => !groupAlive(authority));
    }
    if (current !== undefined) await waitFor(() => !groupAlive(current.child.pid));
  }

  async function readStore(namespace, directory, collection, query = {}) {
    const db = createFeltDB({ namespace, path: join(files.dataDir, directory) });
    try {
      return await db.collection(collection).find(query);
    } finally {
      await db.close?.();
    }
  }

  return {
    get current() {
      return current;
    },
    files,
    grants: () => JSON.parse(readFileSync(files.grants, "utf8")),
    readStore,
    start,
    terminate,
    url: `http://127.0.0.1:${port}/appport`,
  };
}
