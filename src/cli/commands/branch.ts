import chalk from 'chalk';
import { requireInitialized } from '../../core/config.js';
import { ArtifactStore } from '../../core/artifacts.js';
import { BranchManager, MergeEngine } from '../../core/branch.js';
import { createProvider } from '../../providers/index.js';
import { formatTimestamp } from '../../utils/helpers.js';

// ─── ctx branch ───────────────────────────────────────────────────────────────

export async function branchCommand(
  action: 'create' | 'list' | 'delete' | 'add-context',
  name: string | undefined,
  opts: {
    description?: string;
    module?: string;
    context?: string;
  },
) {
  const { config, paths } = await requireInitialized();
  const store = new ArtifactStore(paths);
  const manager = new BranchManager(paths, store);

  switch (action) {
    case 'create': {
      if (!name) {
        console.error(chalk.red('  Branch name required'));
        process.exit(1);
      }
      await manager.create(name, opts.description);
      console.log(chalk.green(`\n  ✓ Branch "${name}" created\n`));
      console.log(chalk.dim('  Use `ctx branch add-context <name>` to add semantic notes'));
      console.log(chalk.dim('  Use `ctx branch merge <name>` to merge back\n'));
      break;
    }

    case 'list': {
      const branches = await manager.list();
      const current = await manager.getCurrent();

      console.log(chalk.bold('\n  Semantic Branches\n'));

      if (branches.length === 0) {
        console.log(chalk.dim('  No branches. Create one: ctx branch create <name>\n'));
        return;
      }

      for (const branch of branches) {
        const isCurrent = branch.name === current;
        const prefix = isCurrent ? chalk.cyan('* ') : '  ';
        console.log(prefix + chalk.bold(branch.name) + chalk.dim(` (${formatTimestamp(branch.lastUpdated)})`));
        if (branch.description) {
          console.log('    ' + chalk.dim(branch.description));
        }
        console.log('    ' + chalk.dim(`Overrides: ${branch.overrides.length} module(s) | Parent: ${branch.parent}`));
      }
      console.log('');
      break;
    }

    case 'add-context': {
      if (!name) {
        console.error(chalk.red('  Branch name required'));
        process.exit(1);
      }
      const contextText = opts.context;
      if (!contextText) {
        console.error(chalk.red('  Context text required: --context "..."'));
        process.exit(1);
      }
      await manager.addContext(name, contextText, opts.module);
      console.log(chalk.green(`\n  ✓ Context added to branch "${name}"\n`));
      break;
    }

    case 'delete': {
      if (!name) {
        console.error(chalk.red('  Branch name required'));
        process.exit(1);
      }
      await manager.delete(name);
      console.log(chalk.green(`\n  ✓ Branch "${name}" deleted\n`));
      break;
    }
  }
}

// ─── ctx merge ────────────────────────────────────────────────────────────────

export async function mergeCommand(
  sourceBranch: string,
  opts: {
    into?: string;
    auto?: boolean;
    review?: boolean;
  },
) {
  const { config, paths } = await requireInitialized();
  const store = new ArtifactStore(paths);
  const provider = createProvider(config);
  const engine = new MergeEngine(paths, store, provider);

  const target = opts.into ?? 'main';
  const auto = opts.auto ?? !opts.review;

  console.log(chalk.bold(`\n  Merging "${sourceBranch}" → "${target}"\n`));

  if (!auto) {
    console.log(chalk.dim('  Interactive review mode (--review)\n'));
  }

  try {
    const result = await engine.merge(sourceBranch, target, auto);

    if (result.conflicts === 0) {
      console.log(chalk.green(`  ✓ Clean merge — ${result.resolved} artifact(s) applied\n`));
    } else if (auto) {
      console.log(chalk.green(`  ✓ Merge complete`));
      console.log(`  ${chalk.cyan(result.conflicts)} conflict(s) resolved by LLM`);
      console.log(`  ${chalk.cyan(result.resolved)} artifact(s) total\n`);
    } else {
      console.log(chalk.yellow(`  ${result.conflicts} conflict(s) require review:`));
      for (const conflict of result.pendingConflicts ?? []) {
        console.log(chalk.dim(`    - ${conflict.moduleId}`));
      }
      console.log('');
      console.log(chalk.dim('  Re-run with --auto to resolve via LLM, or edit manually\n'));
    }

    if (result.errors.length > 0) {
      console.log(chalk.yellow(`  ⚠  ${result.errors.length} error(s):`));
      for (const e of result.errors) console.log(chalk.dim('    ' + e));
    }
  } catch (err) {
    console.error(chalk.red(`  Merge failed: ${(err as Error).message}\n`));
    process.exit(1);
  }
}

// ─── ctx diff ─────────────────────────────────────────────────────────────────

export async function diffCommand(buildId?: string, opts: { module?: string } = {}) {
  const { paths } = await requireInitialized();
  const store = new ArtifactStore(paths);

  const current = await store.loadManifest() as Record<string, unknown> | null;
  if (!current) {
    console.error(chalk.red('  No current build. Run: ctx build'));
    process.exit(1);
  }

  if (opts.module) {
    const artifact = await store.loadModule(opts.module);
    if (!artifact) {
      console.error(chalk.red(`  No artifact for: ${opts.module}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\n  Module: ${opts.module}\n`));
    console.log(chalk.dim(`  Version ${artifact.metadata.version} | Generated ${formatTimestamp(artifact.metadata.generatedAt)}`));
    console.log(chalk.dim(`  Source hash: ${artifact.metadata.sourceHash.slice(0, 8)}\n`));
    console.log(artifact.content);
    return;
  }

  // Show build diff summary
  const stats = current.buildStats as Record<string, unknown>;
  console.log(chalk.bold('\n  Build Summary\n'));
  console.log(`  ${chalk.dim('Build ID')}       ${current.buildId}`);
  console.log(`  ${chalk.dim('Timestamp')}      ${formatTimestamp(current.timestamp as string)}`);
  console.log(`  ${chalk.dim('Modules rebuilt')} ${stats?.modulesRebuilt}`);
  console.log(`  ${chalk.dim('Total modules')}  ${stats?.totalModules}`);
  console.log(`  ${chalk.dim('Files')}          ${stats?.totalFiles}`);
  console.log('');
}
