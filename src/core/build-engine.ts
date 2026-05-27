import { readFile, writeFile, rm } from 'fs/promises';
import path from 'path';
import {
  CtxConfig, DependencyGraph, BuildManifest, FileManifestEntry,
  ChangeSet, ExtractedSymbols, HealthScore, SecurityIssue, DetectedPattern
} from './types.js';
import { CtxPaths } from './config.js';
import { scanRepository, getGitBranch, getGitCommit, getGitRepoName } from './scanner.js';
import { parseFile } from './parser.js';
import { buildGraph, propagateInvalidation, topologicalSort, getModuleGroups } from './graph.js';
import { SemanticCompiler } from './compiler.js';
import { ArtifactStore } from './artifacts.js';
import { LLMProvider } from './types.js';
import {
  fileHash, sha256, pathId, uuid, formatDuration, countTokens,
} from '../utils/helpers.js';

export interface BuildProgress {
  phase: string;
  current: number;
  total: number;
  message?: string;
}

export type ProgressCallback = (progress: BuildProgress) => void;

export interface BuildResult {
  success: boolean;
  incremental: boolean;
  modulesBuilt: number;
  totalModules: number;
  tokensUsed: number;
  durationMs: number;
  errors: string[];
  healthScore?: import('./types.js').HealthScore;
  totalSecurityIssues?: number;
  totalPatterns?: number;
}

// ─── Build engine ─────────────────────────────────────────────────────────────

export class BuildEngine {
  private compiler: SemanticCompiler;
  private store: ArtifactStore;
  private tokenCounter = 0;

  constructor(
    private repoRoot: string,
    private paths: CtxPaths,
    private config: CtxConfig,
    private provider: LLMProvider,
  ) {
    this.compiler = new SemanticCompiler(provider, config);
    this.store = new ArtifactStore(paths);
  }

  async build(
    opts: { full?: boolean; dryRun?: boolean } = {},
    onProgress?: ProgressCallback,
  ): Promise<BuildResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    const progress = (phase: string, current: number, total: number, message?: string) => {
      onProgress?.({ phase, current, total, message });
    };

    // ── Phase 1: Scan repository ─────────────────────────────────────────────
    progress('Scanning repository', 0, 1);
    const scanResult = await scanRepository(this.repoRoot, this.paths, this.config.build.excludePaths);
    const files = scanResult.files;
    progress('Scanning repository', 1, 1, `${files.length} source files found`);

    if (files.length === 0) {
      return { success: false, incremental: false, modulesBuilt: 0, totalModules: 0, tokensUsed: 0, durationMs: Date.now() - startTime, errors: ['No source files found'] };
    }

    // ── Load previous manifest ────────────────────────────────────────────────
    const prevManifest = (await this.store.loadManifest()) as BuildManifest | null;
    const prevGraph = (await this.store.loadGraph()) as DependencyGraph | null;

