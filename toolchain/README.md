# Toolchain

The plugin builds, type-checks and tests against these packages, installed from this folder through `file:` dependencies in `package.json`:

| Package | Tarball | SHA-256 |
| --- | --- | --- |
| `@daintreehq/plugin-sdk@0.2.0` | `daintreehq-plugin-sdk-0.2.0.tgz` | `d6234e38e7894cf4cda84e71f8fbf31e149cdf4f1aa00d5dbca6c6bfdf1bb383` |
| `@daintreehq/plugin-vite@0.2.0` | `daintreehq-plugin-vite-0.2.0.tgz` | `c1e643251f2ff9f163b27b7cc573295c5f0e91ba49db8c7f5fa3cbeb3198a1a6` |
| `daintree-plugin@0.2.0` | `daintree-plugin-0.2.0.tgz` | `df44840cb9e021ec2077671c439c8e260b9d633cf532b52d0c3c064f67948817` |

npm serves only 0.1.0 of these packages, and 0.1.0 can't build this plugin: its `PluginHostApi` and mock host have no `host.tasks` or `host.notify`, and its manifest validator refuses `mcpName` and the `project` context-menu location. All of them shipped in Daintree 0.49.0.

The tarballs are packed from [`daintreehq/daintree`](https://github.com/daintreehq/daintree) at tag `v0.50.0` (commit `dd8193ef63c31327907f39a837a12b70c4b5b1ea`, on `main`), the same packages that repository's `release-packages.yml` publishes:

```bash
git clone --branch v0.50.0 https://github.com/daintreehq/daintree.git && cd daintree
npm ci --ignore-scripts
npm run build --workspace=packages/plugin-sdk --workspace=packages/plugin-vite --workspace=packages/daintree-plugin
npm pack --workspace=packages/plugin-sdk --workspace=packages/plugin-vite --workspace=packages/daintree-plugin --pack-destination <this folder>
```

Once npm serves 0.2.0, replace the three `file:` ranges with `^0.2.0`, run `npm install`, and delete this folder and its line in `.dntrignore`.
