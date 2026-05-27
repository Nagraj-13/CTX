import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { SemanticArtifact, ArtifactType } from './types.js';
import { CtxPaths } from './config.js';
import { fileExists, pathId } from '../utils/helpers.js';

export class ArtifactStore {
  constructor(private paths: CtxPaths) {}

  // ─── Module artifacts ──────────────────────────────────────────────────────

  async saveModule(artifact: SemanticArtifact): Promise<void> {
    const moduleId = pathId(artifact.path);
    const dir = this.paths.moduleDir(moduleId);
    await mkdir(dir, { recursive: true });

    await writeFile(this.paths.moduleSummary(moduleId), artifact.content, 'utf8');
    await writeFile(this.paths.moduleMeta(moduleId), JSON.stringify({
      id: artifact.id,
      path: artifact.path,
      type: artifact.type,
      metadata: artifact.metadata,
      tags: artifact.tags,
    }, null, 2), 'utf8');
  }

  async loadModule(filePath: string): Promise<SemanticArtifact | null> {
    const moduleId = pathId(filePath);
    const summaryPath = this.paths.moduleSummary(moduleId);
    const metaPath = this.paths.moduleMeta(moduleId);

    if (!(await fileExists(summaryPath))) return null;

    const content = await readFile(summaryPath, 'utf8');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));

    return {
      id: meta.id,
      type: meta.type,
      path: meta.path,
      content,
      metadata: meta.metadata,
      tags: meta.tags ?? [],
    };
  }

  async listModules(): Promise<string[]> {
    const dir = this.paths.modulesDir;
    if (!(await fileExists(dir))) return [];
    const entries = await readdir(dir);
    return entries; // returns moduleIds (path hashes)
  }

  async loadAllModules(): Promise<SemanticArtifact[]> {
    const moduleIds = await this.listModules();
    const results: SemanticArtifact[] = [];

    for (const moduleId of moduleIds) {
      const summaryPath = this.paths.moduleSummary(moduleId);
      const metaPath = this.paths.moduleMeta(moduleId);

      if (!(await fileExists(summaryPath)) || !(await fileExists(metaPath))) continue;

      try {
        const content = await readFile(summaryPath, 'utf8');
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        results.push({
          id: meta.id,
          type: meta.type,
          path: meta.path,
          content,
          metadata: meta.metadata,
          tags: meta.tags ?? [],
        });
      } catch {
        // Skip malformed artifacts
      }
    }

    return results;
  }

  // ─── Repo-level artifacts ─────────────────────────────────────────────────

  async saveArchitecture(artifact: SemanticArtifact): Promise<void> {
    await mkdir(this.paths.artifactsDir, { recursive: true });
    await writeFile(this.paths.architectureFile(), artifact.content, 'utf8');
    await writeFile(this.paths.architectureFile() + '.meta.json', JSON.stringify({
      id: artifact.id,
      metadata: artifact.metadata,
      tags: artifact.tags,
    }, null, 2), 'utf8');
  }

  async loadArchitecture(): Promise<SemanticArtifact | null> {
    const file = this.paths.architectureFile();
    if (!(await fileExists(file))) return null;
    const content = await readFile(file, 'utf8');
    let meta: Record<string, unknown> = {};
    const metaFile = file + '.meta.json';
    if (await fileExists(metaFile)) {
      meta = JSON.parse(await readFile(metaFile, 'utf8'));
    }
    return {
      id: (meta.id as string) ?? 'arch',
      type: 'architecture_overview',
      path: '',
      content,
      metadata: (meta.metadata as SemanticArtifact['metadata']) ?? defaultMeta(),
      tags: (meta.tags as string[]) ?? [],
    };
  }

  async saveFlows(artifact: SemanticArtifact): Promise<void> {
    await writeFile(this.paths.flowsFile(), artifact.content, 'utf8');
  }

  async loadFlows(): Promise<SemanticArtifact | null> {
    const file = this.paths.flowsFile();
    if (!(await fileExists(file))) return null;
    const content = await readFile(file, 'utf8');
    return {
      id: 'flows', type: 'execution_flow', path: '', content,
      metadata: defaultMeta(), tags: [],
    };
  }

  async saveContextPrimer(content: string): Promise<void> {
    await writeFile(this.paths.contextPrimer, content, 'utf8');
  }

  async saveIndex(content: string): Promise<void> {
    await writeFile(this.paths.indexFile(), content, 'utf8');
  }

  // ─── Manifest / snapshot ──────────────────────────────────────────────────

  async saveManifest(manifest: Record<string, unknown>): Promise<void> {
    await mkdir(this.paths.snapshotDir, { recursive: true });
    await writeFile(this.paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');
  }

  async loadManifest(): Promise<Record<string, unknown> | null> {
    if (!(await fileExists(this.paths.manifest))) return null;
    return JSON.parse(await readFile(this.paths.manifest, 'utf8'));
  }

  async saveGraph(graph: Record<string, unknown>): Promise<void> {
    await mkdir(this.paths.snapshotDir, { recursive: true });
    await writeFile(this.paths.graphFile, JSON.stringify(graph), 'utf8');
  }

  async loadGraph(): Promise<Record<string, unknown> | null> {
    if (!(await fileExists(this.paths.graphFile))) return null;
    return JSON.parse(await readFile(this.paths.graphFile, 'utf8'));
  }

  // ─── Search across all artifacts ─────────────────────────────────────────

  async searchArtifacts(
    query: string,
    type?: ArtifactType | 'all',
    limit: number = 10,
  ): Promise<Array<{ artifact: SemanticArtifact; score: number }>> {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const results: Array<{ artifact: SemanticArtifact; score: number }> = [];

    if (keywords.length === 0) return results; // No valid keywords

    const modules = await this.loadAllModules();
    const arch = await this.loadArchitecture();
    const flows = await this.loadFlows();

    const candidates: SemanticArtifact[] = [...modules];
    if (arch) candidates.push(arch);
    if (flows) candidates.push(flows);

    for (const artifact of candidates) {
      // Skip if type filter is specified and doesn't match (but 'all' means no filtering)
      if (type && type !== 'all' && artifact.type !== type) continue;

      const text = (artifact.content + ' ' + artifact.tags.join(' ')).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        const matches = (text.match(new RegExp(kw, 'gi')) ?? []).length;
        score += Math.min(matches / 3, 1);
      }
      score /= keywords.length;

      if (score > 0) {
        results.push({ artifact, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function defaultMeta(): SemanticArtifact['metadata'] {
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'unknown',
    sourceHash: '',
    tokenCount: 0,
    version: 1,
    confidence: 0.8,
  };
}
