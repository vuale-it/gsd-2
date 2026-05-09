// GSD-2 — Worktree Lifecycle module: owns milestone entry/exit lifecycle behind a small, typed Interface.
/**
 * Worktree Lifecycle module — first-class Module for worktree create/enter/exit/merge.
 *
 * Per ADR-016, this Module is the sole owner of:
 *   - `s.basePath` mutation across the session
 *   - `process.chdir()` discipline for worktree transitions (delegated to
 *     `enterAutoWorktree`/`createAutoWorktree`, which chdir internally)
 *   - milestone lease coordination (claim/refresh/release fencing tokens)
 *
 * Phase 1 of the migration ships only `enterMilestone`. The remaining verbs
 * (`exitMilestone`, `degradeToBranchMode`, `restoreToProjectRoot`, queries) are
 * extracted from `WorktreeResolver` in subsequent slices.
 *
 * The implementation lives in `_enterMilestoneCore` so `WorktreeResolver` can
 * call the same body during its internal `mergeAndEnterNext` recursion without
 * a circular reference. Both classes share the body until the Resolver retires.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AutoSession } from "./auto/session.js";
import { debugLog } from "./debug-logger.js";
import { emitJournalEvent } from "./journal.js";
import { emitWorktreeCreated, emitWorktreeMerged } from "./worktree-telemetry.js";
import {
  resolveWorktreeProjectRoot,
  normalizeWorktreePathForCompare,
} from "./worktree-root.js";
import {
  claimMilestoneLease,
  refreshMilestoneLease,
  releaseMilestoneLease,
} from "./db/milestone-leases.js";
import { MergeConflictError } from "./git-service.js";
import {
  getCollapseCadence,
  getMilestoneResquash,
  resquashMilestoneOnMain,
} from "./slice-cadence.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import type { WorktreeStateProjection } from "./worktree-state-projection.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface NotifyCtx {
  notify: (
    msg: string,
    level?: "info" | "warning" | "error" | "success",
  ) => void;
}

/**
 * Dependencies the Worktree Lifecycle Module needs from auto-mode wiring.
 *
 * Structurally a subset of `WorktreeResolverDeps`. `WorktreeResolver` can pass
 * its own deps where these are expected — TypeScript's structural typing
 * handles the narrowing.
 *
 * TODO(#5586): collapse this to the ADR target dep set after the resolver
 * recursion retires; shrinking it now would force a parallel migration.
 */
export interface WorktreeLifecycleDeps {
  // ── Entry / branch-mode setup ────────────────────────────────────────
  enterAutoWorktree: (basePath: string, milestoneId: string) => string;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  enterBranchModeForMilestone: (basePath: string, milestoneId: string) => void;
  getAutoWorktreePath: (basePath: string, milestoneId: string) => string | null;
  getIsolationMode: (basePath?: string) => "worktree" | "branch" | "none";

  // ── Cache + git service rebuild ──────────────────────────────────────
  invalidateAllCaches: () => void;
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;
  loadEffectiveGSDPreferences: () =>
    | { preferences?: { git?: Record<string, unknown> } }
    | undefined;

  // ── State Projection Module (ADR-016 one-way edge) ───────────────────
  /**
   * State Projection Module called by Lifecycle on enter/exit transitions.
   * Per ADR-016 the dependency direction is one-way: Lifecycle → Projection.
   */
  worktreeProjection: WorktreeStateProjection;

  // ── Exit / merge / teardown ──────────────────────────────────────────
  isInAutoWorktree: (basePath: string) => boolean;
  autoCommitCurrentBranch: (
    basePath: string,
    reason: string,
    milestoneId: string,
  ) => void;
  autoWorktreeBranch: (milestoneId: string) => string;
  teardownAutoWorktree: (
    basePath: string,
    milestoneId: string,
    opts?: { preserveBranch?: boolean },
  ) => void;
  mergeMilestoneToMain: (
    basePath: string,
    milestoneId: string,
    roadmapContent: string,
  ) => { pushed: boolean; codeFilesChanged: boolean };
  getCurrentBranch: (basePath: string) => string;
  /**
   * Force-checkout the named branch in `basePath`. Required by the branch-mode
   * merge path when HEAD has been moved off the milestone branch — silently
   * skipping the merge would strand the milestone's commits.
   */
  checkoutBranch: (basePath: string, branch: string) => void;
  resolveMilestoneFile: (
    basePath: string,
    milestoneId: string,
    fileType: string,
  ) => string | null;
  /**
   * Roadmap file reader. Injected so unit tests can substitute fixture
   * content without touching the filesystem; production wiring passes
   * `node:fs.readFileSync`.
   */
  readFileSync: (path: string, encoding: string) => string;
}

