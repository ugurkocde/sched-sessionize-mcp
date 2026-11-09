# Contributing

Thanks for helping improve the Sched and Sessionize MCP servers. This guide covers how to set up the project, the conventions the code follows, and how releases work.

## Ways to contribute

- **Report a bug:** open a GitHub issue with steps to reproduce, the server and version, and the error message. Remove API keys, endpoint IDs and personal data first.
- **Suggest a feature or tool:** open an issue describing the use case before you start a larger change.
- **Report a security problem:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Project layout

```
sched-mcp-server/        Sched API server (read or read/write)
sessionize-mcp-server/   Sessionize API server (read-only)
.github/workflows/       CI and npm release
```

Each server is an independent npm package with its own `package.json`, tests and README.

## Development setup

Requirements: Node.js 22.12 or later.

```bash
cd sched-mcp-server       # or sessionize-mcp-server
npm ci
npm run typecheck
npm test
npm run build
```

To try your local build in Claude Code, register it with `node`:

```bash
claude mcp add sched-dev -e SCHED_EVENT=myconf -e SCHED_API_KEY=<key> -- node /absolute/path/to/sched-mcp-server/dist/index.js
```

## Coding guidelines

- **TypeScript, strict mode.** Keep `npm run typecheck` clean.
- **One tool, one job.** Name tools with the server prefix (`sched_`, `sessionize_`) and a clear verb (`list_`, `get_`, `add_`, `update_`, `delete_`, `export_`).
- **Validate every input with zod,** including formats and lengths, and describe each parameter so an AI client knows what to send.
- **Set accurate tool annotations:** `readOnlyHint` for tools that only read, and `destructiveHint` for tools that delete or remove.
- **Read-only by default.** Sched write tools are only registered when `SCHED_ACCESS=readwrite`. New write tools must follow the same rule. The Sessionize server stays read-only.
- **Credentials are only collected by the terminal `setup` command** (hidden input, owner-only settings file) or environment variables. No tool may ask for, accept or return an API key or endpoint ID, and setup-status texts must keep telling the assistant not to ask for them in the chat.
- **Never log or return secrets.** API keys and endpoint IDs must not appear in logs, errors or tool output. Log to stderr only, because stdout is the MCP channel.
- **Turn API errors into tool errors** (`isError: true`) with a message that tells the user what to fix. Do not let them crash the server.
- **Respect the APIs.** Sched revokes keys that make more than 30 calls per minute, so keep the client-side rate limiter in place. Do not add retries that could multiply calls.
- **Document what you find.** If you discover behaviour that differs from the official API docs, note it in the server's README.

## Tests

- Unit and MCP tests use fake `fetch` responses and an in-memory MCP client, so `npm test` needs no network and no credentials. CI runs the same tests.
- Add a test for every bug fix and new tool.
- If you test against the live APIs, only use events you own, a Sched test event, or Sessionize's public demo endpoint (`jl4ktls0`). Clean up any test data you create.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Make sure `npm run typecheck`, `npm test` and `npm run build` pass for every server you changed.
4. Update the README when you add or change tools, settings or behaviour.
5. Describe what you changed and how you tested it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Releases (maintainers)

Packages are published to npm by the [release workflow](.github/workflows/release.yml) when a version tag is pushed. Each server is released on its own.

**One-time setup**

1. Create the npm organization `ugurlabs` on [npmjs.com](https://www.npmjs.com).
2. Create an npm access token that can publish to it, and add it to the GitHub repository as the secret `NPM_TOKEN` (Settings > Secrets and variables > Actions).

**Each release**

1. Bump the version in the server's folder, for example:
   ```bash
   cd sched-mcp-server
   npm version patch --no-git-tag-version
   ```
2. Commit the change and merge it to `main`.
3. Tag the commit as `<folder>-v<version>` and push the tag:
   ```bash
   git tag sched-mcp-server-v0.1.1
   git push origin sched-mcp-server-v0.1.1
   ```
4. The workflow checks that the tag matches the version in `package.json`, runs the tests, and publishes the package to npm with provenance.
