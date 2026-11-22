import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionDispatchResult, PluginMcpCaller } from "@daintreehq/plugin-sdk";
import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import { activateWith } from "../main/index.js";
import { codexRollout, CODEX_SESSION_ID, tempDir, writeJsonl } from "./fixtures.js";

type MockHost = ReturnType<typeof createMockHost>;

const PLUGIN_ID = "daintreehq.continue-session";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  host: MockHost;
  dataDir: string;
  sourcePath: string;
  launches: Record<string, unknown>[];
  front: { projectId: string | null; switchTo?: string; afterReads?: number; reads: number };
  sessionFile: Record<string, unknown>;
  launchResult: (args: Record<string, unknown>) => ActionDispatchResult;
  projects: string[];
  assistantStarts: Record<string, unknown>[];
  /** Terminal ids `terminal.sessionFile.get` was asked about, in order. */
  lookups: string[];
  /** Answers per terminal id, over `sessionFile`. */
  sessionFiles: Record<string, ActionDispatchResult>;
  assistantResult: () => ActionDispatchResult;
  replacements: Record<string, unknown>[];
  replaceResult: () => ActionDispatchResult;
  /** Replaces `assistantResult` when set, for a start that waits or looks around first. */
  onAssistantStart?: () => Promise<ActionDispatchResult>;
  /** What the pane's own record says its project is; unset, the record names none. */
  terminalProjectId?: string;
}

function ok(result: unknown): ActionDispatchResult {
  return { ok: true, result } as ActionDispatchResult;
}

async function setUp(): Promise<Scenario> {
  const dir = tempDir("flow");
  dirs.push(dir);
  const sourcePath = join(dir, `rollout-2026-10-26T13-14-14-${CODEX_SESSION_ID}.jsonl`);
  writeJsonl(sourcePath, codexRollout());
  const scenario = {
    dataDir: join(dir, "data"),
    sourcePath,
    launches: [] as Record<string, unknown>[],
    front: { projectId: "p1" as string | null, reads: 0 } as Scenario["front"],
    sessionFile: {
      status: "observed",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: sourcePath,
      observedBy: "open-for-writing",
    } as Record<string, unknown>,
    launchResult: (args: Record<string, unknown>) =>
      ok({ launched: true, terminalId: args.requestedId, spawnStatus: null }),
    projects: ["p1", "p2"],
    assistantStarts: [] as Record<string, unknown>[],
    lookups: [] as string[],
    sessionFiles: {} as Record<string, ActionDispatchResult>,
    assistantResult: () => ok({ outcome: "started" }),
    replacements: [] as Record<string, unknown>[],
    replaceResult: () => ok({ outcome: "awaiting-confirmation" }),
  } as Omit<Scenario, "host">;
  const host = createMockHost({
    pluginId: PLUGIN_ID,
    dispatch: async (actionId, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      switch (actionId) {
        case "project.getCurrent": {
          const front = scenario.front;
          front.reads += 1;
          if (front.switchTo && front.afterReads !== undefined && front.reads > front.afterReads) {
            front.projectId = front.switchTo;
            front.switchTo = undefined;
          }
          return ok({ project: front.projectId ? { id: front.projectId } : null });
        }
        case "project.getAll":
          return ok({ projects: scenario.projects.map((id) => ({ id })) });
        case "terminal.info.get":
          return ok({
            id: input.terminalId,
            cwd: "/repo/wt",
            worktreeId: "wt-1",
            ...(scenario.terminalProjectId ? { projectId: scenario.terminalProjectId } : {}),
          });
        case "terminal.sessionFile.get":
          scenario.lookups.push(String(input.terminalId));
          return scenario.sessionFiles[String(input.terminalId)] ?? ok(scenario.sessionFile);
        case "agent.launch":
          scenario.launches.push(input);
          return scenario.launchResult(input);
        case "help.newSessionWithAgent":
          scenario.assistantStarts.push(input);
          return scenario.onAssistantStart
            ? scenario.onAssistantStart()
            : scenario.assistantResult();
        case "help.replaceGlobalAssistant":
          scenario.replacements.push(input);
          return scenario.replaceResult();
        default:
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: actionId },
          } as ActionDispatchResult;
      }
    },
  });
  let counter = 0;
  await activateWith(host, { dataDir: scenario.dataDir, newId: () => `id-${(counter += 1)}` });
  // The same object the dispatch stub reads, so a test can change what it answers.
  return Object.assign(scenario, { host }) as Scenario;
}

