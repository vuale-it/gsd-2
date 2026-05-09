/**
 * merge-conflict-stops-loop.test.ts — #2330
 *
 * When a squash merge has real code conflicts (not just .gsd/ files),
 * the merge used to retry forever because `MergeConflictError` was
 * caught silently in `mergeAndExit`. The fix:
 *
 *   1. `WorktreeResolver.mergeAndExit` **re-throws** `MergeConflictError`
 *      (and other unexpected errors) so the caller sees the failure.
 *   2. `auto/phases.ts` catches `MergeConflictError` from `mergeAndExit`
 *      and returns `{ action: "break", reason: "merge-conflict" }` +
 *      calls `stopAuto`, instead of looping.
 *
 * The previous version of this file was three source-grep assertions
 * (`src.includes("MergeConflictError")` / `src.includes("throw err")` /
 * `extractSourceRegion(..., "instanceof MergeConflictError").includes("stopAuto")`).
 * Those all pass even if the bug reappears verbatim — the catch block
 * could swallow the error silently as long as the identifier text
 * remains somewhere in the file. Called out in #4784 / #4824 as the
 * canonical source-grep false-coverage case.
 *
 * This rewrite tests the invariant at the `WorktreeResolver` layer
 * (where the re-throw happens) with injected deps: we wire
 * `mergeMilestoneToMain` to throw `MergeConflictError`, call
 * `mergeAndExit`, and assert the error propagates. That is the ONLY
 * assertion that fails if someone reverts the re-throw to a silent
 * catch.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorktreeLifecycle, type WorktreeLifecycleDeps } from "../worktree-lifecycle.ts";
import { WorktreeStateProjection } from "../worktree-state-projection.ts";
import { MergeConflictError } from "../git-service.ts";
import type { AutoSession } from "../auto/session.ts";

// Test-local: LegacyTestDeps had three fields Lifecycle does not need
// (shouldUseWorktreeIsolation, syncWorktreeStateBack, captureIntegrationBranch).
// Permit them in test fixtures so existing override patterns keep working —
// Lifecycle ignores the extras via structural typing.
type LegacyTestDeps = WorktreeLifecycleDeps & {
  shouldUseWorktreeIsolation?: () => boolean;
  syncWorktreeStateBack?: (
    mainBasePath: string,
    worktreePath: string,
    milestoneId: string,
  ) => { synced: string[] };
  captureIntegrationBranch?: (basePath: string, mid: string | undefined) => void;
};

/**
 * Shim factory preserving the legacy WorktreeResolver throw shape for
 * `mergeAndExit` so the existing assert.throws bodies migrate verbatim.
 */
function makeResolver(s: AutoSession, deps: LegacyTestDeps) {
  const lifecycle = new WorktreeLifecycle(s, deps);
  return {
    mergeAndExit: (mid: string, ctx: { notify: (msg: string, level?: "info" | "warning" | "error" | "success") => void }) => {
      const r = lifecycle.exitMilestone(mid, { merge: true }, ctx);
      if (!r.ok && r.cause instanceof Error) throw r.cause;
    },
  };
}

// ─── Test-only session double ───────────────────────────────────────────
// `AutoSession` is a large class but `WorktreeResolver` only reads a few
// fields from it (basePath, originalBasePath, currentMilestoneId).
function makeSession(basePath: string): AutoSession {
  return {
    basePath,
    originalBasePath: basePath,
    currentMilestoneId: "M001",
  } as unknown as AutoSession;
}

/**
 * Build a deps object where every method is a no-op or a controlled
 * value, except the ones the caller explicitly overrides. This is the
 * boring-tech approach — no mocking library, just plain objects.
 */
function makeDeps(
  overrides: Partial<LegacyTestDeps> = {},
): LegacyTestDeps {
  return {
    isInAutoWorktree: () => true,
    shouldUseWorktreeIsolation: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    syncWorktreeStateBack: () => ({ synced: [] }),
    teardownAutoWorktree: () => undefined,
    createAutoWorktree: () => "",
    enterAutoWorktree: () => "",
    enterBranchModeForMilestone: () => undefined,
    getAutoWorktreePath: () => null,
    autoCommitCurrentBranch: () => undefined,
    getCurrentBranch: () => "worktree/M001",
    checkoutBranch: () => undefined,
    autoWorktreeBranch: (mid: string) => `worktree/${mid}`,
    resolveMilestoneFile: () => null, // no roadmap → early return path
    readFileSync: () => "",
    GitServiceImpl: class {
      constructor(_basePath: string, _config: unknown) {}
    } as never,
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    invalidateAllCaches: () => undefined,
    captureIntegrationBranch: () => undefined,
    worktreeProjection: new WorktreeStateProjection(),
    ...overrides,
  };
}

function makeNotifyCtx(): {
  notify: (msg: string, level?: "info" | "warning" | "error" | "success") => void;
  calls: Array<{ msg: string; level?: string }>;
} {
  const calls: Array<{ msg: string; level?: string }> = [];
  return {
    notify: (msg, level) => {
      calls.push({ msg, level });
    },
    calls,
  };
}

