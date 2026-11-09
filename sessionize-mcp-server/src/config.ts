export interface SessionizeConfig {
  endpointId: string;
  /** How long fetched event data is reused between tool calls. Sessionize itself caches for up to 5 minutes. */
  cacheSeconds: number;
  timeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Accepts a bare endpoint ID ("jl4ktls0") or any Sessionize API URL that contains it
 * ("https://sessionize.com/api/v2/jl4ktls0/view/All").
 */
export function parseEndpointId(input: string | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new ConfigError("SESSIONIZE_ENDPOINT_ID is required (API / Embed page in your Sessionize event)");
  const fromUrl = raw.match(/sessionize\.com\/api\/v2\/([A-Za-z0-9]+)/i);
  const id = fromUrl ? fromUrl[1]! : raw;
  if (!/^[A-Za-z0-9]{4,32}$/.test(id)) {
    throw new ConfigError("SESSIONIZE_ENDPOINT_ID is not a valid endpoint ID or Sessionize API URL");
  }
  return id;
}

function parseNonNegativeInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SessionizeConfig {
  return {
    endpointId: parseEndpointId(env.SESSIONIZE_ENDPOINT_ID),
    cacheSeconds: parseNonNegativeInt("SESSIONIZE_CACHE_SECONDS", env.SESSIONIZE_CACHE_SECONDS, 60),
    timeoutMs: parseNonNegativeInt("SESSIONIZE_TIMEOUT_MS", env.SESSIONIZE_TIMEOUT_MS, 30_000) || 30_000,
  };
}
