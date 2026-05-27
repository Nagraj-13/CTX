import { LLMProvider, SemanticArtifact, CtxConfig, GraphNode, DependencyGraph } from './types.js';
import { sha256, countTokens, truncateToTokens } from '../utils/helpers.js';
import { summarizeGraph, getModuleGroups } from './graph.js';

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildModuleSummaryPrompt(
  filePath: string,
  language: string,
  sourceContent: string,
  depSummaries: string,
  maxTokens: number,
  previousSummary?: string,
): { system: string; user: string } {
  const system = `You are a technical documentation expert. Generate precise, structured semantic summaries for software modules consumed by AI coding agents. Be concrete and accurate. Focus on what the module does, how it's used, and what's non-obvious. Output ONLY the markdown content, no preamble.`;

  const isUpdate = !!previousSummary;

  const user = isUpdate
    ? `Update this semantic summary to reflect the current code. Only update what changed. Mark changed sections with [UPDATED].

PREVIOUS SUMMARY:
${previousSummary}

CURRENT SOURCE (${language}) — ${filePath}:
\`\`\`${language}
${truncateToTokens(sourceContent, maxTokens - 500)}
\`\`\`

Output the full updated summary in the same structure.`
    : `Generate a semantic summary for this module.

MODULE PATH: ${filePath}
LANGUAGE: ${language}

SOURCE CODE:
\`\`\`${language}
${truncateToTokens(sourceContent, maxTokens - 600)}
\`\`\`

${depSummaries ? `KEY DEPENDENCIES (brief summaries):\n${depSummaries}\n` : ''}
OUTPUT STRUCTURE — use exactly these sections, be concise:

## Purpose
One paragraph: what this module does and why it exists.

## Public API
Each exported symbol with a one-line description. If none, omit.

## Key Patterns
2–4 notable implementation patterns or design choices. If straightforward, omit.

## Dependencies
Which modules does this depend on and what does it use from each? Only local dependencies.

## Gotchas
1–3 things that trip up developers new to this module. If none, omit.

## Change Surface
What kinds of changes typically happen here?`;

  return { system, user };
}

function buildArchitecturePrompt(
  repoName: string,
  languages: string[],
  moduleCount: number,
  groupedSummaries: string,
  graphSummary: string,
): { system: string; user: string } {
  const system = `You are a senior software architect. Generate a high-level architecture document for an AI coding agent. Be architectural — focus on structure, patterns, and key decisions. Output ONLY the markdown content.`;

  const user = `Generate an architecture overview for this repository.

REPOSITORY: ${repoName}
LANGUAGES: ${languages.join(', ')}
MODULE COUNT: ${moduleCount}

MODULE SUMMARIES BY DOMAIN:
${truncateToTokens(groupedSummaries, 6000)}

DEPENDENCY GRAPH:
${graphSummary}

OUTPUT STRUCTURE:

## System Overview
2–3 paragraphs: what this system is, its purpose, key architectural characteristics.

## Major Subsystems
For each major subsystem: name, purpose, key modules, internal structure.

## Data Flow
How data moves through the system for the 2–3 most important workflows.

## Technology Stack
Languages, frameworks, key dependencies.

## Architectural Decisions
3–5 notable design choices made in this codebase.

## Extension Points
How new features are typically added.`;

  return { system, user };
}

function buildFlowsPrompt(
  repoName: string,
  topModules: GraphNode[],
  moduleSummaries: string,
): { system: string; user: string } {
  const system = `You are a technical writer. Extract and describe the key execution flows in this codebase for AI coding agents. Output ONLY the markdown content.`;

  const user = `Extract the 3–5 most important execution flows from this codebase.

REPOSITORY: ${repoName}

TOP MODULES:
${topModules.slice(0, 10).map(m => `- ${m.path} (${m.symbolExports.map(s => s.name).slice(0, 5).join(', ')})`).join('\n')}

MODULE SUMMARIES:
${truncateToTokens(moduleSummaries, 5000)}

For each flow, provide:
## Flow: [Name]
**Trigger**: what initiates this flow
**Steps**: numbered list of module → module interactions
**Key functions**: the most important function calls
**Notes**: edge cases or important considerations`;

  return { system, user };
}