    // ── Phase 2: Parse all files ─────────────────────────────────────────────
    progress('Parsing files', 0, files.length);
    const allExtracted: ExtractedSymbols[] = [];
    const fileContents: Record<string, string> = {};
    const fileHashes: Record<string, { content: string; sig: string }> = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      progress('Parsing files', i + 1, files.length, file.path);
      try {
        const content = await readFile(file.absolutePath, 'utf8');
        const contentHash = sha256(content);
        const extracted = parseFile(content, file.path, file.language, this.repoRoot);
        allExtracted.push(extracted);
        fileContents[file.path] = content;
        fileHashes[file.path] = { content: contentHash, sig: extracted.signatureHash };
      } catch (err) {
        errors.push(`Parse error in ${file.path}: ${(err as Error).message}`);
      }
    }

    // ── Phase 3: Build dependency graph ──────────────────────────────────────
    progress('Building dependency graph', 0, 1);
    const graph = buildGraph(allExtracted, this.repoRoot);
    progress('Building dependency graph', 1, 1);

    // ── Phase 4: Determine what needs rebuilding ──────────────────────────────
    let changeSet: ChangeSet = {
      added: [], modified: [], deleted: [],
      signatureChanged: [], implOnlyChanged: [],
      invalidated: new Set(),
    };

    let isIncremental = false;

    if (!opts.full && prevManifest) {
      isIncremental = true;
      changeSet = await detectChanges(files, fileHashes, prevManifest);

      // All invalidated (including propagated)
      changeSet.invalidated = new Set([
        ...changeSet.added,
        ...changeSet.modified,
      ]);

      // Propagate signature changes through graph
      if (changeSet.signatureChanged.length > 0 && prevGraph) {
        const propagated = propagateInvalidation(graph, changeSet.signatureChanged);
        for (const p of propagated) changeSet.invalidated.add(p);
      }

      // Safety net: any file that exists on disk but has no stored artifact
      // should be rebuilt (catches files missed in previous partial builds)
      const existingModuleIds = new Set(await this.store.listModules());
      for (const file of files) {
        const moduleId = pathId(file.path);
        if (!existingModuleIds.has(moduleId)) {
          changeSet.invalidated.add(file.path);
          if (!changeSet.added.includes(file.path)) {
            changeSet.added.push(file.path);
          }
        }
      }

      // Clean up artifacts for deleted files
      if (changeSet.deleted.length > 0) {
        for (const deletedPath of changeSet.deleted) {
          const moduleId = pathId(deletedPath);
          const dir = this.paths.moduleDir(moduleId);
          try {
            await rm(dir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } else {
      // Full build: all files need building
      changeSet.invalidated = new Set(files.map(f => f.path));
    }

    const filesToBuild = [...changeSet.invalidated].filter(p =>
      fileContents[p] !== undefined
    );

    // Sort in topological order (dependencies before dependents)
    const buildOrder = topologicalSort(graph, filesToBuild);

    if (opts.dryRun) {
      return {
        success: true, incremental: isIncremental,
        modulesBuilt: buildOrder.length, totalModules: files.length,
        tokensUsed: 0, durationMs: Date.now() - startTime, errors,
      };
    }

    // ── Phase 5: Generate module summaries ────────────────────────────────────
    progress('Generating module summaries', 0, buildOrder.length);

    const batchSize = this.config.build.parallelWorkers;
    const moduleSummaries: Record<string, string> = {};

    // Track deleted paths for exclusion
    const deletedPaths = new Set(changeSet.deleted);

    // Load existing summaries for modules not being rebuilt (exclude deleted)
    const allModules = await this.store.loadAllModules();
    for (const artifact of allModules) {
      if (!changeSet.invalidated.has(artifact.path) && !deletedPaths.has(artifact.path)) {
        moduleSummaries[artifact.path] = artifact.content;
      }
    }

    let builtCount = 0;
    for (let i = 0; i < buildOrder.length; i += batchSize) {
      const batch = buildOrder.slice(i, i + batchSize);

      await Promise.all(batch.map(async (filePath) => {
        const file = files.find(f => f.path === filePath);
        if (!file) return;

        const content = fileContents[filePath];
        if (!content) return;

        // Get dependency summaries for context
        const node = graph.nodes[pathId(filePath)];
        const depSummaries = node
          ? node.imports
              .map(depId => graph.nodes[depId])
              .filter(Boolean)
              .map(depNode => moduleSummaries[depNode.path])
              .filter(Boolean)
              .slice(0, 3)
              .join('\n\n---\n\n')
          : '';

        // Check if we have a previous summary to update incrementally
        const previousSummary = changeSet.implOnlyChanged.includes(filePath)
          ? moduleSummaries[filePath]
          : undefined;

        try {
          const artifact = await this.compiler.compileModule(
            filePath, file.language, content, depSummaries, previousSummary
          );
          this.tokenCounter += artifact.metadata.tokenCount;
          moduleSummaries[filePath] = artifact.content;
          await this.store.saveModule(artifact);
        } catch (err) {
          errors.push(`Compile error for ${filePath}: ${(err as Error).message}`);
        }

        builtCount++;
        progress('Generating module summaries', builtCount, buildOrder.length, filePath);
      }));
    }

    // ── Phase 6: Generate architecture overview ───────────────────────────────
    const shouldRebuildArch = !isIncremental ||
      changeSet.invalidated.size > 3 ||
      !prevManifest;

    if (shouldRebuildArch && Object.keys(moduleSummaries).length > 0) {
      progress('Generating architecture overview', 0, 1);

      const groups = getModuleGroups(graph);
      const summariesByGroup: Record<string, string> = {};
      for (const [group, paths] of Object.entries(groups)) {
        const groupSummaries = paths
          .slice(0, 5)
          .map(p => moduleSummaries[p])
          .filter(Boolean)
          .join('\n\n');
        if (groupSummaries) summariesByGroup[group] = groupSummaries;
      }

      try {
        const repoName = getGitRepoName(this.repoRoot);
        const archArtifact = await this.compiler.compileArchitecture(repoName, graph, summariesByGroup);
        this.tokenCounter += archArtifact.metadata.tokenCount;
        await this.store.saveArchitecture(archArtifact);

        // Generate flows
        if (this.config.features.flowExtraction) {
          const flowArtifact = await this.compiler.compileFlows(repoName, graph, moduleSummaries);
          this.tokenCounter += flowArtifact.metadata.tokenCount;
          await this.store.saveFlows(flowArtifact);
        }

        // Generate context primer
        const primer = await this.compiler.compileContextPrimer(repoName, archArtifact, graph);
        await this.store.saveContextPrimer(primer);

        progress('Generating architecture overview', 1, 1);
      } catch (err) {
        errors.push(`Architecture compile error: ${(err as Error).message}`);
      }
    }

    // ── Phase 7: Generate wiki index ─────────────────────────────────────────
    progress('Writing index', 0, 1);
    await this.generateIndex(graph, moduleSummaries);
    progress('Writing index', 1, 1);

    // ── Phase 8: Compute Health & Save manifest ───────────────────────────────
    progress('Computing health score', 0, 1);
    const healthScore = computeHealth(graph, fileContents);

    let totalSecurityIssues = 0;
    let totalPatterns = 0;
    Object.values(graph.nodes).forEach(n => {
      totalSecurityIssues += n.securityIssues.length;
      totalPatterns += n.patterns.length;
    });

    const manifest: BuildManifest = {
      buildId: uuid(),
      timestamp: new Date().toISOString(),
      repositoryRoot: this.repoRoot,
      branch: getGitBranch(this.repoRoot),
      commitHash: getGitCommit(this.repoRoot),
      files: buildFileManifest(files, fileHashes, graph),
      artifacts: Object.fromEntries(
        Object.keys(moduleSummaries).map(p => [p, pathId(p)])
      ),
      graphPath: this.paths.graphFile,
      buildStats: {
        totalFiles: files.length,
        totalModules: Object.keys(moduleSummaries).length,
        totalTokensConsumed: this.tokenCounter,
        buildDurationMs: Date.now() - startTime,
        incrementalRebuild: isIncremental,
        modulesRebuilt: builtCount,
        healthScore,
        totalSecurityIssues,
        totalPatterns,
      },
      providerConfig: {
        type: this.config.provider.type,
        model: this.config.provider.model,
      },
    };

    await this.store.saveManifest(manifest as unknown as Record<string, unknown>);
    await this.store.saveGraph(graph as unknown as Record<string, unknown>);

    return {
      success: true,
      incremental: isIncremental,
      modulesBuilt: builtCount,
      totalModules: files.length,
      tokensUsed: this.tokenCounter,
      durationMs: Date.now() - startTime,
      errors,
      healthScore,
      totalSecurityIssues,
      totalPatterns,
    };
  }

  private async generateIndex(
    graph: DependencyGraph,
    summaries: Record<string, string>,
  ): Promise<void> {
    const groups = getModuleGroups(graph);
    const lines = [
      '# CTX Knowledge Index',
      '',
      `> Generated: ${new Date().toISOString()}`,
      '',
      '## Module Domains',
      '',
    ];

    for (const [group, paths] of Object.entries(groups)) {
      lines.push(`### ${group}`);
      for (const p of paths) {
        const node = graph.nodes[pathId(p)];
        const exports = node?.symbolExports.slice(0, 4).map(s => s.name).join(', ') ?? '';
        lines.push(`- \`${p}\`${exports ? ` — ${exports}` : ''}`);
      }
      lines.push('');
    }

    await this.store.saveIndex(lines.join('\n'));
  }
}

// ─── Health Scoring ───────────────────────────────────────────────────────────

function computeHealth(graph: DependencyGraph, fileContents: Record<string, string>): HealthScore {
  let score = 100;
  const issues: string[] = [];
  
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return { score: 0, grade: 'F', issues: ['No files found'] };

  let isolatedFiles = 0;
  let circularCount = 0;
  let largeFiles = 0;
  let totalConnections = 0;
  let highSecIssues = 0;

  for (const node of nodes) {
    if (node.importedBy.length === 0 && !node.path.match(/(index|main|app|cli)\.(ts|js|go|py)$/)) {
      isolatedFiles++; 
    }

    if (node.imports.some(imp => graph.nodes[imp]?.imports.includes(node.id))) {
      circularCount++;
    }

    const size = fileContents[node.path]?.length ?? 0;
    if (size > 20000) { 
      largeFiles++;
    }

    totalConnections += node.imports.length;
    highSecIssues += node.securityIssues.filter(i => i.severity === 'high').length;
  }

  const deadPct = nodes.length > 0 ? (isolatedFiles / nodes.length * 100) : 0;
  if (deadPct > 0) {
    const penalty = Math.min(20, deadPct);
    score -= penalty;
    if (penalty >= 5) issues.push(`High amount of isolated files (${deadPct.toFixed(1)}%)`);
  }

  circularCount = circularCount / 2;
  if (circularCount > 0) {
    const penalty = Math.min(20, circularCount * 5);
    score -= penalty;
    issues.push(`${circularCount} circular dependencies detected`);
  }

  if (largeFiles > 0) {
    const penalty = Math.min(15, largeFiles * 3);
    score -= penalty;
    if (penalty >= 3) issues.push(`${largeFiles} excessively large files (God objects)`);
  }

  const avgCoup = totalConnections / nodes.length;
  if (avgCoup > 3) {
    const penalty = Math.min(15, Math.max(0, avgCoup - 3) * 2);
    score -= penalty;
    issues.push(`High average coupling (${avgCoup.toFixed(1)} imports per file)`);
  }

  if (highSecIssues > 0) {
    const penalty = Math.min(20, highSecIssues * 5);
    score -= penalty;
    issues.push(`${highSecIssues} high-severity security issues`);
  }

  score = Math.max(0, Math.round(score));
  let grade: 'A'|'B'|'C'|'D'|'F' = 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';

  return { score, grade, issues };
}

// ─── Change detection ─────────────────────────────────────────────────────────

async function detectChanges(
  currentFiles: Array<{ path: string; absolutePath: string }>,
  fileHashes: Record<string, { content: string; sig: string }>,
  prevManifest: BuildManifest,
): Promise<ChangeSet> {
  const changeSet: ChangeSet = {
    added: [], modified: [], deleted: [],
    signatureChanged: [], implOnlyChanged: [],
    invalidated: new Set(),
  };

  const prevPaths = new Set(Object.keys(prevManifest.files));
  const currentPaths = new Set(currentFiles.map(f => f.path));

  // Detect added files
  for (const p of currentPaths) {
    if (!prevPaths.has(p)) changeSet.added.push(p);
  }

  // Detect deleted files
  for (const p of prevPaths) {
    if (!currentPaths.has(p)) changeSet.deleted.push(p);
  }

  // Detect modified files
  for (const file of currentFiles) {
    const prev = prevManifest.files[file.path];
    if (!prev) continue; // already in added

    const current = fileHashes[file.path];
    if (!current) continue;

    if (current.content !== prev.hash) {
      changeSet.modified.push(file.path);
      if (current.sig !== prev.symbolHash) {
        changeSet.signatureChanged.push(file.path);
      } else {
        changeSet.implOnlyChanged.push(file.path);
      }
    }
  }

  return changeSet;
}

function buildFileManifest(
  files: Array<{ path: string; language: string; size: number }>,
  hashes: Record<string, { content: string; sig: string }>,
  graph: DependencyGraph,
): Record<string, FileManifestEntry> {
  const manifest: Record<string, FileManifestEntry> = {};
  for (const file of files) {
    const h = hashes[file.path];
    manifest[file.path] = {
      path: file.path,
      hash: h?.content ?? '',
      symbolHash: h?.sig ?? '',
      size: file.size,
      language: file.language,
      lastModified: new Date().toISOString(),
      artifactId: pathId(file.path),
    };
  }
  return manifest;
}
