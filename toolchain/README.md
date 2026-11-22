# Toolchain

The plugin builds, type-checks and tests against these packages, installed from this folder through `file:` dependencies in `package.json`:

| Package | Tarball | SHA-256 |
| --- | --- | --- |
| `@daintreehq/plugin-sdk@0.2.0` | `daintreehq-plugin-sdk-0.2.0.tgz` | `9af6f48d74e495390dac9770a05048cfa90599104f4d8eda2e59483c74021b05` |
| `@daintreehq/plugin-vite@0.2.0` | `daintreehq-plugin-vite-0.2.0.tgz` | `c1e643251f2ff9f163b27b7cc573295c5f0e91ba49db8c7f5fa3cbeb3198a1a6` |
| `daintree-plugin@0.2.0` | `daintree-plugin-0.2.0.tgz` | `348d45f1e86ffd7c5c4f507fadc3a0e980ff53c95a59907fa8db17ffe0e593e1` |

npm serves only 0.1.0 of these packages, and 0.1.0 can't build this plugin: its `PluginHostApi` and mock host have no `host.tasks` or `host.notify`, and its manifest validator refuses `mcpName` and the `project` context-menu location. All of them shipped in Daintree 0.49.0. This plugin also needs what comes after Daintree 0.51.0: the `assistant` context-menu location, a menu item's `availability` and `CONTEXT_MENU_AVAILABILITY_CHANNEL`, and `consumer` on `PluginMcpCaller`. Their packages still say 0.2.0.

The tarballs are packed from [`daintreehq/daintree`](https://github.com/daintreehq/daintree) on `develop` at commit `4430b2add0a2d873fbd8e80e593cba89261a7528`, the same packages that repository's `release-packages.yml` publishes. `daintreehq-plugin-vite-0.2.0.tgz` packs byte for byte as it did at `v0.50.0`. Once Daintree 0.52.0 is tagged, repack from that tag:

```bash
git clone https://github.com/daintreehq/daintree.git && cd daintree && git checkout 4430b2add0a2d873fbd8e80e593cba89261a7528
npm ci --ignore-scripts
npm run build --workspace=packages/plugin-sdk --workspace=packages/plugin-vite --workspace=packages/daintree-plugin
npm pack --workspace=packages/plugin-sdk --workspace=packages/plugin-vite --workspace=packages/daintree-plugin --pack-destination <this folder>
```

Once npm serves 0.2.0, replace the three `file:` ranges with `^0.2.0`, run `npm install`, and delete this folder and its line in `.dntrignore`.
