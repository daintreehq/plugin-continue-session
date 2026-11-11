# Continue Session

A [Daintree](https://github.com/daintreehq/daintree) plugin that carries a Codex session over to Claude Code, or a Claude Code session over to Codex, in the same worktree. A session file can run to hundreds of megabytes, far past any CLI's context window, so the new agent doesn't replay it: it starts with a short hand-off and searches the old conversation when it needs something.

It is an installed plugin, not part of Daintree itself, and the end-to-end test for Daintree's [community plugin catalog](https://github.com/daintreehq/daintree/blob/develop/docs/plugins/catalog.md): each release is a versioned `.dntr` on GitHub Releases with its SHA-256 beside it. Its name sits outside the reserved `daintree.*` namespace, which only built-in plugins may use.

## Installing

Needs Daintree 0.49.0 or later. Take a versioned asset URL from [Releases](https://github.com/daintreehq/plugin-continue-session/releases), for example:

```
https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.0/daintreehq.continue-session-0.1.0.dntr
```

- In Daintree: **Settings → Plugins → Plugin manager → Install plugin → Install from URL**, and paste it.
- From a terminal, with Daintree running: `npx daintree-plugin install <url>`. A Daintree and CLI that support it also take `--sha256 <hex>`, which installs only those bytes.

The release's `SHA256SUMS` asset holds the archive's digest. Installing a newer release's URL replaces the installed version.

The plugin declares `fs:user-data-read` (it reads the session file Daintree observed) and `mcp:expose` (it serves the search tool to agents). Like every Daintree plugin it runs unsandboxed, with full Node.js privileges, whatever it declares.

## Using it

1. Right-click a Codex or Claude Code pane and choose **Continue in another agent…**. The confirmation says what happens and what doesn't.
2. Daintree reads the session once, read-only, into a full-text index on this machine (`~/.daintree/plugin-data/daintreehq.continue-session/sessions/`). Progress and Cancel are in the background-work readout.
3. The other CLI starts in the same worktree and directory. Its first turn is the hand-off: the user's last five requests and the source agent's last message, quoted, plus how to search.
4. The new agent calls `search_converted` on the `daintree-continue-session` MCP server for anything else.

The search tool reaches an agent only where the plugin's agent tools are on (**Project settings → Plugins → Agent tools**, or once for every project), and the Daintree MCP server is enabled. With them off the agent still gets the hand-off and is told the tool is missing.

**Converted sessions…** on the project pill's right-click menu lists the project's converted sessions with their size on disk, starts a continuing agent again, deletes one or all of them, and turns sharing on or off.

## Scope

- **Session-only (default):** only the agent launched to continue a session can search it. The plugin checks the host's record of each call's terminal and project, never anything the agent sends.
- **Shared:** a project that shares its converted sessions lets every agent in it search them. Its agents can also search the sessions of every other project that shares; a project that doesn't share is never searched from outside.

## What it never does

- Write, move or rename a session file. It opens the exact path Daintree observed (`terminal.sessionFile.get`), refuses a symlink or anything but a regular file, and reads up to the file's size at open.
- Guess a session file. When Daintree answers `unknown`, nothing is read.
- Send anything off the machine. Indexing and search are local SQLite FTS5 (`node:sqlite`); what the continuing agent does with the hand-off and its search results is that agent's own traffic, which the confirmation says.
- Declare a `contributes.databases` entry: the host's generic database tools would serve every index to every agent with access, past the per-terminal check.

## Limits

- Codex and Claude Code only, on macOS and Linux, for local panes. A Claude Code session the CLI switched to by itself (`/clear`, a fork) isn't seen; Daintree reports the session it launched.
- Tool inputs and outputs are indexed up to 16,000 characters each, and records over 8 MB are skipped and counted.
- An index is deleted when its project is no longer registered, checked the next time the plugin converts a session or lists them: the plugin isn't told when a project is removed.

## Developing

Node 22.13 or later (`.nvmrc` pins the version CI uses).

```bash
npm ci
npm run check      # typecheck, tests, manifest validation
npm run package    # builds dist/ and writes daintreehq.continue-session-{version}.dntr
```

`main/` is the plugin's worker entry, built by Vite into `dist/index.mjs`, the manifest's `main`. `__tests__/` runs against the SDK's in-memory mock host.

The build toolchain (`@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite` and the `daintree-plugin` CLI, all 0.2.0) comes from `toolchain/`, not npm: npm still serves 0.1.0, which predates host APIs this plugin uses. See [`toolchain/README.md`](toolchain/README.md).

## Releasing

1. Bump `version` in both `plugin.json` and `package.json`, run `npm install` to update the lockfile, and add a `CHANGELOG.md` entry.
2. Commit, then tag and push: `git tag v{version} && git push origin main v{version}`.

The `Release` workflow refuses a tag that doesn't match both versions, runs the checks, packages the plugin with `daintree-plugin package`, and publishes a GitHub Release with the `.dntr` and its `SHA256SUMS`. It never replaces an existing release's assets: a published URL keeps serving the bytes whose digest was published.

## License

Apache-2.0. Originally developed in [`daintreehq/daintree`](https://github.com/daintreehq/daintree) as `plugins/sample/continue-session`.
