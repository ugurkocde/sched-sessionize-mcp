import { SchedApiError, SchedClient } from "./client.js";
import { ConfigError, normalizeEventUrl, type AccessMode } from "./config.js";
import { readStoredConfig, writeStoredConfig, type StoredConfig } from "./storage.js";
import type { SetupIO } from "./tty.js";

export interface SetupDeps {
  path: string;
  fetchImpl?: typeof fetch;
}

type WriteCheck = "write" | "read-only" | "unknown";

/** Sched has no "who am I" endpoint, so probe a write method with no fields. It never creates anything. */
async function detectWriteAccess(client: SchedClient): Promise<WriteCheck> {
  try {
    await client.call("session/add");
    return "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/required field is missing/i.test(msg)) return "write";
    if (/authori[sz]ation failed/i.test(msg)) return "read-only";
    return "unknown";
  }
}

function explainError(err: unknown): string {
  if (err instanceof SchedApiError) {
    if (err.status !== undefined && err.status >= 300 && err.status < 400) {
      return "Sched does not know this event. Check the event name: it is the part before .sched.com in your event URL.";
    }
    if (/authori[sz]ation failed/i.test(err.message)) {
      return "Sched rejected the API key. Copy it again from the Sched admin (Settings > API).";
    }
    if (err.status === 429) return "Sched is rate limiting requests right now. Wait a minute and try again.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Interactive setup. Returns true when settings were saved. */
export async function runSetup(io: SetupIO, deps: SetupDeps): Promise<boolean> {
  let existing: StoredConfig | null = null;
  try {
    existing = readStoredConfig(deps.path);
  } catch {
    existing = null;
  }

  io.print("Sched MCP server setup");
  io.print("");
  io.print("You need two things from Sched:");
  io.print("  1. Your event: the name before .sched.com (for example myconf) or the full event URL.");
  io.print("  2. An API key: in the Sched admin, open Settings > API. API access needs a paid Sched plan.");
  io.print("     Use a read-only key if you only want to look things up.");
  io.print("");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const eventInput = await io.ask("Sched event", existing?.event);
    let baseUrl: string;
    try {
      baseUrl = normalizeEventUrl(eventInput);
    } catch (err) {
      io.print(err instanceof ConfigError ? err.message : String(err));
      continue;
    }

    let apiKey = await io.askSecret(existing ? "Sched API key (press Enter to keep the saved key)" : "Sched API key");
    if (!apiKey && existing) apiKey = existing.apiKey;
    if (!apiKey) {
      io.print("The API key cannot be empty.");
      continue;
    }

    io.print("Checking with Sched...");
    const client = new SchedClient({ baseUrl, apiKey, access: "read", rateLimitPerMinute: 25, timeoutMs: 30_000 }, deps.fetchImpl);
    let title = baseUrl;
    try {
      const res = await client.call("site/sync");
      const t = (res.json as Record<string, unknown> | undefined)?.title;
      if (typeof t === "string" && t.trim()) title = t.trim();
    } catch (err) {
      io.print(explainError(err));
      if (attempt < 3 && (await io.confirm("Try again?", true))) continue;
      return false;
    }
    io.print(`Connected to "${title}" (${baseUrl}).`);

    let access: AccessMode = "read";
    const check = await detectWriteAccess(client);
    if (check === "read-only") {
      io.print("This is a read-only key, so only the read tools will be available.");
    } else {
      io.print(
        check === "write"
          ? "This key can also change your event."
          : "Could not tell whether this key can change your event.",
      );
      const allow = await io.confirm(
        "Enable the tools that create, update and delete sessions, people and tags?",
        existing?.access === "readwrite",
      );
      access = allow ? "readwrite" : "read";
    }

    writeStoredConfig(deps.path, { event: baseUrl, apiKey, access });
    io.print("");
    io.print(`Saved to ${deps.path} (readable only by your user account).`);
    io.print(`Access: ${access === "readwrite" ? "read and write" : "read-only"}.`);
    io.print("");
    io.print("Next: go back to your AI client. The Sched tools appear automatically.");
    io.print("If they do not, reconnect the server (in Claude Code: /mcp) or restart the client.");
    return true;
  }
  io.print("Setup was not completed.");
  return false;
}

/** Prints where settings come from without revealing the key. */
export function describeStatus(path: string, stored: StoredConfig | null, envOverride: boolean): string[] {
  const lines = [`Settings file: ${path}`];
  if (stored) {
    lines.push(`Event: ${stored.event}`);
    lines.push(`Access: ${stored.access === "readwrite" ? "read and write" : "read-only"}`);
    lines.push(`API key: saved (ends in ${stored.apiKey.slice(-4)})`);
  } else {
    lines.push("Not set up yet.");
  }
  if (envOverride) lines.push("Note: SCHED_EVENT / SCHED_API_KEY environment variables are set and take precedence over the file.");
  return lines;
}