/** The context menu's dispatch, through the plugin's own registered action. */
async function clickContinue(host: MockHost, panelId = "pane-codex"): Promise<unknown> {
  const action = host.registeredActions.find((entry) => entry.descriptor.id === "continue");
  return action!.handler({ panelId, panelKind: "terminal", worktreeId: "wt-1" });
}

function searchTool(host: MockHost) {
  const roster = host.registeredMcpTools.find((entry) => entry.endpointId === "sessions");
  return roster!.tools.search_converted!;
}

function caller(projectId: string, terminalId: string, consumer?: "assistant"): PluginMcpCaller {
  return { credentialId: "cred", projectId, terminalId, ...(consumer ? { consumer } : {}) };
}

/** A project assistant session's menu, as the Assistant panel dispatches it. */
async function clickOnProjectAssistant(
  host: MockHost,
  overrides: Record<string, unknown> = {}
): Promise<unknown> {
  const action = host.registeredActions.find((entry) => entry.descriptor.id === "continue");
  return action!.handler({
    assistantScope: "project",
    projectId: "p1",
    slot: 2,
    terminalId: "assistant-term",
    agentId: "codex",
    ...overrides,
  });
}

/** The global assistant's More actions menu. */
async function clickOnGlobalAssistant(host: MockHost): Promise<unknown> {
  const action = host.registeredActions.find((entry) => entry.descriptor.id === "continue");
  return action!.handler({
    assistantScope: "global",
    terminalId: "global-term",
    incarnation: 3,
    agentId: "codex",
  });
}

