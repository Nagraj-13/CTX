import { readFile, writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { CtxConfig, DEFAULT_CONFIG, ProviderType, BuildDepth } from './types.js';
import { fileExists } from '../utils/helpers.js';

// ─── Zod schema for config validation ────────────────────────────────────────

const ProviderSchema = z.object({
  type: z.enum(['openai', 'groq', 'nvidia_nim', 'ollama', 'custom']),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

const ConfigSchema = z.object({
  provider: ProviderSchema,
  build: z.object({
    depth: z.enum(['minimal', 'standard', 'deep']).default('standard'),
    languages: z.array(z.string()).default([]),
    excludePaths: z.array(z.string()).default([]),
    maxTokensPerModule: z.number().default(2000),
    parallelWorkers: z.number().default(4),
    batchSize: z.number().default(8),
  }).default({}),
  features: z.object({
    wikiGeneration: z.boolean().default(true),
    flowExtraction: z.boolean().default(true),
    decisionExtraction: z.boolean().default(false),
    gotchaRegistry: z.boolean().default(true),
  }).default({}),
  storage: z.object({
    compress: z.boolean().default(false),
    maxSnapshots: z.number().default(10),
    retentionDays: z.number().default(30),
  }).default({}),
});

// ─── CTX directory layout ─────────────────────────────────────────────────────

export class CtxPaths {
  readonly root: string;
  readonly ctxDir: string;

  constructor(repoRoot: string) {
    this.root = repoRoot;
    this.ctxDir = path.join(repoRoot, '.ctx');
  }

  get configFile()     { return path.join(this.ctxDir, 'config.yaml'); }
  get localConfig()    { return path.join(this.ctxDir, 'config.local.yaml'); }
  get ctxignore()      { return path.join(this.root, '.ctxignore'); }
  get contextPrimer()  { return path.join(this.ctxDir, 'CONTEXT_PRIMER.md'); }
  get snapshotDir()    { return path.join(this.ctxDir, 'snapshot'); }
  get manifest()       { return path.join(this.ctxDir, 'snapshot', 'manifest.json'); }
  get graphFile()      { return path.join(this.ctxDir, 'snapshot', 'graph.json'); }
  get symbolIndex()    { return path.join(this.ctxDir, 'snapshot', 'symbol_index.json'); }
  get artifactsDir()   { return path.join(this.ctxDir, 'artifacts'); }
  get modulesDir()     { return path.join(this.ctxDir, 'artifacts', 'modules'); }
  get branchesDir()    { return path.join(this.ctxDir, 'branches'); }
  get historyDir()     { return path.join(this.ctxDir, 'history'); }

  moduleDir(moduleId: string) {
    return path.join(this.modulesDir, moduleId);
  }
  moduleSummary(moduleId: string) {
    return path.join(this.modulesDir, moduleId, 'summary.md');
  }
  moduleMeta(moduleId: string) {
    return path.join(this.modulesDir, moduleId, 'meta.json');
  }
  moduleGotchas(moduleId: string) {
    return path.join(this.modulesDir, moduleId, 'gotchas.md');
  }
  architectureFile()   { return path.join(this.ctxDir, 'artifacts', 'architecture.md'); }
  indexFile()          { return path.join(this.ctxDir, 'artifacts', 'index.md'); }
  flowsFile()          { return path.join(this.ctxDir, 'artifacts', 'flows.md'); }
  decisionsFile()      { return path.join(this.ctxDir, 'artifacts', 'decisions.md'); }
}

// ─── Config reader/writer ─────────────────────────────────────────────────────

export async function loadConfig(repoRoot: string): Promise<CtxConfig> {
  const paths = new CtxPaths(repoRoot);

  if (!(await fileExists(paths.configFile))) {
    throw new Error(`CTX not initialized in ${repoRoot}. Run: ctx init`);
  }

  const raw = YAML.parse(await readFile(paths.configFile, 'utf8')) || {};

  // Merge local config overrides
  let localRaw: Record<string, unknown> = {};
  if (await fileExists(paths.localConfig)) {
    localRaw = YAML.parse(await readFile(paths.localConfig, 'utf8')) || {};
  }

  const merged = deepMerge(raw, localRaw) as Record<string, unknown>;

  // Resolve env var references in API key
  const provider = (merged.provider as Record<string, unknown> | undefined) ?? {};
  const apiKey = provider.apiKey as string | undefined;
  
  if (apiKey && typeof apiKey === 'string') {
    if (apiKey.startsWith('${') && apiKey.endsWith('}')) {
      const envVar = apiKey.slice(2, -1);
      (provider as Record<string, unknown>).apiKey = process.env[envVar] ?? '';
    }
  }

  // Also check standard env vars
  if (!apiKey) {
    (merged as Record<string, unknown>).provider = provider;
    (provider as Record<string, unknown>).apiKey =
      process.env.CTX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GROQ_API_KEY ||
      '';
  }
  
  merged.provider = provider;

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }

  return result.data as CtxConfig;
}

export async function saveConfig(repoRoot: string, config: CtxConfig): Promise<void> {
  const paths = new CtxPaths(repoRoot);

  // Never write the API key to the committed config
  const apiKey = config.provider.apiKey;
  const safeConfig = {
    ...config,
    provider: {
      ...config.provider,
      apiKey: apiKey ? '${CTX_API_KEY}' : undefined,
    },
  };

  await writeFile(paths.configFile, YAML.stringify(safeConfig, { indent: 2 }));

  // Write actual key to local config (gitignored)
  if (apiKey) {
    const localConfig = {
      provider: { apiKey },
    };
    await writeFile(paths.localConfig, YAML.stringify(localConfig, { indent: 2 }));
  }
}

// ─── Directory initializer ────────────────────────────────────────────────────

export async function initCtxDirectories(repoRoot: string): Promise<void> {
  const paths = new CtxPaths(repoRoot);
  const dirs = [
    paths.ctxDir,
    paths.snapshotDir,
    paths.artifactsDir,
    paths.modulesDir,
    paths.branchesDir,
    paths.historyDir,
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

// ─── Find repo root ───────────────────────────────────────────────────────────

export async function findRepoRoot(startDir: string = process.cwd()): Promise<string> {
  let current = path.resolve(startDir);
  while (true) {
    // Check for .ctx dir (already initialized)
    if (await fileExists(path.join(current, '.ctx', 'config.yaml'))) {
      return current;
    }
    // Check for git root
    if (await fileExists(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export async function requireInitialized(startDir?: string): Promise<{ repoRoot: string; config: CtxConfig; paths: CtxPaths }> {
  const repoRoot = await findRepoRoot(startDir);
  const paths = new CtxPaths(repoRoot);
  if (!(await fileExists(paths.configFile))) {
    console.error('CTX not initialized. Run: ctx init');
    process.exit(1);
  }
  const config = await loadConfig(repoRoot);
  return { repoRoot, config, paths };
}

// ─── Default ignore patterns ──────────────────────────────────────────────────

export const DEFAULT_CTXIGNORE = `# CTX ignore patterns
# API keys and secrets
.env
.env.*
*.key
*.pem
*.p12
secrets/
credentials/
.secrets/

# Build outputs
node_modules/
dist/
build/
out/
target/
.next/
.nuxt/
__pycache__/
*.pyc
*.pyo
.venv/
venv/
env/

# Version control
.git/

# Generated files
**/__generated__/**
**/generated/**
*.min.js
*.min.css
*.bundle.js

# Test fixtures (large)
**/fixtures/**/*.json
**/testdata/large/

# Lock files
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock
poetry.lock

# Binaries
*.exe
*.dll
*.so
*.dylib
*.wasm
`;

// ─── Deep merge utility ───────────────────────────────────────────────────────

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (
      typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && overVal !== null && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}
