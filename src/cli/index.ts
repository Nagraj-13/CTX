#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

// ── Commands ──────────────────────────────────────────────────────────────────

import { initCommand }    from './commands/init.js';
import { buildCommand }   from './commands/build.js';
import {
  resolveCommand,
  statusCommand,
  moduleCommand,
  searchCommand,
  architectureCommand,
  doctorCommand,
  gcCommand,
} from './commands/query.js';
import {
  branchCommand,
  mergeCommand,
  diffCommand,
} from './commands/branch.js';
import { costCommand } from './commands/cost.js';
import { startMcpServer } from '../mcp/server.js';

// ── Version ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
  try {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const version = await getVersion();
  const program = new Command();

  program
    .name('ctx')
    .description('Semantic context management system for AI coding agents')
    .version(version);

  // ── ctx init ───────────────────────────────────────────────────────────────

  program
    .command('init')
    .description('Initialize CTX in the current repository')
    .option('--provider <type>', 'LLM provider (openai|groq|nvidia_nim|ollama|custom)')
    .option('--model <model>', 'Model identifier')
    .option('--api-key <key>', 'API key (prefer env var CTX_API_KEY)')
    .option('-y, --yes', 'Non-interactive mode with defaults')
    .action(async (opts) => {
      await initCommand(opts).catch(bail);
    });

  // ── ctx build ──────────────────────────────────────────────────────────────

  program
    .command('build')
    .description('Build or incrementally update semantic artifacts')
    .option('--full', 'Force complete rebuild')
    .option('--watch', 'Watch for file changes and rebuild automatically')
    .option('--dry-run', 'Show what would be rebuilt without building')
    .option('--verbose', 'Show detailed progress')
    .action(async (opts) => {
      await buildCommand(opts).catch(bail);
    });

  // ── ctx resolve ────────────────────────────────────────────────────────────

  program
    .command('resolve <task>')
    .description('Resolve compressed semantic context for a task')
    .option('--files <paths...>', 'Target file paths for focused resolution')
    .option('--op <type>', 'Operation type: bug_fix|feature_add|refactor|test|explain|auto')
    .option('--budget <tokens>', 'Max token budget for returned context', '8000')
    .option('--format <format>', 'Output format: text|compact|json', 'text')
    .option('--json', 'Output as JSON (shorthand for --format json)')
    .action(async (task, opts) => {
      await resolveCommand(task, {
        ...opts,
        budget: parseInt(opts.budget),
      }).catch(bail);
    });

  // ── ctx status ─────────────────────────────────────────────────────────────

  program
    .command('status')
    .description('Show build status and artifact freshness')
    .action(async () => {
      await statusCommand().catch(bail);
    });

  // ── ctx module ─────────────────────────────────────────────────────────────

  program
    .command('module <path>')
    .description('Show semantic summary for a specific module')
    .action(async (filePath) => {
      await moduleCommand(filePath).catch(bail);
    });

  // ── ctx search ─────────────────────────────────────────────────────────────

  program
    .command('search <query>')
    .description('Search semantic artifacts by keyword or concept')
    .option('--type <type>', 'Artifact type: module_summary|execution_flow|gotcha_entry|all', 'all')
    .option('--limit <n>', 'Max results', '8')
    .action(async (query, opts) => {
      await searchCommand(query, { ...opts, limit: parseInt(opts.limit) }).catch(bail);
    });

  // ── ctx architecture ───────────────────────────────────────────────────────

  program
    .command('architecture')
    .alias('arch')
    .description('Show system-wide architecture overview')
    .action(async () => {
      await architectureCommand().catch(bail);
    });

  // ── ctx doctor ─────────────────────────────────────────────────────────────

  program
    .command('doctor')
    .description('Validate configuration and provider connectivity')
    .action(async () => {
      await doctorCommand().catch(bail);
    });

  // ── ctx gc ────────────────────────────────────────────────────────────────

  program
    .command('gc')
    .description('Garbage collect old history snapshots')
    .action(async () => {
      await gcCommand().catch(bail);
    });

  // ── ctx cost ──────────────────────────────────────────────────────────────

  program
    .command('cost')
    .description('Estimate token and dollar cost for a build')
    .option('--full', 'Estimate full build')
    .option('--incremental', 'Estimate incremental build')
    .action(async (opts) => {
      await costCommand(opts).catch(bail);
    });

  // ── ctx diff ──────────────────────────────────────────────────────────────

  program
    .command('diff [buildId]')
    .description('Compare current artifacts to a previous build')
    .option('--module <path>', 'Show diff for a specific module')
    .action(async (buildId, opts) => {
      await diffCommand(buildId, opts).catch(bail);
    });

  // ── ctx branch ────────────────────────────────────────────────────────────

  const branchCmd = program
    .command('branch')
    .description('Manage semantic branches');

  branchCmd
    .command('create <name>')
    .description('Create a new semantic branch')
    .option('--description <text>', 'Branch description')
    .action(async (name, opts) => {
      await branchCommand('create', name, opts).catch(bail);
    });

  branchCmd
    .command('list')
    .description('List all semantic branches')
    .action(async () => {
      await branchCommand('list', undefined, {}).catch(bail);
    });

  branchCmd
    .command('delete <name>')
    .description('Delete a semantic branch')
    .action(async (name) => {
      await branchCommand('delete', name, {}).catch(bail);
    });

  branchCmd
    .command('add-context <name>')
    .description('Add semantic context notes to a branch')
    .option('--context <text>', 'Context text to add')
    .option('--module <path>', 'Apply to specific module only')
    .action(async (name, opts) => {
      await branchCommand('add-context', name, opts).catch(bail);
    });

  // ── ctx merge ─────────────────────────────────────────────────────────────

  program
    .command('merge <sourceBranch>')
    .description('Merge a semantic branch into main (LLM-assisted)')
    .option('--into <branch>', 'Target branch (default: main)')
    .option('--auto', 'Automatically resolve conflicts via LLM')
    .option('--review', 'Interactively review each conflict')
    .action(async (sourceBranch, opts) => {
      await mergeCommand(sourceBranch, opts).catch(bail);
    });

  // ── ctx mcp ───────────────────────────────────────────────────────────────

  program
    .command('mcp')
    .description('Start the MCP server for IDE/agent integrations')
    .action(async () => {
      await startMcpServer().catch(bail);
    });

  // ── Parse ─────────────────────────────────────────────────────────────────

  await program.parseAsync(process.argv);

  // Show help if no command given
  if (process.argv.length <= 2) {
    program.help();
  }
}

function bail(err: Error): never {
  console.error('\n' + (err.message.startsWith('CTX') ? err.message : `  Error: ${err.message}`) + '\n');
  process.exit(1);
}

main().catch(bail);
