export type AccessMode = "read" | "readwrite";

export interface SchedConfig {
  /** Event origin, e.g. https://myconf.sched.com */
  baseUrl: string;
  apiKey: string;
  access: AccessMode;
  /** Max API calls per rolling minute. Sched revokes keys that exceed 30/min. */
  rateLimitPerMinute: number;
  timeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Accepts "myconf", "myconf.sched.com", or a full URL (custom domains work too)
 * and returns the bare origin.
 */
export function normalizeEventUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new ConfigError("SCHED_EVENT is required (e.g. myconf or https://myconf.sched.com)");

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = candidate.includes(".") ? `https://${candidate}` : `https://${candidate}.sched.com`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError(`SCHED_EVENT is not a valid event name or URL: ${input}`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("SCHED_EVENT must use https so the API key is not sent in clear text");
  }
  return url.origin;
}

export function parseAccessMode(value: string | undefined): AccessMode {
  const v = (value ?? "read").trim().toLowerCase();
  if (v === "" || v === "read" || v === "readonly" || v === "read-only") return "read";
  if (v === "readwrite" || v === "read-write" || v === "rw" || v === "write") return "readwrite";
  throw new ConfigError(`SCHED_ACCESS must be "read" or "readwrite", got: ${value}`);
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got: ${value}`);
  return n;
}

/**
 * Sched temporarily revokes keys that exceed 30 calls per minute. Calls are
 * counted when they leave the client, so keep one call of headroom for jitter.
 */
export const SCHED_MAX_CALLS_PER_MINUTE = 29;

function parseRateLimit(value: string | undefined): number {
  const n = parsePositiveInt("SCHED_RATE_LIMIT", value, 25);
  if (n > SCHED_MAX_CALLS_PER_MINUTE) {
    throw new ConfigError(`SCHED_RATE_LIMIT cannot exceed ${SCHED_MAX_CALLS_PER_MINUTE} (Sched revokes keys that exceed 30/min)`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SchedConfig {
  const apiKey = env.SCHED_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("SCHED_API_KEY is required");

  return {
    baseUrl: normalizeEventUrl(env.SCHED_EVENT ?? ""),
    apiKey,
    access: parseAccessMode(env.SCHED_ACCESS),
    rateLimitPerMinute: parseRateLimit(env.SCHED_RATE_LIMIT),
    timeoutMs: parsePositiveInt("SCHED_TIMEOUT_MS", env.SCHED_TIMEOUT_MS, 30_000),
  };
}
