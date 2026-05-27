import chalk from 'chalk';
import ora from 'ora';
import { requireInitialized } from '../../core/config.js';
import { scanRepository } from '../../core/scanner.js';
import { ProviderType } from '../../core/types.js';
import { formatDuration } from '../../utils/helpers.js';

interface ProviderCost {
  inputPer1k: number;
  outputPer1k: number;
}

const PROVIDER_COSTS: Record<ProviderType, ProviderCost> = {
  openai:      { inputPer1k: 0.00015, outputPer1k: 0.00060 },
  groq:        { inputPer1k: 0.00006, outputPer1k: 0.00008 },
  nvidia_nim:  { inputPer1k: 0,       outputPer1k: 0 },
  ollama:      { inputPer1k: 0,       outputPer1k: 0 },
  custom:      { inputPer1k: 0,       outputPer1k: 0 },
};

export async function costCommand(opts: { full?: boolean; incremental?: boolean }) {
  const { repoRoot, config, paths } = await requireInitialized();

  const spinner = ora({ prefixText: ' ', text: 'Scanning repository...' }).start();
  const scanResult = await scanRepository(repoRoot, paths, config.build.excludePaths);
  spinner.stop();

  const fileCount = scanResult.totalFiles;
  const tokensPerModule = config.build.maxTokensPerModule;

  // Estimate input tokens: avg ~500 tokens to read each file for summary
  const avgInputPerModule = 800;
  const avgOutputPerModule = tokensPerModule * 0.6;

  const fullBuildInputTokens  = fileCount * avgInputPerModule;
  const fullBuildOutputTokens = fileCount * avgOutputPerModule;

  // Architecture + flows add ~5k tokens
  const archTokens = 8000;
  const totalFullInput  = fullBuildInputTokens  + archTokens;
  const totalFullOutput = fullBuildOutputTokens + archTokens * 0.5;

  // Incremental estimate: assume 5% of files change
  const changedFiles = Math.ceil(fileCount * 0.05);
  const incrementalInput  = changedFiles * avgInputPerModule + 1000;
  const incrementalOutput = changedFiles * avgOutputPerModule;

  const providerCost = PROVIDER_COSTS[config.provider.type];
  const fullCost  = (totalFullInput / 1000 * providerCost.inputPer1k) +
                    (totalFullOutput / 1000 * providerCost.outputPer1k);
  const incrCost  = (incrementalInput / 1000 * providerCost.inputPer1k) +
                    (incrementalOutput / 1000 * providerCost.outputPer1k);

  // Per-session savings
  const rawSessionTokens = fileCount * 1800; // avg tokens to read all files per session
  const ctxSessionTokens = 5000;             // typical ctx resolve output

  console.log(chalk.bold('\n  CTX Cost Estimate\n'));
  console.log(`  Repository: ${chalk.cyan(fileCount)} source files\n`);

  console.log(chalk.bold('  Build costs:'));
  printRow('Full build tokens',       formatTokens(totalFullInput + totalFullOutput));
  printRow('Full build cost',         formatCost(fullCost, config.provider.type));
  printRow('Full build time (est.)',  estimateBuildTime(fileCount));
  console.log('');

  printRow('Incremental build (5% changed)', formatTokens(incrementalInput + incrementalOutput));
  printRow('Incremental cost',        formatCost(incrCost, config.provider.type));
  printRow('Incremental time (est.)', estimateBuildTime(changedFiles));
  console.log('');

  console.log(chalk.bold('  Per-session savings (after build):'));
  printRow('Raw codebase scan',       chalk.red(formatTokens(rawSessionTokens) + '/session'));
  printRow('With CTX',                chalk.green(formatTokens(ctxSessionTokens) + '/session'));
  printRow('Savings',                 chalk.green(formatTokens(rawSessionTokens - ctxSessionTokens) + ' saved/session'));
  const savingsPct = Math.round((1 - ctxSessionTokens / rawSessionTokens) * 100);
  printRow('Reduction',               chalk.green(savingsPct + '%'));

  if (fileCount > 10) {
    const breakEvenSessions = fullCost / ((rawSessionTokens - ctxSessionTokens) / 1000 * providerCost.inputPer1k);
    if (breakEvenSessions < Infinity && breakEvenSessions > 0) {
      console.log('');
      printRow('Break-even', `~${Math.ceil(breakEvenSessions)} sessions`);
    }
  }

  console.log('');
  console.log(chalk.dim(`  Provider: ${config.provider.type}/${config.provider.model}`));
  console.log(chalk.dim('  Estimates are approximate based on average file sizes.\n'));
}

function printRow(label: string, value: string) {
  console.log(`  ${chalk.dim(label.padEnd(36))} ${value}`);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M tokens';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K tokens';
  return n + ' tokens';
}

function formatCost(usd: number, provider: ProviderType): string {
  if (provider === 'ollama' || provider === 'nvidia_nim') return chalk.green('Free (local)');
  if (usd === 0) return chalk.green('$0.00');
  if (usd < 0.01) return chalk.green(`< $0.01`);
  return `$${usd.toFixed(3)}`;
}

function estimateBuildTime(fileCount: number): string {
  // Assume ~2s per LLM call, 8 parallel workers, so files/8 calls
  const calls = Math.ceil(fileCount / 8);
  const ms = calls * 2500;
  return formatDuration(ms);
}