/**
 * Internal sentinel — thrown by `_mergeBranchMode` when it has already
 * emitted a user-visible error. The outer `mergeAndExit` catches the type
 * and skips its own warning toast to avoid duplicate notifications.
 */
class UserNotifiedError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "UserNotifiedError";
    this.cause = cause;
  }
}

/**
 * Compare two paths for physical identity, tolerating trailing slashes,
 * symlink differences, and case variations on case-insensitive volumes.
 *
 * Used in place of string `===` / `!==` wherever one operand may be
 * realpath-normalised and the other may not be (e.g. raw caller-supplied
 * basePath vs. realpath-normalised projectRoot).
 */
function isSamePathPhysical(a: string, b: string): boolean {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}

export type EnterResult =
  | { ok: true; mode: "worktree" | "branch" | "none"; path: string }
  | {
      ok: false;
      reason:
        | "isolation-degraded"
        | "lease-conflict"
        | "creation-failed"
        | "invalid-milestone-id";
      cause?: unknown;
    };

export type ExitResult =
  | { ok: true; merged: boolean; codeFilesChanged: boolean }
  | { ok: false; reason: "merge-conflict" | "teardown-failed"; cause?: unknown };

// ─── Validation ──────────────────────────────────────────────────────────

function isValidMilestoneId(milestoneId: string): boolean {
  return !/[\/\\]|\.\./.test(milestoneId);
}

function invalidMilestoneIdError(milestoneId: string): Error {
  return new Error(
    `Invalid milestoneId: ${milestoneId} — contains path separators or traversal`,
  );
}

/**
 * Throwing variant used by the merge/exit paths that surface failures via
 * the typed `ExitResult` (callers wrap the throw → cause). The enter path
 * uses `isValidMilestoneId` + the typed result directly.
 */
function validateMilestoneId(milestoneId: string): void {
  if (!isValidMilestoneId(milestoneId)) {
    throw invalidMilestoneIdError(milestoneId);
  }
}

// ─── Implementation core ─────────────────────────────────────────────────

/**
 * Shared implementation of milestone entry. Called by both
 * `WorktreeLifecycle.enterMilestone` and the legacy
 * `WorktreeResolver.mergeAndEnterNext` internal recursion until the Resolver
 * retires (slice #5587).
 *
 * Side effects (preserved from the original `WorktreeResolver.enterMilestone`):
 *   - mutates `s.milestoneLeaseToken` on lease claim/release/refresh
 *   - mutates `s.basePath` on successful worktree entry
 *   - mutates `s.gitService` (rebuilt against the new base path)
 *   - mutates `s.isolationDegraded` on hard failure of branch/worktree setup
 *   - emits journal events: worktree-skip, worktree-enter, worktree-create-failed
 *   - emits worktree-created telemetry on successful entry
 *   - notifies the caller via `ctx.notify` for every user-visible outcome
 */
