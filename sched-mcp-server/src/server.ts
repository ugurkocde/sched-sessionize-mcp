import { createHash } from "node:crypto";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SchedClient } from "./client.js";
import type { SchedConfig } from "./config.js";
import { SETUP_COMMAND, type Resolution } from "./storage.js";
import { TOOLS, type ToolDef } from "./tools.js";

export const SERVER_NAME = "sched";
export const SERVER_VERSION = "0.1.0";
export const STATUS_TOOL = "sched_setup_status";

/** Write tools are only registered when the server runs with a read/write key. */
export function toolsFor(access: SchedConfig["access"]): ToolDef[] {
  return TOOLS.filter((t) => t.access === "read" || access === "readwrite");
}

export interface ServerOptions {
  /** Re-reads settings; used to pick up `setup` without restarting the server. */
  reload?: () => Resolution;
  /** How often to re-read settings, to pick up setup, a new key or a reset. 0 disables polling. */
  pollMs?: number;
  /** Client factory, replaced in tests. */
  makeClient?: (config: SchedConfig) => SchedClient;
}

function setupText(resolution: Resolution | null): string {
  const lines = [
    "The Sched MCP server is installed but not set up yet.",
    "",
    `Ask the user to run this command in a terminal: ${SETUP_COMMAND}`,
    "It asks for the Sched event and API key, checks them, and saves them on this computer.",
    "Do not ask the user to paste their API key into this chat; the setup command keeps it out of the conversation.",
    "",
    "After setup the Sched tools appear automatically. If they do not, reconnect the server (in Claude Code: /mcp).",
  ];
  if (resolution?.problem) lines.push("", `Problem found: ${resolution.problem}`);
  if (resolution) lines.push("", `Settings file: ${resolution.path}`);
  return lines.join("\n");
}

function registerSchedTools(server: McpServer, config: SchedConfig, client: SchedClient): RegisteredTool[] {
  return toolsFor(config.access).map((tool) =>
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === "read",
          destructiveHint: tool.access === "write" ? Boolean(tool.destructive) : undefined,
          idempotentHint: tool.access === "read" ? true : Boolean(tool.idempotent),
          openWorldHint: true,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const res = await tool.run(client, args ?? {});
          const text = res.json !== undefined ? JSON.stringify(res.json, null, 2) : res.text || "Ok";
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
    ),
  );
}

/** Identifies a configuration without keeping the key in plain text. */
function signature(c: SchedConfig): string {
  const key = createHash("sha256").update(c.apiKey).digest("hex");
  return [c.baseUrl, c.access, key, c.rateLimitPerMinute, c.timeoutMs].join("|");
}

/**
 * With a config the server starts normally. Without one it starts in setup mode:
 * only the status tool is available until settings appear, then the Sched tools
 * are registered and the client is notified that the tool list changed.
 */
export function createServer(config: SchedConfig | null, client?: SchedClient, opts: ServerOptions = {}): McpServer {
  const makeClient = opts.makeClient ?? ((c: SchedConfig) => new SchedClient(c));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: config
        ? config.access === "readwrite"
          ? `Connected to the Sched event at ${config.baseUrl} with a read/write API key. Write tools change the live event; confirm with the user before creating, modifying or deleting data.`
          : `Connected to the Sched event at ${config.baseUrl} with a read-only API key. Only read tools are available.`
        : `Not set up yet. Call ${STATUS_TOOL} for instructions. Never ask the user to paste an API key into the chat.`,
    },
  );

  // The registered Sched tools for the current settings. Re-running setup or reset
  // swaps them while the server keeps running.
  let current: { sig: string; config: SchedConfig; tools: RegisteredTool[] } | null = null;
  const apply = (cfg: SchedConfig | null, c?: SchedClient) => {
    const sig = cfg ? signature(cfg) : null;
    if ((current?.sig ?? null) === sig) return;
    for (const t of current?.tools ?? []) t.remove();
    current = cfg ? { sig: sig!, config: cfg, tools: registerSchedTools(server, cfg, c ?? makeClient(cfg)) } : null;
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
      description: "Shows whether the Sched server is set up and, if not, how the user can set it up.",
      inputSchema: {},
      annotations: { title: "Setup status", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const r = refresh();
      if (current) {
        const a = current.config;
        return {
          content: [
            {
              type: "text",
              text: `Set up for ${a.baseUrl} with ${a.access === "readwrite" ? "read/write" : "read-only"} access. To change the event or key, the user can run "${SETUP_COMMAND}" in a terminal; the server picks up the change within a few seconds.`,
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
