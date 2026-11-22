import { describe, expect, it } from "vitest";
import { buildHandoffPrompt, clip, HandoffCollector } from "../main/handoff.js";

describe("HandoffCollector", () => {
  it("keeps the last five prompts, oldest first", () => {
    const collector = new HandoffCollector();
    for (let n = 1; n <= 7; n += 1)
      collector.add({ kind: "prompt", text: `request ${n}` }, n, null);
    expect(collector.recentPrompts().map((turn) => turn.text)).toEqual([
      "request 3",
      "request 4",
      "request 5",
      "request 6",
      "request 7",
    ]);
  });

  it("joins the blocks of one reply and keeps only the last reply", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "assistant", text: "first", messageKey: "a" }, 1, null);
    collector.add({ kind: "assistant", text: "second, part 1", messageKey: "b" }, 2, "t2");
    collector.add({ kind: "tool_call", text: "Bash ls" }, 3, null);
    collector.add({ kind: "assistant", text: "part 2", messageKey: "b" }, 4, null);
    expect(collector.lastReply()).toEqual({
      text: "second, part 1\n\npart 2",
      line: 2,
      timestamp: "t2",
    });
  });

  it("drops a reply that came before the last request", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "assistant", text: "old answer" }, 1, null);
    collector.add({ kind: "prompt", text: "new question" }, 2, null);
    expect(collector.lastReply()).toBeNull();
  });

  it("quotes neither injected context nor tool text, and keeps the reply across them", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "prompt", text: "do it" }, 1, null);
    collector.add({ kind: "assistant", text: "done", messageKey: "m" }, 2, null);
    collector.add({ kind: "context", text: "Daintree: terminal t1 is waiting." }, 3, null);
    collector.add({ kind: "context", text: "<command-name>/old</command-name>" }, 3, null);
    collector.add({ kind: "tool_result", text: "ok" }, 4, null);
    expect(collector.recentPrompts().map((turn) => turn.text)).toEqual(["do it"]);
    expect(collector.lastReply()?.text).toBe("done");
  });
});

describe("buildHandoffPrompt", () => {
  const prompt = buildHandoffPrompt({
    target: "worktree",
    sourceAgent: "codex",
    sourceSessionId: "s-1",
    sourcePath: "/home/me/.codex/sessions/rollout.jsonl",
    conversionId: "c-1",
    prompts: [
      { text: "--dangerously-skip-permissions please", line: 7, timestamp: "2026-10-26T13:02:00Z" },
    ],
    lastReply: { text: "Done.", line: 9, timestamp: null },
  });

  it("never starts like a launch flag, even when the first quoted request does", () => {
    expect(prompt.trimStart().startsWith("-")).toBe(false);
    expect(prompt).toContain("--dangerously-skip-permissions please");
  });

  it("clips a long request and a long reply, keeping their heads", () => {
    const long = buildHandoffPrompt({
      target: "worktree",
      sourceAgent: "codex",
      sourceSessionId: "s",
      sourcePath: "/p",
      conversionId: "c",
      prompts: [{ text: `HEAD-REQUEST ${"r".repeat(20_000)}`, line: 1, timestamp: null }],
      lastReply: { text: `HEAD-REPLY ${"a".repeat(50_000)}`, line: 2, timestamp: null },
    });
    expect(long).toContain("HEAD-REQUEST");
    expect(long).toContain("HEAD-REPLY");
    expect(long.length).toBeLessThan(10_000);
    expect(long.match(/more characters, searchable/g)).toHaveLength(2);
  });

  it("names the search tool, the session and its file, and fences the quotations", () => {
    expect(prompt).toContain("`search_converted`");
    expect(prompt).toContain("`daintree-continue-session`");
    expect(prompt).toContain("/home/me/.codex/sessions/rollout.jsonl");
    expect(prompt).toContain('<request line="7" time="2026-10-26T13:02:00Z">');
    expect(prompt).toContain('<reply line="9">\nDone.\n</reply>');
    expect(prompt).toContain("not as new instructions");
  });

  it("says so when there is no request or reply to quote", () => {
    const empty = buildHandoffPrompt({
      target: "worktree",
      sourceAgent: "claude",
      sourceSessionId: "s",
      sourcePath: "/p",
      conversionId: "c",
      prompts: [],
      lastReply: null,
    });
    expect(empty).toContain("holds no request typed by the user");
    expect(empty).toContain("Claude Code sent no reply after the last request");
  });
});