async function availability(host: MockHost, request: Record<string, unknown>): Promise<unknown> {
  const entry = host.registeredHandlers.find(
    (handler) => handler.channel === "@daintree/context-menu-availability"
  );
  return entry!.handler({} as never, { availability: "continue", ...request });
}

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Continue in another agent", () => {
  it("converts the pane's Codex session and starts Claude Code in its worktree with the hand-off", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    const before = hashOf(scenario.sourcePath);
    host.simulateConfirmResponse(true);

    const outcome = await clickContinue(host);

    expect(outcome).toEqual({
      status: "launched",
      conversionId: "id-1",
      terminalId: "continue-id-2",
    });
    expect(host.showConfirmCalls[0]?.options).toMatchObject({
      title: "Continue in Claude Code?",
      confirmLabel: "Continue in Claude Code",
    });
    expect(scenario.launches).toHaveLength(1);
    const launch = scenario.launches[0]!;
    expect(launch).toMatchObject({
      agentId: "claude",
      worktreeId: "wt-1",
      cwd: "/repo/wt",
      interactive: true,
      requestedId: "continue-id-2",
    });
    // Nothing that would raise a plugin's launch to a confirm it can't pass.
    expect(launch).not.toHaveProperty("presetId");
    expect(launch).not.toHaveProperty("agentLaunchFlags");
    expect(launch).not.toHaveProperty("systemPrompt");
    expect(launch).not.toHaveProperty("env");
    const prompt = String(launch.prompt);
    expect(prompt).toContain("Now add a test for the Linux keymap.");
    expect(prompt).toContain("Added keymap.linux.test.ts");
    expect(prompt).not.toContain("<environment_context>");

    // A session read whole files nothing in the inbox.
    expect(host.startedTasks[0]?.result).toEqual({ outcome: "succeeded" });
    expect(host.notifications).toEqual([]);
    expect(hashOf(scenario.sourcePath)).toBe(before);
  });

  it("says how many records the index leaves out", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    appendFileSync(scenario.sourcePath, '{"type":"response_item","payload":\n[]\n');
    host.simulateConfirmResponse(true);

    expect(await clickContinue(host)).toMatchObject({ status: "launched" });

    const result = host.startedTasks[0]?.result;
    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(result && "message" in result ? result.message : "").toMatch(
      /^Converted\. The index leaves out 2 records that couldn't be read/
    );
    expect(host.notifications.map((entry) => entry.options)).toEqual([
      expect.objectContaining({ delivery: "passive", title: "Converting the Codex session" }),
    ]);
  });

  it("lets only the continuing agent search the session", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    await clickContinue(host);
    const tool = searchTool(host);
    const signal = new AbortController().signal;

    const found = (await tool.execute(
      { query: "VOICE_KEY" },
      caller("p1", "continue-id-2"),
      signal
    )) as {
      sessions: { convertedSessionId: string; sessionFile: string; hits: { line: number }[] }[];
    };
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]!.convertedSessionId).toBe("id-1");
    expect(found.sessions[0]!.sessionFile).toBe(scenario.sourcePath);
    expect(found.sessions[0]!.hits[0]!.line).toBeGreaterThan(0);

    await expect(
      tool.execute({ query: "VOICE_KEY" }, caller("p1", "another-pane"), signal)
    ).rejects.toThrow(/No converted session is searchable/);
    await expect(
      tool.execute({ query: "VOICE_KEY" }, caller("p2", "continue-id-2"), signal)
    ).rejects.toThrow(/No converted session is searchable/);
  });

  it("does nothing when the user declines", async () => {
    const scenario = await setUp();
    scenario.host.simulateConfirmResponse(false);
    expect(await clickContinue(scenario.host)).toEqual({ status: "declined" });
    expect(scenario.launches).toEqual([]);
    expect(scenario.host.startedTasks).toEqual([]);
  });

  it("says why when core can't name the session file, and reads nothing", async () => {
    const scenario = await setUp();
    scenario.sessionFile = { status: "unknown", reason: "session-id-unknown" };
    const outcome = (await clickContinue(scenario.host)) as { status: string };
    expect(outcome.status).toBe("unavailable");
    expect(scenario.host.showConfirmCalls).toEqual([]);
    expect(scenario.host.shownToasts[0]?.message).toContain("didn't record this pane's session");
  });

  it("refuses a pane whose own record puts it in a project that isn't in front", async () => {
    const scenario = await setUp();
    scenario.terminalProjectId = "p2";
    const outcome = (await clickContinue(scenario.host)) as { status: string };
    expect(outcome.status).toBe("unavailable");
    expect(scenario.host.showConfirmCalls).toEqual([]);
  });

  it("files the session under the pane's own project", async () => {
    const scenario = await setUp();
    scenario.terminalProjectId = "p1";
    scenario.host.simulateConfirmResponse(true);
    await clickContinue(scenario.host);
    await expect(
      searchTool(scenario.host).execute(
        { query: "keymap" },
        caller("p1", "continue-id-2"),
        new AbortController().signal
      )
    ).resolves.toBeDefined();
  });

  it("keeps nothing and launches nothing when Cancel lands while the session is saved", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    const storage = host.storage as { set: typeof host.storage.set };
    const realSet = storage.set.bind(host.storage);
    storage.set = async (key, value, scope) => {
      const task = host.startedTasks[0];
      if (key === "conversions" && task?.state === "working") host.simulateTaskCancel(task.id);
      return realSet(key, value, scope);
    };

    const outcome = (await clickContinue(host)) as { status: string };

    expect(outcome.status).toBe("cancelled");
    expect(scenario.launches).toEqual([]);
    expect(readdirSync(join(scenario.dataDir, "sessions"))).toEqual([]);
    expect(await host.storage.get("conversions")).toEqual({});
  });

  it("refuses a file that turns out to be another session's", async () => {
    const scenario = await setUp();
    scenario.sessionFile = { ...scenario.sessionFile, sessionId: "a-different-session" };
    scenario.host.simulateConfirmResponse(true);
    const outcome = (await clickContinue(scenario.host)) as { status: string };
    expect(outcome.status).toBe("failed");
    expect(scenario.launches).toEqual([]);
    expect(scenario.host.startedTasks[0]?.result).toMatchObject({ outcome: "failed" });
  });

  it("keeps the converted session and offers a retry when the project in front changed", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    // The project in front changes while the session converts: the click and
    // the retention check read p1, the launch check reads p2.
    scenario.front.switchTo = "p2";
    scenario.front.afterReads = 2;

    const outcome = (await clickContinue(host)) as { status: string; conversionId: string };

    expect(outcome.status).toBe("not-launched");
    expect(scenario.launches).toEqual([]);
    const notice = host.notifications[0]?.options;
    expect(notice).toMatchObject({ severity: "error", title: "Couldn't start Claude Code" });
    expect(notice?.actions?.[0]).toMatchObject({
      actionId: `${PLUGIN_ID}.launch`,
      args: { conversionId: outcome.conversionId },
    });

    // Back in the right project, the retry launches from the kept index.
    scenario.front.projectId = "p1";
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch");
    const retried = (await launch!.handler({ conversionId: outcome.conversionId })) as {
      status: string;
    };
    expect(retried.status).toBe("launched");
    expect(String(scenario.launches[0]!.prompt)).toContain("Now add a test for the Linux keymap.");
  });

  it("takes the search grant back when the CLI doesn't start", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    scenario.launchResult = () =>
      ok({ launched: false, terminalId: null, spawnStatus: "missing-cli" });
    host.simulateConfirmResponse(true);
    const outcome = (await clickContinue(host)) as { status: string; reason: string };
    expect(outcome).toMatchObject({ status: "not-launched" });
    expect(outcome.reason).toContain("isn't installed");
    await expect(
      searchTool(host).execute(
        { query: "voice" },
        caller("p1", String(scenario.launches[0]!.requestedId)),
        new AbortController().signal
      )
    ).rejects.toThrow(/No converted session is searchable/);
  });
});

