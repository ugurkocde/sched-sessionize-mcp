import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SessionizeClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { describeStatus, runSetup } from "../src/setup.js";
import { configFilePath, readStoredConfig, resolveConfig, writeStoredConfig, type Resolution } from "../src/storage.js";
import type { SetupIO } from "../src/tty.js";
import demo from "./fixtures/demo-all.json" with { type: "json" };

const tmpPath = async () => join(await mkdtemp(join(tmpdir(), "sz-setup-")), "nested", "sessionize.json");
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

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

/** Known endpoint "goodid12" returns the demo data; everything else is a 404. */
const fakeSessionize = (async (url: string | URL | Request) =>
  String(url).includes("/api/v2/goodid12/") ? json(demo) : new Response("<html>", { status: 404 })) as typeof fetch;

describe("settings file", () => {
  it("defaults per platform and honours SESSIONIZE_CONFIG_FILE", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/ugurlabs-mcp/sessionize.json");
    expect(configFilePath({ SESSIONIZE_CONFIG_FILE: "/c.json" })).toBe("/c.json");
  });

  it("writes owner-only; env wins; corrupt files are reported, not thrown", async () => {
    const path = await tmpPath();
    expect(resolveConfig({}, path)).toMatchObject({ config: null, problem: null });
    writeStoredConfig(path, { endpointId: "fileid99" });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(resolveConfig({}, path)).toMatchObject({ source: "file", config: { endpointId: "fileid99" } });
    expect(resolveConfig({ SESSIONIZE_ENDPOINT_ID: "envid123" }, path)).toMatchObject({ source: "env", config: { endpointId: "envid123" } });
    const bad = await tmpPath();
    writeStoredConfig(bad, { endpointId: "x" });
    await (await import("node:fs/promises")).writeFile(bad, "{not json");
    expect(resolveConfig({}, bad)).toMatchObject({ config: null, problem: /not valid JSON/ });
  });
});

describe("setup mode", () => {
  it("starts with only the status tool and activates when settings appear", async () => {
    let resolution: Resolution = { config: null, source: null, path: "/tmp/s.json", problem: null };
    const server = createServer(null, undefined, {
      reload: () => resolution,
      pollMs: 0,
      makeClient: (c) => new SessionizeClient(c, fakeSessionize),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["sessionize_setup_status"]);
    const text = ((await client.callTool({ name: "sessionize_setup_status", arguments: {} })).content as { text: string }[])[0]!.text;
    expect(text).toContain("npx -y @ugurlabs/sessionize-mcp-server setup");
    expect(text).toMatch(/Do not ask the user to paste the endpoint ID/);

    resolution = { config: { endpointId: "goodid12", cacheSeconds: 0, timeoutMs: 5000 }, source: "file", path: "/tmp/s.json" };
    const after = ((await client.callTool({ name: "sessionize_setup_status", arguments: {} })).content as { text: string }[])[0]!.text;
    expect(after).toMatch(/Set up and connected/);
    expect(after).not.toContain("goodid12");
    const overview = await client.callTool({ name: "sessionize_get_overview", arguments: {} });
    expect(overview.isError).toBeFalsy();
  });
});

describe("review fixes", () => {
  it("swaps to a new endpoint and removes tools on reset, without restarting", async () => {
    const cfg = (endpointId: string) => ({ endpointId, cacheSeconds: 0, timeoutMs: 5000 });
    let resolution: Resolution = { config: cfg("goodid12"), source: "file", path: "/tmp/s.json" };
    const seen: string[] = [];
    const server = createServer(cfg("goodid12"), undefined, {
      reload: () => resolution,
      pollMs: 0,
      makeClient: (c) => new SessionizeClient(c, (async (u: string | URL | Request) => { seen.push(String(u)); return fakeSessionize(u); }) as typeof fetch),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const status = async () => ((await client.callTool({ name: "sessionize_setup_status", arguments: {} })).content as { text: string }[])[0]!.text;

    resolution = { config: cfg("otherid9"), source: "file", path: "/tmp/s.json" };
    await status();
    const r = await client.callTool({ name: "sessionize_get_overview", arguments: {} });
    expect(r.isError).toBe(true); // otherid9 is unknown to the fake: proves the new endpoint is in use
    expect(seen.at(-1)).toContain("/api/v2/otherid9/");

    resolution = { config: null, source: null, path: "/tmp/s.json", problem: null };
    expect(await status()).toMatch(/not set up yet/);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["sessionize_setup_status"]);
  });

  it("resolves a relative config path to an absolute one", async () => {
    const { isAbsolute } = await import("node:path");
    expect(isAbsolute(configFilePath({ SESSIONIZE_CONFIG_FILE: "rel/s.json" }))).toBe(true);
  });
});

describe("runSetup", () => {
  it("accepts a pasted URL, validates it and saves only the ID", async () => {
    const path = await tmpPath();
    const { io, out } = scriptedIO(["https://sessionize.com/api/v2/goodid12/view/All"]);
    expect(await runSetup(io, { path, fetchImpl: fakeSessionize })).toBe(true);
    expect(readStoredConfig(path)).toEqual({ endpointId: "goodid12" });
    expect(out.join("\n")).toMatch(/shows 10 sessions/);
    expect(out.join("\n")).not.toContain("goodid12");
  });

  it("explains an unknown ID and retries; Enter keeps the saved ID", async () => {
    const path = await tmpPath();
    const first = scriptedIO(["wrongid1", true, "goodid12"]);
    expect(await runSetup(first.io, { path, fetchImpl: fakeSessionize })).toBe(true);
    expect(first.out.join("\n")).toMatch(/does not know this endpoint ID/);
    const again = scriptedIO([""]);
    expect(await runSetup(again.io, { path, fetchImpl: fakeSessionize })).toBe(true);
    expect(readStoredConfig(path)).toEqual({ endpointId: "goodid12" });
    expect(describeStatus(path, readStoredConfig(path), false).join("\n")).toContain("go****12");
    expect(await readFile(path, "utf8")).toContain("goodid12");
  });

  it("rejects input that is not an endpoint ID", async () => {
    const { io, out } = scriptedIO(["not an id!", "", "also bad!"]);
    expect(await runSetup(io, { path: await tmpPath(), fetchImpl: fakeSessionize })).toBe(false);
    expect(out.join("\n")).toMatch(/does not look like a Sessionize endpoint ID/);
  });
});
