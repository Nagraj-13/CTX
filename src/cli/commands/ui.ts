import chalk from 'chalk';
import { requireInitialized } from '../../core/config.js';
import { startDashboardServer } from '../ui/server.js';

export async function uiCommand(opts: {
  port?: number;
  noOpen?: boolean;
}) {
  const { repoRoot, config, paths } = await requireInitialized();
  const port = opts.port ?? 7331;

  console.log(chalk.bold('\n  CTX Dashboard\n'));
  console.log(chalk.dim(`  Repository: ${repoRoot}`));

  await startDashboardServer({
    repoRoot,
    paths,
    config,
    port,
    openBrowser: !opts.noOpen,
  });
}