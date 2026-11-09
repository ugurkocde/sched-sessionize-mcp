import { createHash } from "node:crypto";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SessionizeClient } from "./client.js";
import type { SessionizeConfig } from "./config.js";
import { SETUP_COMMAND, type Resolution } from "./storage.js";
import { TOOLS } from "./tools.js";

export const SERVER_NAME = "sessionize";
export const SERVER_VERSION = "0.1.0";
export const STATUS_TOOL = "sessionize_setup_status";

export interface ServerOptions {
  /** Re-reads settings; used to pick up `setup` without restarting the server. */
  reload?: () => Resolution;
  /** How often to re-read settings, to pick up setup, a new key or a reset. 0 disables polling. */
  pollMs?: number;
  makeClient?: (config: SessionizeConfig) => SessionizeClient;
}

function setupText(resolution: Resolution | null): string {
  const lines = [
    "The Sessionize MCP server is installed but not set up yet.",
    "",
    `Ask the user to run this command in a terminal: ${SETUP_COMMAND}`,
    "It explains how to create a JSON endpoint on the API / Embed page in Sessionize, asks for the endpoint ID, checks it, and saves it on this computer.",
    "Do not ask the user to paste the endpoint ID into this chat; it works like a password.",
    "",
    "After setup the Sessionize tools appear automatically. If they do not, reconnect the server (in Claude Code: /mcp).",
  ];
  if (resolution?.problem) lines.push("", `Problem found: ${resolution.problem}`);
  if (resolution) lines.push("", `Settings file: ${resolution.path}`);
  return lines.join("\n");
}

function registerSessionizeTools(server: McpServer, client: SessionizeClient): RegisteredTool[] {
  return TOOLS.map((tool) =>
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: tool.readOnly,
          openWorldHint: true,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.run(client, args ?? {});
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    ),
  );
}

/** Identifies a configuration without keeping the endpoint ID in plain text. */
function signature(c: SessionizeConfig): string {
  return [createHash("sha256").update(c.endpointId).digest("hex"), c.cacheSeconds, c.timeoutMs].join("|");
}

/**
 * With a config the server starts normally. Without one it starts in setup mode:
 * only the status tool is available until settings appear, then the Sessionize
 * tools are registered and the client is notified that the tool list changed.
 */
export function createServer(config: SessionizeConfig | null, client?: SessionizeClient, opts: ServerOptions = {}): McpServer {
  const makeClient = opts.makeClient ?? ((c: SessionizeConfig) => new SessionizeClient(c));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: config
        ? "Read-only access to one Sessionize event through its API / Embed endpoint. Use sessionize_get_overview first. Filter sessions by status 'confirmed' for speakers who confirmed, or 'accepted' for all accepted sessions. sessionize_export writes local files only."
        : `Not set up yet. Call ${STATUS_TOOL} for instructions. Never ask the user to paste the endpoint ID into the chat.`,
    },
  );

  // The registered tools for the current settings; swapped when setup or reset changes them.
  let current: { sig: string; tools: RegisteredTool[] } | null = null;
  const apply = (cfg: SessionizeConfig | null, c?: SessionizeClient) => {
    const sig = cfg ? signature(cfg) : null;
    if ((current?.sig ?? null) === sig) return;
    for (const t of current?.tools ?? []) t.remove();
    current = cfg ? { sig: sig!, tools: registerSessionizeTools(server, c ?? makeClient(cfg)) } : null;
  };
  const refresh = (): Resolution | null => {
    if (!opts.reload) return null;
    const r = opts.reload();
    apply(r.config);
    return r;
  };

  server.registerTool(
    STATUS_TOOL,
    {
      title: "Setup status",
      description: "Shows whether the Sessionize server is set up and, if not, how the user can set it up.",
      inputSchema: {},
      annotations: { title: "Setup status", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const r = refresh();
      if (current) {
        return {
          content: [
            {
              type: "text",
              text: `Set up and connected to a Sessionize endpoint. To use a different endpoint, the user can run "${SETUP_COMMAND}" in a terminal; the server picks up the change within a few seconds.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: setupText(r) }] };
    },
  );

  if (config) apply(config, client);
  if (opts.reload && (opts.pollMs ?? 3000) > 0) {
    const timer = setInterval(() => {
      try {
        refresh();
      } catch {
        /* keep the current tools */
      }
    }, opts.pollMs ?? 3000);
    timer.unref();
  }
  return server;
}