describe("WorktreeResolver.mergeAndExit re-throws MergeConflictError (#2330)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "merge-conflict-stops-loop-"));
    // Fake out a milestone directory so mergeAndExit reaches mergeMilestoneToMain.
    mkdirSync(join(baseDir, ".gsd", "milestones", "M001"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("propagates MergeConflictError with conflicted file list", () => {
    const conflicted = ["src/feature.ts", "README.md"];
    const roadmapPath = join(baseDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    const deps = makeDeps({
      resolveMilestoneFile: (_base, _mid, type) =>
        type === "ROADMAP" ? roadmapPath : null,
      readFileSync: () => "# M001\n",
      mergeMilestoneToMain: () => {
        throw new MergeConflictError(conflicted, "squash", "worktree/M001", "main");
      },
    });

    const resolver = makeResolver(makeSession(baseDir), deps);
    const ctx = makeNotifyCtx();

    assert.throws(
      () => resolver.mergeAndExit("M001", ctx),
      (err: unknown) => {
        assert.ok(
          err instanceof MergeConflictError,
          `expected MergeConflictError, got: ${err}`,
        );
        assert.deepEqual(err.conflictedFiles, conflicted);
        assert.equal(err.strategy, "squash");
        assert.equal(err.branch, "worktree/M001");
        assert.equal(err.mainBranch, "main");
        return true;
      },
    );
  });

  test("propagates non-conflict errors too (#4380 — never swallow silently)", () => {
    const roadmapPath = join(baseDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    class FakePermError extends Error {}
    const deps = makeDeps({
      resolveMilestoneFile: (_base, _mid, type) =>
        type === "ROADMAP" ? roadmapPath : null,
      readFileSync: () => "# M001\n",
      mergeMilestoneToMain: () => {
        throw new FakePermError("EACCES: permission denied");
      },
    });

    const resolver = makeResolver(makeSession(baseDir), deps);
    const ctx = makeNotifyCtx();

    assert.throws(
      () => resolver.mergeAndExit("M001", ctx),
      (err: unknown) => {
        assert.ok(
          err instanceof FakePermError,
          `expected FakePermError, got: ${err}`,
        );
        return true;
      },
    );
  });

  test("successful merge does not throw", () => {
    const roadmapPath = join(baseDir, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    const deps = makeDeps({
      resolveMilestoneFile: (_base, _mid, type) =>
        type === "ROADMAP" ? roadmapPath : null,
      readFileSync: () => "# M001\n",
      mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    });

    const resolver = makeResolver(makeSession(baseDir), deps);
    const ctx = makeNotifyCtx();

    // Should not throw — the success path.
    assert.doesNotThrow(() => resolver.mergeAndExit("M001", ctx));
  });
});

// ─── phases.ts handler contract ──────────────────────────────────────────
//
// The inline handler at `auto/phases.ts:580-598 / 695-712 / 823-840`:
//
//   if (mergeErr instanceof MergeConflictError) {
//     ctx.ui.notify(`Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. ...`);
//     await deps.stopAuto(...);
//     return { action: "break", reason: "merge-conflict" };
//   }
//
// Testing it end-to-end requires constructing a full `IterationContext`
// + `LoopState` + `deps` surface (hundreds of fields). Extracting the
// handler into a reusable helper is the right refactor and is tracked
// alongside this issue. In the meantime, defend the contract between
// the thrower and the handler: if the fields the handler formats drift,
// the handler silently regresses.

describe("Merge-conflict handler contract (#2330 — phases.ts inline pattern)", () => {
  test("MergeConflictError exposes fields the phases.ts handler formats", () => {
    const err = new MergeConflictError(
      ["a.ts", "b.ts"],
      "squash",
      "worktree/M001",
      "main",
    );
    assert.deepEqual(err.conflictedFiles, ["a.ts", "b.ts"]);
    assert.equal(err.strategy, "squash");
    assert.equal(err.branch, "worktree/M001");
    assert.equal(err.mainBranch, "main");
    // instanceof is the type-discriminant the handler uses.
    assert.ok(err instanceof MergeConflictError);
    // The class extends Error so the non-conflict fallback message path
    // (`String(mergeErr)` / `mergeErr.message`) still works.
    assert.ok(err instanceof Error);
    assert.match(err.message, /worktree\/M001/);
    assert.match(err.message, /main/);
  });

  test("MergeConflictError with empty conflicted list still serializes (edge)", () => {
    // The handler's `conflictedFiles.join(", ")` must not crash on empty
    // list. Defensive: some producers could legitimately emit a
    // zero-length array.
    const err = new MergeConflictError([], "merge", "feature/x", "main");
    assert.deepEqual(err.conflictedFiles, []);
    assert.equal(err.conflictedFiles.join(", "), "");
    assert.ok(err instanceof MergeConflictError);
  });
});
