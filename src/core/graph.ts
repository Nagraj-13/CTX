import { DependencyGraph, GraphNode, ExtractedSymbols } from './types.js';
import { pathId } from '../utils/helpers.js';
import path from 'path';

// ─── Graph builder ────────────────────────────────────────────────────────────

export function buildGraph(
  extractedFiles: ExtractedSymbols[],
  repoRoot: string,
): DependencyGraph {
  const nodes: Record<string, GraphNode> = {};
  const pathIndex: Record<string, string> = {};

  // First pass: create all nodes
  for (const file of extractedFiles) {
    const id = pathId(file.filePath);
    const node: GraphNode = {
      id,
      path: file.filePath,
      language: file.language,
      moduleGroup: inferModuleGroup(file.filePath),
      imports: [],
      importedBy: [],
      externalDeps: file.imports
        .filter(i => i.isExternal)
        .map(i => i.source)
        .filter((v, i, arr) => arr.indexOf(v) === i),
      symbolExports: file.exports,
      semanticWeight: 0,
      lastSemanticChange: new Date().toISOString(),
      fileSize: 0,
      securityIssues: file.securityIssues || [],
      patterns: file.patterns || [],
    };
    nodes[id] = node;
    pathIndex[file.filePath] = id;
  }

  // Second pass: resolve import edges
  for (const file of extractedFiles) {
    const nodeId = pathId(file.filePath);
    const node = nodes[nodeId];

    for (const imp of file.imports) {
      if (imp.isExternal) continue;
      if (!imp.source) continue;

      // Try to resolve the import to a known file
      const resolved = resolveToKnownFile(
        imp.resolvedPath ?? imp.source,
        file.filePath,
        pathIndex,
        repoRoot,
      );

      if (resolved && resolved !== nodeId) {
        // Add forward edge: this file imports resolved
        if (!node.imports.includes(resolved)) {
          node.imports.push(resolved);
        }
        // Add reverse edge: resolved is imported by this file
        const target = nodes[resolved];
        if (target && !target.importedBy.includes(nodeId)) {
          target.importedBy.push(nodeId);
        }
      }
    }
  }

  // Third pass: compute semantic weight (centrality based on in-degree)
  const maxInDegree = Math.max(1, ...Object.values(nodes).map(n => n.importedBy.length));
  for (const node of Object.values(nodes)) {
    node.semanticWeight = Math.min(1, node.importedBy.length / maxInDegree);
  }

  return {
    nodes,
    pathIndex,
    buildTime: new Date().toISOString(),
    repositoryRoot: repoRoot,
  };
}

// ─── Graph queries ────────────────────────────────────────────────────────────

export function getNode(graph: DependencyGraph, pathOrId: string): GraphNode | undefined {
  // Try as ID first
  if (graph.nodes[pathOrId]) return graph.nodes[pathOrId];
  // Try as path
  const id = graph.pathIndex[pathOrId];
  if (id) return graph.nodes[id];
  return undefined;
}

export function getTopModules(graph: DependencyGraph, limit = 20): GraphNode[] {
  return Object.values(graph.nodes)
    .sort((a, b) => b.semanticWeight - a.semanticWeight)
    .slice(0, limit);
}

export function getModuleGroups(graph: DependencyGraph): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const node of Object.values(graph.nodes)) {
    const group = node.moduleGroup;
    if (!groups[group]) groups[group] = [];
    groups[group].push(node.path);
  }
  return groups;
}

// ─── Traversal for context resolution ────────────────────────────────────────

/**
 * BFS from a set of starting node IDs outward through the dependency graph.
 * Returns a map of nodeId → distance.
 */