describe("Continuing a session again", () => {
  it("keeps the first agent's search when another launch fails, and adds the new one's when it works", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    await clickContinue(host);
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch")!;
    const signal = new AbortController().signal;
    const search = (terminalId: string) =>
      searchTool(host).execute({ query: "keymap" }, caller("p1", terminalId), signal);

    scenario.launchResult = () =>
      ok({ launched: false, terminalId: null, spawnStatus: "panel-limit" });
    await launch.handler({ conversionId: "id-1" });
    await expect(search("continue-id-2")).resolves.toBeDefined();
    await expect(search("continue-id-3")).rejects.toThrow(/No converted session is searchable/);

    scenario.launchResult = (args) =>
      ok({ launched: true, terminalId: args.requestedId, spawnStatus: null });
    await launch.handler({ conversionId: "id-1" });
    await expect(search("continue-id-2")).resolves.toBeDefined();
    await expect(search("continue-id-4")).resolves.toBeDefined();
  });
});

describe("Converted sessions", () => {
  async function converted(): Promise<Scenario> {
    const scenario = await setUp();
    scenario.host.simulateConfirmResponse(true);
    await clickContinue(scenario.host);
    return scenario;
  }

  function manage(host: MockHost, projectId = "p1"): Promise<unknown> {
    const action = host.registeredActions.find((entry) => entry.descriptor.id === "manage");
    return Promise.resolve(action!.handler({ projectId }));
  }

  it("lists the project's sessions with their size", async () => {
    const { host } = await converted();
    await manage(host);
    const items = host.showQuickPickCalls[0]!.items;
    expect(items[0]).toMatchObject({ id: "id-1", label: "Codex → Claude Code" });
    expect(items[0]!.description).toMatch(/KB$/);
    expect(items.map((item) => item.id)).toEqual(["id-1", "share", "delete-all"]);
    expect(items[0]!.detail).toBe("Searchable by the agent that continued it");
  });

  it.each([
    { launched: true, detail: "Searchable by the agent that continued it · 1 record skipped" },
    { launched: false, detail: "Not continued yet · 1 record skipped" },
  ])(
    "says when a session's index leaves records out (launched: $launched)",
    async ({ launched, detail }) => {
      const scenario = await setUp();
      appendFileSync(scenario.sourcePath, "not json\n");
      if (!launched) {
        scenario.launchResult = () =>
          ok({ launched: false, terminalId: null, spawnStatus: "missing-cli" });
      }
      scenario.host.simulateConfirmResponse(true);
      await clickContinue(scenario.host);

      await manage(scenario.host);

      expect(scenario.host.showQuickPickCalls[0]!.items[0]!.detail).toBe(detail);
    }
  );

  it("shares the project's sessions with every agent in it after a confirm", async () => {
    const { host } = await converted();
    host.simulateQuickPickResponse({ id: "share", label: "Share" });
    host.simulateConfirmResponse(true);
    await manage(host);
    const found = (await searchTool(host).execute(
      { query: "keymap" },
      caller("p1", "any-pane"),
      new AbortController().signal
    )) as { sessions: unknown[] };
    expect(found.sessions).toHaveLength(1);
  });

  it("deletes every converted session in the project, index files included", async () => {
    const scenario = await converted();
    const { host } = scenario;
    host.simulateQuickPickResponse({ id: "delete-all", label: "Delete" });
    host.simulateConfirmResponse(true);
    await manage(host);
    expect(readdirSync(join(scenario.dataDir, "sessions"))).toEqual([]);
    await expect(
      searchTool(host).execute(
        { query: "keymap" },
        caller("p1", "continue-id-2"),
        new AbortController().signal
      )
    ).rejects.toThrow(/No converted session is searchable/);
  });

  it("deletes a removed project's sessions, but never on a listing it can't trust", async () => {
    const scenario = await converted();
    const { host } = scenario;
    // A second session, converted in p3.
    scenario.front.projectId = "p3";
    scenario.projects = ["p1", "p3"];
    await clickContinue(host, "pane-in-p3");
    const indexes = () => readdirSync(join(scenario.dataDir, "sessions")).sort();
    expect(indexes()).toEqual(["id-1.db", "id-3.db"]);

    // An empty listing, or one from another host that doesn't name p3, deletes nothing.
    scenario.projects = [];
    await manage(host, "p3");
    scenario.projects = ["remote-1", "remote-2"];
    await manage(host, "p3");
    // Nor does a listing anchored on a project with no converted sessions,
    // as a remote project's pill would be.
    scenario.front.projectId = "remote-1";
    await manage(host, "remote-1");
    expect(indexes()).toEqual(["id-1.db", "id-3.db"]);

    // p1 is gone from a listing that names p3, in front: its session goes.
    scenario.front.projectId = "p3";
    scenario.projects = ["p3"];
    await manage(host, "p3");
    expect(indexes()).toEqual(["id-3.db"]);
  });
});

