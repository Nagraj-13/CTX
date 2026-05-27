import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, findRepoRoot, CtxPaths } from '../core/config.js';
import { ArtifactStore } from '../core/artifacts.js';
import { ContextResolver, formatContextPackage, detectOperationType } from '../core/resolver.js';
import { DependencyGraph } from '../core/types.js';

export async function startMcpServer(): Promise<void> {
  const repoRoot = await findRepoRoot();
  const config = await loadConfig(repoRoot);
  const paths = new CtxPaths(repoRoot);
  const store = new ArtifactStore(paths);
  const resolver = new ContextResolver(store);

  const server = new Server(
    { name: 'ctx', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // ── Tool definitions ───────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ctx_resolve',
        description:
          'Get compressed semantic context for a coding task. Use this BEFORE implementing any feature, fixing any bug, or making architectural changes. Returns relevant module summaries, architecture context, and execution flows.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Description of the task or question' },
            files: { type: 'array', items: { type: 'string' }, description: 'Target file paths (optional)' },
            operation: {
              type: 'string',
              enum: ['bug_fix', 'feature_add', 'refactor', 'test', 'explain', 'auto'],
              default: 'auto',
              description: 'Operation type for better context selection',
            },
            budget: { type: 'integer', default: 8000, description: 'Max token budget for returned context' },
            format: { type: 'string', enum: ['text', 'compact', 'json'], default: 'compact' },
          },
          required: ['task'],
        },
      },
      {
        name: 'ctx_module',
        description: 'Get the full semantic summary for a specific module by file path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to repository root' },
          },
          required: ['path'],
        },
      },
      {
        name: 'ctx_search',
        description: 'Search semantic artifacts by keyword or concept.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            type: {
              type: 'string',
              enum: ['module_summary', 'execution_flow', 'architectural_decision', 'gotcha_entry', 'all'],
              default: 'all',
            },
            limit: { type: 'integer', default: 5 },
          },
          required: ['query'],
        },
      },
      {
        name: 'ctx_architecture',
        description: 'Get the system-wide architecture overview. Useful at the start of a session for large features.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'ctx_status',
        description: 'Check if semantic artifacts are current. Returns build metadata and staleness info.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  }));

  // ── Tool handlers ──────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> };

    try {
      if (name === 'ctx_resolve') {
        if (!args) throw new Error('Missing arguments for ctx_resolve');
        const graph = await loadGraph(store);
        const pkg = await resolver.resolve(
          {
            task: args.task as string,
            targetFiles: args.files as string[] | undefined,
            operation: (args.operation as string ?? 'auto') as never,
            budget: (args.budget as number) ?? 8000,
          },
          graph,
        );
        const format = (args.format as 'text' | 'compact' | 'json') ?? 'compact';
        return { content: [{ type: 'text', text: formatContextPackage(pkg, format) }] };
      }

      if (name === 'ctx_module') {
        if (!args) throw new Error('Missing arguments for ctx_module');
        const artifact = await store.loadModule(args.path as string);
        if (!artifact) {
          return { content: [{ type: 'text', text: `No semantic summary found for: ${args.path}\nRun: ctx build` }] };
        }
        return { content: [{ type: 'text', text: `# ${artifact.path}\n\n${artifact.content}` }] };
      }

      if (name === 'ctx_search') {
        if (!args) throw new Error('Missing arguments for ctx_search');
        const results = await store.searchArtifacts(
          args.query as string,
          args.type !== 'all' ? (args.type as never) : undefined,
          (args.limit as number) ?? 5,
        );
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching artifacts found.' }] };
        }
        const text = results.map(({ artifact, score }) =>
          `## ${artifact.path || artifact.type} (score: ${score.toFixed(2)})\n${artifact.content.slice(0, 800)}`
        ).join('\n\n---\n\n');
        return { content: [{ type: 'text', text }] };
      }

      if (name === 'ctx_architecture') {
        const arch = await store.loadArchitecture();
        if (!arch) {
          return { content: [{ type: 'text', text: 'No architecture overview found. Run: ctx build' }] };
        }
        return { content: [{ type: 'text', text: arch.content }] };
      }

      if (name === 'ctx_status') {
        const manifest = await store.loadManifest() as Record<string, unknown> | null;
        if (!manifest) {
          return { content: [{ type: 'text', text: 'CTX not built yet. Run: ctx build' }] };
        }
        const stats = manifest.buildStats as Record<string, unknown>;
        const ts = manifest.timestamp as string;
        const ageMin = Math.floor((Date.now() - Date.parse(ts)) / 60000);
        const status = [
          `Built: ${ts} (${ageMin} minutes ago)`,
          `Modules: ${stats?.totalModules ?? 0}`,
          `Files: ${stats?.totalFiles ?? 0}`,
          `Incremental: ${stats?.incrementalRebuild ? 'yes' : 'no (full build)'}`,
          `Provider: ${(manifest.providerConfig as Record<string, string>)?.type}/${(manifest.providerConfig as Record<string, string>)?.model}`,
          ageMin > 120 ? '⚠️  Artifacts may be stale. Consider running: ctx build' : '✓ Artifacts are fresh',
        ];
        return { content: [{ type: 'text', text: status.join('\n') }] };
      }

      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  // ── Start server ───────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function loadGraph(store: ArtifactStore): Promise<DependencyGraph | null> {
  const raw = await store.loadGraph();
  return raw as DependencyGraph | null;
}
