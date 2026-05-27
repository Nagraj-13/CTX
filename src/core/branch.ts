import { readFile, writeFile, mkdir, copyFile, readdir } from 'fs/promises';
import path from 'path';
import { BranchMeta, SemanticArtifact, LLMProvider } from './types.js';
import { CtxPaths } from './config.js';
import { ArtifactStore } from './artifacts.js';
import { fileExists, uuid, pathId } from '../utils/helpers.js';

// ─── Branch manager ───────────────────────────────────────────────────────────

export class BranchManager {
  constructor(
    private paths: CtxPaths,
    private store: ArtifactStore,
  ) {}

  async create(name: string, description?: string): Promise<void> {
    const branchDir = path.join(this.paths.branchesDir, sanitizeBranchName(name));
    await mkdir(branchDir, { recursive: true });
    await mkdir(path.join(branchDir, 'modules'), { recursive: true });

    const meta: BranchMeta = {
      name,
      createdAt: new Date().toISOString(),
      parent: await this.getCurrentBranch(),
      description,
      lastUpdated: new Date().toISOString(),
      overrides: [],
    };

    await writeFile(
      path.join(branchDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8',
    );
  }

  async list(): Promise<BranchMeta[]> {
    if (!(await fileExists(this.paths.branchesDir))) return [];

    const entries = await readdir(this.paths.branchesDir);
    const metas: BranchMeta[] = [];

    for (const entry of entries) {
      const metaPath = path.join(this.paths.branchesDir, entry, 'meta.json');
      if (await fileExists(metaPath)) {
        metas.push(JSON.parse(await readFile(metaPath, 'utf8')));
      }
    }

    return metas;
  }

  async getCurrent(): Promise<string> {
    return this.getCurrentBranch();
  }

  async addContext(branchName: string, contextText: string, modulePath?: string): Promise<void> {
    const branchDir = path.join(this.paths.branchesDir, sanitizeBranchName(branchName));

    if (!(await fileExists(branchDir))) {
      throw new Error(`Branch "${branchName}" does not exist`);
    }

    if (modulePath) {
      // Override specific module
      const moduleId = pathId(modulePath);
      const moduleDir = path.join(branchDir, 'modules', moduleId);
      await mkdir(moduleDir, { recursive: true });

      // Load existing summary and append override
      const existing = await this.store.loadModule(modulePath);
      const newContent = existing
        ? existing.content + '\n\n---\n## Branch Override\n' + contextText
        : contextText;

      await writeFile(path.join(moduleDir, 'summary.md'), newContent, 'utf8');
    } else {
      // Append to branch-level notes
      const notesPath = path.join(branchDir, 'notes.md');
      const existing = await fileExists(notesPath)
        ? await readFile(notesPath, 'utf8')
        : '# Branch Context Notes\n\n';
      await writeFile(notesPath, existing + '\n\n' + contextText, 'utf8');
    }

    // Update meta
    await this.updateMeta(branchName, meta => ({
      ...meta,
      lastUpdated: new Date().toISOString(),
    }));
  }

  async delete(name: string): Promise<void> {
    const { rm } = await import('fs/promises');
    const branchDir = path.join(this.paths.branchesDir, sanitizeBranchName(name));
    if (await fileExists(branchDir)) {
      await rm(branchDir, { recursive: true });
    }
  }

  private async getCurrentBranch(): Promise<string> {
    const currentFile = path.join(this.paths.branchesDir, 'CURRENT');
    if (await fileExists(currentFile)) {
      return (await readFile(currentFile, 'utf8')).trim();
    }
    return 'main';
  }

  private async updateMeta(name: string, updater: (m: BranchMeta) => BranchMeta): Promise<void> {
    const metaPath = path.join(this.paths.branchesDir, sanitizeBranchName(name), 'meta.json');
    if (!(await fileExists(metaPath))) return;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    await writeFile(metaPath, JSON.stringify(updater(meta), null, 2), 'utf8');
  }
}

// ─── Merge engine ─────────────────────────────────────────────────────────────

export class MergeEngine {
  constructor(
    private paths: CtxPaths,
    private store: ArtifactStore,
    private provider: LLMProvider,
  ) {}