export function _enterMilestoneCore(
  s: AutoSession,
  deps: WorktreeLifecycleDeps,
  milestoneId: string,
  ctx: NotifyCtx,
): EnterResult {
  if (!isValidMilestoneId(milestoneId)) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      rejected: "invalid-milestone-id",
    });
    return {
      ok: false,
      reason: "invalid-milestone-id",
      cause: invalidMilestoneIdError(milestoneId),
    };
  }

  if (s.isolationDegraded) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      skipped: true,
      reason: "isolation-degraded",
    });
    return { ok: false, reason: "isolation-degraded" };
  }

  // Phase B: claim a milestone lease before any worktree mutation. Two
  // workers cannot enter the same milestone concurrently. Best-effort:
  // skip if no worker registered (single-worker fallback) or DB
  // unavailable; reuse existing lease if we already hold it on this
  // milestone (re-entry within the same session).
  if (s.workerId) {
    if (
      s.currentMilestoneId === milestoneId &&
      s.milestoneLeaseToken !== null
    ) {
      const refreshed = refreshMilestoneLease(
        s.workerId,
        milestoneId,
        s.milestoneLeaseToken,
      );
      if (refreshed) {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          leaseRefreshed: true,
          fencingToken: s.milestoneLeaseToken,
        });
      } else {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          staleLeaseToken: s.milestoneLeaseToken,
        });
        s.milestoneLeaseToken = null;
      }
    }

    // If we held a different milestone, release it first so other
    // workers don't have to wait for TTL.
    if (
      s.currentMilestoneId &&
      s.currentMilestoneId !== milestoneId &&
      s.milestoneLeaseToken !== null
    ) {
      try {
        releaseMilestoneLease(
          s.workerId,
          s.currentMilestoneId,
          s.milestoneLeaseToken,
        );
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          releasePriorLeaseError:
            err instanceof Error ? err.message : String(err),
        });
      }
      s.milestoneLeaseToken = null;
    }

    if (s.milestoneLeaseToken === null) {
      try {
        const claim = claimMilestoneLease(s.workerId, milestoneId);
        if (claim.ok) {
          s.milestoneLeaseToken = claim.token;
          debugLog("WorktreeLifecycle", {
            action: "enterMilestone",
            milestoneId,
            leaseAcquired: true,
            fencingToken: claim.token,
            expiresAt: claim.expiresAt,
          });
        } else {
          // Lease held by another worker — fail loud so the user can
          // see the conflict instead of silently double-running.
          const msg = `Milestone ${milestoneId} is held by worker ${claim.byWorker} until ${claim.expiresAt}.`;
          debugLog("WorktreeLifecycle", {
            action: "enterMilestone",
            milestoneId,
            leaseHeldByOther: claim.byWorker,
            expiresAt: claim.expiresAt,
          });
          ctx.notify(
            `${msg} Another auto-mode worker is active. Stop it before entering ${milestoneId}.`,
            "error",
          );
          return { ok: false, reason: "lease-conflict" };
        }
      } catch (err) {
        // DB unavailable or other error — log and fall through to the
        // pre-Phase-B single-worker behavior so a fresh project before
        // DB init still works.
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          leaseError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Resolve the project root for worktree operations via shared helper.
  // Handles the case where originalBasePath is falsy and basePath is itself
  // a worktree path — prevents double-nested worktree paths (#3729).
  const basePath = resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
  const mode = deps.getIsolationMode(basePath);

  if (mode === "none") {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      skipped: true,
      reason: "isolation-disabled",
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: new Date().toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-skip",
      data: { milestoneId, reason: "isolation-disabled" },
    });
    return { ok: true, mode: "none", path: basePath };
  }

  debugLog("WorktreeLifecycle", {
    action: "enterMilestone",
    milestoneId,
    mode,
    basePath,
  });

  if (
    mode === "worktree" &&
    s.currentMilestoneId === milestoneId &&
    s.basePath !== basePath
  ) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      mode: "worktree",
      result: "already-entered",
      wtPath: s.basePath,
    });
    return { ok: true, mode: "worktree", path: s.basePath };
  }

  // ── Branch mode: create/checkout milestone branch, stay in project root ──
  if (mode === "branch") {
    try {
      deps.enterBranchModeForMilestone(basePath, milestoneId);
      // basePath does not change — no worktree, no chdir.
      // Rebuild GitService so the new HEAD is reflected, then flush any
      // path-keyed caches that may have been populated before the checkout.
      rebuildGitService(s, deps);
      deps.invalidateAllCaches();
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        milestoneId,
        mode: "branch",
        result: "success",
      });
      emitJournalEvent(basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-skip",
        data: { milestoneId, reason: "branch-mode-no-worktree" },
      });
      ctx.notify(`Switched to branch milestone/${milestoneId}.`, "info");
      return { ok: true, mode: "branch", path: basePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        milestoneId,
        mode: "branch",
        result: "error",
        error: msg,
      });
      ctx.notify(
        `Branch isolation setup for ${milestoneId} failed: ${msg}. Continuing on current branch.`,
        "warning",
      );
      s.isolationDegraded = true;
      return { ok: false, reason: "creation-failed", cause: err };
    }
  }

  // ── Worktree mode ────────────────────────────────────────────────────────
  try {
    const existingPath = deps.getAutoWorktreePath(basePath, milestoneId);
    let wtPath: string;

    if (existingPath) {
      wtPath = deps.enterAutoWorktree(basePath, milestoneId);
    } else {
      wtPath = deps.createAutoWorktree(basePath, milestoneId);
    }

    s.basePath = wtPath;
    rebuildGitService(s, deps);
    deps.invalidateAllCaches();

    // Per ADR-016: Lifecycle calls Projection on entry, before any Unit
    // dispatches. Build a temporary scope from the new basePath; callers may
    // later set s.scope via their own rebuildScope hook (the two are
    // independent — this scope is only used to drive the projection rules).
    try {
      const enterScope = scopeMilestone(createWorkspace(wtPath), milestoneId);
      deps.worktreeProjection.projectRootToWorktree(enterScope);
    } catch (projErr) {
      // Non-fatal: projection failures must not block worktree entry.
      // The pre-dispatch path in auto/phases.ts performs the same projection
      // on every iteration, so a transient failure here self-heals on the
      // next loop pass.
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        phase: "projection-on-enter",
        error: projErr instanceof Error ? projErr.message : String(projErr),
      });
    }

    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      result: "success",
      wtPath,
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: new Date().toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-enter",
      data: { milestoneId, wtPath, created: !existingPath },
    });
    // #4764 — record creation/enter as a lifecycle event so the telemetry
    // aggregator can pair it with the eventual worktree-merged event.
    try {
      emitWorktreeCreated(s.originalBasePath || s.basePath, milestoneId, {
        reason: existingPath ? "enter-milestone" : "create-milestone",
      });
    } catch (telemetryErr) {
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        phase: "telemetry-emit",
        error:
          telemetryErr instanceof Error
            ? telemetryErr.message
            : String(telemetryErr),
      });
    }
    ctx.notify(`Entered worktree for ${milestoneId} at ${wtPath}`, "info");
    return { ok: true, mode: "worktree", path: wtPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      result: "error",
      error: msg,
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: new Date().toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-create-failed",
      data: { milestoneId, error: msg, fallback: "project-root" },
    });
    ctx.notify(
      `Auto-worktree creation for ${milestoneId} failed: ${msg}. Continuing in project root.`,
      "warning",
    );
    // Degrade isolation for the rest of this session so mergeAndExit
    // doesn't try to merge a nonexistent worktree branch (#2483)
    s.isolationDegraded = true;
    // Do NOT update s.basePath — stay in project root
    return { ok: false, reason: "creation-failed", cause: err };
  }
}

