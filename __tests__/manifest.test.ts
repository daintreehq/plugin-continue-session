import { readFileSync, rmSync } from "node:fs";
import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { MANIFEST_NAME } from "../main/context.js";
import { activateWith } from "../main/index.js";
import { tempDir } from "./fixtures.js";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
  name: string;
  contributes: {
    commands: { id: string; when?: string }[];
    contextMenus: { actionId: string }[];
  };
};

async function registeredDescriptors() {
  const dataDir = tempDir("manifest");
  try {
    const host = createMockHost({ pluginId: manifest.name });
    await activateWith(host, { dataDir, newId: () => "id" });
    return host.registeredActions.map((entry) => entry.descriptor);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("plugin.json", () => {
  it("is the plugin the actions and notifications are addressed from", () => {
    expect(manifest.name).toBe(MANIFEST_NAME);
  });

  // The plugin is lazy: until something activates it, only the manifest's
  // commands exist, so a menu item or a notification's button naming an
  // action that activate() alone registers would find nothing after a
  // restart. Registering replaces the declared descriptor whole, so the two
  // must also agree field for field, `when` included.
  it("declares every action activate() registers, as activate() registers it", async () => {
    const registered = await registeredDescriptors();

    expect(registered.map((descriptor) => descriptor.id).sort()).toEqual(
      manifest.contributes.commands.map((command) => command.id).sort()
    );
    for (const descriptor of registered) {
      expect(descriptor).toEqual(
        manifest.contributes.commands.find((command) => command.id === descriptor.id)
      );
    }
  });

  it("points every context menu item at a declared command", () => {
    const declared = new Set(
      manifest.contributes.commands.map((command) => `${manifest.name}.${command.id}`)
    );
    expect(manifest.contributes.contextMenus.length).toBeGreaterThan(0);
    for (const item of manifest.contributes.contextMenus) {
      expect(declared).toContain(item.actionId);
    }
  });
});
