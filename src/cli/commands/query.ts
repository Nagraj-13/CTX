import chalk from 'chalk';
import ora from 'ora';
import { requireInitialized } from '../../core/config.js';
import { ArtifactStore } from '../../core/artifacts.js';
import { ContextResolver, formatContextPackage, detectOperationType } from '../../core/resolver.js';
import { DependencyGraph, OperationType } from '../../core/types.js';
import { validateProvider } from '../../providers/index.js';
import { formatTimestamp, formatDuration } from '../../utils/helpers.js';

// ─── ctx resolve ──────────────────────────────────────────────────────────────

export async function resolveCommand(
  task: string,
  opts: {
    files?: string[];
    op?: string;
    budget?: number;
    format?: string;
    json?: boolean;
  },
) {
  const { repoRoot, config, paths } = await requireInitialized();
  const store = new ArtifactStore(paths);
  const resolver = new ContextResolver(store);

  const manifest = await store.loadManifest();
  if (!manifest) {
    console.error(chalk.red('  No artifacts found. Run: ctx build'));
    process.exit(1);
  }

  const spinner = ora({ prefixText: ' ', text: 'Resolving context...' }).start();

  const graph = (await store.loadGraph()) as DependencyGraph | null;

  const operation = (opts.op as OperationType) ?? detectOperationType(task);
  const budget = opts.budget ?? 8000;

  try {
    const pkg = await resolver.resolve(
      {
        task,
        targetFiles: opts.files,
        operation,
        budget,
      },
      graph,
    );

    spinner.succeed(
      `Context resolved — ${chalk.cyan(pkg.tokenCount.toLocaleString())} tokens in ${chalk.dim(pkg.resolvedIn + 'ms')}`
    );

    const format = opts.json
      ? 'json'
      : (opts.format as 'text' | 'compact' | 'json') ?? 'text';

    console.log('\n' + formatContextPackage(pkg, format));

    if (pkg.excluded.length > 0 && format !== 'json') {
      console.log(chalk.dim(`\n  ⚠  ${pkg.excluded.length} relevant artifacts excluded — increase --budget to include them`));
    }
  } catch (err) {
    spinner.fail(chalk.red('Resolution failed'));
    console.error(chalk.dim((err as Error).message));
    process.exit(1);
  }
}

// ─── ctx status ───────────────────────────────────────────────────────────────

export async function statusCommand() {
  const { repoRoot, config, paths } = await requireInitialized();
  const store = new ArtifactStore(paths);

  const manifest = await store.loadManifest() as Record<string, unknown> | null;

  console.log(chalk.bold('\n  CTX Status\n'));

  if (!manifest) {
    console.log(chalk.yellow('  ✗ Not built yet'));
    console.log(chalk.dim('  Run: ctx build\n'));
    return;
  }

  const ts = manifest.timestamp as string;
  const stats = manifest.buildStats as Record<string, unknown>;
  const ageMs = Date.now() - Date.parse(ts);
  const ageMin = Math.floor(ageMs / 60000);
  const stale = ageMin > 120;

  const rows: Array<[string, string]> = [
    ['Status',      stale ? chalk.yellow('⚠  Stale (' + ageMin + 'm ago)') : chalk.green('✓ Fresh')],
    ['Built',       formatTimestamp(ts)],
    ['Branch',      manifest.branch as string],
    ['Commit',      ((manifest.commitHash as string) ?? 'unknown').slice(0, 8)],
    ['Modules',     String(stats?.totalModules ?? 0)],
    ['Files',       String(stats?.totalFiles ?? 0)],
    ['Tokens used', (stats?.totalTokensConsumed as number ?? 0).toLocaleString()],
    ['Build type',  stats?.incrementalRebuild ? 'incremental' : 'full'],
    ['Provider',    `${(manifest.providerConfig as Record<string, string>)?.type}/${(manifest.providerConfig as Record<string, string>)?.model}`],
  ];

  for (const [label, value] of rows) {
    console.log(`  ${chalk.dim(label.padEnd(14))} ${value}`);
  }

  if (stale) {
    console.log(chalk.dim('\n  Run `ctx build` to refresh\n'));
  } else {
    console.log('');
  }
}

// ─── ctx module ───────────────────────────────────────────────────────────────

export async function moduleCommand(filePath: string) {
  const { paths } = await requireInitialized();
  const store = new ArtifactStore(paths);

  const artifact = await store.loadModule(filePath);
  if (!artifact) {
    // Try fuzzy match
    const all = await store.loadAllModules();
    const match = all.find(a =>
      a.path.endsWith(filePath) || a.path.includes(filePath)
    );
    if (match) {
      console.log(chalk.dim(`\n  Showing: ${match.path}\n`));
      printArtifact(match.path, match.content, match.metadata);
      return;
    }
    console.error(chalk.red(`  No summary for: ${filePath}`));
    console.log(chalk.dim('  Run: ctx build'));
    process.exit(1);
  }

  printArtifact(artifact.path, artifact.content, artifact.metadata);
}

// ─── ctx search ───────────────────────────────────────────────────────────────