function rebuildGitService(
  s: AutoSession,
  deps: WorktreeLifecycleDeps,
): void {
  const gitConfig =
    deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  s.gitService = new deps.GitServiceImpl(
    s.basePath,
    gitConfig,
  ) as AutoSession["gitService"];
}

// ─── Module class ────────────────────────────────────────────────────────

/**
 * Worktree Lifecycle module instance.
 *
 * Constructed once per auto-mode session. Holds the session reference so
 * verbs can mutate `s.basePath` and related coordination state directly
 * without round-tripping through callers.
 */
export class WorktreeLifecycle {
  private readonly s: AutoSession;
  private readonly deps: WorktreeLifecycleDeps;

  constructor(s: AutoSession, deps: WorktreeLifecycleDeps) {
    this.s = s;
    this.deps = deps;
  }

  /**
   * Enter or create the auto-worktree for `milestoneId`. Idempotent if
   * already in this milestone (lease refreshed; basePath unchanged).
   *
   * Returns a typed `EnterResult` describing the outcome. Callers may
   * ignore the result if they read `s.basePath` directly afterwards
   * (legacy behaviour); new callers should branch on the result.
   */
  enterMilestone(milestoneId: string, ctx: NotifyCtx): EnterResult {
    return _enterMilestoneCore(this.s, this.deps, milestoneId, ctx);
  }

  /**
   * Exit the current worktree. With `opts.merge === true`, runs the full
   * merge-and-teardown path (worktree-mode or branch-mode auto-detected).
   * With `opts.merge === false`, runs auto-commit and teardown without
   * merging to main.
   *
   * Returns a typed `ExitResult`. `MergeConflictError` is surfaced as
   * `{ ok: false, reason: "merge-conflict", cause }` instead of thrown,
   * giving callers a typed branch for the expected failure path.
   * Unexpected failures (filesystem, git permissions, etc.) are wrapped
   * as `{ ok: false, reason: "teardown-failed", cause }` so callers always
   * receive a discriminated union — no exceptions for any expected outcome.
   */
  exitMilestone(
    milestoneId: string,
    opts: { merge: boolean; preserveBranch?: boolean },
    ctx: NotifyCtx,
  ): ExitResult {
    if (opts.merge) {
      try {
        const merged = this._mergeAndExit(milestoneId, ctx);
        return { ok: true, merged, codeFilesChanged: false };
      } catch (err) {
        if (err instanceof MergeConflictError) {
          return { ok: false, reason: "merge-conflict", cause: err };
        }
        return { ok: false, reason: "teardown-failed", cause: err };
      }
    }
    try {
      this._exitWithoutMerge(milestoneId, ctx, {
        preserveBranch: opts.preserveBranch,
      });
      return { ok: true, merged: false, codeFilesChanged: false };
    } catch (err) {
      return { ok: false, reason: "teardown-failed", cause: err };
    }
  }

