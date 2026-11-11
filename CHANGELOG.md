# Changelog

## 0.1.1

- A conversion that skips records says so. Records that are malformed or over 8 MB can't be indexed, and nothing used to say they were missing from search: the finished conversion now leaves an inbox entry with the count, and **Converted sessions…** shows it beside the session.

## 0.1.0

The first release from this repository. The plugin was developed in [`daintreehq/daintree`](https://github.com/daintreehq/daintree) as `plugins/sample/continue-session` and moves here unchanged, except:

- `plugin.json` declares the plugin's three commands. Daintree activates a plugin on first use, and until then only declared commands exist, so after a restart **Continue in another agent…**, **Converted sessions…** and the Retry and Continue again buttons on its notifications found no action to run.
- The worker entry is built to `dist/index.mjs` by Vite.
