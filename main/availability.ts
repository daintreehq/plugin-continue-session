import type { ContextMenuAvailabilityRequest, PluginHostApi } from "@daintreehq/plugin-sdk";
import { currentProjectId } from "./context.js";
import type { SessionFileAnswer } from "./continueFlow.js";

/** The `availability` id the manifest's "Continue in another agent…" items set. */
export const CONTINUE_AVAILABILITY = "continue";

/**
 * Why the menu item can't run, shown beside it: one line, at most 120
 * characters, sentence case with no full stop.
 */
const SHORT_REASONS: Readonly<Record<string, string>> = {
  "terminal-unavailable": "Not a session in this project",
  "no-live-agent": "No agent is running here",
  "unsupported-agent": "Only Codex and Claude Code sessions can continue",
  "unsupported-platform": "Not available on Windows yet",
  "remote-pane": "Runs on a remote host",
  "session-id-unknown": "Daintree didn't record this session",
  "store-unknown": "Claude Code's session store isn't known",
  "not-observed": "Session file not seen yet, try again shortly",
  ambiguous: "More than one session file matches",
  unverified: "The session file failed a check",
  "probe-failed": "Couldn't look for the session file",
  "pane-changed": "The session restarted, try again",
  busy: "Daintree is busy, try again in a moment",
};

const CONTINUABLE_AGENTS = new Set(["codex", "claude"]);

/**
 * Answers whether "Continue in another agent…" can run on what the menu was
 * opened on: `null` when it can, else the reason. It only advises the menu,
 * which offers the item anyway when this fails or is slow, so a lookup that
 * can't be made answers `null` and leaves the action to explain.
 */
export async function continueAvailability(
  host: PluginHostApi,
  payload: unknown
): Promise<string | null> {
  if (!payload || typeof payload !== "object") return null;
  const request = payload as Partial<ContextMenuAvailabilityRequest>;
  if (request.availability !== CONTINUE_AVAILABILITY) return null;

  // A scratch workspace's assistant is a project-scope session too, but a new
  // session can only start in the project in front.
  if (
    request.location === "assistant" &&
    request.assistantScope === "project" &&
    (await currentProjectId(host)) !== request.projectId
  ) {
    return "Only available in a project";
  }
  if (
    request.location === "assistant" &&
    typeof request.agentId === "string" &&
    !CONTINUABLE_AGENTS.has(request.agentId)
  ) {
    return SHORT_REASONS["unsupported-agent"]!;
  }
  // A worker pane names its terminal as the panel; an assistant session names it directly.
  const terminalId = request.panelId ?? request.terminalId;
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    return "The session hasn't started yet";
  }
  const located = await host.dispatch("terminal.sessionFile.get", { terminalId });
  if (!located.ok) return null;
  const file = located.result as SessionFileAnswer | undefined;
  if (!file || file.status === "observed") return null;
  return SHORT_REASONS[file.reason] ?? "The session file isn't known yet";
}
