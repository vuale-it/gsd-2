// Project/App: GSD-2
// File Purpose: ADR-015 Worktree Safety module for pre-dispatch Unit root validation.

import { existsSync as nodeExistsSync, statSync as nodeStatSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveManifest } from "./unit-context-manifest.js";

export type WorktreeSafetyResult =
  | {
      ok: true;
      root: string;
      sourceWriting: boolean;
      reason: "source-writing-root-valid" | "non-source-writing-root";
    }
  | {
      ok: false;
      reason: "unknown-unit-type" | "root-missing" | "git-metadata-missing" | "root-not-directory";
      detail: string;
      root: string;
      sourceWriting: boolean;
    };

export interface WorktreeSafetyContext {
  basePath: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  statSync?: typeof nodeStatSync;
}

export function prepareUnitRoot(
  unitType: string,
  _unitId: string,
  context: WorktreeSafetyContext,
): WorktreeSafetyResult {
  const manifest = resolveManifest(unitType);
  if (!manifest) {
    return {
      ok: false,
      reason: "unknown-unit-type",
      detail: `No Unit manifest is registered for ${unitType}`,
      root: resolve(context.basePath),
      sourceWriting: true,
    };
  }

  const sourceWriting = manifest.tools.mode === "all" || manifest.tools.mode === "docs";
  const root = resolve(context.env?.GSD_UNIT_ROOT ?? context.basePath);
  if (!sourceWriting) {
    return { ok: true, root, sourceWriting, reason: "non-source-writing-root" };
  }

  const existsSync = context.existsSync ?? nodeExistsSync;
  const statSync = context.statSync ?? nodeStatSync;
  if (!existsSync(root)) {
    return {
      ok: false,
      reason: "root-missing",
      detail: `Source-writing Unit root does not exist: ${root}`,
      root,
      sourceWriting,
    };
  }

  try {
    if (!statSync(root).isDirectory()) {
      return {
        ok: false,
        reason: "root-not-directory",
        detail: `Source-writing Unit root is not a directory: ${root}`,
        root,
        sourceWriting,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "root-not-directory",
      detail: `Source-writing Unit root could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      root,
      sourceWriting,
    };
  }

  const gitPath = join(root, ".git");
  if (!existsSync(gitPath)) {
    return {
      ok: false,
      reason: "git-metadata-missing",
      detail: `Source-writing Unit root is missing git metadata: ${gitPath}`,
      root,
      sourceWriting,
    };
  }

  return { ok: true, root, sourceWriting, reason: "source-writing-root-valid" };
}