export async function searchCommand(
  query: string,
  opts: { type?: string; limit?: number },
) {
  const { paths } = await requireInitialized();
  const store = new ArtifactStore(paths);

  const spinner = ora({ prefixText: ' ', text: `Searching for "${query}"...` }).start();

  try {
    const results = await store.searchArtifacts(
      query,
      opts.type as never,
      opts.limit ?? 8,
    );

    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.dim('\n  No results found.\n'));
      return;
    }

    console.log(`\n  ${results.length} result(s) for "${chalk.cyan(query)}"\n`);

    for (const { artifact, score } of results) {
      const label = artifact.path || artifact.type;
      const bar = '█'.repeat(Math.round(score * 10)) + '░'.repeat(10 - Math.round(score * 10));
      console.log(`  ${chalk.bold(label)} ${chalk.dim(bar)} ${chalk.cyan((score * 100).toFixed(0) + '%')}`);
      // Show first 3 lines of content
      const preview = artifact.content.split('\n').slice(0, 3).join('\n');
      console.log(chalk.dim('  ' + preview.replace(/\n/g, '\n  ')));
      console.log('');
    }
  } catch (err) {
    spinner.fail(chalk.red('Search failed'));
    console.error(chalk.dim((err as Error).message));
    process.exit(1);
  }
}

// ─── ctx architecture ─────────────────────────────────────────────────────────

export async function architectureCommand() {
  const { paths } = await requireInitialized();
  const store = new ArtifactStore(paths);

  const arch = await store.loadArchitecture();
  if (!arch) {
    console.error(chalk.red('  No architecture overview. Run: ctx build'));
    process.exit(1);
  }

  printArtifact('Architecture Overview', arch.content, arch.metadata);
}

// ─── ctx doctor ───────────────────────────────────────────────────────────────

export async function doctorCommand() {
  const { repoRoot, config, paths } = await requireInitialized();

  console.log(chalk.bold('\n  CTX Doctor\n'));

  const checks: Array<{ label: string; fn: () => Promise<{ ok: boolean; msg: string }> }> = [
    {
      label: 'Repository root found',
      fn: async () => ({ ok: true, msg: repoRoot }),
    },
    {
      label: 'Config file readable',
      fn: async () => {
        const { fileExists } = await import('../../utils/helpers.js');
        const ok = await fileExists(paths.configFile);
        return { ok, msg: paths.configFile };
      },
    },
    {
      label: 'Provider connectivity',
      fn: async () => {
        const result = await validateProvider(config);
        return {
          ok: result.ok,
          msg: result.ok ? `${config.provider.type}/${result.model}` : (result.error ?? 'failed'),
        };
      },
    },
    {
      label: 'Semantic artifacts exist',
      fn: async () => {
        const modules = await store.loadAllModules();
        const ok = modules.length > 0;
        return { ok, msg: ok ? `${modules.length} modules` : 'Run ctx build' };
      },
    },
    {
      label: 'Architecture overview',
      fn: async () => {
        const arch = await store.loadArchitecture();
        return { ok: !!arch, msg: arch ? `${arch.metadata.tokenCount} tokens` : 'Run ctx build' };
      },
    },
    {
      label: 'Context primer',
      fn: async () => {
        const { fileExists } = await import('../../utils/helpers.js');
        const ok = await fileExists(paths.contextPrimer);
        return { ok, msg: ok ? paths.contextPrimer : 'Run ctx build' };
      },
    },
    {
      label: 'API key configured',
      fn: async () => {
        const hasKey = !!config.provider.apiKey || config.provider.type === 'ollama';
        return { ok: hasKey, msg: hasKey ? 'set' : 'missing — set CTX_API_KEY env var' };
      },
    },
  ];

  const store = new ArtifactStore(paths);
  let passed = 0;

  for (const check of checks) {
    process.stdout.write(`  ${chalk.dim(check.label.padEnd(35))}`);
    try {
      const { ok, msg } = await check.fn();
      if (ok) {
        console.log(chalk.green('✓') + chalk.dim(' ' + msg));
        passed++;
      } else {
        console.log(chalk.red('✗') + chalk.dim(' ' + msg));
      }
    } catch (err) {
      console.log(chalk.red('✗') + chalk.dim(' ' + (err as Error).message));
    }
  }

  console.log('');
  if (passed === checks.length) {
    console.log(chalk.green('  All checks passed\n'));
  } else {
    console.log(chalk.yellow(`  ${passed}/${checks.length} checks passed\n`));
  }
}

// ─── ctx gc ───────────────────────────────────────────────────────────────────

export async function gcCommand() {
  const { paths } = await requireInitialized();
  const { readdir, rm, stat } = await import('fs/promises');
  const { fileExists } = await import('../../utils/helpers.js');

  console.log(chalk.dim('\n  Garbage collecting old history snapshots...\n'));

  const histDir = paths.historyDir;
  if (!(await fileExists(histDir))) {
    console.log(chalk.dim('  Nothing to clean.\n'));
    return;
  }

  const entries = await readdir(histDir);
  const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  let removed = 0;

  for (const entry of entries) {
    const entryPath = `${histDir}/${entry}`;
    try {
      const s = await stat(entryPath);
      if (Date.now() - s.mtimeMs > maxAge) {
        await rm(entryPath, { recursive: true });
        removed++;
      }
    } catch { /* skip */ }
  }

  console.log(chalk.green(`  ✓ Removed ${removed} old snapshot(s)\n`));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printArtifact(
  label: string,
  content: string,
  meta: { generatedAt: string; generatedBy: string; tokenCount: number },
) {
  console.log('');
  console.log(chalk.bold('  ' + label));
  console.log(chalk.dim(`  Generated ${formatTimestamp(meta.generatedAt)} by ${meta.generatedBy} • ${meta.tokenCount} tokens`));
  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log('');
  // Indent content
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('#')) {
      console.log(chalk.bold('  ' + line));
    } else if (line.startsWith('##')) {
      console.log(chalk.cyan('  ' + line));
    } else {
      console.log('  ' + line);
    }
  }
  console.log('');
}