  /**
   * Milestone transition: merge the current milestone, then enter the next
   * one. Pattern used when the loop detects that the active milestone has
   * changed (current completed, next is now active). Caller is responsible
   * for re-deriving state between the merge and the enter.
   */
  mergeAndEnterNext(
    currentMilestoneId: string,
    nextMilestoneId: string,
    ctx: NotifyCtx,
  ): void {
    debugLog("WorktreeLifecycle", {
      action: "mergeAndEnterNext",
      currentMilestoneId,
      nextMilestoneId,
    });
    let merged = false;
    let mergeThrew = false;
    try {
      merged = this._mergeAndExit(currentMilestoneId, ctx);
    } catch (err) {
      if (err instanceof UserNotifiedError) throw err;
      mergeThrew = true;
      // _mergeAndExit emits a warning and restores state on failure during
      // merge/cleanup. If it throws before recovery runs (e.g. validation,
      // emitJournalEvent), basePath isn't restored — re-throw so we don't
      // enter the next milestone with the current one unmerged.
      const projectRoot = resolveWorktreeProjectRoot(
        this.s.basePath,
        this.s.originalBasePath,
      );
      if (this.s.basePath !== projectRoot) throw err;
      // Otherwise: merge attempted, failed cleanly with state restored.
      // The loop intentionally continues to the next milestone — the
      // failed milestone's branch is preserved for manual recovery.
    }
    if (!merged && !mergeThrew && !this.s.isolationDegraded) {
      // _mergeAndExit returned without attempting a merge (no roadmap
      // → preserveBranch path) and state is restored. The current
      // milestone was deliberately NOT merged; halt before entering the
      // next so we don't silently strand commits on the preserved
      // branch. (#5602 halt-on-no-merge regression coverage.)
      //
      // mergeThrew=true means a merge was attempted but failed — that
      // path proceeds (existing test "enters next even if merge fails").
      // isolationDegraded=true means the loop intentionally continues
      // without merging — that path proceeds too.
      throw new Error(
        `Cannot enter milestone ${nextMilestoneId} because ${currentMilestoneId} was not merged`,
      );
    }
    _enterMilestoneCore(this.s, this.deps, nextMilestoneId, ctx);
  }

  // ── Private — exit without merge ─────────────────────────────────────

