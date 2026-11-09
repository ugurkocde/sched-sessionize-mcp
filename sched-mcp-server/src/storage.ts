import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError, loadConfig, parseAccessMode, type AccessMode, type SchedConfig } from "./config.js";

export const PACKAGE_NAME = "@ugurlabs/sched-mcp-server";
export const SETUP_COMMAND = `npx -y ${PACKAGE_NAME} setup`;

/** What `setup` saves. The API key is stored in a file only the current user can read. */
export interface StoredConfig {
  event: string;
  apiKey: string;
  access: AccessMode;
  savedAt?: string;
}

/**
 * Settings file location. SCHED_CONFIG_FILE overrides it, which also lets you run
 * one server per Sched event. Defaults to the platform's per-user config folder.
 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.SCHED_CONFIG_FILE?.trim()) return resolve(env.SCHED_CONFIG_FILE.trim());
  const base =
    platform === "win32"
      ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "ugurlabs-mcp", "sched.json");
}

/** Returns null when no settings file exists; throws ConfigError when it is unreadable. */
export function readStoredConfig(path: string): StoredConfig | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`The settings file ${path} is not valid JSON. Run "${SETUP_COMMAND}" again.`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.event !== "string" || typeof o.apiKey !== "string") {
    throw new ConfigError(`The settings file ${path} is incomplete. Run "${SETUP_COMMAND}" again.`);
  }
  let access: AccessMode;
  try {
    access = parseAccessMode(typeof o.access === "string" ? o.access : "read");
  } catch {
    throw new ConfigError(`The settings file ${path} has an invalid access value. Run "${SETUP_COMMAND}" again.`);
  }
  return { event: o.event, apiKey: o.apiKey, access };
}

/** Writes atomically with owner-only permissions (0600 file, 0700 folder). */
export function writeStoredConfig(path: string, cfg: StoredConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a stale file would keep its old permissions
  try {
    writeFileSync(tmp, JSON.stringify({ ...cfg, savedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true }); // never leave a copy of the secret behind
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported on every platform */
  }
}

export function deleteStoredConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export type Resolution =
  | { config: SchedConfig; source: "env" | "file"; path: string; problem?: undefined }
  | { config: null; source: null; path: string; problem: string | null };

/**
 * Environment variables win over the settings file, field by field. Returns
 * config: null (with a problem description when something is set but invalid)
 * so the server can start in setup mode instead of crashing.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, path = configFilePath(env)): Resolution {
  let stored: StoredConfig | null = null;
  try {
    stored = readStoredConfig(path);
  } catch (err) {
    if (!env.SCHED_EVENT?.trim() || !env.SCHED_API_KEY?.trim()) {
      return { config: null, source: null, path, problem: (err as Error).message };
    }
  }

  const event = env.SCHED_EVENT?.trim() || stored?.event;
  const apiKey = env.SCHED_API_KEY?.trim() || stored?.apiKey;
  if (!event && !apiKey) return { config: null, source: null, path, problem: null };
  if (!event || !apiKey) {
    return { config: null, source: null, path, problem: !event ? "The Sched event is missing." : "The Sched API key is missing." };
  }

  try {
    const config = loadConfig({
      ...env,
      SCHED_EVENT: event,
      SCHED_API_KEY: apiKey,
      SCHED_ACCESS: env.SCHED_ACCESS?.trim() || stored?.access,
    });
    return { config, source: env.SCHED_API_KEY?.trim() ? "env" : "file", path };
  } catch (err) {
    return { config: null, source: null, path, problem: (err as Error).message };
  }
}

