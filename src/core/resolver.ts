import {
  ResolveRequest, ContextPackage, RelevanceScore, SemanticArtifact,
  DependencyGraph, OperationType,
} from './types.js';
import { ArtifactStore } from './artifacts.js';
import { bfsFromNodes } from './graph.js';
import { pathId, extractKeywords, keywordOverlap, countTokens, truncateToTokens } from '../utils/helpers.js';

// ─── Operation-type artifact weights ─────────────────────────────────────────

const OPERATION_WEIGHTS: Record<OperationType, Record<string, number>> = {
  bug_fix: {
    module_summary: 0.9,
    execution_flow: 0.8,
    gotcha_entry: 1.0,
    architecture_overview: 0.3,
    architectural_decision: 0.4,
    feature_domain: 0.3,
    symbol_description: 0.7,
  },
  feature_add: {
    module_summary: 0.8,
    execution_flow: 0.6,
    gotcha_entry: 0.5,
    architecture_overview: 0.9,
    architectural_decision: 0.8,
    feature_domain: 0.7,
    symbol_description: 0.5,
  },
  refactor: {
    module_summary: 0.9,
    execution_flow: 0.7,
    gotcha_entry: 0.7,
    architecture_overview: 0.7,
    architectural_decision: 0.9,
    feature_domain: 0.6,
    symbol_description: 0.8,
  },
  test: {
    module_summary: 1.0,
    execution_flow: 0.7,
    gotcha_entry: 0.8,
    architecture_overview: 0.3,
    architectural_decision: 0.2,
    feature_domain: 0.4,
    symbol_description: 0.9,
  },
  explain: {
    module_summary: 0.8,
    execution_flow: 0.9,
    gotcha_entry: 0.7,
    architecture_overview: 1.0,
    architectural_decision: 0.8,
    feature_domain: 0.7,
    symbol_description: 0.6,
  },
  auto: {
    module_summary: 0.8,
    execution_flow: 0.6,
    gotcha_entry: 0.6,
    architecture_overview: 0.5,
    architectural_decision: 0.5,
    feature_domain: 0.5,
    symbol_description: 0.6,
  },
};

// ─── Auto-detect operation type from task text ────────────────────────────────

export function detectOperationType(task: string): OperationType {
  const t = task.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|wrong|incorrect|fail)\b/.test(t)) return 'bug_fix';
  if (/\b(add|implement|create|build|feature|new)\b/.test(t)) return 'feature_add';
  if (/\b(refactor|rename|move|restructure|reorganize|clean)\b/.test(t)) return 'refactor';
  if (/\b(test|spec|coverage|unit|integration)\b/.test(t)) return 'test';
  if (/\b(explain|understand|what|how|why|describe)\b/.test(t)) return 'explain';
  return 'auto';
}

// ─── Context resolver ─────────────────────────────────────────────────────────

export class ContextResolver {
  constructor(private store: ArtifactStore) {}

