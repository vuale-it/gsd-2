// Project/App: GSD-2
// File Purpose: ADR-015 runtime invariant module contract tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { classifyFailure } from "../recovery-classification.js";
import { reconcileBeforeDispatch } from "../state-reconciliation.js";
import { compileUnitToolContract } from "../tool-contract.js";
import { prepareUnitRoot } from "../worktree-safety.js";
import type { GSDState } from "../types.js";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
    ...overrides,
  };
}

test("State Reconciliation invalidates cache and returns reconciled state", async () => {
  const calls: string[] = [];
  const state = makeState();

  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache() { calls.push("invalidate"); },
    async deriveState(basePath) {
      calls.push(`derive:${basePath}`);
      return state;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["invalidate", "derive:/project"]);
  assert.equal(result.ok && result.stateSnapshot, state);
});

test("State Reconciliation blocks when derived state carries blockers", async () => {
  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache() {},
    async deriveState() {
      return makeState({ phase: "blocked", blockers: ["slice lock missing"] });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "slice lock missing");
});

test("Tool Contract compiles known Unit prompt and tool policy", () => {
  const result = compileUnitToolContract("execute-task");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.contract.unitType, "execute-task");
  assert.deepEqual(result.ok && result.contract.requiredWorkflowTools, ["gsd_task_complete"]);
  assert.equal(result.ok && result.contract.toolsPolicy.mode, "all");
  assert.ok(result.ok && result.contract.validationRules.includes("closeout-tool-present"));
});

test("Tool Contract fails closed for unknown Units", () => {
  const result = compileUnitToolContract("custom-step");

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unknown-unit-type");
});

test("Worktree Safety validates source-writing Unit root git metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-worktree-safety-"));
  writeFileSync(join(root, ".git"), "gitdir: /tmp/worktrees/M001\n");
  try {
    const result = prepareUnitRoot("execute-task", "M001/S01/T01", { basePath: root });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.sourceWriting, true);
    assert.equal(result.ok && result.reason, "source-writing-root-valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worktree Safety fails closed when source-writing root lacks git metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-worktree-safety-"));
  try {
    const result = prepareUnitRoot("execute-task", "M001/S01/T01", { basePath: root });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "git-metadata-missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worktree Safety does not require git metadata for planning Units", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-worktree-safety-"));
  try {
    mkdirSync(join(root, "nested"));
    const result = prepareUnitRoot("plan-slice", "M001/S01", { basePath: join(root, "nested") });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.sourceWriting, false);
    assert.equal(result.ok && result.reason, "non-source-writing-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Recovery Classification covers ADR-015 failure families", () => {
  const cases = [
    ["invalid tool schema enum", "tool-schema", "stop"],
    ["deterministic policy rejection", "deterministic-policy", "stop"],
    ["stale worker lease", "stale-worker", "stop"],
    ["worktree root missing .git", "worktree-invalid", "stop"],
    ["verification drift in state snapshot", "verification-drift", "escalate"],
    ["rate limit 429", "provider", "retry"],
    ["unexpected invariant", "runtime-unknown", "escalate"],
  ] as const;

  for (const [message, failureKind, action] of cases) {
    const result = classifyFailure({ error: new Error(message), unitType: "execute-task", unitId: "T01" });

    assert.equal(result.failureKind, failureKind);
    assert.equal(result.action, action);
  }
});
