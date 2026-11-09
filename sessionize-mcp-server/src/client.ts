import type { SessionizeConfig } from "./config.js";

export const USER_AGENT = "sessionize-mcp-server/0.1.0";
export const API_BASE = "https://sessionize.com/api/v2";

// ---- Raw shapes of the /view/All response (fields we use; unknown extras are ignored) ----
export interface RawQuestionAnswer {
  questionId: number;
  answerValue: string | null;
}
export interface RawSession {
  id: string;
  title: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isServiceSession: boolean;
  isPlenumSession: boolean;
  speakers: string[];
  categoryItems: number[];
  questionAnswers: RawQuestionAnswer[];
  roomId: number | null;
  liveUrl: string | null;
  recordingUrl: string | null;
  status: string | null;
  isInformed: boolean;
  isConfirmed: boolean;
}
export interface RawLink {
  title: string;
  url: string;
  linkType: string;
}
export interface RawSpeaker {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  bio: string | null;
  tagLine: string | null;
  profilePicture: string | null;
  isTopSpeaker: boolean;
  links: RawLink[];
  sessions: number[];
  categoryItems: number[];
  questionAnswers: RawQuestionAnswer[];
}
export interface RawCategory {
  id: number;
  title: string;
  items: { id: number; name: string; sort: number }[];
  sort: number;
  type: string;
}
export interface RawQuestion {
  id: number;
  question: string;
  questionType: string;
  sort: number;
}
export interface RawRoom {
  id: number;
  name: string;
  sort: number;
}
export interface RawEventData {
  sessions: RawSession[];
  speakers: RawSpeaker[];
  questions: RawQuestion[];
  categories: RawCategory[];
  rooms: RawRoom[];
}

const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function assertSessionizeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SessionizeApiError(`Invalid image URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || !/(^|\.)sessionize\.com$/i.test(parsed.hostname)) {
    throw new SessionizeApiError(`Refusing to download image from a non-Sessionize host: ${parsed.protocol}//${parsed.hostname}`);
  }
  return parsed;
}

export class SessionizeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SessionizeApiError";
  }
}

export class SessionizeClient {
  private cache?: { at: number; data: RawEventData };

  constructor(
    private readonly config: SessionizeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fetches /view/All, reusing a recent copy unless `refresh` is set. */
  async getAll(refresh = false): Promise<RawEventData> {
    const ttl = this.config.cacheSeconds * 1000;
    if (!refresh && this.cache && this.now() - this.cache.at < ttl) return this.cache.data;

    const url = `${API_BASE}/${this.config.endpointId}/view/All`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new SessionizeApiError(`Request to Sessionize failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 404) {
      throw new SessionizeApiError(
        "Sessionize returned 404: the endpoint ID is wrong or the endpoint was deleted. Check API / Embed in your Sessionize event.",
        404,
      );
    }
    if (!res.ok) throw new SessionizeApiError(`Sessionize returned HTTP ${res.status}`, res.status);

    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!type.includes("json")) {
      throw new SessionizeApiError(
        "Sessionize did not return JSON. Set the endpoint format to JSON on the API / Embed page.",
        res.status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SessionizeApiError("Sessionize returned invalid JSON");
    }
    const data = normalize(json);
    this.cache = { at: this.now(), data };
    return data;
  }

  /**
   * Downloads a speaker photo. Only https Sessionize hosts are allowed, including on every redirect hop,
   * the response must be an image, and the size is capped.
   */
  async downloadImage(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = assertSessionizeUrl(current);
      const res = await this.fetchImpl(parsed, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new SessionizeApiError(`Image redirect without a Location header: ${url}`, res.status);
        current = new URL(location, parsed).toString();
        continue;
      }
      if (!res.ok) throw new SessionizeApiError(`Image download failed with HTTP ${res.status}: ${url}`, res.status);
      const contentType = res.headers.get("content-type") ?? "";
      if (!/^image\//i.test(contentType)) {
        throw new SessionizeApiError(`Not an image (content-type "${contentType || "missing"}"): ${url}`);
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_IMAGE_BYTES) throw new SessionizeApiError(`Image larger than ${MAX_IMAGE_BYTES} bytes: ${url}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new SessionizeApiError(`Image larger than ${MAX_IMAGE_BYTES} bytes: ${url}`);
      return { bytes, contentType };
    }
    throw new SessionizeApiError(`Too many redirects downloading image: ${url}`);
  }
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function normalize(json: unknown): RawEventData {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new SessionizeApiError(
      "Unexpected response shape. This server reads the /view/All output; make sure the endpoint is a JSON API endpoint.",
    );
  }
  const o = json as Record<string, unknown>;
  return {
    sessions: arr<RawSession>(o.sessions),
    speakers: arr<RawSpeaker>(o.speakers),
    questions: arr<RawQuestion>(o.questions),
    categories: arr<RawCategory>(o.categories),
    rooms: arr<RawRoom>(o.rooms),
  };
}