  async resolve(request: ResolveRequest, graph: DependencyGraph | null): Promise<ContextPackage> {
    const startTime = Date.now();

    const operation = request.operation === 'auto'
      ? detectOperationType(request.task)
      : request.operation;

    // Load all available artifacts
    const modules = await this.store.loadAllModules();
    const architecture = await this.store.loadArchitecture();
    const flows = await this.store.loadFlows();

    const candidates: SemanticArtifact[] = [...modules];
    if (flows) candidates.push(flows);

    // Score all candidates
    const taskKeywords = extractKeywords(request.task);

    // Get graph distances from target files if provided
    const graphDistances = new Map<string, number>();
    if (graph && request.targetFiles && request.targetFiles.length > 0) {
      const targetIds = request.targetFiles
        .map(f => graph.pathIndex[f] ?? pathId(f))
        .filter(id => graph.nodes[id]);
      const distances = bfsFromNodes(graph, targetIds, 4);
      distances.forEach((dist, id) => {
        const node = graph.nodes[id];
        if (node) graphDistances.set(node.path, dist);
      });
    }

    const scored: RelevanceScore[] = candidates.map(artifact => {
      return scoreArtifact(artifact, taskKeywords, operation, graphDistances, graph, request.targetFiles);
    });

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    // Architecture is special — always try to include, possibly truncated
    let archIncluded: SemanticArtifact | undefined;
    let tokenBudget = request.budget;

    if (architecture) {
      const archTokens = countTokens(architecture.content);
      const archBudget = Math.floor(request.budget * 0.25); // max 25% of budget
      if (archTokens <= archBudget) {
        archIncluded = architecture;
        tokenBudget -= archTokens;
      } else {
        archIncluded = {
          ...architecture,
          content: truncateToTokens(architecture.content, archBudget),
        };
        tokenBudget -= archBudget;
      }
    }

    // Fill remaining budget with scored artifacts
    const selected: SemanticArtifact[] = [];
    const excluded: string[] = [];
    let usedTokens = archIncluded ? countTokens(archIncluded.content) : 0;

    for (const { artifactId } of scored) {
      if (usedTokens >= request.budget) break;

      const artifact = candidates.find(a => a.id === artifactId);
      if (!artifact) continue;

      const tokens = countTokens(artifact.content);
      if (usedTokens + tokens <= tokenBudget + (archIncluded ? countTokens(archIncluded.content) : 0)) {
        selected.push(artifact);
        usedTokens += tokens;
      } else {
        excluded.push(artifactId);
      }
    }

    // Separate into primary (high relevance) and supporting
    const primary = selected.filter(a => {
      const s = scored.find(sc => sc.artifactId === a.id);
      return s && s.score > 0.4 && a.type === 'module_summary';
    });
    const supporting = selected.filter(a => {
      const s = scored.find(sc => sc.artifactId === a.id);
      return !primary.includes(a) && a.type === 'module_summary';
    });
    const gotchas = selected.filter(a => a.type === 'gotcha_entry');
    const flowArtifacts = selected.filter(a => a.type === 'execution_flow');

    return {
      primary,
      supporting,
      architecture: archIncluded,
      flows: flowArtifacts,
      gotchas,
      tokenCount: usedTokens,
      excluded,
      resolvedIn: Date.now() - startTime,
    };
  }
}

// ─── Scoring algorithm ────────────────────────────────────────────────────────

function scoreArtifact(
  artifact: SemanticArtifact,
  taskKeywords: string[],
  operation: OperationType,
  graphDistances: Map<string, number>,
  graph: DependencyGraph | null,
  targetFiles?: string[],
): RelevanceScore {
  // 1. Keyword match: overlap between task keywords and artifact content + tags
  const artifactKeywords = [
    ...artifact.tags,
    ...extractKeywords(artifact.path ?? ''),
    ...extractKeywords(artifact.content.slice(0, 500)),
  ];
  const keywordMatch = keywordOverlap(taskKeywords, artifactKeywords);

  // 2. Graph proximity: how close is this artifact to the target files?
  let graphProximity = 0.3; // default if no target files
  if (targetFiles && targetFiles.length > 0 && artifact.path) {
    const dist = graphDistances.get(artifact.path);
    if (dist !== undefined) {
      // dist=0 → 1.0, dist=1 → 0.7, dist=2 → 0.4, dist=3 → 0.2
      graphProximity = Math.max(0, 1 - dist * 0.3);
    } else {
      graphProximity = 0.05; // not in graph neighborhood
    }

    // Direct target file match
    if (targetFiles.some(f => artifact.path?.includes(f) || f.includes(artifact.path ?? ''))) {
      graphProximity = 1.0;
    }
  }

  // 3. Operation type relevance
  const opWeights = OPERATION_WEIGHTS[operation];
  const operationRelevance = opWeights[artifact.type] ?? 0.5;

  // 4. Recency of artifact
  const ageMs = Date.now() - Date.parse(artifact.metadata.generatedAt);
  const ageHours = ageMs / 3600000;
  const recency = Math.exp(-ageHours / 168); // decay over 1 week

  // 5. Centrality bonus (for module_summary artifacts)
  let centralityBonus = 0;
  if (artifact.path && graph) {
    const node = graph.nodes[graph.pathIndex[artifact.path] ?? ''];
    if (node) {
      centralityBonus = Math.min(node.importedBy.length / 20, 0.3);
    }
  }

  const score = (
    keywordMatch * 0.35 +
    graphProximity * 0.30 +
    operationRelevance * 0.20 +
    recency * 0.10 +
    centralityBonus * 0.05
  );

  return {
    artifactId: artifact.id,
    score,
    factors: { keywordMatch, graphProximity, operationRelevance, recency, centralityBonus },
  };
}

