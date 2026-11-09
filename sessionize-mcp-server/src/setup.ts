import { SessionizeApiError, SessionizeClient } from "./client.js";
import { ConfigError, parseEndpointId } from "./config.js";
import { buildModel, matchesStatus } from "./model.js";
import { readStoredConfig, writeStoredConfig, type StoredConfig } from "./storage.js";
import type { SetupIO } from "./tty.js";

export interface SetupDeps {
  path: string;
  fetchImpl?: typeof fetch;
}

const mask = (id: string) => (id.length <= 4 ? "****" : `${id.slice(0, 2)}****${id.slice(-2)}`);

/** Interactive setup. Returns true when settings were saved. */
export async function runSetup(io: SetupIO, deps: SetupDeps): Promise<boolean> {
  let existing: StoredConfig | null = null;
  try {
    existing = readStoredConfig(deps.path);
  } catch {
    existing = null;
  }

  io.print("Sessionize MCP server setup");
  io.print("");
  io.print("Sessionize has no API keys. Instead, you create a read-only endpoint for your event:");
  io.print("  1. In Sessionize, open your event and go to API / Embed.");
  io.print('  2. Click "Create new endpoint" and set the format to JSON.');
  io.print('  3. Choose which sessions to include (for example "Accepted And Informed").');
  io.print("  4. Tick the fields you want: Session Description, Speaker Photo, Speaker Biography, links.");
  io.print("     Leave private submission questions (allergies, hotel, T-shirt size) unticked.");
  io.print('  5. Save, click "Get Code" and copy the endpoint ID: the part after /api/v2/ in the URL.');
  io.print("     You can also paste the whole URL.");
  io.print("");
  io.print("Keep the endpoint ID private: anyone who has it can read what the endpoint exposes.");
  io.print("");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const input = await io.askSecret(
      existing ? `Endpoint ID or URL (press Enter to keep ${mask(existing.endpointId)})` : "Endpoint ID or URL",
    );
    let endpointId: string;
    try {
      endpointId = input ? parseEndpointId(input) : existing ? existing.endpointId : parseEndpointId("");
    } catch (err) {
      io.print(err instanceof ConfigError ? "That does not look like a Sessionize endpoint ID or API URL." : String(err));
      continue;
    }

    io.print("Checking with Sessionize...");
    const client = new SessionizeClient({ endpointId, cacheSeconds: 0, timeoutMs: 30_000 }, deps.fetchImpl);
    try {
      const model = buildModel(await client.getAll(true));
      const regular = model.sessions.filter((s) => !s.isServiceSession);
      const confirmed = regular.filter((s) => matchesStatus(s, "confirmed")).length;
      io.print(
        `Connected. The endpoint currently shows ${regular.length} sessions (${confirmed} confirmed) and ${model.speakers.length} speakers.`,
      );
      if (regular.length === 0) {
        io.print("No sessions yet is normal until sessions are accepted and match the endpoint's \"Includes sessions\" setting.");
      }
    } catch (err) {
      const msg =
        err instanceof SessionizeApiError && err.status === 404
          ? "Sessionize does not know this endpoint ID. Copy it again from Get Code on the API / Embed page."
          : err instanceof Error
            ? err.message
            : String(err);
      io.print(msg);
      if (attempt < 3 && (await io.confirm("Try again?", true))) continue;
      return false;
    }

    writeStoredConfig(deps.path, { endpointId });
    io.print("");
    io.print(`Saved to ${deps.path} (readable only by your user account).`);
    io.print("");
    io.print("Next: go back to your AI client. The Sessionize tools appear automatically.");
    io.print("If they do not, reconnect the server (in Claude Code: /mcp) or restart the client.");
    return true;
  }
  io.print("Setup was not completed.");
  return false;
}

/** Prints where settings come from without revealing the endpoint ID. */
export function describeStatus(path: string, stored: StoredConfig | null, envOverride: boolean): string[] {
  const lines = [`Settings file: ${path}`];
  lines.push(stored ? `Endpoint ID: saved (${mask(stored.endpointId)})` : "Not set up yet.");
  if (envOverride) lines.push("Note: the SESSIONIZE_ENDPOINT_ID environment variable is set and takes precedence over the file.");
  return lines;
}
