// Project/App: GSD-2
// File Purpose: Stop-auto worktree exit strategy regression tests.
/**
 * stop-auto-merge-back.test.ts — Regression test for #2317.
 *
 * When auto-mode stops after a milestone is complete, stopAuto should trigger
 * merge-back (mergeAndExit) instead of just exiting the worktree with
 * preserveBranch: true. Otherwise milestone code stays stranded on the
 * worktree branch and never reaches main.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { _selectStopAutoWorktreeExit } from "../auto.ts";

test("#2317: stopAuto should check milestone completion status before choosing exit strategy", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: true,
      milestoneMergedInPhases: false,
    }),
    "merge",
  );
});

test("#2317: stopAuto still preserves branch for incomplete milestones", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: false,
      milestoneMergedInPhases: false,
    }),
    "preserve",
  );
});

test("#2317: stopAuto does not merge a milestone already merged in phases", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: true,
      milestoneMergedInPhases: true,
    }),
    "none",
  );
});

test("#2317: stopAuto skips worktree teardown when no milestone is active", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: null,
      milestoneComplete: true,
      milestoneMergedInPhases: false,
    }),
    "none",
  );
});
