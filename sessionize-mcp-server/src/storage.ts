import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError, loadConfig, type SessionizeConfig } from "./config.js";

export const PACKAGE_NAME = "@ugurlabs/sessionize-mcp-server";
export const SETUP_COMMAND = `npx -y ${PACKAGE_NAME} setup`;

/** What `setup` saves. The endpoint ID works like a password, so the file is owner-only. */
export interface StoredConfig {
  endpointId: string;
  savedAt?: string;
}

/** SESSIONIZE_CONFIG_FILE overrides the location (also useful for one server per event). */
export function configFilePath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.SESSIONIZE_CONFIG_FILE?.trim()) return resolve(env.SESSIONIZE_CONFIG_FILE.trim());
  const base =
    platform === "win32"
      ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "ugurlabs-mcp", "sessionize.json");
}

export function readStoredConfig(path: string): StoredConfig | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`The settings file ${path} is not valid JSON. Run "${SETUP_COMMAND}" again.`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.endpointId !== "string") {
    throw new ConfigError(`The settings file ${path} is incomplete. Run "${SETUP_COMMAND}" again.`);
  }
  return { endpointId: o.endpointId };
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
  | { config: SessionizeConfig; source: "env" | "file"; path: string; problem?: undefined }
  | { config: null; source: null; path: string; problem: string | null };

/** SESSIONIZE_ENDPOINT_ID wins over the settings file. Never throws. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, path = configFilePath(env)): Resolution {
  const fromEnv = env.SESSIONIZE_ENDPOINT_ID?.trim();
  let stored: StoredConfig | null = null;
  if (!fromEnv) {
    try {
      stored = readStoredConfig(path);
    } catch (err) {
      return { config: null, source: null, path, problem: (err as Error).message };
    }
  }
  const endpointId = fromEnv || stored?.endpointId;
  if (!endpointId) return { config: null, source: null, path, problem: null };
  try {
    return { config: loadConfig({ ...env, SESSIONIZE_ENDPOINT_ID: endpointId }), source: fromEnv ? "env" : "file", path };
  } catch (err) {
    return { config: null, source: null, path, problem: (err as Error).message };
  }
}
