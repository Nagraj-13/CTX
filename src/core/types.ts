// ─── Core Data Models ────────────────────────────────────────────────────────

export type ArtifactType =
  | 'module_summary'
  | 'architecture_overview'
  | 'feature_domain'
  | 'execution_flow'
  | 'architectural_decision'
  | 'gotcha_entry'
  | 'symbol_description';

export type OperationType = 'bug_fix' | 'feature_add' | 'refactor' | 'test' | 'explain' | 'auto';

export type ProviderType = 'openai' | 'groq' | 'nvidia_nim' | 'ollama' | 'custom';

export type BuildDepth = 'minimal' | 'standard' | 'deep';

// ─── Symbol / AST Models ─────────────────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'type' | 'const' | 'interface' | 'enum' | 'method';

export interface SymbolExport {
  name: string;
  kind: SymbolKind;
  signature: string;
  signatureHash: string;
  description?: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

export interface ImportStatement {
  source: string;           // raw import path e.g. '../payments/retry'
  resolvedPath?: string;    // absolute resolved path
  symbols: string[];        // named imports
  isTypeOnly: boolean;
  isDynamic: boolean;
  isExternal: boolean;      // npm package vs local file
}

export interface ExtractedSymbols {
  filePath: string;
  language: string;
  imports: ImportStatement[];
  exports: SymbolExport[];
  internals: SymbolExport[];
  signatureHash: string;    // hash of all exported signatures combined
}

// ─── Graph Models ─────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;               // sha256 of normalized file path
  path: string;             // relative file path from repo root
  language: string;
  moduleGroup: string;      // feature domain grouping
  imports: string[];        // ids of nodes this file imports (local only)
  importedBy: string[];     // ids of nodes that import this
  externalDeps: string[];   // npm packages imported
  symbolExports: SymbolExport[];
  semanticWeight: number;   // 0–1: centrality score
  lastSemanticChange: string;
  fileSize: number;
}

export interface DependencyGraph {
  nodes: Record<string, GraphNode>;  // id → node
  pathIndex: Record<string, string>; // relative path → id
  buildTime: string;
  repositoryRoot: string;
}

// ─── Artifact Models ──────────────────────────────────────────────────────────

export interface SemanticArtifact {
  id: string;               // sha256 of content
  type: ArtifactType;
  path: string;             // source file path (empty for repo-level artifacts)
  content: string;          // Markdown content
  metadata: {
    generatedAt: string;
    generatedBy: string;    // 'provider/model'
    sourceHash: string;     // hash of source used for generation
    tokenCount: number;
    version: number;
    confidence: number;
  };
  tags: string[];
}

// ─── Build Models ─────────────────────────────────────────────────────────────

export interface FileManifestEntry {
  path: string;
  hash: string;             // sha256 of file content
  symbolHash: string;       // sha256 of exported signatures
  size: number;
  language: string;
  lastModified: string;
  artifactId: string;
  dirty?: boolean;
  invalidationReason?: string;
}

export interface BuildManifest {
  buildId: string;
  timestamp: string;
  repositoryRoot: string;
  branch: string;
  commitHash: string;
  files: Record<string, FileManifestEntry>;
  artifacts: Record<string, string>;   // source path → artifact id
  graphPath: string;
  buildStats: {
    totalFiles: number;
    totalModules: number;
    totalTokensConsumed: number;
    buildDurationMs: number;
    incrementalRebuild: boolean;
    modulesRebuilt: number;
  };
  providerConfig: {
    type: string;
    model: string;
  };
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  signatureChanged: string[];    // subset of modified: exported API changed
  implOnlyChanged: string[];    // subset of modified: internal impl only
  invalidated: Set<string>;     // full set after propagation
}

// ─── Config Models ────────────────────────────────────────────────────────────

export interface CtxConfig {
  provider: {
    type: ProviderType;
    model: string;
    apiKey?: string;          // prefer env var
    baseUrl?: string;         // for custom / nvidia nim / ollama
  };
  build: {
    depth: BuildDepth;
    languages: string[];
    excludePaths: string[];
    maxTokensPerModule: number;
    parallelWorkers: number;
    batchSize: number;
  };
  features: {
    wikiGeneration: boolean;
    flowExtraction: boolean;
    decisionExtraction: boolean;
    gotchaRegistry: boolean;
  };
  storage: {
    compress: boolean;
    maxSnapshots: number;
    retentionDays: number;
  };
}

export const DEFAULT_CONFIG: CtxConfig = {
  provider: {
    type: 'openai',
    model: 'gpt-4o-mini',
  },
  build: {
    depth: 'standard',
    languages: [],
    excludePaths: [],
    maxTokensPerModule: 2000,
    parallelWorkers: 4,
    batchSize: 8,
  },
  features: {
    wikiGeneration: true,
    flowExtraction: true,
    decisionExtraction: false,
    gotchaRegistry: true,
  },
  storage: {
    compress: false,
    maxSnapshots: 10,
    retentionDays: 30,
  },
};

// ─── Resolution Models ────────────────────────────────────────────────────────

export interface ResolveRequest {
  task: string;
  targetFiles?: string[];
  operation: OperationType;
  budget: number;          // max tokens for returned context
}

export interface RelevanceScore {
  artifactId: string;
  score: number;
  factors: {
    keywordMatch: number;
    graphProximity: number;
    operationRelevance: number;
    recency: number;
    centralityBonus: number;
  };
}

export interface ContextPackage {
  primary: SemanticArtifact[];
  supporting: SemanticArtifact[];
  architecture?: SemanticArtifact;
  flows: SemanticArtifact[];
  gotchas: SemanticArtifact[];
  tokenCount: number;
  excluded: string[];
  resolvedIn: number;      // ms
}

// ─── Branch Models ────────────────────────────────────────────────────────────

export interface BranchMeta {
  name: string;
  createdAt: string;
  parent: string;
  description?: string;
  lastUpdated: string;
  overrides: string[];     // artifact ids that differ from parent
}

// ─── Provider Models ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  stopSequences?: string[];
}

export interface LLMProvider {
  name: string;
  model: string;
  complete(req: CompletionRequest): Promise<string>;
  estimateTokens(text: string): number;
  contextWindowSize: number;
}