describe("Continue a project assistant session", () => {
  type Found = { sessions: { convertedSessionId: string; sessionFile: string; hits: unknown[] }[] };

  /** The session ids the project's assistant finds "keymap" in; [] when it may search none. */
  async function assistantFinds(host: MockHost, projectId = "p1"): Promise<string[]> {
    try {
      const found = (await searchTool(host).execute(
        { query: "keymap" },
        caller(projectId, "any-assistant-lane", "assistant"),
        new AbortController().signal
      )) as Found;
      return found.sessions
        .filter((session) => session.hits.length > 0)
        .map((session) => session.convertedSessionId);
    } catch (error) {
      if (String(error).includes("No converted session is searchable")) return [];
      throw error;
    }
  }

  it("converts the session and starts the other CLI as a new assistant session with the hand-off", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);

    const outcome = await clickOnProjectAssistant(host);

    expect(outcome).toEqual({ status: "launched", conversionId: "id-1" });
    expect(scenario.lookups).toEqual(["assistant-term"]);
    expect(host.showConfirmCalls[0]?.options.message).toContain(
      "starts as a new assistant session in this project"
    );
    expect(scenario.launches).toEqual([]);
    expect(scenario.assistantStarts).toHaveLength(1);
    const start = scenario.assistantStarts[0]!;
    expect(Object.keys(start).sort()).toEqual(["agentId", "prompt"]);
    expect(start.agentId).toBe("claude");
    const prompt = String(start.prompt);
    expect(prompt).toContain("ran as this project's Daintree Assistant");
    expect(prompt).toContain("Now add a test for the Linux keymap.");
    expect(host.notifications).toEqual([]);
  });

  it("does nothing when the user declines", async () => {
    const scenario = await setUp();
    scenario.host.simulateConfirmResponse(false);
    expect(await clickOnProjectAssistant(scenario.host)).toEqual({ status: "declined" });
    expect(scenario.host.startedTasks).toEqual([]);
    expect(scenario.assistantStarts).toEqual([]);
  });

  it("lets the project's assistant search from its first turn, and no worker or other project", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    let duringStart: string[] = [];
    scenario.onAssistantStart = async () => {
      duringStart = await assistantFinds(host);
      return ok({ outcome: "started" });
    };
    host.simulateConfirmResponse(true);
    await clickOnProjectAssistant(host);
    const signal = new AbortController().signal;

    expect(duringStart).toEqual(["id-1"]);
    expect(await assistantFinds(host)).toEqual(["id-1"]);
    expect(await assistantFinds(host, "p2")).toEqual([]);
    await expect(
      searchTool(host).execute({ query: "keymap" }, caller("p1", "a-worker-pane"), signal)
    ).rejects.toThrow(/No converted session is searchable/);
  });

  it("takes the assistant's grant back and offers a retry when every tab is in use", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    let duringStart: string[] = [];
    scenario.onAssistantStart = async () => {
      duringStart = await assistantFinds(host);
      return ok({ outcome: "lanes-full" });
    };
    host.simulateConfirmResponse(true);

    const outcome = (await clickOnProjectAssistant(host)) as { status: string; reason: string };

    expect(outcome.status).toBe("not-launched");
    expect(outcome.reason).toContain("Every assistant session tab is in use");
    expect(duringStart).toEqual(["id-1"]);
    expect(await assistantFinds(host)).toEqual([]);
    expect(host.notifications[0]?.options.actions?.[0]).toMatchObject({
      actionId: `${PLUGIN_ID}.launch`,
      args: { conversionId: "id-1" },
    });

    // The retry starts an assistant session again, never a pane, and grants search.
    scenario.onAssistantStart = undefined;
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch");
    expect(await launch!.handler({ conversionId: "id-1" })).toEqual({
      status: "launched",
      conversionId: "id-1",
    });
    expect(scenario.assistantStarts).toHaveLength(2);
    expect(scenario.launches).toEqual([]);
    expect(await assistantFinds(host)).toEqual(["id-1"]);
  });

  it("keeps an earlier start's grant when a later one fails", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    await clickOnProjectAssistant(host);
    scenario.assistantResult = () => ok({ outcome: "unavailable" });
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch");

    expect(await launch!.handler({ conversionId: "id-1" })).toMatchObject({
      status: "not-launched",
    });
    expect(scenario.assistantStarts).toHaveLength(2);
    expect(await assistantFinds(host)).toEqual(["id-1"]);
  });

  it("never lets a start that fails withdraw one that succeeded beside it", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    scenario.assistantResult = () => ok({ outcome: "lanes-full" });
    host.simulateConfirmResponse(true);
    await clickOnProjectAssistant(host);
    expect(await assistantFinds(host)).toEqual([]);

    // Two starts at once: the first fails after the second succeeded.
    let failFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (failFirst = resolve));
    let calls = 0;
    scenario.onAssistantStart = async () => {
      calls += 1;
      if (calls === 1) {
        await firstHeld;
        return ok({ outcome: "lanes-full" });
      }
      return ok({ outcome: "started" });
    };
    const launch = host.registeredActions.find((entry) => entry.descriptor.id === "launch")!;
    const first = launch.handler({ conversionId: "id-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await launch.handler({ conversionId: "id-1" })).toMatchObject({ status: "launched" });
    failFirst();
    expect(await first).toMatchObject({ status: "not-launched" });

    expect(await assistantFinds(host)).toEqual(["id-1"]);
  });

  it("keeps the grant and offers no blind retry when Daintree doesn't answer in time", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    scenario.assistantResult = () =>
      ({
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: "Plugin action dispatch timed out: help.newSessionWithAgent",
        },
      }) as ActionDispatchResult;
    host.simulateConfirmResponse(true);

    expect(await clickOnProjectAssistant(host)).toMatchObject({ status: "not-launched" });

    expect(await assistantFinds(host)).toEqual(["id-1"]);
    expect(host.notifications.filter((entry) => entry.options.severity === "error")).toEqual([]);
    expect(host.shownToasts.at(-1)?.message).toContain("didn't answer in time");
  });

  it("treats a dispatch the host stopped answering like one that timed out", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    scenario.onAssistantStart = async () => {
      throw Object.assign(new Error("main stopped answering"), { code: "TIMEOUT" });
    };
    host.simulateConfirmResponse(true);

    expect(await clickOnProjectAssistant(host)).toMatchObject({ status: "not-launched" });

    expect(await assistantFinds(host)).toEqual(["id-1"]);
    expect(host.shownToasts.at(-1)?.message).toContain("didn't answer in time");
  });

  it("refuses a session from a project that isn't in front, looking nothing up", async () => {
    const scenario = await setUp();
    const outcome = (await clickOnProjectAssistant(scenario.host, { projectId: "p2" })) as {
      status: string;
    };
    expect(outcome.status).toBe("unavailable");
    expect(scenario.lookups).toEqual([]);
    expect(scenario.host.showConfirmCalls).toEqual([]);
    expect(scenario.host.startedTasks).toEqual([]);
  });

  it("refuses a session whose terminal isn't up yet, looking nothing up", async () => {
    const scenario = await setUp();
    const action = scenario.host.registeredActions.find(
      (entry) => entry.descriptor.id === "continue"
    );
    // As the panel dispatches a lane with no terminal: the field is left out.
    const outcome = (await action!.handler({
      assistantScope: "project",
      projectId: "p1",
      slot: 0,
      agentId: "codex",
    })) as { status: string; reason: string };
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(outcome.reason).toContain("hasn't started yet");
    expect(scenario.lookups).toEqual([]);
  });

  it("lists an assistant conversion by whether a start succeeded", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    host.simulateConfirmResponse(true);
    await clickOnProjectAssistant(host);
    scenario.assistantResult = () => ok({ outcome: "lanes-full" });
    await clickOnProjectAssistant(host);
    const manage = host.registeredActions.find((entry) => entry.descriptor.id === "manage");
    await manage!.handler({ projectId: "p1" });
    const details = Object.fromEntries(
      host.showQuickPickCalls[0]!.items.map((item) => [item.id, item.detail])
    );
    expect(details["id-1"]).toBe("Searchable by this project's assistant");
    expect(details["id-2"]).toBe("Not continued yet");
  });
});

