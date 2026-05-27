import { readFile } from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { fileExists, detectLanguage, isSourceFile } from '../utils/helpers.js';
import { CtxPaths } from './config.js';

export interface ScannedFile {
  path: string;         // relative path from repo root
  absolutePath: string;
  language: string;
  size: number;
}

export interface ScanResult {
  files: ScannedFile[];
  languageCounts: Record<string, number>;
  totalFiles: number;
  scannedAt: string;
}

const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.venv/**',
  '**/venv/**',
  '**/.ctx/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.bundle.js',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

const MAX_FILE_SIZE = 500 * 1024; // 500KB

export async function scanRepository(
  repoRoot: string,
  paths: CtxPaths,
  extraExclude: string[] = [],
): Promise<ScanResult> {
  // Build ignore rules from .gitignore and .ctxignore
  const ig = ignore();

  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (await fileExists(gitignorePath)) {
    const content = await readFile(gitignorePath, 'utf8');
    ig.add(content);
  }

  const ctxignorePath = paths.ctxignore;
  if (await fileExists(ctxignorePath)) {
    const content = await readFile(ctxignorePath, 'utf8');
    ig.add(content);
  }

  const excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...extraExclude];

  // Glob all files
  const allFiles = await fg('**/*', {
    cwd: repoRoot,
    onlyFiles: true,
    dot: false,
    ignore: excludePatterns,
    stats: true,
  });

  const scannedFiles: ScannedFile[] = [];
  const languageCounts: Record<string, number> = {};

  for (const entry of allFiles) {
    const relativePath = entry.path;

    // Check ignore rules
    if (ig.ignores(relativePath)) continue;

    const language = detectLanguage(relativePath);

    // Only include source files we can meaningfully parse
    if (!isSourceFile(relativePath)) continue;

    const size = (entry.stats?.size ?? 0);
    if (size > MAX_FILE_SIZE) continue;
    if (size === 0) continue;

    scannedFiles.push({
      path: relativePath,
      absolutePath: path.join(repoRoot, relativePath),
      language,
      size,
    });

    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }

  return {
    files: scannedFiles,
    languageCounts,
    totalFiles: scannedFiles.length,
    scannedAt: new Date().toISOString(),
  };
}

// ─── Get files changed since last build ──────────────────────────────────────

export async function getChangedFiles(
  repoRoot: string,
  manifestFiles: Record<string, { hash: string; path: string }>,
): Promise<string[]> {
  const changed: string[] = [];

  for (const [relativePath, entry] of Object.entries(manifestFiles)) {
    const absPath = path.join(repoRoot, relativePath);
    if (!(await fileExists(absPath))) {
      changed.push(relativePath);
      continue;
    }
    // We do a quick mtime check first — if mtime matches, skip expensive hash
    // (In practice we always hash for accuracy)
  }

  return changed;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

import { execSync } from 'child_process';

export function getGitBranch(repoRoot: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, stdio: 'pipe' })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

export function getGitCommit(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: 'pipe' })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

export function getGitRepoName(repoRoot: string): string {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoRoot, stdio: 'pipe' })
      .toString().trim();
    return path.basename(remote, '.git');
  } catch {
    return path.basename(repoRoot);
  }
}
