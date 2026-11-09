import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { SchedClient } from "../src/client.js";
import type { SchedConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { describeStatus, runSetup } from "../src/setup.js";
import { configFilePath, readStoredConfig, resolveConfig, writeStoredConfig, type Resolution } from "../src/storage.js";
import type { SetupIO } from "../src/tty.js";

const tmpPath = async () => join(await mkdtemp(join(tmpdir(), "sched-setup-")), "nested", "sched.json");

/** Scripted terminal: answers are consumed in order; everything printed is captured. */
function scriptedIO(answers: (string | boolean)[]) {
  const out: string[] = [];
  const next = () => {
    if (!answers.length) throw new Error("setup asked more questions than scripted");
    return answers.shift()!;
  };
  const io: SetupIO = {
    print: (m) => out.push(m),
    ask: async (_q, def) => String(next()) || def || "",
    askSecret: async () => String(next()),
    confirm: async () => Boolean(next()),
  };
  return { io, out };
}

/** Fake Sched: site/sync answers per key, session/add tells write access. */
function fakeSched(keys: Record<string, "rw" | "ro">) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = String(_url);
    const body = new URLSearchParams(String(init?.body));
    const kind = keys[body.get("api_key") ?? ""];
    if (!url.startsWith("https://myconf.sched.com/")) return new Response(null, { status: 302, headers: { location: "https://www.sched.com/" } });
    if (!kind) return new Response("ERR: Authorization failed.");
    if (url.endsWith("/api/site/sync")) return new Response('{"title":"My Conf 2027","status":"updated"}');
    if (url.endsWith("/api/session/add")) return new Response(kind === "rw" ? "ERR: Required field is missing: session_key" : "ERR: Authorization failed.");
    return new Response("ERR: unexpected");
  }) as typeof fetch;
}

describe("settings file", () => {
  it("uses XDG / APPDATA locations and SCHED_CONFIG_FILE overrides", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/ugurlabs-mcp/sched.json");
    expect(configFilePath({}, "darwin", "/Users/u")).toBe("/Users/u/.config/ugurlabs-mcp/sched.json");
    expect(configFilePath({ APPDATA: "C:\\AppData" }, "win32", "C:\\u")).toContain("ugurlabs-mcp");
    expect(configFilePath({ SCHED_CONFIG_FILE: "/custom.json" })).toBe("/custom.json");
  });

  it("writes owner-only and resolves with env taking precedence", async () => {
    const path = await tmpPath();
    expect(resolveConfig({}, path)).toMatchObject({ config: null, problem: null });
    writeStoredConfig(path, { event: "https://myconf.sched.com", apiKey: "filekey", access: "readwrite" });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(resolveConfig({}, path)).toMatchObject({ source: "file", config: { apiKey: "filekey", access: "readwrite" } });
    expect(resolveConfig({ SCHED_API_KEY: "envkey", SCHED_ACCESS: "read" }, path)).toMatchObject({
      source: "env",
      config: { apiKey: "envkey", access: "read", baseUrl: "https://myconf.sched.com" },
    });
    expect(resolveConfig({ SCHED_API_KEY: "only-key" }, await tmpPath())).toMatchObject({ config: null, problem: /event is missing/ });
  });
});

