// Project/App: GSD-2
// File Purpose: Behavior tests for auto-loop cleanup after paused provider exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupAfterLoopExit, rerootCommandSession, stopAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";

test("cleanupAfterLoopExit preserves paused auto badge after provider pause", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-cleanup-"));
  const previousCwd = process.cwd();
  const statuses: Array<[string, string | undefined]> = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = true;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M001");
  autoSession.originalBasePath = base;

  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statuses.push([key, value]);
        },
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(statuses.some(([key]) => key === "gsd-auto"), false);
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, true);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit clears status and widget when auto is not paused", async () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;

  try {
    await cleanupAfterLoopExit({
      hasUI: false,
      ui: {
        setStatus: (...args: unknown[]) => statusCalls.push(args),
        setWidget: (...args: unknown[]) => widgetCalls.push(args),
        notify: () => {},
      },
    } as any);

    assert.deepEqual(statusCalls, [["gsd-auto", undefined]]);
    assert.deepEqual(widgetCalls, [["gsd-progress", undefined]]);
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, false);
  } finally {
    autoSession.reset();
  }
});

test("rerootCommandSession refreshes command workspace to project root", async () => {
  const calls: string[] = [];
  const result = await rerootCommandSession(
    {
      newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
        calls.push(workspaceRoot);
        return { cancelled: false };
      },
    } as any,
    "/project/root",
  );

  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(calls, ["/project/root"]);
});

test("stopAuto completion closeout reroots session and preserves final widget", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-completion-stop-"));
  const previousCwd = process.cwd();
  const widgetCalls: Array<[string, unknown]> = [];
  const newSessionWorkspaces: string[] = [];
  const milestoneDir = join(base, ".gsd", "milestones", "M003");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M003-SUMMARY.md"), [
    "---",
    "id: M003",
    'title: "Budget tracking"',
    "status: complete",
    "key_decisions:",
    "  - Keep completion closeout in the same TUI surface.",
    "key_files:",
    "  - src/resources/extensions/gsd/auto-dashboard.ts",
    "lessons_learned:",
    "  - Milestone endings need report output, not auto-loop status.",
    "---",
    "",
    "# M003: Budget tracking",
    "",
    "**Added budget warning output and provider roll-up details.**",
    "",
    "## Success Criteria Results",
    "",
    "Budget warnings appear at milestone completion.",
    "",
    "## Definition of Done Results",
    "",
    "Completion leaves the report surface visible.",
    "",
    "## Requirement Outcomes",
    "",
    "Users can see what shipped without opening a fresh session.",
    "",
    "## Deviations",
    "",
    "None.",
    "",
    "## Follow-ups",
    "",
    "None.",
    "",
  ].join("\n"), "utf-8");

  autoSession.reset();
  openDatabase(join(base, "gsd-test.db"));
  insertMilestone({ id: "M003", title: "Budget tracking", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Complete slice", status: "complete", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Done slice", status: "done", sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M003", title: "Pending slice", status: "active", sequence: 3 });

  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M003");
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M003";
  autoSession.autoStartTime = Date.now() - 60_000;
  autoSession.cmdCtx = {
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      widgetCalls.push(["gsd-progress", undefined]);
      return { cancelled: false };
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 100, cacheRead: 900 },
          },
        },
      ],
    },
    getContextUsage: () => ({ percent: 0.9, contextWindow: 1_000_000 }),
    model: { contextWindow: 1_000_000 },
  } as any;

  try {
    await stopAuto(
      {
        hasUI: true,
        ui: {
          setStatus: () => {},
          setWidget: (key: string, value: unknown) => {
            widgetCalls.push([key, value]);
          },
          setHeader: () => {},
          notify: () => {},
        },
        modelRegistry: { find: () => null },
      } as any,
      { events: { emit: () => {} } } as any,
      "Milestone M003 complete",
      {
        completionWidget: {
          milestoneId: "M003",
          milestoneTitle: "Budget tracking",
        },
      },
    );

    assert.deepEqual(newSessionWorkspaces, [base], "completion stop must reroot command session to original project root");
    assert.ok(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && typeof value === "function"),
      "completion stop must install a final progress widget",
    );
    const lastProgressWidget = widgetCalls.filter(([key]) => key === "gsd-progress").at(-1);
    assert.equal(typeof lastProgressWidget?.[1], "function", "completion stop must leave the final progress widget installed after reroot");
    const factory = lastProgressWidget?.[1] as any;
    const component = factory(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    );
    const output = component.render(140).join("\n");
    assert.match(output, /Milestone M003 roll-up/);
    assert.match(output, /Outcome/);
    assert.match(output, /Added budget warning output/);
    assert.match(output, /Verification/);
    assert.match(output, /Files: src\/resources\/extensions\/gsd\/auto-dashboard\.ts/);
    assert.match(output, /Lessons: Milestone endings need report output/);
    assert.match(output, /2\/3 slices/);
    assert.doesNotMatch(output, /COMPLETE-MILESTONE/);
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
