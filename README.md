# Sched and Sessionize MCP Servers

Two [Model Context Protocol](https://modelcontextprotocol.io) servers for running a conference with AI assistants such as Claude Code, Claude Desktop or any other MCP client:

| Folder | What it connects to | Access |
| --- | --- | --- |
| [`sched-mcp-server`](sched-mcp-server) | [Sched](https://sched.com) event schedule, sessions, people, roles and tags | Read-only or read/write, depending on your API key |
| [`sessionize-mcp-server`](sessionize-mcp-server) | [Sessionize](https://sessionize.com) call for speakers: sessions, speakers, photos | Read-only |

A common setup is to run the call for speakers on Sessionize and everything attendee-facing (schedule, registration, tickets, mobile app) on Sched. With both servers connected, an assistant can read the selected sessions from Sessionize and publish them to Sched for you.

## Main use case: sync approved Sessionize sessions to Sched

Once you have selected your sessions in Sessionize, the assistant moves them into your Sched schedule. That covers session titles, descriptions, tracks, rooms and times, plus speaker profiles with bios and photos.

### How it works

```
Sessionize (read-only)                          Sched (read/write)
----------------------                          ------------------
sessionize_list_sessions  status=confirmed  -->  sched_add_session / sched_update_session
sessionize_get_speaker    bio, tagline, photo -> sched_add_user (role: speaker, avatar URL)
                                                 sched_add_role (link speaker to session)
```

1. **Pick what counts as approved.** In Sessionize, open **API / Embed** and create a separate **JSON** endpoint for this server. Its **Includes sessions** setting decides what the endpoint exposes. Within that, filter by `status`:
   - `accepted`: the session is accepted.
   - `informed`: accepted, and the speaker has been told.
   - `confirmed`: accepted, and the speaker confirmed attendance.
2. **Preview first.** Ask for a dry run: the assistant lists what it would create or change in Sched, and writes nothing.
3. **Apply.** After you confirm, it creates or updates the Sched sessions and speakers.
4. **Re-run any time.** Each Sched session uses a stable key derived from the Sessionize session ID (for example `sz12345`), so later runs update the existing sessions instead of creating duplicates.

Sched needs a start time, an end time and a session type (track) to create a session. Sessionize only provides times after you announce the schedule there, so there are two ways to sync:

- **Schedule already announced in Sessionize:** create Sched sessions with the times and rooms from Sessionize.
- **Not announced yet:** build the agenda in Sched first, with placeholder slots per track (for example "Endpoint Management: TBD"). The assistant then fills those slots with `sched_update_session`, putting each session into a free slot of its track.

### Field mapping

| Sessionize | Sched |
| --- | --- |
| Session ID | `session_key`, for example `sz` + ID (max 32 alphanumeric characters) |
| Title | `name` (max 120 characters) |
| Description | `description` |
| Category such as Track | `session_type` (Sched's color-coded filter, max 32 characters) |
| Room | `venue` |
| `startsAt` / `endsAt` (only after the schedule is announced in Sessionize) | `session_start` / `session_end` as `YYYY-MM-DD HH:MM` in the event's local time |
| Speaker name, tagline, bio | `full_name`, `position`, `about` |
| Speaker `profilePicture` URL | `avatar` (Sched copies the image to its own CDN) |
| Speaker to session link | `sched_add_role` with role `speaker` |

### Example prompt

With the schedule announced in Sessionize:

> Using the sessionize and sched MCP servers: list all **confirmed** sessions from Sessionize. For each one, plan a Sched session with key `sz<sessionize id>`, the same title and description, the Track category as session type, and the room, start and end time from Sessionize. Plan a speaker profile for every speaker with their bio, tagline and photo, linked to their sessions. Show me the plan as a table first and do not write anything to Sched until I confirm.

With placeholder slots in Sched:

> Using the sessionize and sched MCP servers: list all **confirmed** sessions from Sessionize and all "TBD" slots in Sched. Assign each session to a free slot of the same track and plan to update that slot with the session's title and description. Plan a speaker profile for every speaker with their bio, tagline and photo, linked to their session. Show me the plan as a table first and do not write anything to Sched until I confirm.

### Things to know before you sync

- **No speaker emails.** Sessionize's API does not include speaker email addresses, so speakers are created without email and do not receive a Sched invitation. Add emails in Sched afterwards if speakers should manage their own profiles.
- **Speakers become public.** A speaker linked to a session appears in Sched's public speaker directory, even when the profile is set to private and the session is hidden. Sync speakers only when you are ready to announce them.
- **No permanent deletes through the API.** The Sched API cannot permanently delete sessions or people. A withdrawn session is deactivated, and permanent deletion happens in the Sched admin.
- **Rate limits.** Sched temporarily revokes API keys that make more than 30 calls per minute. The server queues calls at 25 per minute by default, so syncing about 50 sessions and 50 speakers takes a few minutes.
- **Sessionize caching.** Sessionize caches API responses for up to 5 minutes. Recent changes in Sessionize may take that long to show up.

## Other use cases

- **Build the agenda skeleton in Sched.** Tracks, rooms, keynotes, breaks and placeholder slots, created in one go.
- **Ask questions about your event.** "How many sessions per track?", "Who are our speakers?", "Which sessions are still TBD?". A read-only Sched key is enough.
- **Export speaker material.** Download every confirmed speaker's photo, bio and session titles from Sessionize as CSV or Markdown, for social posts, the website or badges.
- **Track speaker confirmations.** Compare accepted, informed and confirmed sessions to see who still needs a reminder.

## Installation

Both servers are published on npm as [`@ugurlabs/sched-mcp-server`](https://www.npmjs.com/package/@ugurlabs/sched-mcp-server) and [`@ugurlabs/sessionize-mcp-server`](https://www.npmjs.com/package/@ugurlabs/sessionize-mcp-server). Nothing to clone or build: your MCP client starts them with `npx`.

Requirement: [Node.js](https://nodejs.org) 22 or later, which includes `npx`.

### 1. Add the servers to your AI client

Claude Code:

```bash
claude mcp add sched --scope user -- npx -y @ugurlabs/sched-mcp-server
claude mcp add sessionize --scope user -- npx -y @ugurlabs/sessionize-mcp-server
```

- `--scope user` makes them available in all your projects. Leave it out to add them to the current project only.
- On Windows (not WSL), wrap `npx` in `cmd /c`, for example `-- cmd /c npx -y @ugurlabs/sched-mcp-server`.

Claude Desktop and other MCP clients: add this to the client's MCP configuration (for Claude Desktop, `claude_desktop_config.json` via Settings > Developer > Edit Config) and restart the client.

```json
{
  "mcpServers": {
    "sched": { "command": "npx", "args": ["-y", "@ugurlabs/sched-mcp-server"] },
    "sessionize": { "command": "npx", "args": ["-y", "@ugurlabs/sessionize-mcp-server"] }
  }
}
```

### 2. Run the setup once, in a terminal

```bash
npx -y @ugurlabs/sched-mcp-server setup
npx -y @ugurlabs/sessionize-mcp-server setup
```

Each setup explains where to find what it needs, checks it against Sched or Sessionize right away, and saves it on your computer:

- **Sched** asks for your event (the name before `.sched.com`, or the full URL) and an API key (Sched admin, Settings > API; needs a paid Sched plan). The key is hidden while you type. Setup detects whether the key can change your event and asks whether to enable the tools that create, update and delete.
- **Sessionize** walks you through creating a JSON endpoint on the **API / Embed** page of your event and asks for its endpoint ID (or the whole URL from **Get Code**).

Settings are saved in `~/.config/ugurlabs-mcp/` (or `$XDG_CONFIG_HOME/ugurlabs-mcp/` if you set that variable; Windows: `%APPDATA%\ugurlabs-mcp\`), in files only your user account can read.

You can add the servers before running setup. Until then they only offer a "setup status" tool, so if you ask your assistant for something it tells you which command to run. The setup happens in the terminal on purpose: API keys never go through the chat. Once setup is saved, the tools appear on their own; if they do not, reconnect the server (in Claude Code: `/mcp`) or restart the client.

Other commands: `status` shows where the settings come from without revealing the key, and `reset` deletes them. Run `setup` again to change the event or key. A running server picks up changes, including `reset`, within a few seconds.

### Advanced: environment variables

Environment variables override the saved settings, which is useful for CI, scripts or several events side by side:

```bash
claude mcp add sched-other -e SCHED_EVENT=otherconf -e SCHED_API_KEY=<key> -e SCHED_ACCESS=read -- npx -y @ugurlabs/sched-mcp-server
```

| Server | Variables |
| --- | --- |
| Sched | `SCHED_EVENT`, `SCHED_API_KEY`, `SCHED_ACCESS` (`read` or `readwrite`), `SCHED_CONFIG_FILE` (use a different settings file) |
| Sessionize | `SESSIONIZE_ENDPOINT_ID`, `SESSIONIZE_CONFIG_FILE` |

### Pinning a version

`npx -y @ugurlabs/sched-mcp-server` always runs the latest release. To stay on a known version, add it to the package name, for example `@ugurlabs/sched-mcp-server@0.1.0`.

### Running from source

For development, or if you prefer not to use npm:

```bash
git clone https://github.com/ugurkocde/sched-sessionize-mcp.git
cd sched-sessionize-mcp/sched-mcp-server && npm ci && npm run build
cd ../sessionize-mcp-server && npm ci && npm run build
```

Then point your client at `node /absolute/path/to/<server>/dist/index.js` instead of `npx`.

Each server's README has the full list of tools, settings and API details.

## Security model

- **Local only.** Both servers run on your machine over stdio. They talk only to `sched.com` and `sessionize.com` (plus Sessionize's image CDN for photo downloads) and send no telemetry.
- **Sched access is explicit.** With `SCHED_ACCESS=read` (the default), write tools are not registered at all, so the assistant cannot see or call them. Use a read-only Sched key where you can.
- **The Sessionize endpoint ID is a credential.** Anyone with the ID can read what the endpoint exposes. Keep it private, and do not enable private submission fields (for example dietary or hotel questions) on the endpoint you use with this server.
- **Keys never go through the chat.** Setup runs in your terminal with hidden input and saves the settings in owner-only files. The servers tell the assistant never to ask for keys in the chat, and they keep secrets out of logs and tool output. Never commit API keys or endpoint IDs.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)

This project is not affiliated with Sched LLC or Sessionize.
