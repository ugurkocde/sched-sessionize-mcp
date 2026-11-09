import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { RateLimiter, SchedApiError, SchedClient, USER_AGENT } from "../src/client.js";
import { ConfigError, loadConfig, normalizeEventUrl, parseAccessMode, type SchedConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

const baseConfig = (over: Partial<SchedConfig> = {}): SchedConfig => ({
  baseUrl: "https://demo.sched.com",
  apiKey: "secretkey",
  access: "read",
  rateLimitPerMinute: 1000,
  timeoutMs: 5000,
  ...over,
});

type Call = { url: string; init: RequestInit; body: URLSearchParams };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init!, body: new URLSearchParams(String(init!.body)) };
    calls.push(call);
    return respond(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function connect(config: SchedConfig, fetchImpl: typeof fetch) {
  const server = createServer(config, new SchedClient(config, fetchImpl));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("config", () => {
  it("normalizes event names and URLs", () => {
    expect(normalizeEventUrl("myconf")).toBe("https://myconf.sched.com");
    expect(normalizeEventUrl("myconf.sched.com")).toBe("https://myconf.sched.com");
    expect(normalizeEventUrl("https://myconf.sched.com/")).toBe("https://myconf.sched.com");
    expect(normalizeEventUrl("https://schedule.example.org/foo")).toBe("https://schedule.example.org");
    expect(() => normalizeEventUrl("http://myconf.sched.com")).toThrow(ConfigError);
    expect(() => normalizeEventUrl("")).toThrow(ConfigError);
  });

  it("defaults to read access and rejects unknown modes", () => {
    expect(parseAccessMode(undefined)).toBe("read");
    expect(parseAccessMode("READWRITE")).toBe("readwrite");
    expect(parseAccessMode("read-write")).toBe("readwrite");
    expect(() => parseAccessMode("admin")).toThrow(ConfigError);
  });

  it("requires an API key", () => {
    expect(() => loadConfig({ SCHED_EVENT: "x" })).toThrow(/SCHED_API_KEY/);
    const c = loadConfig({ SCHED_EVENT: "x", SCHED_API_KEY: " k " });
    expect(c).toMatchObject({ apiKey: "k", access: "read", rateLimitPerMinute: 25 });
  });

  it("refuses rate limits above Sched's 30/min", () => {
    const env = { SCHED_EVENT: "x", SCHED_API_KEY: "k" };
    expect(loadConfig({ ...env, SCHED_RATE_LIMIT: "29" }).rateLimitPerMinute).toBe(29);
    expect(() => loadConfig({ ...env, SCHED_RATE_LIMIT: "30" })).toThrow(ConfigError);
  });
});

describe("SchedClient", () => {
  it("POSTs a form body with api_key and a User-Agent", async () => {
    const f = fakeFetch(() => new Response('[{"id":"1"}]'));
    const res = await new SchedClient(baseConfig(), f.fetch).call("session/list", { format: "json", api_key: "evil" });
    expect(res.json).toEqual([{ id: "1" }]);
    const [call] = f.calls;
    expect(call!.url).toBe("https://demo.sched.com/api/session/list");
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(call!.init.redirect).toBe("manual");
    expect(call!.body.get("api_key")).toBe("secretkey");
    expect(call!.body.get("format")).toBe("json");
  });

  it("turns 200 'ERR:' bodies into errors with a read-only hint", async () => {
    const f = fakeFetch(() => new Response("ERR: Authorization failed.", { status: 200 }));
    await expect(new SchedClient(baseConfig(), f.fetch).call("session/add")).rejects.toThrow(
      /Authorization failed.*read-only key/,
    );
  });

  it("reports redirects as an invalid event", async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { Location: "https://www.sched.com/" } }));
    await expect(new SchedClient(baseConfig(), f.fetch).call("site/sync")).rejects.toThrow(/SCHED_EVENT/);
  });

  it("reports a redirect to the event homepage as an unavailable endpoint", async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { Location: "https://demo.sched.com/" } }));
    await expect(new SchedClient(baseConfig(), f.fetch).call("tag/get")).rejects.toThrow(/endpoint does not exist/);
  });

  it("reports HTTP errors", async () => {
    const f = fakeFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(new SchedClient(baseConfig(), f.fetch).call("site/sync")).rejects.toBeInstanceOf(SchedApiError);
  });

  it("detects non-OK tag envelopes", async () => {
    const f = fakeFetch(() => new Response('{"status":"ERROR","code":5,"message":"Tag not found"}'));
    await expect(new SchedClient(baseConfig(), f.fetch).call("tag/del", { id: 1 })).rejects.toThrow(/Tag not found/);
    // Real shape observed live: HTTP 400 with the message in "result".
    const http400 = fakeFetch(
      () => new Response('{"result":"Name is required","status":"ERROR","code":400}', { status: 400 }),
    );
    await expect(new SchedClient(baseConfig(), http400.fetch).call("tag/people/add")).rejects.toThrow(
      /Name is required \(code 400\)/,
    );
    // site/sync has an unrelated top-level "status" field and no "code"; it is not an error.
    const sync = fakeFetch(() => new Response('{"title":"Demo","status":"updated","sessioncount":"0"}'));
    await expect(new SchedClient(baseConfig(), sync.fetch).call("site/sync")).resolves.toMatchObject({
      json: { title: "Demo", status: "updated" },
    });
    const ok = fakeFetch(() => new Response('{"result":[],"status":"OK","code":0}'));
    await expect(new SchedClient(baseConfig(), ok.fetch).call("tag/get")).resolves.toMatchObject({ json: { status: "OK" } });
  });
});

