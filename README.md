# Continue Session

A [Daintree](https://github.com/daintreehq/daintree) plugin that carries a Codex session over to Claude Code, or a Claude Code session over to Codex: a worker pane's in the same worktree, a project assistant session's as a new assistant session in the same project, and the global assistant's in its place. A session file can run to hundreds of megabytes, far past any CLI's context window, so the new agent doesn't replay it: it starts with a short hand-off and searches the old conversation when it needs something.

It is an installed plugin, not part of Daintree itself, and the end-to-end test for Daintree's [community plugin catalog](https://github.com/daintreehq/daintree/blob/develop/docs/plugins/catalog.md): each release is a versioned `.dntr` on GitHub Releases with its SHA-256 beside it. Its name sits outside the reserved `daintree.*` namespace, which only built-in plugins may use.

## Installing

Needs Daintree 0.52.0 or later (0.1.1, for worker panes only, needs 0.49.0). Take a versioned asset URL from [Releases](https://github.com/daintreehq/plugin-continue-session/releases), for example:

```
https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.1/daintreehq.continue-session-0.1.1.dntr
```

- In Daintree: **Settings → Plugins → Plugin manager → Install plugin → Install from URL**, and paste it.
- From a terminal, with Daintree running: `npx daintree-plugin install <url>`. A Daintree and CLI that support it also take `--sha256 <hex>`, which installs only those bytes.

The release's `SHA256SUMS` asset holds the archive's digest. Installing a newer release's URL replaces the installed version.

Current Daintree builds can't follow the redirect GitHub answers a release URL with ([daintreehq/daintree#16855](https://github.com/daintreehq/daintree/issues/16855)), so a URL install fails with **Couldn't download the plugin from that URL.** Until that's fixed, download the `.dntr`, check it against `SHA256SUMS` (`shasum -a 256 -c SHA256SUMS`), and install the file: **Install plugin → Install from file**, or `npx daintree-plugin install ./daintreehq.continue-session-0.1.1.dntr`.

The plugin declares `fs:user-data-read` (it reads the session file Daintree observed) and `mcp:expose` (it serves the search tool to agents). Like every Daintree plugin it runs unsandboxed, with full Node.js privileges, whatever it declares.

## Using it

**Continue in another agent…** is on a worker pane's right-click menu, on the project assistant's session menu, and on the global assistant's **More actions** menu. When the session can't be continued (its file isn't known yet, or it runs an agent other than Codex or Claude Code), the item stays visible, greyed out, with the reason beside it.

### A worker pane

1. Right-click a Codex or Claude Code pane and choose **Continue in another agent…**. The confirmation says what happens and what doesn't.
2. Daintree reads the session once, read-only, into a full-text index on this machine (`~/.daintree/plugin-data/daintreehq.continue-session/sessions/`). Progress and Cancel are in the background-work readout.
3. The other CLI starts in the same worktree and directory. Its first turn is the hand-off: the user's last five requests and the source agent's last message, quoted, plus how to search.
4. The new agent calls `search_converted` on the `daintree-continue-session` MCP server for anything else.

The search tool reaches an agent only where the plugin's agent tools are on (**Project settings → Plugins → Agent tools**, or once for every project), and the Daintree MCP server is enabled. With them off the agent still gets the hand-off and is told the tool is missing.

### A project assistant session

The same steps, from the session menu in the Assistant panel, except that the other CLI starts as a new assistant session in the same project, leaving the old one open. Any of the project's assistant sessions can then search the converted session. The Daintree Assistant is handed the search tool only when **Daintree Assistant can use this plugin's tools** and **Allow tools that change things** are on for this plugin in **Project settings → Agent tools**; without them the hand-off tells it to read the session file instead.

### The global assistant

The global assistant is handed no plugin tools, so nothing is indexed. The plugin reads the session for the hand-off and asks Daintree to replace the global assistant's run with the other CLI, starting from it. Daintree's own confirmation shows the hand-off and which agent stops, and nothing changes unless you approve. The new run reads the old session file directly when it needs something from it. With two global assistant sessions open, only the one that coordinates can be continued this way.

### Converted sessions

**Converted sessions…** on the project pill's right-click menu lists the project's converted sessions with their size on disk, starts a continuing agent again, deletes one or all of them, and turns sharing on or off.

## Scope

- **Session-only (default):** only the agent launched to continue a session can search it: the pane started for it, or, for a session continued in a project assistant session, that project's Daintree Assistant. The plugin checks the host's record of each call's terminal, project and consumer, never anything the agent sends.
- **Shared:** a project that shares its converted sessions lets every agent in it search them. Its agents can also search the sessions of every other project that shares; a project that doesn't share is never searched from outside.

## What it never does

- Write, move or rename a session file. It opens the exact path Daintree observed (`terminal.sessionFile.get`), refuses a symlink or anything but a regular file, and reads up to the file's size at open.
- Guess a session file. When Daintree answers `unknown`, nothing is read.
- Send anything off the machine. Indexing and search are local SQLite FTS5 (`node:sqlite`); what the continuing agent does with the hand-off and its search results is that agent's own traffic, which the confirmation says.
- Declare a `contributes.databases` entry: the host's generic database tools would serve every index to every agent with access, past the per-terminal check.

## Limits

- Codex and Claude Code only, on macOS and Linux, for local panes and this machine's assistants. A Claude Code session the CLI switched to by itself (`/clear`, a fork) isn't seen; Daintree reports the session it launched.
- Tool inputs and outputs are indexed up to 16,000 characters each. Records that are malformed or over 8 MB are skipped; the finished conversion says how many, and so does **Converted sessions…**.
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
