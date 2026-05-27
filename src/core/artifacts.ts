import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { SemanticArtifact, ArtifactType, DependencyGraph } from './types.js';
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

  async loadGraph(): Promise<DependencyGraph | null> {
    if (!(await fileExists(this.paths.graphFile))) return null;
    return JSON.parse(await readFile(this.paths.graphFile, 'utf8'));
  }

  // ─── Search across all artifacts ─────────────────────────────────────────

  async searchArtifacts(
    query: string,
    type?: ArtifactType | 'all',
    limit: number = 10,
  ): Promise<Array<{ artifact: SemanticArtifact; score: number; snippet: string }>> {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const results: Array<{ artifact: SemanticArtifact; score: number; snippet: string }> = [];

    if (keywords.length === 0) return results; // No valid keywords

    const modules = await this.loadAllModules();
    const arch = await this.loadArchitecture();
    const flows = await this.loadFlows();

    const candidates: SemanticArtifact[] = [...modules];
    if (arch) candidates.push(arch);
    if (flows) candidates.push(flows);

    // Compute inverse-document-frequency per keyword for TF-IDF
    const docCount = candidates.length || 1;
    const idfMap = new Map<string, number>();
    for (const kw of keywords) {
      let docsWithKw = 0;
      for (const a of candidates) {
        const text = (a.content + ' ' + a.path + ' ' + a.tags.join(' ')).toLowerCase();
        if (text.includes(kw)) docsWithKw++;
      }
      idfMap.set(kw, Math.log((docCount + 1) / (docsWithKw + 1)) + 1);
    }

    for (const artifact of candidates) {
      // Skip if type filter is specified and doesn't match (but 'all' means no filtering)
      if (type && type !== 'all' && artifact.type !== type) continue;

      const contentLower = artifact.content.toLowerCase();
      const pathLower = (artifact.path || '').toLowerCase();
      const tagsLower = artifact.tags.map(t => t.toLowerCase());
      const contentLength = Math.max(contentLower.length, 1);

      // Extract first heading or first line as title
      const titleMatch = artifact.content.match(/^#+ (.+)/m);
      const titleLower = (titleMatch ? titleMatch[1] : artifact.content.split('\n')[0] || '').toLowerCase();

      let totalScore = 0;
      let firstMatchIndex = -1;

      for (const kw of keywords) {
        const idf = idfMap.get(kw) ?? 1;
        let kwScore = 0;

        // Signal 1: Path/filename match (strongest signal — 2.0x weight)
        if (pathLower.includes(kw)) {
          const pathBasename = pathLower.split('/').pop() || pathLower;
          if (pathBasename.includes(kw)) {
            kwScore += 2.5; // filename match is very strong
          } else {
            kwScore += 1.5; // directory match
          }
        }

        // Signal 2: Tag match (1.5x weight)
        const tagMatches = tagsLower.filter(t => t.includes(kw) || kw.includes(t)).length;
        kwScore += Math.min(tagMatches * 1.5, 3.0);

        // Signal 3: Title/heading match (1.3x weight)
        if (titleLower.includes(kw)) {
          kwScore += 1.3;
        }

        // Signal 4: Content match — TF-IDF normalized
        const contentMatches = (contentLower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
        if (contentMatches > 0) {
          // Term frequency normalized by document length (per 1000 chars)
          const tf = (contentMatches / (contentLength / 1000));
          kwScore += Math.min(tf * idf * 0.3, 2.0);

          // Track first match position for snippet extraction
          if (firstMatchIndex === -1) {
            firstMatchIndex = contentLower.indexOf(kw);
          }
        }

        totalScore += kwScore;
      }

      // Normalize by keyword count to balance multi-word queries
      totalScore /= keywords.length;

      // Apply minimum threshold
      if (totalScore < 0.1) continue;

      // Extract contextual snippet around first match
      let snippet = '';
      if (firstMatchIndex >= 0) {
        const snippetRadius = 150;
        const start = Math.max(0, firstMatchIndex - snippetRadius);
        const end = Math.min(artifact.content.length, firstMatchIndex + snippetRadius);
        snippet = (start > 0 ? '…' : '') +
          artifact.content.slice(start, end).replace(/\n+/g, ' ').trim() +
          (end < artifact.content.length ? '…' : '');
      } else {
        snippet = artifact.content.slice(0, 250).replace(/\n+/g, ' ').trim();
        if (artifact.content.length > 250) snippet += '…';
      }

      results.push({ artifact, score: Math.min(totalScore / 5, 1), snippet });
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
