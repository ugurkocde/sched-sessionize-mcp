#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { describeStatus, runSetup } from "./setup.js";
import { configFilePath, deleteStoredConfig, readStoredConfig, resolveConfig, SETUP_COMMAND } from "./storage.js";
import { createTerminalIO, NotInteractiveError, SetupCancelledError } from "./tty.js";

const HELP = `Sessionize MCP server ${SERVER_VERSION}

Usage:
  sessionize-mcp-server            Start the MCP server (your AI client runs this)
  sessionize-mcp-server setup      Set up the Sessionize endpoint in this terminal
  sessionize-mcp-server status     Show where settings come from (the ID is not shown)
  sessionize-mcp-server reset      Delete the saved settings
  sessionize-mcp-server --version

Settings file: ${configFilePath()}
The SESSIONIZE_ENDPOINT_ID environment variable overrides the file.`;

async function serve(): Promise<void> {
  const first = resolveConfig();
  const server = createServer(first.config, undefined, { reload: () => resolveConfig() });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only. The endpoint ID is a secret and is never logged.
  if (first.config) {
    console.error(`sessionize-mcp-server: ready (settings from ${first.source})`);
  } else {
    console.error(`sessionize-mcp-server: not set up yet; run "${SETUP_COMMAND}" in a terminal${first.problem ? ` (${first.problem})` : ""}`);
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
      console.log(describeStatus(path, stored, Boolean(process.env.SESSIONIZE_ENDPOINT_ID?.trim())).join("\n"));
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
  console.error("sessionize-mcp-server: fatal", err);
  process.exit(1);
});