function buildContextPrimerPrompt(
  repoName: string,
  architectureSummary: string,
  moduleGroups: Record<string, string[]>,
): { system: string; user: string } {
  const system = `You are writing a brief context primer for an AI coding agent. Output ONLY the markdown content. Keep it under 600 tokens.`;

  const user = `Write a context primer for an AI coding agent working on this repository.

REPOSITORY: ${repoName}
MODULE GROUPS: ${Object.keys(moduleGroups).join(', ')}

ARCHITECTURE SUMMARY:
${truncateToTokens(architectureSummary, 2000)}

The primer should:
1. Introduce the project in 2-3 sentences
2. List the major subsystems with one-line descriptions
3. Explain how to use ctx_resolve tool before any task
4. Mention any critical gotchas

Format as clean markdown under 500 tokens. Do not add headers beyond what's needed.`;

  return { system, user };
}

// ─── Semantic compiler class ──────────────────────────────────────────────────

export class SemanticCompiler {
  constructor(
    private provider: LLMProvider,
    private config: CtxConfig,
  ) {}

  async compileModule(
    filePath: string,
    language: string,
    sourceContent: string,
    depSummaries: string = '',
    previousSummary?: string,
  ): Promise<SemanticArtifact> {
    const maxTokens = this.config.build.maxTokensPerModule;
    const { system, user } = buildModuleSummaryPrompt(
      filePath, language, sourceContent, depSummaries, maxTokens, previousSummary
    );

    const content = await this.provider.complete({
      system, user,
      maxTokens,
      temperature: 0.1,
    });

    return makeArtifact('module_summary', filePath, content, this.provider, sha256(sourceContent));
  }

  async compileArchitecture(
    repoName: string,
    graph: DependencyGraph,
    moduleSummariesByGroup: Record<string, string>,
  ): Promise<SemanticArtifact> {
    const languages = [...new Set(Object.values(graph.nodes).map(n => n.language))];
    const moduleCount = Object.keys(graph.nodes).length;
    const graphSummary = summarizeGraph(graph);

    const groupedText = Object.entries(moduleSummariesByGroup)
      .map(([group, summary]) => `### Domain: ${group}\n${summary}`)
      .join('\n\n---\n\n');

    const { system, user } = buildArchitecturePrompt(
      repoName, languages, moduleCount, groupedText, graphSummary
    );

    const content = await this.provider.complete({
      system, user,
      maxTokens: 2500,
      temperature: 0.2,
    });

    return makeArtifact('architecture_overview', '', content, this.provider, sha256(groupedText));
  }

  async compileFlows(
    repoName: string,
    graph: DependencyGraph,
    moduleSummaries: Record<string, string>,
  ): Promise<SemanticArtifact> {
    const topNodes = Object.values(graph.nodes)
      .sort((a, b) => b.semanticWeight - a.semanticWeight)
      .slice(0, 15);

    const summaryText = topNodes
      .map(n => moduleSummaries[n.path] ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n');

    const { system, user } = buildFlowsPrompt(repoName, topNodes, summaryText);

    const content = await this.provider.complete({
      system, user,
      maxTokens: 2000,
      temperature: 0.2,
    });

    return makeArtifact('execution_flow', '', content, this.provider, sha256(summaryText));
  }

  async compileContextPrimer(
    repoName: string,
    architectureArtifact: SemanticArtifact,
    graph: DependencyGraph,
  ): Promise<string> {
    const groups = getModuleGroups(graph);
    const { system, user } = buildContextPrimerPrompt(
      repoName, architectureArtifact.content, groups
    );

    const content = await this.provider.complete({
      system, user,
      maxTokens: 700,
      temperature: 0.1,
    });

    // Prepend a standard header
    return `# ${repoName} — CTX Context Primer

> This file is auto-generated by CTX. Update by running \`ctx build\`.
> For task-specific context, use: \`ctx resolve "your task"\`

${content}

---
*Built: ${new Date().toISOString()} | Use \`ctx status\` to check freshness*
`;
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeArtifact(
  type: SemanticArtifact['type'],
  filePath: string,
  content: string,
  provider: LLMProvider,
  sourceHash: string,
  version: number = 1,
): SemanticArtifact {
  return {
    id: sha256(content),
    type,
    path: filePath,
    content,
    metadata: {
      generatedAt: new Date().toISOString(),
      generatedBy: `${provider.name}/${provider.model}`,
      sourceHash,
      tokenCount: countTokens(content),
      version,
      confidence: 0.85,
    },
    tags: extractTagsFromContent(content, filePath),
  };
}

function extractTagsFromContent(content: string, filePath: string): string[] {
  const tags: string[] = [];

  // From file path
  const parts = filePath.split('/');
  for (const part of parts) {
    if (part && !part.includes('.') && part.length > 2) {
      tags.push(part.toLowerCase());
    }
  }

  // Extract capitalized words from content (likely module/function names)
  const words = content.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const frequent = [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w.toLowerCase());

  return [...new Set([...tags, ...frequent])];
}