  async merge(
    sourceBranch: string,
    targetBranch: string,
    auto: boolean = false,
  ): Promise<MergeResult> {
    const branchDir = path.join(this.paths.branchesDir, sanitizeBranchName(sourceBranch));

    if (!(await fileExists(branchDir))) {
      throw new Error(`Branch "${sourceBranch}" does not exist`);
    }

    const conflicts: MergeConflict[] = [];
    const resolved: ResolvedConflict[] = [];

    // Find all module overrides in the source branch
    const moduleOverridesDir = path.join(branchDir, 'modules');
    if (await fileExists(moduleOverridesDir)) {
      const moduleIds = await readdir(moduleOverridesDir);

      for (const moduleId of moduleIds) {
        const branchSummaryPath = path.join(moduleOverridesDir, moduleId, 'summary.md');
        if (!(await fileExists(branchSummaryPath))) continue;

        const branchContent = await readFile(branchSummaryPath, 'utf8');
        const mainSummaryPath = path.join(this.paths.modulesDir, moduleId, 'summary.md');

        if (!(await fileExists(mainSummaryPath))) {
          // New module in branch — just copy
          await mkdir(path.join(this.paths.modulesDir, moduleId), { recursive: true });
          await copyFile(branchSummaryPath, mainSummaryPath);
          resolved.push({ moduleId, strategy: 'branch_new', content: branchContent });
          continue;
        }

        const mainContent = await readFile(mainSummaryPath, 'utf8');

        if (mainContent === branchContent) {
          // No conflict
          continue;
        }

        conflicts.push({ moduleId, mainContent, branchContent });
      }
    }

    // Merge notes into architecture doc
    const branchNotesPath = path.join(branchDir, 'notes.md');
    if (await fileExists(branchNotesPath)) {
      const notes = await readFile(branchNotesPath, 'utf8');
      const archPath = this.paths.architectureFile();
      if (await fileExists(archPath)) {
        const arch = await readFile(archPath, 'utf8');
        const merged = arch + '\n\n---\n\n## Merged from branch: ' + sourceBranch + '\n\n' + notes;
        await writeFile(archPath, merged, 'utf8');
      }
    }

    if (conflicts.length === 0) {
      return { conflicts: 0, resolved: resolved.length, errors: [], auto: true };
    }

    if (auto) {
      // LLM-assisted resolution
      for (const conflict of conflicts) {
        try {
          const resolution = await this.resolveConflict(conflict);
          const summaryPath = path.join(this.paths.modulesDir, conflict.moduleId, 'summary.md');
          await writeFile(summaryPath, resolution, 'utf8');
          resolved.push({ moduleId: conflict.moduleId, strategy: 'llm_merge', content: resolution });
        } catch (err) {
          // Keep main on failure
          resolved.push({ moduleId: conflict.moduleId, strategy: 'keep_main', content: conflict.mainContent });
        }
      }
      return { conflicts: conflicts.length, resolved: resolved.length, errors: [], auto: true };
    }

    return {
      conflicts: conflicts.length,
      resolved: resolved.length,
      pendingConflicts: conflicts,
      errors: [],
      auto: false,
    };
  }

  private async resolveConflict(conflict: MergeConflict): Promise<string> {
    const response = await this.provider.complete({
      system: `You are reconciling two versions of a semantic module summary. 
Produce a single merged summary that accurately represents the module, 
incorporating valid information from both versions. Output ONLY the merged markdown.`,
      user: `Reconcile these two descriptions of the same module.

VERSION A (main):
${conflict.mainContent}

VERSION B (branch):
${conflict.branchContent}

Output the reconciled summary.`,
      maxTokens: 1500,
      temperature: 0.1,
    });
    return response;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MergeResult {
  conflicts: number;
  resolved: number;
  errors: string[];
  auto: boolean;
  pendingConflicts?: MergeConflict[];
}

interface MergeConflict {
  moduleId: string;
  mainContent: string;
  branchContent: string;
}

interface ResolvedConflict {
  moduleId: string;
  strategy: 'llm_merge' | 'keep_main' | 'use_branch' | 'branch_new';
  content: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}
