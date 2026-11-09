import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SessionizeClient } from "../src/client.js";
import { ConfigError, loadConfig, parseEndpointId, type SessionizeConfig } from "../src/config.js";
import { sessionsToCsv, slugify } from "../src/export.js";
import { buildModel, filterSessions, filterSpeakers } from "../src/model.js";
import { createServer } from "../src/server.js";
import demo from "./fixtures/demo-all.json" with { type: "json" };

const config: SessionizeConfig = { endpointId: "jl4ktls0", cacheSeconds: 60, timeoutMs: 5000 };

/** Demo data with a few status flags flipped so status filters have something to find. */
function fixture() {
  const data = structuredClone(demo) as typeof demo;
  const regular = data.sessions.filter((s) => !s.isServiceSession);
  regular[0]!.isInformed = true;
  regular[0]!.isConfirmed = true;
  regular[1]!.isInformed = true;
  return data;
}

type Handler = (url: string) => Response;
function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });

async function connect(handler: Handler) {
  const f = fakeFetch(handler);
  const server = createServer(config, new SessionizeClient(config, f.fetch));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls: f.calls };
}
const parse = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0]!.text);

describe("config", () => {
  it("accepts a bare endpoint ID or an API URL", () => {
    expect(parseEndpointId("jl4ktls0")).toBe("jl4ktls0");
    expect(parseEndpointId("https://sessionize.com/api/v2/jl4ktls0/view/All")).toBe("jl4ktls0");
    expect(() => parseEndpointId("")).toThrow(ConfigError);
    expect(() => parseEndpointId("not an id!")).toThrow(ConfigError);
    expect(loadConfig({ SESSIONIZE_ENDPOINT_ID: " jl4ktls0 " })).toMatchObject({ endpointId: "jl4ktls0", cacheSeconds: 60 });
  });
});

describe("client", () => {
  it("calls /view/All with a User-Agent and caches the result", async () => {
    let now = 0;
    const f = fakeFetch(() => jsonResponse(fixture()));
    const c = new SessionizeClient(config, f.fetch, () => now);
    await c.getAll();
    await c.getAll();
    expect(f.calls).toEqual(["https://sessionize.com/api/v2/jl4ktls0/view/All"]);
    now += 61_000;
    await c.getAll();
    await c.getAll(true);
    expect(f.calls).toHaveLength(3);
  });

  it("explains 404 and non-JSON endpoints", async () => {
    const nf = new SessionizeClient(config, fakeFetch(() => new Response("<html>", { status: 404 })).fetch);
    await expect(nf.getAll()).rejects.toThrow(/endpoint ID is wrong/);
    const xml = new SessionizeClient(
      config,
      fakeFetch(() => new Response("<xml/>", { headers: { "content-type": "application/xml" } })).fetch,
    );
    await expect(xml.getAll()).rejects.toThrow(/format to JSON/);
  });

  it("only downloads images from Sessionize hosts", async () => {
    const c = new SessionizeClient(config, fakeFetch(() => new Response(new Uint8Array([1, 2, 3]))).fetch);
    await expect(c.downloadImage("https://evil.example.com/x.jpg")).rejects.toThrow(/non-Sessionize host/);
    await expect(c.downloadImage("http://cdn.sessionize.com/x.jpg")).rejects.toThrow(/non-Sessionize host/);
    const img = new SessionizeClient(config, fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })).fetch);
    await expect(img.downloadImage("https://cdn.sessionize.com/image/x.jpg")).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    // Redirects are re-checked, and non-images are refused.
    const redirect = new SessionizeClient(config, fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.jpg" } })).fetch);
    await expect(redirect.downloadImage("https://cdn.sessionize.com/image/x.jpg")).rejects.toThrow(/non-Sessionize host/);
    const html = new SessionizeClient(config, fakeFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } })).fetch);
    await expect(html.downloadImage("https://cdn.sessionize.com/image/x.jpg")).rejects.toThrow(/Not an image/);
  });
});

