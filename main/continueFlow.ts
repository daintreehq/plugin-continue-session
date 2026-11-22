import type { PluginHostApi } from "@daintreehq/plugin-sdk";
import type { ConversionRecord } from "./catalog.js";
import { currentProjectId, MANIFEST_NAME, type PluginContext } from "./context.js";
import { convertSession, MAX_RECORD_BYTES, recordCount, SessionMismatchError } from "./convert.js";
import { AGENT_LABELS, buildHandoffPrompt } from "./handoff.js";
import { pruneRemovedProjects } from "./retention.js";
import type { SessionAgentId } from "./sessionRecords.js";

/** What `terminal.sessionFile.get` answers (docs/plugins/host-api.md). */
export type SessionFileAnswer =
  | {
      status: "observed";
      agentId: SessionAgentId;
      sessionId: string;
      path: string;
      observedBy: string;
    }
  | { status: "unknown"; reason: string };

type ObservedFile = Extract<SessionFileAnswer, { status: "observed" }>;

export type ContinueOutcome =
  /** `terminalId` is absent for an assistant session, whose terminal the start doesn't name. */
  | { status: "launched"; conversionId: string; terminalId?: string }
  | { status: "not-launched"; conversionId: string; reason: string }
  /** The global assistant: Daintree asks the person, and the plugin never learns the answer. */
  | { status: "awaiting-confirmation" }
  | { status: "declined" }
  | { status: "unavailable"; reason: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

/** Which session the menu was opened on, as each location's dispatch names it. */
type Subject =
  | { kind: "pane"; terminalId: string }
  | { kind: "project-assistant"; terminalId: string; projectId: string }
  | { kind: "global-assistant"; terminalId: string };

const UNKNOWN_REASONS: Readonly<Record<string, string>> = {
  "terminal-unavailable": "This pane isn't a terminal in this project.",
  "no-live-agent": "No agent is running in this pane.",
  "unsupported-agent": "Only Codex and Claude Code sessions can be continued.",
  "unsupported-platform": "Session files can't be located on Windows yet.",
  "remote-pane": "This pane runs on a remote host, where its session file can't be read.",
  "session-id-unknown":
    "Daintree didn't record this pane's session. A Claude Code session started by hand in the pane can't be located.",
  "store-unknown": "Daintree isn't sure which Claude Code store this pane uses.",
  "not-observed":
    "The session file wasn't seen. Codex opens it a few seconds into a session, so try again shortly.",
  ambiguous: "More than one session file could be this pane's, so none was taken.",
  unverified: "A session file was found but failed a check.",
  "probe-failed": "Looking for the session file failed.",
  "pane-changed": "The pane restarted while its session file was being located.",
  busy: "Daintree is already locating other session files. Try again in a moment.",
};

/**
 * "Continue in another agent…" on a worker pane or an assistant session:
 * locate the session file, then continue it in the other CLI where it ran.
 */
export async function continueFromPane(
  ctx: PluginContext,
  args: unknown
): Promise<ContinueOutcome> {
  const subject = readSubject(args);
  if (typeof subject === "string") return unavailable(ctx.host, subject);
  if (subject.kind === "global-assistant") return continueGlobalAssistant(ctx, subject, args);
  return continueIndexed(ctx, subject, args);
}

function readSubject(args: unknown): Subject | string {
  const scope = readString(args, "assistantScope");
  const terminalId = readString(args, "terminalId");
  if (scope === "global") {
    return terminalId
      ? { kind: "global-assistant", terminalId }
      : "The global assistant isn't running.";
  }
  if (scope === "project") {
    const projectId = readString(args, "projectId");
    if (!projectId) return "This assistant session's project wasn't named.";
    return terminalId
      ? { kind: "project-assistant", terminalId, projectId }
      : "This assistant session hasn't started yet.";
  }
  const panelId = readString(args, "panelId") ?? terminalId;
  return panelId ? { kind: "pane", terminalId: panelId } : "No pane was named.";
}

/**
 * A worker pane or a project assistant session: convert the session into a
 * searchable index, then start the other CLI with the hand-off, in the pane's
 * worktree or as a new assistant session in the same project.
 */
async function continueIndexed(
  ctx: PluginContext,
  subject: Extract<Subject, { kind: "pane" | "project-assistant" }>,
  args: unknown
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const { terminalId } = subject;
  const front = await currentProjectId(host);
  if (!front) return unavailable(host, "No project is open.");

  let projectId: string;
  let worktreeId: string | null = null;
  let cwd = "";
  if (subject.kind === "project-assistant") {
    // The new session starts in the project in front, so it has to be this one.
    if (subject.projectId !== front) {
      return unavailable(host, "This assistant session isn't in the project in front.");
    }
    projectId = front;
  } else {
    const info = await host.dispatch("terminal.info.get", { terminalId });
    if (!info.ok) return unavailable(host, "This pane's details couldn't be read.");
    const terminal = info.result as { cwd?: unknown; worktreeId?: unknown; projectId?: unknown };
    // The pane's own record names its project when it can; the session is filed
    // under that, and a pane outside the project in front isn't one dispatch reaches.
    projectId = typeof terminal.projectId === "string" ? terminal.projectId : front;
    if (projectId !== front) return unavailable(host, "This pane isn't in the project in front.");
    worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId : null;
    cwd = typeof terminal.cwd === "string" ? terminal.cwd : "";
  }

  const file = await locate(host, terminalId);
  if (typeof file === "string") return unavailable(host, file);

  const inAssistant = subject.kind === "project-assistant";
  const sourceAgent = file.agentId;
  const targetAgent = otherAgent(sourceAgent);
  const source = AGENT_LABELS[sourceAgent];
  const target = AGENT_LABELS[targetAgent];
  const confirmed = await host.showConfirm({
    title: `Continue in ${target}?`,
    message: inAssistant
      ? `Daintree reads this ${source} session once and turns it into a searchable index on this machine. ${target} starts as a new assistant session in this project with a short hand-off: your last few requests and ${source}'s last message. ` +
        `It doesn't get the conversation as history: it searches it with a tool if this project lets the Daintree Assistant use this plugin's tools, and otherwise reads the session file. Any of this project's assistant sessions can search it. The hand-off and what it finds go to its model like any other context. ` +
        `The session file isn't changed. The index stays until you delete it from the project's Converted sessions menu.`
      : `Daintree reads this ${source} session once and turns it into a searchable index on this machine. ${target} starts in the same worktree with a short hand-off: your last few requests and ${source}'s last message. ` +
        `It doesn't get the conversation as history: it searches it with a tool when it needs something. The hand-off and what it finds go to its model like any other context. ` +
        `The session file isn't changed. The index stays until you delete it from the project's Converted sessions menu.`,
    confirmLabel: `Continue in ${target}`,
  });
  if (!confirmed) return { status: "declined" };

  const conversionId = ctx.newId();
  const read = await readSession(ctx, {
    id: conversionId,
    file,
    indexed: true,
    retryArgs: args,
  });
  if (read.status !== "read") return read;

  const record: ConversionRecord = {
    id: conversionId,
    continuedIn: inAssistant ? "assistant" : "worktree",
    projectId,
    worktreeId,
    cwd,
    sourceAgent,
    targetAgent,
    sourceSessionId: file.sessionId,
    sourcePath: file.path,
    sourceBytes: read.converted.sourceBytes,
    fragments: read.converted.fragments,
    skippedLines: read.converted.skippedLines,
    createdAt: Date.now(),
    terminalIds: [],
    assistantGrant: false,
  };
  let prompt: string;
  try {
    prompt = buildHandoffPrompt({
      target: inAssistant ? "project-assistant" : "worktree",
      sourceAgent,
      sourceSessionId: file.sessionId,
      sourcePath: file.path,
      conversionId,
      prompts: read.converted.prompts,
      lastReply: read.converted.lastReply,
    });
    await ctx.store.writeHandoff(conversionId, prompt);
    // A cancel that lands while the index is published still wins: nothing
    // is kept and nothing launches.
    read.signal.throwIfAborted();
    await ctx.catalog.put(record);
    read.signal.throwIfAborted();
  } catch (error) {
    return read.fail(error);
  } finally {
    read.done();
  }

  // Unreadable records would otherwise go missing from search unannounced.
  await read.succeed(
    record.skippedLines > 0
      ? `Converted. The index leaves out ${recordCount(record.skippedLines)} that couldn't be read: malformed, or over ${MAX_RECORD_BYTES / (1024 * 1024)} MB.`
      : undefined
  );
  await pruneRemovedProjects(ctx, projectId).catch(() => undefined);
  return launchConversion(ctx, record, prompt);
}

/**
 * The global assistant: it is handed no plugin tools, so its session is read
 * for the hand-off alone and nothing is kept. Daintree asks the person before
 * replacing the run, naming the session the hand-off was read from, so a
 * hand-off from one global session never replaces the other.
 */
async function continueGlobalAssistant(
  ctx: PluginContext,
  subject: Extract<Subject, { kind: "global-assistant" }>,
  args: unknown
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const file = await locate(host, subject.terminalId);
  if (typeof file === "string") return unavailable(host, file);
  const targetAgent = otherAgent(file.agentId);

  const read = await readSession(ctx, {
    id: ctx.newId(),
    file,
    indexed: false,
    retryArgs: args,
  });
  if (read.status !== "read") return read;
  let prompt: string;
  try {
    // A Cancel that lands as the file closes still wins: nothing is asked.
    read.signal.throwIfAborted();
    prompt = buildHandoffPrompt({
      target: "global-assistant",
      sourceAgent: file.agentId,
      sourceSessionId: file.sessionId,
      sourcePath: file.path,
      conversionId: null,
      prompts: read.converted.prompts,
      lastReply: read.converted.lastReply,
    });
  } catch (error) {
    return read.fail(error);
  }
  read.done();
  await read.succeed(undefined);

  const target = AGENT_LABELS[targetAgent];
  let asked: Awaited<ReturnType<PluginHostApi["dispatch"]>>;
  try {
    asked = await host.dispatch("help.replaceGlobalAssistant", {
      agentId: targetAgent,
      prompt,
      terminalId: subject.terminalId,
    });
  } catch (error) {
    asked = {
      ok: false,
      error: { code: "EXECUTION_ERROR", message: `timed out (${errorName(error)})` },
    } as typeof asked;
  }
  if (!asked.ok) {
    return unavailable(
      host,
      timedOut(asked.error)
        ? `Daintree didn't answer in time (${asked.error.message}). If it asks whether to replace the global assistant, that is this request.`
        : `The global assistant couldn't be continued in ${target}: ${asked.error.message}`
    );
  }
  const outcome = (asked.result as { outcome?: unknown } | undefined)?.outcome;
  if (outcome === "awaiting-confirmation") return { status: "awaiting-confirmation" };
  return unavailable(
    host,
    `The global assistant can't be continued in ${target} right now. Only the session that coordinates can, while no other change to it is waiting, and only on an agent that can run the global assistant here.`
  );
}

/** A dispatch the renderer didn't answer in time; the action may still run. */
function timedOut(error: { code?: string; message?: string }): boolean {
  return error.code === "EXECUTION_ERROR" && /timed out/i.test(error.message ?? "");
}

async function locate(host: PluginHostApi, terminalId: string): Promise<ObservedFile | string> {
  const located = await host.dispatch("terminal.sessionFile.get", { terminalId });
  if (!located.ok) return "This session's file couldn't be located.";
  const file = located.result as SessionFileAnswer;
  if (file.status === "observed") return file;
  return UNKNOWN_REASONS[file.reason] ?? "This session's file is unknown.";
}

type ReadSession =
  | {
      status: "read";
      converted: Awaited<ReturnType<typeof convertSession>>;
      signal: AbortSignal;
      /** Undoes what was kept, finishes the task as failed or cancelled, and says which. */
      fail: (error: unknown) => Promise<ContinueOutcome>;
      succeed: (message: string | undefined) => Promise<void>;
      /** Stops the plugin's unload from aborting this read. */
      done: () => void;
    }
  | Extract<ContinueOutcome, { status: "cancelled" | "failed" }>;

/** Reads the session file under a cancellable task, indexing it when `indexed`. */
async function readSession(
  ctx: PluginContext,
  input: { id: string; file: ObservedFile; indexed: boolean; retryArgs: unknown }
): Promise<ReadSession> {
  const { host } = ctx;
  const source = AGENT_LABELS[input.file.agentId];
  const controller = new AbortController();
  ctx.running.add(controller);
  const done = () => ctx.running.delete(controller);
  let task: Awaited<ReturnType<PluginHostApi["tasks"]["start"]>>;
  try {
    task = await host.tasks.start({
      title: input.indexed ? `Converting the ${source} session` : `Reading the ${source} session`,
      detail: "Reading the session file",
      cancellable: true,
      fraction: 0,
      retry: { actionId: `${MANIFEST_NAME}.continue`, args: retryable(input.retryArgs) },
    });
  } catch (error) {
    done();
    throw error;
  }
  const signal = AbortSignal.any([controller.signal, task.signal]);

  const fail = async (error: unknown): Promise<ContinueOutcome> => {
    done();
    if (input.indexed) {
      await ctx.catalog.remove([input.id]).catch(() => undefined);
      await ctx.store.delete(input.id).catch(() => undefined);
    }
    if (signal.aborted) {
      await task.finish({ outcome: "cancelled" });
      return { status: "cancelled" };
    }
    const reason =
      error instanceof SessionMismatchError
        ? error.message
        : `The session couldn't be read${input.indexed ? " or indexed" : ""} (${errorName(error)}).`;
    await task.finish({ outcome: "failed", message: reason });
    return { status: "failed", reason };
  };

  try {
    const converted = await convertSession(input.indexed ? ctx.store : null, {
      id: input.id,
      agentId: input.file.agentId,
      sessionId: input.file.sessionId,
      path: input.file.path,
      signal,
      onProgress: (fraction) => task.report({ fraction }),
    });
    return {
      status: "read",
      converted,
      signal,
      fail,
      done,
      succeed: (message) =>
        task.finish(message ? { outcome: "succeeded", message } : { outcome: "succeeded" }),
    };
  } catch (error) {
    return (await fail(error)) as Extract<ContinueOutcome, { status: "cancelled" | "failed" }>;
  }
}

/**
 * Starts the continuing agent for a converted session: a pane in its
 * worktree, or a new assistant session in its project.
 *
 * The project check sits right before the launch, with nothing awaited
 * between them but the check itself, because an installed plugin's dispatch
 * runs in whichever project is in front. A pane in a worktree is also safe
 * from a switch in that gap: the launcher refuses a worktree id the project
 * in front doesn't have.
 */
export async function launchConversion(
  ctx: PluginContext,
  record: ConversionRecord,
  prompt: string
): Promise<ContinueOutcome> {
  return record.continuedIn === "assistant"
    ? launchInAssistant(ctx, record, prompt)
    : launchInWorktree(ctx, record, prompt);
}

/**
 * The terminal id is chosen up front and granted before the launch, so the
 * agent can search from its very first turn; a launch that doesn't happen
 * takes back its own grant and no other.
 */
async function launchInWorktree(
  ctx: PluginContext,
  record: ConversionRecord,
  prompt: string
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const target = AGENT_LABELS[record.targetAgent];
  const requestedId = `continue-${ctx.newId()}`;
  const notLaunched = (reason: string) =>
    reportNotLaunched(ctx, record, reason, () => ctx.catalog.revoke(record.id, requestedId));

  await ctx.catalog.grant(record.id, requestedId);
  if ((await currentProjectId(host)) !== record.projectId) {
    return notLaunched("The project this session belongs to isn't the one in front.");
  }
  const launch = await host.dispatch("agent.launch", {
    agentId: record.targetAgent,
    ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    prompt,
    interactive: true,
    requestedId,
    focusPolicy: "take",
  });
  if (!launch.ok) return notLaunched(launch.error.message);
  const result = launch.result as {
    launched?: unknown;
    terminalId?: unknown;
    spawnStatus?: unknown;
  };
  if (result.launched !== true || typeof result.terminalId !== "string") {
    return notLaunched(launchRefusal(result.spawnStatus, target));
  }
  if (result.terminalId !== requestedId) {
    await ctx.catalog.revoke(record.id, requestedId, result.terminalId);
  }
  return { status: "launched", conversionId: record.id, terminalId: result.terminalId };
}

/**
 * A new assistant session's terminal isn't named before it starts, so the
 * grant goes to the project's Daintree Assistant. While a start is in flight
 * the grant is held in memory, so the session can search from its first turn;
 * it is kept only once a start succeeds. A start that fails withdraws only its
 * own hold, never another start's or one that already succeeded.
 */
async function launchInAssistant(
  ctx: PluginContext,
  record: ConversionRecord,
  prompt: string
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const target = AGENT_LABELS[record.targetAgent];
  const notLaunched = (reason: string) =>
    reportNotLaunched(ctx, record, reason, async () => undefined);
  if ((await currentProjectId(host)) !== record.projectId) {
    return notLaunched("The project this session belongs to isn't the one in front.");
  }
  const release = holdAssistantGrant(ctx, record.id);
  let started: Awaited<ReturnType<PluginHostApi["dispatch"]>> | null;
  try {
    started = await host.dispatch("help.newSessionWithAgent", {
      agentId: record.targetAgent,
      prompt,
    });
  } catch {
    // The host stopped answering: the start may still happen.
    started = null;
  }
  const outcome = started?.ok
    ? (started.result as { outcome?: unknown } | undefined)?.outcome
    : undefined;
  if (outcome === "started" || !started || (!started.ok && timedOut(started.error))) {
    try {
      await ctx.catalog.grantAssistant(record.id);
    } finally {
      release();
    }
    if (outcome === "started") return { status: "launched", conversionId: record.id };
    // It may still start, so its grant is kept and no blind retry offered.
    await host.showToast({
      message: `Daintree didn't answer in time. Check the Assistant panel for the ${target} session before continuing again.`,
      type: "warning",
    });
    return { status: "not-launched", conversionId: record.id, reason: "timed out" };
  }
  release();
  if (!started.ok) return notLaunched(started.error.message);
  return notLaunched(
    outcome === "lanes-full"
      ? "Every assistant session tab is in use. Close one first."
      : `The assistant couldn't start a ${target} session.`
  );
}

function holdAssistantGrant(ctx: PluginContext, id: string): () => void {
  ctx.pendingAssistantGrants.set(id, (ctx.pendingAssistantGrants.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (ctx.pendingAssistantGrants.get(id) ?? 1) - 1;
    if (left > 0) ctx.pendingAssistantGrants.set(id, left);
    else ctx.pendingAssistantGrants.delete(id);
  };
}

async function reportNotLaunched(
  ctx: PluginContext,
  record: ConversionRecord,
  reason: string,
  takeBackGrant: () => Promise<void>
): Promise<ContinueOutcome> {
  await takeBackGrant();
  await ctx.host.notify({
    title: `Couldn't start ${AGENT_LABELS[record.targetAgent]}`,
    body: `${reason} The converted session is kept.`,
    severity: "error",
    actions: [
      {
        id: "retry",
        label: "Retry",
        actionId: `${MANIFEST_NAME}.launch`,
        args: { conversionId: record.id },
      },
    ],
  });
  return { status: "not-launched", conversionId: record.id, reason };
}

/** The "Retry" on a failed launch, and "Continue again" in the Converted sessions menu. */
export async function launchById(ctx: PluginContext, args: unknown): Promise<ContinueOutcome> {
  const id = readString(args, "conversionId");
  const record = id ? await ctx.catalog.get(id) : null;
  if (!record) return unavailable(ctx.host, "That converted session was deleted.");
  const prompt = await ctx.store.readHandoff(record.id).catch(() => null);
  if (!prompt) {
    return unavailable(
      ctx.host,
      "That converted session's index is missing. Convert the session again from its menu."
    );
  }
  return launchConversion(ctx, record, prompt);
}

export function otherAgent(agentId: SessionAgentId): SessionAgentId {
  return agentId === "codex" ? "claude" : "codex";
}

/** The menu's dispatch, kept to the fields that name the session, for the task's Retry. */
function retryable(args: unknown): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  if (!args || typeof args !== "object") return kept;
  for (const key of [
    "panelId",
    "panelKind",
    "worktreeId",
    "assistantScope",
    "projectId",
    "slot",
    "terminalId",
    "incarnation",
    "agentId",
  ]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") kept[key] = value;
  }
  return kept;
}

function launchRefusal(spawnStatus: unknown, target: string): string {
  switch (spawnStatus) {
    case "missing-cli":
      return `${target} isn't installed or can't be found, so Daintree opened its setup instead.`;
    case "panel-limit":
      return "The grid is full.";
    case "already-launching":
    case "presets-loading":
      return "Daintree was busy starting another agent.";
    default:
      return `${target} didn't start.`;
  }
}

async function unavailable(host: PluginHostApi, reason: string): Promise<ContinueOutcome> {
  await host.showToast({ message: `Can't continue this session. ${reason}`, type: "warning" });
  return { status: "unavailable", reason };
}

function readString(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}