describe("setup mode", () => {
  const config: SchedConfig = { baseUrl: "https://myconf.sched.com", apiKey: "k", access: "read", rateLimitPerMinute: 1000, timeoutMs: 5000 };

  it("starts with only the status tool, never asks for the key in chat, and activates without restart", async () => {
    let resolution: Resolution = { config: null, source: null, path: "/tmp/x.json", problem: null };
    const server = createServer(null, undefined, {
      reload: () => resolution,
      pollMs: 0,
      makeClient: (c) => new SchedClient(c, (async () => new Response("[]")) as typeof fetch),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    await Promise.all([server.connect(a), client.connect(b)]);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["sched_setup_status"]);
    const before = await client.callTool({ name: "sched_setup_status", arguments: {} });
    const text = (before.content as { text: string }[])[0]!.text;
    expect(text).toContain("npx -y @ugurlabs/sched-mcp-server setup");
    expect(text).toMatch(/Do not ask the user to paste their API key/);

    resolution = { config, source: "file", path: "/tmp/x.json" };
    const after = await client.callTool({ name: "sched_setup_status", arguments: {} });
    expect((after.content as { text: string }[])[0]!.text).toMatch(/Set up for https:\/\/myconf\.sched\.com with read-only access/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("sched_list_sessions");
    expect(names).not.toContain("sched_add_session");
    expect(changed).toBeGreaterThan(0);
  });

  it("picks up settings by polling", async () => {
    let resolution: Resolution = { config: null, source: null, path: "/tmp/x.json", problem: null };
    const server = createServer(null, undefined, { reload: () => resolution, pollMs: 20 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    resolution = { config: { ...config, access: "readwrite" }, source: "file", path: "/tmp/x.json" };
    await new Promise((r) => setTimeout(r, 120));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("sched_add_session");
  });
});

describe("review fixes", () => {
  const config: SchedConfig = { baseUrl: "https://myconf.sched.com", apiKey: "k1", access: "read", rateLimitPerMinute: 1000, timeoutMs: 5000 };

  it("swaps tools when settings change and removes them on reset, without restarting", async () => {
    let resolution: Resolution = { config, source: "file", path: "/tmp/x.json" };
    const server = createServer(config, undefined, { reload: () => resolution, pollMs: 0 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    const status = async () => ((await client.callTool({ name: "sched_setup_status", arguments: {} })).content as { text: string }[])[0]!.text;

    expect(await names()).not.toContain("sched_add_session");
    resolution = { config: { ...config, access: "readwrite" }, source: "file", path: "/tmp/x.json" };
    expect(await status()).toMatch(/read\/write access/);
    expect(await names()).toContain("sched_add_session");

    resolution = { config: { ...config, baseUrl: "https://other.sched.com", apiKey: "k2", access: "read" }, source: "file", path: "/tmp/x.json" };
    expect(await status()).toMatch(/other\.sched\.com with read-only/);
    expect(await names()).not.toContain("sched_add_session");

    resolution = { config: null, source: null, path: "/tmp/x.json", problem: null }; // reset
    expect(await status()).toMatch(/not set up yet/);
    expect(await names()).toEqual(["sched_setup_status"]);
  });

  it("names the file, not an env var, for a bad saved access value", async () => {
    const path = await tmpPath();
    writeStoredConfig(path, { event: "https://myconf.sched.com", apiKey: "k", access: "read" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ event: "https://myconf.sched.com", apiKey: "k", access: "bogus" }));
    const r = resolveConfig({}, path);
    expect(r.config).toBeNull();
    expect(r.problem).toContain(path);
    expect(r.problem).not.toContain("SCHED_ACCESS");
  });

  it("leaves no temp file behind and resolves relative config paths", async () => {
    const path = await tmpPath();
    writeStoredConfig(path, { event: "https://myconf.sched.com", apiKey: "k", access: "read" });
    writeStoredConfig(path, { event: "https://myconf.sched.com", apiKey: "k2", access: "read" });
    const { readdir } = await import("node:fs/promises");
    const { dirname, isAbsolute } = await import("node:path");
    expect((await readdir(dirname(path))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(isAbsolute(configFilePath({ SCHED_CONFIG_FILE: "relative/sched.json" }))).toBe(true);
  });
});

describe("runSetup", () => {
  it("saves a read/write key only when the user enables write tools", async () => {
    const path = await tmpPath();
    const { io, out } = scriptedIO(["myconf", "rwkey", true]);
    expect(await runSetup(io, { path, fetchImpl: fakeSched({ rwkey: "rw" }) })).toBe(true);
    expect(readStoredConfig(path)).toMatchObject({ event: "https://myconf.sched.com", apiKey: "rwkey", access: "readwrite" });
    expect(out.join("\n")).toContain('Connected to "My Conf 2027"');
    expect(out.join("\n")).not.toContain("rwkey");
  });

  it("detects a read-only key without asking about write tools", async () => {
    const path = await tmpPath();
    const { io } = scriptedIO(["myconf", "rokey"]);
    expect(await runSetup(io, { path, fetchImpl: fakeSched({ rokey: "ro" }) })).toBe(true);
    expect(readStoredConfig(path)).toMatchObject({ access: "read" });
  });

  it("explains a wrong key, retries, and keeps the saved key on Enter", async () => {
    const path = await tmpPath();
    const fetchImpl = fakeSched({ goodkey: "rw" });
    const first = scriptedIO(["myconf", "badkey", true, "myconf", "goodkey", false]);
    expect(await runSetup(first.io, { path, fetchImpl })).toBe(true);
    expect(first.out.join("\n")).toMatch(/rejected the API key/);
    expect(readStoredConfig(path)).toMatchObject({ apiKey: "goodkey", access: "read" });

    const again = scriptedIO(["", "", true]); // keep event and key, now enable write tools
    expect(await runSetup(again.io, { path, fetchImpl })).toBe(true);
    expect(readStoredConfig(path)).toMatchObject({ apiKey: "goodkey", access: "readwrite" });
    expect(describeStatus(path, readStoredConfig(path), false).join("\n")).toMatch(/ends in dkey/);
  });

  it("explains an unknown event", async () => {
    const { io, out } = scriptedIO(["other-event", "k", false]);
    expect(await runSetup(io, { path: await tmpPath(), fetchImpl: fakeSched({ k: "rw" }) })).toBe(false);
    expect(out.join("\n")).toMatch(/does not know this event/);
  });

  it("never writes the key into the file name or output", async () => {
    const path = await tmpPath();
    const { io, out } = scriptedIO(["myconf", "secretvalue123", true]);
    await runSetup(io, { path, fetchImpl: fakeSched({ secretvalue123: "rw" }) });
    expect(out.join("\n")).not.toContain("secretvalue123");
    expect(await readFile(path, "utf8")).toContain("secretvalue123");
  });
});
