# sched-mcp-server

`@ugurlabs/sched-mcp-server` on npm. Part of [sched-sessionize-mcp](../README.md).

MCP server for the [Sched API](https://sched.com/api). Point it at your event, give it a read-only or a read/write API key, and it exposes the matching tools.

## Access modes

| Access | Tools exposed |
| --- | --- |
| Read-only (default) | 12 read tools. Write tools are not registered, so a client cannot even see them. |
| Read/write | The 12 read tools plus 11 write tools (sessions, users, roles, tags). |

Setup chooses the access level: it detects a read-only key, and for a read/write key it asks whether to enable the write tools. With environment variables, `SCHED_ACCESS` sets it. Every server also has a `sched_setup_status` tool.

Sched itself also enforces the key's permissions. If you use a read-only key with `SCHED_ACCESS=readwrite`, write calls come back as `Authorization failed` tool errors.

## Installation

Requires Node.js 22 or later. Your MCP client runs the published package with `npx`; nothing to clone or build.

1. Add the server. Claude Code:

   ```bash
   claude mcp add sched --scope user -- npx -y @ugurlabs/sched-mcp-server
   ```

   Other MCP clients: `{ "command": "npx", "args": ["-y", "@ugurlabs/sched-mcp-server"] }`. On Windows (not WSL), use `cmd /c npx -y @ugurlabs/sched-mcp-server`.

2. Run the setup once, in a terminal:

   ```bash
   npx -y @ugurlabs/sched-mcp-server setup
   ```

   It asks for your event and API key (hidden while you type), checks them with Sched, detects whether the key can change your event, and asks whether to enable the write tools. Settings are saved to `~/.config/ugurlabs-mcp/sched.json` (or under `$XDG_CONFIG_HOME` if set; Windows: `%APPDATA%\ugurlabs-mcp\sched.json`), readable only by your user account.

Until setup is done the server offers only `sched_setup_status`, which tells the assistant (and you) which command to run. After setup the Sched tools appear without restarting; if your client does not refresh, reconnect the server (in Claude Code: `/mcp`).

Commands: `setup`, `status` (shows the source of the settings, never the key), `reset` (deletes the saved settings), `--help`. A running server picks up a new `setup` or a `reset` within a few seconds.

From source: `npm ci && npm run build`, then use `node /absolute/path/to/sched-mcp-server/dist/index.js` as the command.

## Configuration

Setup is the easiest way. Environment variables override the saved settings, which is useful for CI, scripts, or running one server per event:

| Variable | Description |
| --- | --- |
| `SCHED_EVENT` | Event subdomain (`myconf`), host (`myconf.sched.com`) or full https URL (custom domains work) |
| `SCHED_API_KEY` | API key from your event's Sched admin (Settings > API). Paid plans only. |
| `SCHED_ACCESS` | `read` (default) or `readwrite` |
| `SCHED_CONFIG_FILE` | Use a different settings file, for example one per event |
| `SCHED_RATE_LIMIT` | Max calls per rolling minute, default `25`, max `29`. Sched temporarily revokes keys that go over 30/min, so calls are queued, not dropped. |
| `SCHED_TIMEOUT_MS` | Per-request timeout, default `30000` |

Example with two entries, one read-only and one with write access:

```json
{
  "mcpServers": {
    "sched-read": {
      "command": "npx",
      "args": ["-y", "@ugurlabs/sched-mcp-server"],
      "env": { "SCHED_EVENT": "myconf", "SCHED_API_KEY": "<read-key>", "SCHED_ACCESS": "read" }
    },
    "sched-admin": {
      "command": "npx",
      "args": ["-y", "@ugurlabs/sched-mcp-server"],
      "env": { "SCHED_EVENT": "myconf", "SCHED_API_KEY": "<read-write-key>", "SCHED_ACCESS": "readwrite" }
    }
  }
}
```

## Tools

Read (`readOnlyHint: true`):

| Tool | Sched endpoint |
| --- | --- |
| `sched_setup_status` | none: reports whether the server is set up and how to set it up |
| `sched_get_event` | `site/sync` |
| `sched_list_sessions` | `session/list` |
| `sched_export_sessions` | `session/export` |
| `sched_count_sessions` | `session/count` |
| `sched_get_session_seats` | `session/seats` |
| `sched_list_users` | `user/list` |
| `sched_get_user` | `user/get` |
| `sched_list_user_activity` | `user/active` |
| `sched_list_user_sessions` | `user/sessions` |
| `sched_list_all_schedules` | `going/all` |
| `sched_export_role` | `role/export` |
| `sched_list_tags` | `tag/people/get` |

Write (only with `SCHED_ACCESS=readwrite`):

| Tool | Sched endpoint | Notes |
| --- | --- | --- |
| `sched_add_session` | `session/add` | Requires `session_type`. The first add on a new event clears Sched demo data |
| `sched_update_session` | `session/mod` | |
| `sched_delete_session` | `session/del` | Destructive. Deactivates the session; data is kept |
| `sched_add_user` | `user/add` | Response includes the generated password |
| `sched_update_user` | `user/mod` | |
| `sched_set_user_avatar` | `user/avatar` | |
| `sched_add_role` | `role/add` | |
| `sched_remove_role` | `role/del` | Destructive |
| `sched_add_tag` | `tag/people/add` | |
| `sched_update_tag` | `tag/people/mod` | |
| `sched_delete_tag` | `tag/people/del` | Destructive |

Not included: `auth/login` and the per-attendee `going/add|del|schedule|list` endpoints (they need an attendee's own password), and `assets/banner` (a base64 image).

## Behavior notes

- Requests are `POST` with a form body, so the key never shows up in URLs or proxy logs. The server only connects over https.
- Sched returns most errors as HTTP 200 with an `ERR: ...` body. These come back as MCP tool errors (`isError: true`). An unknown event name gets a redirect from Sched, which is reported as a `SCHED_EVENT` problem.
- Tags are people tags (applied to users). The Sched docs list `/api/tag/get` etc., but the live API only serves them under `/api/tag/people/*`; the plain paths redirect to the event homepage.
- Sched API quirks seen on a live event (Nov 2026):
  - `session/add` stores its own `format` request parameter (default `csv`) as a custom session field named `format` on every session it creates. It is not shown on public session pages. Renaming the field in the admin only renames it on active sessions.
  - Custom fields can be set on `session/add` but writes through `session/mod` return `Ok` and are ignored.
  - `session/list` returns active sessions only; hidden (`active=false`) and deleted sessions are the same state and appear under `include_deleted`.
  - Event settings (timezone, location, description, banner, ticketing) are not in the API; use the Sched admin.
  - A user linked to a session with the `speaker` role appears in the public speaker directory, even with `privacy=true` and a hidden session.
  - Removing a user's only role (`role/del`) removes the user from the event.
  - The API cannot permanently delete sessions or users. `session/del` deactivates a session; permanent deletion is done in the Sched admin.
  - Sched's public pages are cached for several minutes, so admin and API changes can take a while to show for logged-out visitors.
- Datetimes are `YYYY-MM-DD HH:MM` in the event's local time.
- `custom_fields` on session add/update are sent as top-level params using the custom field's API name. They cannot use the name of any built-in param or `api_key`.

## Development

```bash
npm test         # unit + in-memory MCP client tests (no network)
npm run typecheck
```
