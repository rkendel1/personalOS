import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];

export function cleanEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("VERCEL") || name.endsWith("_API_KEY") || name.startsWith("APPPORT_"))
      continue;
    env[name] = value;
  }
  return { ...env, EVE_TELEMETRY_DISABLED: "1", NODE_ENV: "production", ...extra };
}

export function startProcess(command, args, env, readyPattern, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const match = readyPattern.exec(output);
      if (match) resolve({ child, output: () => output, url: match[1] });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) =>
      reject(new Error(`${command} exited (${code}) before ready:\n${output}`)),
    );
    setTimeout(() => reject(new Error(`${command} not ready in time:\n${output}`)), 90_000).unref();
  });
}

export function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stop(child) {
  if (groupAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
  await waitFor(() => !groupAlive(child.pid));
}

export const stopAll = () => Promise.all(children.map(stop));

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function signJwt(secret, sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    aud: "appport-agent",
    exp: now + 600,
    iat: now,
    iss: "appport-agent-operator",
    sub,
  });
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}

export async function waitFor(condition, { attempts = 300, intervalMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("condition not met in time");
}
