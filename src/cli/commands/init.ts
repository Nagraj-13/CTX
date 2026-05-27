import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import * as readline from 'readline/promises';
import chalk from 'chalk';
import { CtxConfig, DEFAULT_CONFIG, ProviderType } from '../../core/types.js';
import {
  CtxPaths, initCtxDirectories, saveConfig, findRepoRoot, DEFAULT_CTXIGNORE,
} from '../../core/config.js';
import { fileExists } from '../../utils/helpers.js';
import { validateProvider } from '../../providers/index.js';

export async function initCommand(opts: {
  provider?: string;
  model?: string;
  apiKey?: string;
  yes?: boolean;
}) {
  const repoRoot = await findRepoRoot();
  const paths = new CtxPaths(repoRoot);

  console.log(chalk.bold('\n  CTX — Semantic Context Manager'));
  console.log(chalk.dim('  ' + repoRoot + '\n'));

  if (await fileExists(paths.configFile)) {
    console.log(chalk.yellow('  ⚠  CTX already initialized. Edit .ctx/config.yaml to reconfigure.\n'));
    if (!opts.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('  Reinitialize? (y/N): ');
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log(chalk.dim('  Aborted.\n'));
        return;
      }
    }
  }

  // Collect config interactively or from flags
  const config: CtxConfig = structuredClone(DEFAULT_CONFIG);

  if (opts.yes) {
    // Non-interactive: use flags or defaults
    config.provider.type = (opts.provider as ProviderType) || 'openai';
    config.provider.model = opts.model || getDefaultModel(config.provider.type);
    if (opts.apiKey) config.provider.apiKey = opts.apiKey;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Provider
    console.log(chalk.dim('  Providers: openai, groq, nvidia_nim, ollama, custom'));
    const providerRaw = await rl.question(`  Provider [${chalk.cyan('openai')}]: `);
    config.provider.type = (providerRaw.trim() as ProviderType) || 'openai';

    // Model
    const defaultModel = getDefaultModel(config.provider.type);
    const modelRaw = await rl.question(`  Model [${chalk.cyan(defaultModel)}]: `);
    config.provider.model = modelRaw.trim() || defaultModel;

    // API Key
    if (config.provider.type !== 'ollama') {
      const envKey = process.env.CTX_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;
      if (envKey) {
        console.log(chalk.dim(`  API key found in environment (${chalk.green('✓')})`));
        config.provider.apiKey = envKey;
      } else {
        const keyRaw = await rl.question('  API key: ');
        config.provider.apiKey = keyRaw.trim();
      }
    } else {
      const baseUrlRaw = await rl.question(`  Ollama URL [${chalk.cyan('http://localhost:11434')}]: `);
      config.provider.baseUrl = baseUrlRaw.trim() || 'http://localhost:11434';
    }

    // Build depth
    const depthRaw = await rl.question(`  Build depth (minimal/standard/deep) [${chalk.cyan('standard')}]: `);
    const depth = depthRaw.trim();
    if (depth === 'minimal' || depth === 'deep') {
      config.build.depth = depth;
    }

    rl.close();
  }

  // Initialize directories
  await initCtxDirectories(repoRoot);

  // Write .ctxignore
  const ctxignorePath = paths.ctxignore;
  if (!(await fileExists(ctxignorePath))) {
    await writeFile(ctxignorePath, DEFAULT_CTXIGNORE, 'utf8');
  }

  // Write gitignore entry for .ctx/config.local.yaml
  await addGitignoreEntry(repoRoot);

  // Save config
  await saveConfig(repoRoot, config);

  // Validate provider
  process.stdout.write('  Checking provider connectivity...');
  const check = await validateProvider(config);
  if (check.ok) {
    console.log(chalk.green(' ✓'));
  } else {
    console.log(chalk.yellow(` ⚠  ${check.error}`));
    console.log(chalk.dim('  (You can continue but ctx build may fail)'));
  }

  // Write CLAUDE.md hint
  await writeClaudioHint(paths);

  console.log(chalk.green('\n  ✓ CTX initialized\n'));
  console.log('  Next steps:');
  console.log(chalk.cyan('    ctx build') + chalk.dim('         — compile semantic artifacts'));
  console.log(chalk.cyan('    ctx doctor') + chalk.dim('        — verify setup'));
  console.log(chalk.cyan('    ctx resolve "task"') + chalk.dim(' — get task context\n'));
}

function getDefaultModel(provider: ProviderType): string {
  const models: Record<ProviderType, string> = {
    openai: 'gpt-4o-mini',
    groq: 'llama-3.3-70b-versatile',
    nvidia_nim: 'meta/llama-3.1-70b-instruct',
    ollama: 'llama3.2:latest',
    custom: 'default',
  };
  return models[provider] ?? 'gpt-4o-mini';
}

async function addGitignoreEntry(repoRoot: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const entry = '.ctx/config.local.yaml';
  if (await fileExists(gitignorePath)) {
    const content = await (await import('fs/promises')).readFile(gitignorePath, 'utf8');
    if (!content.includes(entry)) {
      await (await import('fs/promises')).appendFile(gitignorePath, `\n# CTX local config (contains API keys)\n${entry}\n`);
    }
  }
}

async function writeClaudioHint(paths: CtxPaths): Promise<void> {
  const hintPath = path.join(path.dirname(paths.ctxDir), 'CLAUDE.md');
  if (await fileExists(hintPath)) return; // Don't overwrite existing

  const content = `# Project Context

This project uses **CTX** for semantic context management.

## Using CTX

Before working on any task, get compressed relevant context:
\`\`\`
ctx resolve "your task description"
\`\`\`

For module-specific info:
\`\`\`
ctx module src/path/to/file.ts
\`\`\`

For architecture overview:
\`\`\`
ctx architecture
\`\`\`

> Full project context: see \`.ctx/CONTEXT_PRIMER.md\` (generated after \`ctx build\`)
`;
  await (await import('fs/promises')).writeFile(hintPath, content, 'utf8');
}