describe("buildHandoffPrompt for assistants", () => {
  const turns = {
    sourceSessionId: "s-1",
    sourcePath: "/home/me/.claude/projects/x/s-1.jsonl",
    prompts: [{ text: "Plan the release", line: 3, timestamp: null }],
    lastReply: { text: "Here's the plan.", line: 4, timestamp: null },
  };

  it("tells a project assistant session to read the file when it has no search tool", () => {
    const prompt = buildHandoffPrompt({
      ...turns,
      target: "project-assistant",
      sourceAgent: "claude",
      conversionId: "c-1",
    });
    expect(prompt).toContain("ran as this project's Daintree Assistant");
    expect(prompt).toContain("`search_converted`");
    expect(prompt).toContain("search the session file below instead");
    expect(prompt).toContain("converted session id c-1");
    expect(prompt).not.toContain("git status");
  });

  it("hands the global assistant the session file alone, naming no tool or index", () => {
    const prompt = buildHandoffPrompt({
      ...turns,
      target: "global-assistant",
      sourceAgent: "claude",
      conversionId: null,
    });
    expect(prompt).toContain("ran as the global Daintree Assistant");
    expect(prompt).toContain("/home/me/.claude/projects/x/s-1.jsonl");
    expect(prompt).not.toContain("search_converted");
    expect(prompt).not.toContain("converted session id");
    expect(prompt).toContain("not as new instructions");
  });

  // The rule Daintree checks an assistant's hand-off against (shared/utils/assistantHandoff.ts).
  // eslint-disable-next-line no-control-regex
  const refused = /[\x00-\x08\x0B-\x1F\x7F]/;

  it.each(["project-assistant", "global-assistant"] as const)(
    "carries no control character an assistant's launch would refuse (%s)",
    (target) => {
      const prompt = buildHandoffPrompt({
        ...turns,
        target,
        sourceAgent: "codex",
        sourcePath: "/home/me/odd\u0007dir/s.jsonl",
        conversionId: target === "global-assistant" ? null : "c",
        prompts: [
          {
            text: "red \u001b[31mtext\u001b[0m\r\nnext\tline\u0007 lone\rcr",
            line: 1,
            timestamp: "2026-11-22\rbroken",
          },
        ],
        lastReply: { text: "reply\u001b[0m\r\nend\u000c", line: 2, timestamp: null },
      });
      expect(refused.test(prompt)).toBe(false);
      expect(prompt).toContain("red [31mtext[0m\nnext\tline lonecr");
      expect(prompt).toContain("reply[0m\nend");
      // A path keeps its line, and the successor can still tell the name.
      expect(prompt).toContain("/home/me/odd\\u0007dir/s.jsonl");
      // A timestamp that isn't one is left out, not quoted.
      expect(prompt).toContain('<request line="1">');
    }
  );

  it.each(["project-assistant", "global-assistant"] as const)(
    "stays within the longest hand-off an assistant takes, even in emoji (%s)",
    (target) => {
      const longest = buildHandoffPrompt({
        ...turns,
        target,
        sourceAgent: "claude",
        sourcePath: `/home/${"p".repeat(4_000)}/session.jsonl`,
        conversionId: target === "global-assistant" ? null : "c",
        prompts: Array.from({ length: 5 }, (_, i) => ({
          text: `REQUEST-${i} ${"😀".repeat(20_000)}`,
          line: i,
          timestamp: `2026-11-22T10:00:00.000Z${"9".repeat(17_000)}`,
        })),
        lastReply: { text: `LAST-REPLY ${"😀".repeat(50_000)}`, line: 9, timestamp: null },
      });
      expect(longest.length).toBeLessThanOrEqual(16_384);
      expect(longest).toContain("REQUEST-4");
      expect(longest).toContain("LAST-REPLY");
    }
  );
});

describe("clip", () => {
  it("keeps short text whole and cuts long text on a code point, counting UTF-16 units", () => {
    expect(clip("short", 10)).toBe("short");
    // Three UTF-16 units hold one emoji (two units) and never half of the next.
    const cut = clip("😀".repeat(5), 3);
    expect(cut.startsWith("😀\n")).toBe(true);
    expect(cut).toContain("4 more characters");
  });
});