// ─── Context package formatter ────────────────────────────────────────────────

export function formatContextPackage(pkg: ContextPackage, format: 'text' | 'json' | 'compact'): string {
  if (format === 'json') {
    return JSON.stringify({
      tokenCount: pkg.tokenCount,
      resolvedIn: pkg.resolvedIn,
      primary: pkg.primary.map(a => ({ path: a.path, content: a.content })),
      supporting: pkg.supporting.map(a => ({ path: a.path, content: a.content })),
      architecture: pkg.architecture?.content,
      flows: pkg.flows.map(a => a.content),
      gotchas: pkg.gotchas.map(a => a.content),
      excluded: pkg.excluded,
    }, null, 2);
  }

  if (format === 'compact') {
    const parts: string[] = [];
    if (pkg.architecture) {
      parts.push('## Architecture Overview\n' + pkg.architecture.content);
    }
    for (const a of [...pkg.primary, ...pkg.supporting]) {
      parts.push(`## ${a.path}\n${a.content}`);
    }
    for (const a of pkg.flows) {
      parts.push('## Key Flows\n' + a.content);
    }
    return parts.join('\n\n---\n\n');
  }

  // text format (default)
  const sections: string[] = [];

  sections.push(`📦 Context Package — ${pkg.tokenCount} tokens (resolved in ${pkg.resolvedIn}ms)`);
  if (pkg.excluded.length > 0) {
    sections.push(`⚠️  ${pkg.excluded.length} relevant artifacts excluded due to token budget`);
  }
  sections.push('');

  if (pkg.architecture) {
    sections.push('─'.repeat(60));
    sections.push('🏛️  ARCHITECTURE OVERVIEW');
    sections.push('─'.repeat(60));
    sections.push(pkg.architecture.content);
  }

  if (pkg.primary.length > 0) {
    sections.push('─'.repeat(60));
    sections.push(`📁 PRIMARY MODULES (${pkg.primary.length})`);
    sections.push('─'.repeat(60));
    for (const a of pkg.primary) {
      sections.push(`\n### ${a.path}`);
      sections.push(a.content);
    }
  }

  if (pkg.supporting.length > 0) {
    sections.push('─'.repeat(60));
    sections.push(`📎 SUPPORTING CONTEXT (${pkg.supporting.length})`);
    sections.push('─'.repeat(60));
    for (const a of pkg.supporting) {
      sections.push(`\n### ${a.path}`);
      sections.push(a.content);
    }
  }

  if (pkg.flows.length > 0) {
    sections.push('─'.repeat(60));
    sections.push('🔄 EXECUTION FLOWS');
    sections.push('─'.repeat(60));
    for (const a of pkg.flows) {
      sections.push(a.content);
    }
  }

  if (pkg.gotchas.length > 0) {
    sections.push('─'.repeat(60));
    sections.push('⚠️  GOTCHAS');
    sections.push('─'.repeat(60));
    for (const a of pkg.gotchas) {
      sections.push(a.content);
    }
  }

  return sections.join('\n');
}
