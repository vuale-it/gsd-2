// Project/App: GSD-2
// File Purpose: Regression tests for the TUI header lifecycle fixes —
// header is suppressed (zero lines) when auto-mode activates, the wizard
// step status badge is cleared, the NEXT-mode footer hint renders when
// step mode is active, and the health widget appends guidance for active
// projects.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { updateProgressWidget } from "../auto-dashboard.ts";
import type { GSDState } from "../types.ts";

interface CapturedSetHeader {
  factory: ((tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) | undefined;
}

function makeTempDir(prefix: string): string {
  return join(
    tmpdir(),
    `gsd-tui-lifecycle-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const baseState: GSDState = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Milestone" },
  activeSlice: { id: "S01", title: "Slice" },
  activeTask: { id: "T01", title: "Task" },
} as unknown as GSDState;

const baseAccessors = {
  getAutoStartTime: () => 0,
  isStepMode: () => false,
  getCmdCtx: () => null,
  getBasePath: () => "/tmp",
  isVerbose: () => false,
  isSessionSwitching: () => false,
  getCurrentDispatchedModelId: () => null,
};

// ── Header lifecycle ────────────────────────────────────────────────────

test("updateProgressWidget installs an EMPTY-rendering header (not undefined) — addresses codex P1 finding that setHeader(undefined) restores the built-in logo+instructions header", (t) => {
  const dir = makeTempDir("empty-header");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  const captured: CapturedSetHeader = { factory: undefined };
  let setHeaderCallCount = 0;

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {},
        setHeader(factory: any) {
          setHeaderCallCount++;
          captured.factory = factory;
        },
        setStatus() {},
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir },
  );

  assert.equal(setHeaderCallCount, 1, "setHeader must be called exactly once when widget installs");
  assert.notEqual(captured.factory, undefined, "factory must NOT be undefined — undefined restores the built-in logo+instructions header (codex P1)");
  assert.equal(typeof captured.factory, "function", "factory must be a component-creating function");

  const component = captured.factory!(null, null);
  const rendered = component.render(80);
  assert.deepEqual(rendered, [], "empty header component must render zero lines so auto-mode actually suppresses the welcome banner");
});

test("updateProgressWidget clears the gsd-step wizard badge when auto-mode activates", (t) => {
  const dir = makeTempDir("step-badge");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  const statusCalls: Array<[string, string | undefined]> = [];

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {},
        setHeader() {},
        setStatus(key: string, value: string | undefined) { statusCalls.push([key, value]); },
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir },
  );

  assert.ok(
    statusCalls.some(([key, value]) => key === "gsd-step" && value === undefined),
    `expected setStatus("gsd-step", undefined) to be called; got ${JSON.stringify(statusCalls)}`,
  );
});

test("updateProgressWidget gracefully no-ops when ctx.ui lacks setHeader/setStatus (RPC mode)", (t) => {
  const dir = makeTempDir("rpc-mode");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  // ctx.ui without setHeader / setStatus — must not throw.
  assert.doesNotThrow(() => {
    updateProgressWidget(
      {
        hasUI: true,
        ui: { setWidget() {} },
      } as any,
      "execute-task",
      "M001/S01/T01",
      baseState,
      { ...baseAccessors, getBasePath: () => dir },
    );
  });
});

// ── NEXT-mode footer guidance ───────────────────────────────────────────

test("auto-dashboard widget render output includes Ctrl+N guidance when isStepMode is true", (t) => {
  const dir = makeTempDir("step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  let widgetFactory: ((tui: unknown, theme: unknown) => any) | undefined;

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key: string, factory: any) { widgetFactory = factory; },
        setHeader() {},
        setStatus() {},
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => true },
  );

  assert.ok(widgetFactory, "widget factory must be installed");

  const fakeTui = { requestRender() {} };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = widgetFactory!(fakeTui, fakeTheme);
  const lines = component.render(120);

  const hasStepHint = lines.some((line: string) => line.includes("Ctrl+N to advance"));
  assert.ok(hasStepHint, `expected step-mode hint in render output; got:\n${lines.join("\n")}`);

  if (component.dispose) component.dispose();
});

test("auto-dashboard widget render output omits Ctrl+N guidance when isStepMode is false", (t) => {
  const dir = makeTempDir("no-step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  let widgetFactory: ((tui: unknown, theme: unknown) => any) | undefined;

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key: string, factory: any) { widgetFactory = factory; },
        setHeader() {},
        setStatus() {},
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => false },
  );

  assert.ok(widgetFactory);

  const fakeTui = { requestRender() {} };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = widgetFactory!(fakeTui, fakeTheme);
  const lines = component.render(120);

  const hasStepHint = lines.some((line: string) => line.includes("Ctrl+N to advance"));
  assert.equal(hasStepHint, false, "step-mode hint must NOT appear when isStepMode is false");

  if (component.dispose) component.dispose();
});
