import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_MENU_AVAILABILITY_CHANNEL,
  type PluginActionContribution,
  type PluginHostApi,
} from "@daintreehq/plugin-sdk";
import manifest from "../plugin.json" with { type: "json" };
import { continueAvailability } from "./availability.js";
import { Catalog } from "./catalog.js";
import type { PluginContext } from "./context.js";
import { continueFromPane, launchById } from "./continueFlow.js";
import { SEARCH_TOOL_NAME } from "./handoff.js";
import { IndexStore } from "./indexStore.js";
import { manageConversions } from "./manageFlow.js";
import { createSearchTool } from "./search.js";

/**
 * Continue Session (#16097): carries a Codex session over to Claude Code, or
 * a Claude Code session over to Codex. Core's `terminal.sessionFile.get` says
 * which file the pane's or assistant's agent is writing; this plugin reads it
 * once into a local full-text index, starts the other CLI where the session
 * ran (the same worktree, or a new session of the project's assistant) with a
 * mechanical hand-off, and serves one MCP tool that searches the index. The
 * global assistant is handed no plugin tools, so its successor gets the
 * hand-off alone and Daintree asks the person before replacing its run.
 *
 * Nothing is read until the user asks for a conversion, and the source file
 * is only ever opened read-only.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  return activateWith(host, {
    dataDir: join(homedir(), ".daintree", "plugin-data", host.pluginId),
    newId: randomUUID,
  });
}

export async function activateWith(
  host: PluginHostApi,
  options: { dataDir: string; newId: () => string }
): Promise<() => void> {
  const ctx: PluginContext = {
    host,
    catalog: new Catalog(host.storage),
    store: new IndexStore(join(options.dataDir, "sessions")),
    newId: options.newId,
    running: new Set(),
    pendingAssistantGrants: new Map(),
  };

  await host.registerAction(declaredCommand("continue"), (args) => continueFromPane(ctx, args));
  await host.registerAction(declaredCommand("launch"), (args) => launchById(ctx, args));
  await host.registerAction(declaredCommand("manage"), (args) => manageConversions(ctx, args));
  // Greys out "Continue in another agent…" with the reason when the session
  // file can't be located, instead of failing once it is picked.
  await host.registerHandler(CONTEXT_MENU_AVAILABILITY_CHANNEL, (_ipc, payload) =>
    continueAvailability(host, payload)
  );

  const disposeTools = await host.mcp.registerTools("sessions", {
    [SEARCH_TOOL_NAME]: createSearchTool({
      catalog: ctx.catalog,
      store: ctx.store,
      log: (message) => host.logger.warn(message),
      assistantStarting: () => new Set(ctx.pendingAssistantGrants.keys()),
    }),
  });

  // Leftovers of a build the plugin was stopped in the middle of. Not awaited:
  // activation stays within its budget, and nothing reads a partial file.
  void ctx.store.sweepPartials().catch(() => undefined);

  return () => {
    for (const controller of ctx.running) controller.abort();
    ctx.running.clear();
    ctx.pendingAssistantGrants.clear();
    disposeTools();
  };
}

/**
 * The descriptor plugin.json declares for a command. The host holds the
 * declared one until the plugin activates, and registering replaces it whole,
 * so a hand-kept copy that drifted (lost a `when`, say) would change the
 * command the moment the plugin runs.
 */
function declaredCommand(id: string): PluginActionContribution {
  const command = manifest.contributes.commands.find((entry) => entry.id === id);
  if (!command) throw new Error(`plugin.json declares no "${id}" command`);
  return command as PluginActionContribution;
}
