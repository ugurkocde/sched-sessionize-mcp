#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { describeStatus, runSetup } from "./setup.js";
import { configFilePath, deleteStoredConfig, readStoredConfig, resolveConfig, SETUP_COMMAND } from "./storage.js";
import { createTerminalIO, NotInteractiveError, SetupCancelledError } from "./tty.js";

const HELP = `Sched MCP server ${SERVER_VERSION}

Usage:
  sched-mcp-server            Start the MCP server (your AI client runs this)
  sched-mcp-server setup      Set up the Sched event and API key in this terminal
  sched-mcp-server status     Show where settings come from (the key is not shown)
  sched-mcp-server reset      Delete the saved settings
  sched-mcp-server --version

Settings file: ${configFilePath()}
Environment variables SCHED_EVENT, SCHED_API_KEY and SCHED_ACCESS override the file.`;

async function serve(): Promise<void> {
  const first = resolveConfig();
  const server = createServer(first.config, undefined, { reload: () => resolveConfig() });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only, and never log the key.
  if (first.config) {
    console.error(`sched-mcp-server: connected to ${first.config.baseUrl} (${first.config.access}, settings from ${first.source})`);
  } else {
    console.error(`sched-mcp-server: not set up yet; run "${SETUP_COMMAND}" in a terminal${first.problem ? ` (${first.problem})` : ""}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const path = configFilePath();
  switch (cmd) {
    case undefined:
      return serve();
    case "setup": {
      const ok = await runSetup(createTerminalIO(), { path });
      process.exit(ok ? 0 : 1);
    }
    case "status": {
      let stored = null;
      try {
        stored = readStoredConfig(path);
      } catch (err) {
        console.log((err as Error).message);
      }
      const envOverride = Boolean(process.env.SCHED_EVENT?.trim() || process.env.SCHED_API_KEY?.trim());
      console.log(describeStatus(path, stored, envOverride).join("\n"));
      return;
    }
    case "reset":
      console.log(deleteStoredConfig(path) ? `Deleted ${path}` : `Nothing to delete at ${path}`);
      return;
    case "--version":
    case "-v":
      console.log(SERVER_VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  if (err instanceof SetupCancelledError) {
    console.error("Setup cancelled. Nothing was changed.");
    process.exit(130);
  }
  if (err instanceof NotInteractiveError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error("sched-mcp-server: fatal", err);
  process.exit(1);
});