export function bfsFromNodes(
  graph: DependencyGraph,
  startIds: string[],
  maxDepth: number = 3,
): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const id of startIds) {
    if (graph.nodes[id]) {
      distances.set(id, 0);
      queue.push({ id, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const node = graph.nodes[id];
    if (!node) continue;

    // Traverse both directions
    const neighbors = [...node.imports, ...node.importedBy];
    for (const neighborId of neighbors) {
      if (!distances.has(neighborId)) {
        distances.set(neighborId, depth + 1);
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }
  }

  return distances;
}

// ─── Invalidation propagation ─────────────────────────────────────────────────

/**
 * Given a set of files with signature changes, propagate invalidation
 * through the reverse dependency graph (importedBy edges).
 */
export function propagateInvalidation(
  graph: DependencyGraph,
  signatureChanged: string[],  // file paths
  maxDepth: number = 2,
): Set<string> {
  const invalidated = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [];

  for (const filePath of signatureChanged) {
    invalidated.add(filePath);
    queue.push({ path: filePath, depth: 0 });
  }

  while (queue.length > 0) {
    const { path: fp, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const nodeId = graph.pathIndex[fp];
    if (!nodeId) continue;
    const node = graph.nodes[nodeId];
    if (!node) continue;

    for (const importerId of node.importedBy) {
      const importer = graph.nodes[importerId];
      if (!importer) continue;
      if (!invalidated.has(importer.path)) {
        invalidated.add(importer.path);
        queue.push({ path: importer.path, depth: depth + 1 });
      }
    }
  }

  return invalidated;
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Sort a set of file paths in topological order (dependencies first).
 * This ensures we generate summaries for dependencies before dependents.
 */
export function topologicalSort(
  graph: DependencyGraph,
  filePaths: string[],
): string[] {
  const pathSet = new Set(filePaths);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(fp: string) {
    if (visited.has(fp)) return;
    visited.add(fp);

    const nodeId = graph.pathIndex[fp];
    if (nodeId) {
      const node = graph.nodes[nodeId];
      if (node) {
        for (const importId of node.imports) {
          const importedNode = graph.nodes[importId];
          if (importedNode && pathSet.has(importedNode.path)) {
            visit(importedNode.path);
          }
        }
      }
    }
    result.push(fp);
  }

  for (const fp of filePaths) {
    visit(fp);
  }

  return result;
}

// ─── Graph summary for LLM ────────────────────────────────────────────────────

export function summarizeGraph(graph: DependencyGraph): string {
  const groups = getModuleGroups(graph);
  const topModules = getTopModules(graph, 15);

  const lines: string[] = [
    `Total modules: ${Object.keys(graph.nodes).length}`,
    `Module groups: ${Object.keys(groups).join(', ')}`,
    '',
    'Most central modules (by import count):',
  ];

  for (const node of topModules.slice(0, 10)) {
    lines.push(`  ${node.path} (imported by ${node.importedBy.length} modules)`);
  }

  lines.push('', 'Module groups:');
  for (const [group, paths] of Object.entries(groups)) {
    lines.push(`  ${group}: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`);
  }

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveToKnownFile(
  resolvedPath: string,
  fromFile: string,
  pathIndex: Record<string, string>,
  repoRoot: string,
): string | null {
  if (!resolvedPath) return null;

  // Make sure we use forward slashes for matching
  const normalizedPath = resolvedPath.replace(/\\/g, '/');

  // Try exact match
  if (pathIndex[normalizedPath]) return pathIndex[normalizedPath];

  // Try adding common extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.php', '.rb', '.swift', '.html', '.md', '.json']) {
    const withExt = normalizedPath + ext;
    if (pathIndex[withExt]) return pathIndex[withExt];

    // Try as directory index
    const indexPath = normalizedPath + '/index' + ext;
    if (pathIndex[indexPath]) return pathIndex[indexPath];
  }

  return null;
}

function inferModuleGroup(filePath: string): string {
  const parts = filePath.split('/');

  // Use src/X or first meaningful directory as group
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 0 && parts[srcIdx + 1]) {
    return parts[srcIdx + 1];
  }

  // Common top-level dirs
  const topLevel = parts[0];
  if (['lib', 'pkg', 'internal', 'api', 'core', 'utils', 'services', 'components', 'modules'].includes(topLevel)) {
    return parts[1] ?? topLevel;
  }

  if (parts.length >= 2) return parts[0];
  return 'root';
}
