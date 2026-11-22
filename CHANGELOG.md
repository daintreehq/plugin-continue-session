# Changelog

## 0.2.0

Needs Daintree 0.52.0 or later.

- **Continue an assistant session.** **Continue in another agent…** is also on the project assistant's session menu and the global assistant's **More actions** menu. A project assistant session continues as a new assistant session in the same project, and the project's Daintree Assistant can search the converted session. The global assistant is handed no plugin tools, so its session isn't indexed: Daintree asks before replacing its run with the other CLI, starting from the hand-off, and the new run reads the old session file when it needs something.
- **The item says why it can't run.** When a session's file isn't known yet, or it runs an agent other than Codex or Claude Code, the menu item stays visible and greyed out with the reason, instead of failing once picked.
- Hand-offs leave out control characters a launch command can't carry, keeping line breaks and tabs.

## 0.1.1

- A conversion that skips records says so. Records that are malformed or over 8 MB can't be indexed, and nothing used to say they were missing from search: the finished conversion now leaves an inbox entry with the count, and **Converted sessions…** shows it beside the session.

## 0.1.0

The first release from this repository. The plugin was developed in [`daintreehq/daintree`](https://github.com/daintreehq/daintree) as `plugins/sample/continue-session` and moves here unchanged, except:

- `plugin.json` declares the plugin's three commands. Daintree activates a plugin on first use, and until then only declared commands exist, so after a restart **Continue in another agent…**, **Converted sessions…** and the Retry and Continue again buttons on its notifications found no action to run.
- The worker entry is built to `dist/index.mjs` by Vite.