describe("RateLimiter", () => {
  it("waits once the per-minute budget is spent", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(2, () => now, async (ms) => {
      sleeps.push(ms);
      now += ms;
    });
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toEqual([]);
    await rl.acquire();
    expect(sleeps.length).toBe(1);
    expect(now).toBeGreaterThanOrEqual(60_000);
  });
});

describe("MCP server access modes", () => {
  // Every server also has the setup status tool.
  const readNames = [...TOOLS.filter((t) => t.access === "read").map((t) => t.name), "sched_setup_status"].sort();
  const allNames = [...TOOLS.map((t) => t.name), "sched_setup_status"].sort();

  it("read key exposes only read tools, all marked readOnly", async () => {
    const client = await connect(baseConfig({ access: "read" }), fakeFetch(() => new Response("")).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(readNames);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("read/write key exposes write tools too, with destructive hints on deletes", async () => {
    const client = await connect(baseConfig({ access: "readwrite" }), fakeFetch(() => new Response("")).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(allNames);
    const del = tools.find((t) => t.name === "sched_delete_session")!;
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("write tools cannot be called with a read key", async () => {
    const f = fakeFetch(() => new Response("Ok"));
    const client = await connect(baseConfig({ access: "read" }), f.fetch);
    const res = await client.callTool({ name: "sched_delete_session", arguments: { session_key: "abc" } });
    expect(res.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("maps add_session arguments to Sched params", async () => {
    const f = fakeFetch(() => new Response("Ok"));
    const client = await connect(baseConfig({ access: "readwrite" }), f.fetch);
    const res = await client.callTool({
      name: "sched_add_session",
      arguments: {
        session_key: "abc123",
        name: "Keynote",
        session_start: "2026-12-01 09:00",
        session_end: "2026-12-01 10:00",
        session_type: "Keynotes",
        tags: ["ai", "keynote"],
        active: true,
        custom_fields: { room_code: "A1" },
      },
    });
    expect(res.isError).toBeFalsy();
    const body = f.calls[0]!.body;
    expect(f.calls[0]!.url).toMatch(/\/api\/session\/add$/);
    expect(Object.fromEntries(body)).toMatchObject({
      api_key: "secretkey",
      session_key: "abc123",
      name: "Keynote",
      session_start: "2026-12-01 09:00",
      session_type: "Keynotes",
      tags: "ai,keynote",
      active: "Y",
      room_code: "A1",
    });
  });

  it("rejects bad datetimes and custom fields that clobber real params", async () => {
    const f = fakeFetch(() => new Response("Ok"));
    const client = await connect(baseConfig({ access: "readwrite" }), f.fetch);
    const bad = await client.callTool({
      name: "sched_add_session",
      arguments: {
        session_key: "a",
        name: "x",
        session_type: "T",
        session_start: "tomorrow",
        session_end: "2026-12-01 10:00",
      },
    });
    expect(bad.isError).toBe(true);
    const noType = await client.callTool({
      name: "sched_add_session",
      arguments: { session_key: "a", name: "x", session_start: "2026-12-01 09:00", session_end: "2026-12-01 10:00" },
    });
    expect(noType.isError).toBe(true);
    // A real param the caller did not pass must still be blocked, so schema checks cannot be bypassed.
    for (const key of ["session_start", "media_url", "api_key"]) {
      const sneaky = await client.callTool({
        name: "sched_update_session",
        arguments: { session_key: "a", custom_fields: { [key]: "garbage" } },
      });
      expect(sneaky.isError, key).toBe(true);
    }
    expect(f.calls).toHaveLength(0);
    // zod drops a __proto__ record key before the handler; it must never reach Sched.
    await client.callTool({
      name: "sched_update_session",
      arguments: { session_key: "a", custom_fields: { ["__proto__"]: "garbage" } },
    });
    expect(f.calls.every((c) => !c.body.has("__proto__"))).toBe(true);
    f.calls.length = 0;
    const clobber = await client.callTool({
      name: "sched_update_session",
      arguments: { session_key: "a", name: "x", custom_fields: { name: "y" } },
    });
    expect(clobber.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("returns Sched errors as tool errors", async () => {
    const client = await connect(
      baseConfig({ access: "readwrite" }),
      fakeFetch(() => new Response("ERR: Authorization failed.")).fetch,
    );
    const res = await client.callTool({ name: "sched_delete_tag", arguments: { id: 5 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/read-only key/);
  });

  it("strips UI translation strings from get_event unless asked", async () => {
    const body = '{"title":"Demo","timezone":"Europe/Berlin","lang":{"a":"b"},"strings":{"c":"d"}}';
    const client = await connect(baseConfig(), fakeFetch(() => new Response(body)).fetch);
    const slim = await client.callTool({ name: "sched_get_event", arguments: {} });
    expect(JSON.parse((slim.content as { text: string }[])[0]!.text)).toEqual({ title: "Demo", timezone: "Europe/Berlin" });
    const full = await client.callTool({ name: "sched_get_event", arguments: { include_ui_strings: true } });
    expect(JSON.parse((full.content as { text: string }[])[0]!.text)).toHaveProperty("lang");
  });

  it("encodes tag metadata and returns JSON", async () => {
    const f = fakeFetch(() => new Response('{"result":{"id":7},"status":"OK","code":0}'));
    const client = await connect(baseConfig({ access: "readwrite" }), f.fetch);
    const res = await client.callTool({ name: "sched_add_tag", arguments: { name: "AI", metadata: { color: "red" } } });
    expect(f.calls[0]!.url).toBe("https://demo.sched.com/api/tag/people/add");
    expect(f.calls[0]!.body.get("metadata[color]")).toBe("red");
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({ result: { id: 7 } });
  });
});