describe("Continue the global assistant", () => {
  it("asks Daintree to replace the clicked session from a hand-off, keeping nothing", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    const before = hashOf(scenario.sourcePath);

    const outcome = await clickOnGlobalAssistant(host);

    expect(outcome).toEqual({ status: "awaiting-confirmation" });
    expect(scenario.lookups).toEqual(["global-term"]);
    // Daintree's own dialog asks; the plugin doesn't ask first.
    expect(host.showConfirmCalls).toEqual([]);
    expect(scenario.replacements).toHaveLength(1);
    const asked = scenario.replacements[0]!;
    expect(asked.agentId).toBe("claude");
    expect(asked.terminalId).toBe("global-term");
    const prompt = String(asked.prompt);
    expect(prompt).toContain("ran as the global Daintree Assistant");
    expect(prompt).toContain("Now add a test for the Linux keymap.");
    expect(prompt).toContain(scenario.sourcePath);
    expect(prompt).not.toContain("search_converted");
    expect(host.startedTasks[0]?.result).toEqual({ outcome: "succeeded" });
    expect(await host.storage.get("conversions")).toBeUndefined();
    // No index: not even its folder.
    expect(existsSync(scenario.dataDir)).toBe(false);
    expect(hashOf(scenario.sourcePath)).toBe(before);
  });

  it("says why when Daintree won't ask", async () => {
    const scenario = await setUp();
    scenario.replaceResult = () => ok({ outcome: "unavailable" });

    const outcome = (await clickOnGlobalAssistant(scenario.host)) as {
      status: string;
      reason: string;
    };

    expect(scenario.replacements).toHaveLength(1);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.reason).toContain("Only the session that coordinates");
    expect(scenario.host.shownToasts[0]?.message).toContain("Can't continue this session.");
  });

  it("passes on Daintree's own refusal rather than guessing at one", async () => {
    const scenario = await setUp();
    scenario.replaceResult = () =>
      ({
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "A hand-off can't hold control characters" },
      }) as ActionDispatchResult;

    const outcome = (await clickOnGlobalAssistant(scenario.host)) as { reason: string };

    expect(outcome.reason).toContain("A hand-off can't hold control characters");
    expect(outcome.reason).not.toContain("Only the session that coordinates");
  });

  it("asks nothing and reads nothing when the session file isn't known", async () => {
    const scenario = await setUp();
    scenario.sessionFile = { status: "unknown", reason: "not-observed" };
    const outcome = (await clickOnGlobalAssistant(scenario.host)) as {
      status: string;
      reason: string;
    };
    expect(outcome.status).toBe("unavailable");
    expect(outcome.reason).toContain("The session file wasn't seen");
    expect(scenario.host.startedTasks).toEqual([]);
    expect(scenario.replacements).toEqual([]);
  });
});