  private _exitWithoutMerge(
    milestoneId: string,
    ctx: NotifyCtx,
    opts: { preserveBranch?: boolean },
  ): void {
    validateMilestoneId(milestoneId);
    if (!this.deps.isInAutoWorktree(this.s.basePath)) {
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        skipped: true,
        reason: "not-in-worktree",
      });
      return;
    }

    debugLog("WorktreeLifecycle", {
      action: "exitMilestone",
      milestoneId,
      basePath: this.s.basePath,
    });

    try {
      this.deps.autoCommitCurrentBranch(this.s.basePath, "stop", milestoneId);
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        phase: "auto-commit-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.notify(
        `Auto-commit before exiting ${milestoneId} failed: ${err instanceof Error ? err.message : String(err)}. Branch ${this.deps.autoWorktreeBranch(milestoneId)} is preserved for recovery.`,
        "warning",
      );
    }

    if (this.s.originalBasePath) {
      try {
        process.chdir(this.s.originalBasePath);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "exitMilestone",
          milestoneId,
          phase: "pre-teardown-chdir-failed",
          originalBasePath: this.s.originalBasePath,
          error: err instanceof Error ? err.message : String(err),
        });
        ctx.notify(
          `Could not leave milestone worktree before cleanup: ${err instanceof Error ? err.message : String(err)}. Branch ${this.deps.autoWorktreeBranch(milestoneId)} is preserved for recovery.`,
          "warning",
        );
      }
    }

    let teardownFailed = false;
    try {
      this.deps.teardownAutoWorktree(this.s.originalBasePath, milestoneId, {
        preserveBranch: opts.preserveBranch ?? false,
      });
    } catch (err) {
      teardownFailed = true;
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        phase: "teardown-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.notify(
        `Worktree cleanup failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}. Branch ${this.deps.autoWorktreeBranch(milestoneId)} is preserved for recovery.`,
        "warning",
      );
    }

    this.restoreToProjectRoot();
    debugLog("WorktreeLifecycle", {
      action: "exitMilestone",
      milestoneId,
      result: "done",
      basePath: this.s.basePath,
    });
    ctx.notify(
      teardownFailed
        ? `Worktree exit for ${milestoneId} needs manual cleanup.`
        : `Exited worktree for ${milestoneId}`,
      teardownFailed ? "warning" : "info",
    );
  }

  // ── Private — merge and exit (worktree-mode or branch-mode) ──────────

  /**
   * Merge the completed milestone branch back to main and exit the worktree.
   *
   * - **worktree mode**: reads the roadmap, runs squash merge, projects
   *   final state back via Projection.finalizeProjectionForMerge, tears
   *   down the worktree, restores `s.basePath`. Falls back to bare
   *   teardown (preserving the branch) if no roadmap exists.
   * - **branch mode**: validates HEAD is on the milestone branch (recovers
   *   via checkout if not), merges, rebuilds GitService.
   * - **none**: no-op unless physically inside an auto-worktree (#2625).
   *
   * Returns true when an actual squash-merge ran. Throws MergeConflictError
   * (and other non-recoverable errors) for callers to handle.
   */
  private _mergeAndExit(milestoneId: string, ctx: NotifyCtx): boolean {
    validateMilestoneId(milestoneId);

    // Anchor cwd at the project root before any merge work. Some merge
    // paths (mergeMilestoneToMain, slice-cadence) chdir explicitly; others
    // (branch-mode, isolation-degraded skip) do not. If the worktree dir
    // is later torn down while cwd still points into it, every subsequent
    // process.cwd() throws ENOENT — which after de73fb43d surfaces as a
    // session-failed cancel and (in headless mode) terminates the whole
    // gsd process. Best-effort: silent on failure so synthetic test paths
    // still pass.
    if (this.s.originalBasePath) {
      try {
        process.chdir(this.s.originalBasePath);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          phase: "pre-merge-chdir-failed",
          milestoneId,
          originalBasePath: this.s.originalBasePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // #4764 — telemetry: record start timestamp so we can emit merge duration.
    const mergeStartedAt = new Date().toISOString();
    const mergeStartMs = Date.now();

    if (this.s.isolationDegraded) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        skipped: true,
        reason: "isolation-degraded",
      });
      ctx.notify(
        `Skipping worktree merge for ${milestoneId} — isolation was degraded (worktree creation failed earlier). Work is on the current branch.`,
        "info",
      );
      return false;
    }

    const mode = this.deps.getIsolationMode(
      this.s.originalBasePath || this.s.basePath,
    );
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      mode,
      basePath: this.s.basePath,
    });
    emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
      ts: new Date().toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-merge-start",
      data: { milestoneId, mode },
    });

    // #2625: If we are physically inside an auto-worktree, we MUST merge
    // regardless of the current isolation config. This prevents data loss
    // when the default isolation mode changes between versions.
    const inWorktree =
      this.deps.isInAutoWorktree(this.s.basePath) && this.s.originalBasePath;

    if (mode === "none" && !inWorktree) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        skipped: true,
        reason: "mode-none",
      });
      return false;
    }

    let actuallyMerged = false;
    if (mode === "worktree" || inWorktree) {
      actuallyMerged = this._mergeWorktreeMode(milestoneId, ctx);
    } else if (mode === "branch") {
      actuallyMerged = this._mergeBranchMode(milestoneId, ctx);
    }

    if (!actuallyMerged) {
      this.s.milestoneStartShas.delete(milestoneId);
      return false;
    }

    // #4765 — when collapse_cadence=slice AND milestone_resquash=true, the
    // N per-slice commits on main should be collapsed into one milestone
    // commit. Done AFTER the primary merge-and-teardown so the branch and
    // worktree are already cleaned up; we operate on main directly.
    try {
      const startSha = this.s.milestoneStartShas.get(milestoneId);
      if (startSha) {
        const prefs = loadEffectiveGSDPreferences(
          this.s.originalBasePath || this.s.basePath,
        )?.preferences;
        if (
          getCollapseCadence(prefs) === "slice" &&
          getMilestoneResquash(prefs)
        ) {
          const result = resquashMilestoneOnMain(
            this.s.originalBasePath || this.s.basePath,
            milestoneId,
            startSha,
          );
          if (result.resquashed) {
            ctx.notify(
              `slice-cadence: re-squashed slice commits for ${milestoneId} into a single milestone commit.`,
              "info",
            );
          }
        }
        this.s.milestoneStartShas.delete(milestoneId);
      }
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        phase: "resquash",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // #4764 — record merge completion. Only reaches here when an actual
    // merge ran; failure paths throw out before this point.
    try {
      emitWorktreeMerged(
        this.s.originalBasePath || this.s.basePath,
        milestoneId,
        {
          reason: "milestone-complete",
          startedAt: mergeStartedAt,
          durationMs: Date.now() - mergeStartMs,
        },
      );
    } catch (telemetryErr) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        phase: "telemetry-emit",
        error:
          telemetryErr instanceof Error
            ? telemetryErr.message
            : String(telemetryErr),
      });
    }
    return true;
  }

  /** Worktree-mode merge body. Returns true when an actual squash-merge ran. */
  private _mergeWorktreeMode(milestoneId: string, ctx: NotifyCtx): boolean {
    const originalBase = this.s.originalBasePath;
    if (!originalBase) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        mode: "worktree",
        skipped: true,
        reason: "missing-original-base",
      });
      return false;
    }

    let merged = false;
    try {
      // ADR-016: final projection before teardown. Replaces the legacy
      // syncWorktreeStateBack(originalBase, basePath, milestoneId) call.
      const finalScope = scopeMilestone(
        createWorkspace(this.s.basePath),
        milestoneId,
      );
      const { synced } =
        this.deps.worktreeProjection.finalizeProjectionForMerge(finalScope);
      if (synced.length > 0) {
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          milestoneId,
          phase: "reverse-sync",
          synced: synced.length,
        });
      }

      // Resolve roadmap — try project root first, then worktree path as
      // fallback. The worktree may hold the only copy when state-back
      // projection silently dropped it or .gsd/ is not symlinked. Without
      // the fallback, a missing roadmap triggers bare teardown which
      // deletes the branch and orphans all milestone commits (#1573).
      let roadmapPath = this.deps.resolveMilestoneFile(
        originalBase,
        milestoneId,
        "ROADMAP",
      );
      if (
        !roadmapPath &&
        !isSamePathPhysical(this.s.basePath, originalBase)
      ) {
        roadmapPath = this.deps.resolveMilestoneFile(
          this.s.basePath,
          milestoneId,
          "ROADMAP",
        );
        if (roadmapPath) {
          debugLog("WorktreeLifecycle", {
            action: "mergeAndExit",
            milestoneId,
            phase: "roadmap-fallback",
            note: "resolved from worktree path",
          });
        }
      }

      if (roadmapPath) {
        const roadmapContent = this.deps.readFileSync(roadmapPath, "utf-8");
        const mergeResult = this.deps.mergeMilestoneToMain(
          originalBase,
          milestoneId,
          roadmapContent,
        );
        merged = true;

        // #2945 Bug 3: mergeMilestoneToMain performs best-effort worktree
        // cleanup internally (step 12), but it can silently fail on Windows
        // or when the worktree directory is locked. Perform a secondary
        // teardown here to ensure the worktree is properly cleaned up.
        // Idempotent — if already removed, teardownAutoWorktree no-ops.
        try {
          this.deps.teardownAutoWorktree(originalBase, milestoneId);
        } catch {
          // Best-effort — primary cleanup in mergeMilestoneToMain may have
          // already removed the worktree.
        }

        if (mergeResult.codeFilesChanged) {
          ctx.notify(
            `Milestone ${milestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
            "info",
          );
        } else {
          // #1906 — milestone produced only .gsd/ metadata. Surface
          // clearly so the user knows the milestone is not truly complete.
          ctx.notify(
            `WARNING: Milestone ${milestoneId} merged to main but contained NO code changes — only .gsd/ metadata files. ` +
              `The milestone summary may describe planned work that was never implemented. ` +
              `Review the milestone output and re-run if code is missing.`,
            "warning",
          );
        }
      } else {
        // No roadmap at either location — teardown but PRESERVE the branch
        // so commits are not orphaned (#1573).
        this.deps.teardownAutoWorktree(originalBase, milestoneId, {
          preserveBranch: true,
        });
        ctx.notify(
          `Exited worktree for ${milestoneId} (no roadmap found — branch preserved for manual merge).`,
          "warning",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        result: "error",
        error: msg,
        fallback: "chdir-to-project-root",
      });
      emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-merge-failed",
        data: { milestoneId, error: msg },
      });
      // Surface a clear, actionable error. Worktree and milestone branch
      // are intentionally preserved — nothing has been deleted. User can
      // retry /gsd dispatch complete-milestone or merge manually once the
      // underlying issue is fixed (#1668, #1891).
      ctx.notify(
        `Milestone merge failed: ${msg}. Your worktree and milestone branch are preserved — retry with \`/gsd dispatch complete-milestone\` or merge manually.`,
        "warning",
      );

      // Clean up stale merge state left by failed squash-merge (#1389)
      try {
        const gitDir = join(originalBase || this.s.basePath, ".git");
        for (const f of ["SQUASH_MSG", "MERGE_HEAD", "MERGE_MSG"]) {
          const p = join(gitDir, f);
          if (existsSync(p)) unlinkSync(p);
        }
      } catch {
        /* best-effort */
      }

      // Error recovery: always restore to project root
      if (originalBase) {
        try {
          process.chdir(originalBase);
        } catch {
          /* best-effort */
        }
      }

      // Restore state before re-throwing so callers always get a
      // consistent session (#4380).
      this.restoreToProjectRoot();
      // Re-throw: MergeConflictError stops the auto loop (#2330);
      // non-conflict errors must also propagate so broken states are
      // diagnosable (#4380).
      throw err;
    }

    // Always restore basePath and rebuild — whether merge succeeded or failed
    this.restoreToProjectRoot();
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      result: "done",
      basePath: this.s.basePath,
    });
    return merged;
  }

  /** Branch-mode merge body. Returns true when a merge actually ran. */
  private _mergeBranchMode(milestoneId: string, ctx: NotifyCtx): boolean {
    try {
      const currentBranch = this.deps.getCurrentBranch(this.s.basePath);
      const milestoneBranch = this.deps.autoWorktreeBranch(milestoneId);

      if (currentBranch !== milestoneBranch) {
        // #5538-followup: previous behaviour was to silently `return false`
        // when HEAD wasn't on the milestone branch — that let the loop
        // advance with the milestone's commits stranded on the branch.
        // Attempt recovery by force-checking-out the milestone branch; if
        // that fails, throw so the caller pauses auto-mode and the user
        // sees the failure instead of a silent merge skip.
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          milestoneId,
          mode: "branch",
          recovery: "checkout-milestone-branch",
          currentBranch,
          milestoneBranch,
        });
        try {
          this.deps.checkoutBranch(this.s.basePath, milestoneBranch);
        } catch (checkoutErr) {
          const checkoutMsg =
            checkoutErr instanceof Error
              ? checkoutErr.message
              : String(checkoutErr);
          ctx.notify(
            `Cannot merge milestone ${milestoneId}: working tree is on ${currentBranch} and checkout to ${milestoneBranch} failed (${checkoutMsg}). Resolve manually and run /gsd auto to resume.`,
            "error",
          );
          throw new UserNotifiedError(checkoutMsg, checkoutErr);
        }

        const reverify = this.deps.getCurrentBranch(this.s.basePath);
        if (reverify !== milestoneBranch) {
          const reverifyMsg = `branch checkout to ${milestoneBranch} reported success but current branch is ${reverify}`;
          ctx.notify(
            `Cannot merge milestone ${milestoneId}: ${reverifyMsg}. Resolve manually and run /gsd auto to resume.`,
            "error",
          );
          throw new UserNotifiedError(reverifyMsg);
        }
      }

      const roadmapPath = this.deps.resolveMilestoneFile(
        this.s.basePath,
        milestoneId,
        "ROADMAP",
      );
      if (!roadmapPath) {
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          milestoneId,
          mode: "branch",
          skipped: true,
          reason: "no-roadmap",
        });
        return false;
      }

      const roadmapContent = this.deps.readFileSync(roadmapPath, "utf-8");
      const mergeResult = this.deps.mergeMilestoneToMain(
        this.s.basePath,
        milestoneId,
        roadmapContent,
      );

      // Rebuild GitService after merge (branch HEAD changed)
      rebuildGitService(this.s, this.deps);

      if (mergeResult.codeFilesChanged) {
        ctx.notify(
          `Milestone ${milestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
          "info",
        );
      } else {
        ctx.notify(
          `WARNING: Milestone ${milestoneId} merged (branch mode) but contained NO code changes — only .gsd/ metadata. ` +
            `Review the milestone output and re-run if code is missing.`,
          "warning",
        );
      }
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        result: "success",
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        result: "error",
        error: msg,
      });
      if (!(err instanceof UserNotifiedError)) {
        ctx.notify(`Milestone merge failed (branch mode): ${msg}`, "warning");
      }
      // Re-throw all errors so callers can apply their own recovery (#4380).
      throw err;
    }
  }

  /**
   * Fall back to branch-mode for `milestoneId` after a failed worktree
   * creation, marking the session's isolation as degraded.
   *
   * Currently delegates to `enterBranchModeForMilestone` from auto-worktree.
   * Idempotent: subsequent calls in a degraded session are no-ops.
   *
   * Issue #5587 ships this as a thin adapter; the body extraction joins the
   * other merge-logic move-out in a follow-up cleanup slice.
   */
  degradeToBranchMode(milestoneId: string, ctx: NotifyCtx): void {
    if (this.s.isolationDegraded) {
      debugLog("WorktreeLifecycle", {
        action: "degradeToBranchMode",
        milestoneId,
        skipped: true,
        reason: "already-degraded",
      });
      return;
    }
    const basePath = resolveWorktreeProjectRoot(
      this.s.basePath,
      this.s.originalBasePath,
    );
    try {
      this.deps.enterBranchModeForMilestone(basePath, milestoneId);
      rebuildGitService(this.s, this.deps);
      this.deps.invalidateAllCaches();
      this.s.isolationDegraded = true;
      ctx.notify(
        `Switched to branch milestone/${milestoneId} (isolation degraded).`,
        "info",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.notify(
        `Branch isolation setup for ${milestoneId} failed: ${msg}. Continuing on current branch.`,
        "warning",
      );
      this.s.isolationDegraded = true;
    }
  }

  /**
   * Restore `s.basePath` to `s.originalBasePath` and rebuild `s.gitService`.
   * No-op when `originalBasePath` is empty (fresh sessions).
   *
   * Used by error/cleanup paths that need the session to behave as if the
   * worktree was never entered. Does NOT teardown the worktree directory —
   * callers that need teardown go through `exitMilestone({ merge: false })`.
   */
  restoreToProjectRoot(): void {
    if (!this.s.originalBasePath) return;
    this.s.basePath = this.s.originalBasePath;
    rebuildGitService(this.s, this.deps);
    this.deps.invalidateAllCaches();
  }

  /** True if `milestoneId` is the session's currently-active milestone. */
  isInMilestone(milestoneId: string): boolean {
    return this.s.currentMilestoneId === milestoneId;
  }

  /** The active milestone id, or `null` if no milestone is active. */
  getCurrentMilestoneIfAny(): string | null {
    return this.s.currentMilestoneId;
  }
}
