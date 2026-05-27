import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { CtxPaths, loadConfig } from '../../core/config.js';
import { ArtifactStore } from '../../core/artifacts.js';
import { CtxConfig, DependencyGraph } from '../../core/types.js';
import { fileExists } from '../../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DashboardServerOptions {
    repoRoot: string;
    paths: CtxPaths;
    config: CtxConfig;
    port: number;
    openBrowser: boolean;
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<void> {
    const { repoRoot, paths, config, port } = opts;
    const store = new ArtifactStore(paths);
    const app = express();

    app.use(express.json());

    // ── CORS for local dev ──────────────────────────────────────────────────────
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        next();
    });

    // ── API: manifest / build stats ─────────────────────────────────────────────
    app.get('/api/manifest', async (req, res) => {
        try {
            const manifest = await store.loadManifest();
            res.json(manifest ?? { error: 'No manifest found. Run: ctx build' });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: dependency graph ───────────────────────────────────────────────────
    app.get('/api/graph', async (req, res) => {
        try {
            const raw = await store.loadGraph();
            if (!raw) return res.status(404).json({ error: 'No graph found. Run: ctx build' });

            const graph = raw as DependencyGraph;

            // Transform to D3-friendly format
            const nodes = Object.values(graph.nodes).map(n => ({
                id: n.id,
                path: n.path,
                group: n.moduleGroup,
                language: n.language,
                weight: n.semanticWeight,
                importedByCount: n.importedBy.length,
                importsCount: n.imports.length,
                externalDeps: n.externalDeps,
                exports: n.symbolExports.slice(0, 6).map(s => ({ name: s.name, kind: s.kind })),
            }));

            const links: Array<{ source: string; target: string }> = [];
            for (const node of Object.values(graph.nodes)) {
                for (const importId of node.imports) {
                    links.push({ source: node.id, target: importId });
                }
            }

            res.json({ nodes, links, buildTime: graph.buildTime });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: all module summaries (list) ────────────────────────────────────────
    app.get('/api/modules', async (req, res) => {
        try {
            const modules = await store.loadAllModules();
            res.json(modules.map(m => ({
                id: m.id,
                path: m.path,
                type: m.type,
                tags: m.tags,
                tokenCount: m.metadata.tokenCount,
                generatedAt: m.metadata.generatedAt,
                generatedBy: m.metadata.generatedBy,
                confidence: m.metadata.confidence,
                version: m.metadata.version,
            })));
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: single module detail ───────────────────────────────────────────────
    app.get('/api/module', async (req, res) => {
        const { path: filePath } = req.query as { path: string };
        if (!filePath) return res.status(400).json({ error: 'path required' });
        try {
            const artifact = await store.loadModule(filePath);
            if (!artifact) {
                // fuzzy match
                const all = await store.loadAllModules();
                const match = all.find(a => a.path.endsWith(filePath) || a.path.includes(filePath));
                if (match) return res.json(match);
                return res.status(404).json({ error: `No artifact for: ${filePath}` });
            }
            res.json(artifact);
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: architecture overview ──────────────────────────────────────────────
    app.get('/api/architecture', async (req, res) => {
        try {
            const arch = await store.loadArchitecture();
            res.json(arch ?? { error: 'No architecture. Run: ctx build' });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: blast radius for a given file ─────────────────────────────────────
    app.get('/api/blast-radius', async (req, res) => {
        const { path: filePath } = req.query as { path: string };
        if (!filePath) return res.status(400).json({ error: 'path required' });

        try {
            const raw = await store.loadGraph();
            if (!raw) return res.status(404).json({ error: 'No graph' });
            const graph = raw as DependencyGraph;

            // Fuzzy path resolution — try multiple strategies to find the node
            let startId = graph.pathIndex[filePath];

            if (!startId) {
                // Normalize separators (Windows backslash → forward slash)
                const normalized = filePath.replace(/\\/g, '/');
                startId = graph.pathIndex[normalized];
            }

            if (!startId) {
                // Try suffix match: find a pathIndex key that ends with the query
                const normalized = filePath.replace(/\\/g, '/');
                const keys = Object.keys(graph.pathIndex);
                const suffixMatch = keys.find(k => k.endsWith(normalized) || k.endsWith('/' + normalized));
                if (suffixMatch) startId = graph.pathIndex[suffixMatch];
            }

            if (!startId) {
                // Try substring match: find key that contains the query path
                const normalized = filePath.replace(/\\/g, '/');
                const keys = Object.keys(graph.pathIndex);
                const substringMatch = keys.find(k => k.includes(normalized) || normalized.includes(k));
                if (substringMatch) startId = graph.pathIndex[substringMatch];
            }

            if (!startId) {
                // Node genuinely not found in graph
                return res.json({
                    found: false,
                    origin: filePath,
                    affected: [],
                    totalAffected: 0,
                    reason: 'Module not found in dependency graph. Run `ctx build` to regenerate.',
                });
            }

            // BFS through importedBy edges (who breaks if this changes)
            const visited = new Map<string, number>(); // id → depth
            const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
            visited.set(startId, 0);

            while (queue.length > 0) {
                const { id, depth } = queue.shift()!;
                const node = graph.nodes[id];
                if (!node || depth >= 5) continue;
                for (const importerId of node.importedBy) {
                    if (!visited.has(importerId)) {
                        visited.set(importerId, depth + 1);
                        queue.push({ id: importerId, depth: depth + 1 });
                    }
                }
            }

            const affected = [...visited.entries()]
                .filter(([id]) => id !== startId)
                .map(([id, depth]) => ({
                    id,
                    path: graph.nodes[id]?.path ?? id,
                    depth,
                    group: graph.nodes[id]?.moduleGroup,
                }))
                .sort((a, b) => a.depth - b.depth);

            res.json({ found: true, origin: filePath, affected, totalAffected: affected.length });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── API: search ─────────────────────────────────────────────────────────────
    app.get('/api/search', async (req, res) => {
        const { q, limit } = req.query as { q: string; limit?: string };
        if (!q) return res.status(400).json({ error: 'q required' });
        try {
            const results = await store.searchArtifacts(q, 'all', parseInt(limit ?? '10'));
            res.json(results.map(r => ({
                path: r.artifact.path,
                type: r.artifact.type,
                score: r.score,
                preview: r.snippet || r.artifact.content.slice(0, 300),
                tags: r.artifact.tags,
            })));
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // ── Serve dashboard HTML ────────────────────────────────────────────────────
    app.use((req, res) => {
        res.sendFile(path.join(__dirname, 'dashboard.html'));
    });

    // ── Start ───────────────────────────────────────────────────────────────────
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => resolve());
        server.on('error', reject);
    });

    const url = `http://localhost:${port}`;
    console.log(chalk.green(`  ✓ Dashboard running at ${chalk.cyan(url)}\n`));
    console.log(chalk.dim('  Press Ctrl+C to stop\n'));

    if (opts.openBrowser) {
        const { exec } = await import('child_process');
        const open =
            process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32' ? `start "" "${url}"` :
                    `xdg-open "${url}"`;
        exec(open);
    }

    // Keep alive
    await new Promise<never>((_, reject) => {
        process.on('SIGINT', () => {
            console.log(chalk.dim('\n  Dashboard stopped\n'));
            process.exit(0);
        });
    });
}