describe("The menu item's availability", () => {
  it("is available when the session file is observed, looking up the session clicked", async () => {
    const scenario = await setUp();
    const { host } = scenario;
    expect(await availability(host, { location: "terminal", panelId: "pane-codex" })).toBeNull();
    expect(
      await availability(host, {
        location: "assistant",
        assistantScope: "global",
        terminalId: "global-term",
        agentId: "codex",
      })
    ).toBeNull();
    expect(
      await availability(host, {
        location: "assistant",
        assistantScope: "project",
        projectId: "p1",
        terminalId: "assistant-term",
        agentId: "codex",
      })
    ).toBeNull();
    expect(scenario.lookups).toEqual(["pane-codex", "global-term", "assistant-term"]);
  });

  it("names each unknown session file's own short reason", async () => {
    const scenario = await setUp();
    const ask = async (reason: string) => {
      scenario.sessionFile = { status: "unknown", reason };
      return availability(scenario.host, { location: "terminal", panelId: "pane-codex" });
    };
    const reasons = [
      await ask("not-observed"),
      await ask("remote-pane"),
      await ask("a-reason-this-plugin-has-never-heard-of"),
    ];
    expect(reasons).toEqual([
      "Session file not seen yet, try again shortly",
      "Runs on a remote host",
      "The session file isn't known yet",
    ]);
    for (const reason of reasons) {
      expect(String(reason).length).toBeLessThanOrEqual(120);
      expect(String(reason).endsWith(".")).toBe(false);
    }
  });

  it("answers an assistant on another agent, one not started, and one outside a project without a lookup", async () => {
    const scenario = await setUp();
    const project = { location: "assistant", assistantScope: "project", projectId: "p1" };
    expect(
      await availability(scenario.host, { ...project, terminalId: "t", agentId: "antigravity" })
    ).toBe("Only Codex and Claude Code sessions can continue");
    expect(await availability(scenario.host, project)).toBe("The session hasn't started yet");
    // A scratch workspace's assistant: no project is in front.
    scenario.front.projectId = null;
    expect(
      await availability(scenario.host, {
        ...project,
        projectId: "scratch-1",
        terminalId: "t",
        agentId: "codex",
      })
    ).toBe("Only available in a project");
    expect(scenario.lookups).toEqual([]);
  });

  it("offers the item when the lookup fails, and ignores another item's id", async () => {
    const scenario = await setUp();
    scenario.sessionFiles["broken"] = {
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    } as ActionDispatchResult;
    expect(
      await availability(scenario.host, { location: "terminal", panelId: "broken" })
    ).toBeNull();
    expect(scenario.lookups).toEqual(["broken"]);

    scenario.sessionFile = { status: "unknown", reason: "not-observed" };
    expect(
      await availability(scenario.host, {
        availability: "something-else",
        location: "terminal",
        panelId: "pane-codex",
      })
    ).toBeNull();
    expect(scenario.lookups).toEqual(["broken"]);
  });
});
