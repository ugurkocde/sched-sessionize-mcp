import type { SchedConfig } from "./config.js";

export const USER_AGENT = "sched-mcp-server/0.1.0";

export type ParamValue = string | number | boolean | undefined | null;
export type Params = Record<string, ParamValue>;

export class SchedApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SchedApiError";
  }
}

/** Rolling one-minute window limiter that delays calls instead of failing them. */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length && t - this.stamps[0]! >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(60_000 - (t - this.stamps[0]!) + 5);
    }
  }
}

export interface SchedResponse {
  /** Parsed JSON when the body is JSON, otherwise undefined. */
  json?: unknown;
  text: string;
}

export class SchedClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: SchedConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    limiter?: RateLimiter,
  ) {
    this.limiter = limiter ?? new RateLimiter(config.rateLimitPerMinute);
  }

  /**
   * Calls /api/<path>. Uses POST with a form body (recommended by Sched) so the
   * API key never appears in URLs or proxy logs.
   */
  async call(path: string, params: Params = {}): Promise<SchedResponse> {
    const body = new URLSearchParams();
    body.set("api_key", this.config.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || k === "api_key") continue;
      body.set(k, typeof v === "boolean" ? (v ? "Y" : "N") : String(v));
    }

    await this.limiter.acquire();

    const url = `${this.config.baseUrl}/api/${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, text/plain, */*",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SchedApiError(`Request to ${url} failed: ${reason}`);
    }

    if (res.status >= 300 && res.status < 400) {
      // An unknown event redirects to www.sched.com; an unknown or unavailable
      // endpoint on a valid event redirects to the event's own homepage.
      const location = res.headers.get("location") ?? "";
      let sameHost = false;
      try {
        sameHost = new URL(location, this.config.baseUrl).host === new URL(this.config.baseUrl).host;
      } catch {
        /* treat as foreign redirect */
      }
      throw new SchedApiError(
        sameHost
          ? `Sched redirected /api/${path} to the event homepage (HTTP ${res.status}): this endpoint does not exist or is not enabled for this event.`
          : `Sched redirected the request (HTTP ${res.status}). Check SCHED_EVENT: ${this.config.baseUrl} does not look like a valid Sched event.`,
        res.status,
      );
    }

    const text = (await res.text()).trim();

    // Sched reports most errors as a plain "ERR: ..." body (usually HTTP 200).
    if (/^ERR\b/i.test(text)) {
      const msg = text.replace(/^ERR:?\s*/i, "");
      const hint = /authori[sz]ation failed/i.test(msg)
        ? " The API key is invalid, or it is a read-only key used for a write operation."
        : "";
      throw new SchedApiError(`Sched API error: ${msg}${hint}`, res.status);
    }

    let json: unknown;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    // Tag endpoints wrap results in { result, status, code }; errors carry the
    // message in result, e.g. {"result":"Name is required","status":"ERROR","code":400}.
    // Only treat objects that have both status and code as an envelope: other
    // endpoints (site/sync) use a plain "status" field for unrelated data.
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const o = json as Record<string, unknown>;
      if ("status" in o && "code" in o) {
        const ok = String(o.status).toUpperCase() === "OK" && Number(o.code) === 0;
        if (!ok) {
          const msg = typeof o.result === "string" ? o.result : String(o.message ?? o.error ?? o.status);
          throw new SchedApiError(`Sched API error: ${msg} (code ${String(o.code)})`, res.status);
        }
      }
    }

    if (!res.ok) {
      const hint =
        res.status === 403
          ? " (Sched blocks requests without a User-Agent and may block keys that exceed the rate limit)"
          : res.status === 429
            ? " (rate limited by Sched; wait a minute)"
            : res.status === 400
              ? " (unknown API method or malformed request)"
              : "";
      throw new SchedApiError(`Sched API returned HTTP ${res.status}${hint}${text ? `: ${truncate(text)}` : ""}`, res.status);
    }

    if (json !== undefined) return { json, text };
    return { text };
  }
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
