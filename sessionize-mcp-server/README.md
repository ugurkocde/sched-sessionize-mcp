# sessionize-mcp-server

`@ugurlabs/sessionize-mcp-server` on npm. Part of [sched-sessionize-mcp](../README.md).

Read-only MCP server for one Sessionize event. Export accepted or confirmed sessions with titles, descriptions, categories and speakers, list speakers with bios and profile pictures, and save everything to CSV, JSON or Markdown, with speaker photos downloaded to a folder.

## How access works

Sessionize has no API keys. Each event can create read-only endpoints on its **API / Embed** page, and each endpoint has a unique ID. That ID is the credential: anyone who has it can read what the endpoint exposes, so keep it private.

1. In your Sessionize event, open **API / Embed** and create an endpoint.
2. Set the format to **JSON**.
3. Under **Includes sessions**, pick what the endpoint should expose. The default is accepted sessions whose speakers have been informed. Use the accepted mode if you also want sessions where speakers have not been told yet.
4. Enable the custom fields you need (categories, questions, speaker links).
5. Copy the endpoint ID from **Get Code** (the part after `/api/v2/` in the URL).

Times and rooms are only included after the schedule is announced in Sessionize. Sessionize caches responses for up to 5 minutes; "Get Code" has a button to clear that cache.

## Installation

Requires Node.js 22 or later. Your MCP client runs the published package with `npx`; nothing to clone or build.

1. Add the server. Claude Code:

   ```bash
   claude mcp add sessionize --scope user -- npx -y @ugurlabs/sessionize-mcp-server
   ```

   Other MCP clients: `{ "command": "npx", "args": ["-y", "@ugurlabs/sessionize-mcp-server"] }`. On Windows (not WSL), use `cmd /c npx -y @ugurlabs/sessionize-mcp-server`.

2. Run the setup once, in a terminal:

   ```bash
   npx -y @ugurlabs/sessionize-mcp-server setup
   ```

   It explains how to create the endpoint (see above), asks for the endpoint ID or the URL from **Get Code** (hidden while you type), checks it with Sessionize, and saves it to `~/.config/ugurlabs-mcp/sessionize.json` (or under `$XDG_CONFIG_HOME` if set; Windows: `%APPDATA%\ugurlabs-mcp\sessionize.json`), readable only by your user account.

Until setup is done the server offers only `sessionize_setup_status`, which tells the assistant (and you) which command to run. After setup the tools appear without restarting; if your client does not refresh, reconnect the server (in Claude Code: `/mcp`).

Commands: `setup`, `status` (shows the source of the settings, never the full ID), `reset` (deletes the saved settings), `--help`. A running server picks up a new `setup` or a `reset` within a few seconds.

From source: `npm ci && npm run build`, then use `node /absolute/path/to/sessionize-mcp-server/dist/index.js` as the command.

## Configuration

Setup is the easiest way. Environment variables override the saved settings:

| Variable | Description |
| --- | --- |
| `SESSIONIZE_ENDPOINT_ID` | Endpoint ID, or the full API URL containing it |
| `SESSIONIZE_CONFIG_FILE` | Use a different settings file, for example one per event |
| `SESSIONIZE_CACHE_SECONDS` | Reuse fetched data between tool calls, default `60`. Tools also accept `refresh: true` |
| `SESSIONIZE_TIMEOUT_MS` | Request timeout, default `30000` |

## Tools

| Tool | What it does |
| --- | --- |
| `sessionize_setup_status` | Reports whether the server is set up and how to set it up |
| `sessionize_get_overview` | Counts by status (accepted, informed, confirmed), speakers with photos, rooms, categories |
| `sessionize_list_sessions` | Sessions with description, status, categories, room, times and speakers (name, tagline, photo URL) |
| `sessionize_get_session` | One session with question answers and full speaker details |
| `sessionize_list_speakers` | Speakers with bio, tagline, photo URL, links and sessions |
| `sessionize_get_speaker` | One speaker |
| `sessionize_export` | Writes CSV, JSON or Markdown to an absolute `output_dir`, optionally saving speaker photos to `output_dir/photos` |

Status filter values: `any`, `accepted`, `informed` (accepted and speaker told), `confirmed` (accepted and speaker confirmed). Other filters: `category` (track, format or level name), `room`, `search`, `include_service_sessions`.

Everything except `sessionize_export` is read-only. The export tool only writes local files; it never changes Sessionize data. Photos are only downloaded from Sessionize hosts, and CSV cells are escaped against spreadsheet formula injection.

## Development

```bash
npm test          # unit and in-memory MCP tests using a copy of Sessionize's public demo endpoint
npm run typecheck
```