describe("model", () => {
  it("joins speakers, photos, categories and rooms onto sessions", () => {
    const m = buildModel(fixture());
    const s = m.sessions.find((x) => x.speakers.length > 0)!;
    expect(s.speakers[0]!.name).toBeTruthy();
    expect(s.speakers[0]!.profilePicture).toMatch(/^https:\/\/cdn\.sessionize\.com\//);
    expect(Object.keys(s.categories).length).toBeGreaterThan(0);
    expect(m.speakers[0]!.sessions[0]!.title).toBeTruthy();
  });

  it("filters by status, category and service sessions", () => {
    const m = buildModel(fixture());
    expect(filterSessions(m.sessions, { status: "confirmed" })).toHaveLength(1);
    expect(filterSessions(m.sessions, { status: "informed" })).toHaveLength(2);
    expect(filterSessions(m.sessions, { status: "accepted" }).length).toBe(m.sessions.filter((s) => !s.isServiceSession).length);
    expect(filterSessions(m.sessions, { includeServiceSessions: true }).length).toBe(m.sessions.length);
    expect(filterSessions(m.sessions, { category: "workshop" }).every((s) => s.categories["Session format"]?.includes("Workshop"))).toBe(true);
  });

  it("never lets a name search pull unconfirmed speakers into a status-filtered list", () => {
    const m = buildModel(fixture());
    const confirmed = filterSessions(m.sessions, { status: "confirmed" });
    const confirmedSpeakerIds = new Set(confirmed.flatMap((s) => s.speakers.map((p) => p.id)));
    const other = m.speakers.find((sp) => !confirmedSpeakerIds.has(sp.id))!;
    const res = filterSpeakers(m, { status: "confirmed", search: other.fullName });
    expect(res.some((sp) => sp.id === other.id)).toBe(false);
    expect(filterSpeakers(m, { search: other.fullName }).some((sp) => sp.id === other.id)).toBe(true);
  });

  it("escapes CSV and neutralises formulas", () => {
    const m = buildModel(fixture());
    const one = { ...m.sessions[0]!, title: '=HYPERLINK("x")', description: 'He said "hi", ok' };
    const csv = sessionsToCsv([one]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"He said ""hi"", ok"`);
    expect(slugify("Jürgen Müller-Lüdenscheidt")).toBe("jurgen-muller-ludenscheidt");
  });
});

describe("MCP server", () => {
  it("exposes six tools plus setup status; everything except export is read-only", async () => {
    const { client } = await connect(() => jsonResponse(fixture()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sessionize_export",
      "sessionize_get_overview",
      "sessionize_get_session",
      "sessionize_get_speaker",
      "sessionize_list_sessions",
      "sessionize_list_speakers",
      "sessionize_setup_status",
    ]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).length).toBe(6);
  });

  it("lists confirmed sessions with speaker photos", async () => {
    const { client } = await connect(() => jsonResponse(fixture()));
    const res = parse(await client.callTool({ name: "sessionize_list_sessions", arguments: { status: "confirmed" } }));
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ isConfirmed: true, status: "Accepted" });
    expect(res.items[0].speakers[0].profilePicture).toMatch(/cdn\.sessionize\.com/);
    const overview = parse(await client.callTool({ name: "sessionize_get_overview", arguments: {} }));
    expect(overview.sessions).toMatchObject({ confirmed: 1, informed: 2 });
  });

  it("returns tool errors for bad endpoints and unknown IDs", async () => {
    const { client } = await connect(() => new Response("", { status: 404 }));
    const r = await client.callTool({ name: "sessionize_get_overview", arguments: {} });
    expect(r.isError).toBe(true);
    const ok = await connect(() => jsonResponse(fixture()));
    const missing = await ok.client.callTool({ name: "sessionize_get_session", arguments: { id: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("exports CSV and downloads photos, rejecting relative paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sz-export-"));
    const { client } = await connect((url) =>
      url.includes("/api/v2/") ? jsonResponse(fixture()) : new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }),
    );
    const bad = await client.callTool({ name: "sessionize_export", arguments: { what: "sessions", output_dir: "relative/dir" } });
    expect(bad.isError).toBe(true);
    const res = parse(
      await client.callTool({
        name: "sessionize_export",
        arguments: { what: "sessions", format: "csv", status: "accepted", output_dir: dir, download_photos: true },
      }),
    );
    const csv = await readFile(res.file, "utf8");
    expect(csv.split("\r\n")[0]).toContain('"speaker_photos"');
    expect(res.rows).toBeGreaterThan(0);
    expect(res.photos.saved).toBeGreaterThan(0);
    const photos = await readdir(join(dir, "photos"));
    expect(photos.every((p) => /\.jpg$/.test(p))).toBe(true);
  });
});
