import chalk from 'chalk';
import ora from 'ora';
import { requireInitialized } from '../../core/config.js';
import { createProvider } from '../../providers/index.js';
import { BuildEngine, BuildProgress } from '../../core/build-engine.js';
import { formatDuration } from '../../utils/helpers.js';

export async function buildCommand(opts: {
  full?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  watch?: boolean;
}) {
  const { repoRoot, config, paths } = await requireInitialized();

  // Dry-run doesn't need a real provider
  const provider = opts.dryRun
    ? { name: 'dry-run', model: 'none', complete: async () => '', estimateTokens: () => 0, contextWindowSize: 128000 }
    : createProvider(config);

  const engine = new BuildEngine(repoRoot, paths, config, provider as never);

  if (opts.watch) {
    await runWatch(engine, opts);
    return;
  }

  await runBuild(engine, { ...opts, repoRoot });
}

async function runBuild(
  engine: BuildEngine,
  opts: { full?: boolean; dryRun?: boolean; verbose?: boolean; repoRoot: string },
) {
  console.log('');
  if (opts.dryRun) {
    console.log(chalk.dim('  [dry-run] No files will be written\n'));
  }

  const spinner = ora({ text: 'Initializing...', prefixText: ' ' }).start();
  let lastPhase = '';

  const result = await engine.build(
    { full: opts.full, dryRun: opts.dryRun },
    (progress: BuildProgress) => {
      const pct = progress.total > 0
        ? Math.round((progress.current / progress.total) * 100)
        : 0;
      const bar = makeBar(pct, 20);

      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        if (opts.verbose && progress.current > 0) {
          spinner.succeed(chalk.dim(progress.phase));
        }
      }

      const msg = progress.message
        ? chalk.dim(truncate(progress.message, 45))
        : '';

      spinner.text = `${chalk.bold(progress.phase)} ${bar} ${chalk.cyan(pct + '%')} ${msg}`;
    },
  );

  if (result.success) {
    spinner.succeed(chalk.green('Build complete'));
  } else {
    spinner.fail(chalk.red('Build failed'));
  }

  console.log('');

  // Stats
  const rows = [
    ['Duration',    formatDuration(result.durationMs)],
    ['Mode',        result.incremental ? chalk.cyan('incremental') : chalk.yellow('full')],
    ['Modules',     `${result.modulesBuilt} built / ${result.totalModules} total`],
    ['Tokens used', result.tokensUsed.toLocaleString()],
  ];

  if (result.healthScore) {
    const gradeColor = result.healthScore.grade === 'A' || result.healthScore.grade === 'B' ? chalk.green 
                     : result.healthScore.grade === 'C' ? chalk.yellow : chalk.red;
    
    rows.push(['Health Grade', gradeColor(`${result.healthScore.grade} (${result.healthScore.score}/100)`)]);
    if (result.totalPatterns) rows.push(['Patterns', chalk.blue(`${result.totalPatterns} detected`)]);
    if (result.totalSecurityIssues) rows.push(['Security', chalk.red(`${result.totalSecurityIssues} issues`)]);
  }

  if (!opts.dryRun) {
    const savedTokensPerSession = Math.round(result.totalModules * 1800 * 0.75);
    rows.push(['Est. savings', chalk.green(`~${savedTokensPerSession.toLocaleString()} tokens/session`)]);
  }

  for (const [label, value] of rows) {
    console.log(`  ${chalk.dim(label.padEnd(14))} ${value}`);
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log(chalk.yellow(`  ⚠  ${result.errors.length} error(s):`));
    for (const err of result.errors.slice(0, 5)) {
      console.log(chalk.dim(`     ${err}`));
    }
    if (result.errors.length > 5) {
      console.log(chalk.dim(`     ...and ${result.errors.length - 5} more`));
    }
  }

  console.log('');

  if (result.success && !opts.dryRun) {
    console.log(chalk.dim('  Run `ctx resolve "your task"` to use the context'));
    console.log('');
  }
}

async function runWatch(engine: BuildEngine, opts: { full?: boolean; verbose?: boolean }) {
  const { watch } = await import('fs');
  const { requireInitialized } = await import('../../core/config.js');
  const { repoRoot } = await requireInitialized();

  console.log(chalk.dim('\n  Watching for changes... (Ctrl+C to stop)\n'));

  // Initial build
  await runBuild(engine, { ...opts, repoRoot });

  let debounceTimer: NodeJS.Timeout | null = null;
  const watcher = watch(repoRoot, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    // Ignore .ctx dir changes and non-source files
    if (filename.startsWith('.ctx') || filename.includes('node_modules')) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log(chalk.dim(`\n  Changed: ${filename}`));
      await runBuild(engine, { ...opts, repoRoot });
    }, 1500);
  });

  // Keep alive
  await new Promise((_, reject) => {
    process.on('SIGINT', () => {
      watcher.close();
      console.log(chalk.dim('\n  Watch mode stopped\n'));
      process.exit(0);
    });
  });
}

function makeBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function truncate(s: string, max: number): string {
  return s.length > max ? '…' + s.slice(s.length - max + 1) : s;
}
