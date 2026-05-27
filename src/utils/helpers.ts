import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { getEncoding } from 'js-tiktoken';

// ─── Hashing ─────────────────────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function fileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function shortId(hash: string): string {
  return hash.slice(0, 8);
}

// ─── Token counting ───────────────────────────────────────────────────────────

let _encoder: ReturnType<typeof getEncoding> | null = null;

function getEncoder() {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base');
  }
  return _encoder;
}

export function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length;
  } catch {
    // Fallback: approximate 4 chars per token
    return Math.ceil(text.length / 4);
  }
}

// ─── File system helpers ──────────────────────────────────────────────────────

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function normalizePath(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, path.resolve(repoRoot, filePath));
}

export function pathId(relativePath: string): string {
  return sha256(relativePath.replace(/\\/g, '/'));
}

// ─── Language detection ───────────────────────────────────────────────────────

const EXT_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'shell',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
};

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] || 'unknown';
}

export const SOURCE_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'ruby',
  'kotlin', 'swift', 'cpp', 'c', 'csharp', 'php',
]);

export function isSourceFile(filePath: string): boolean {
  return SOURCE_LANGUAGES.has(detectLanguage(filePath));
}

// ─── Text utilities ───────────────────────────────────────────────────────────

export function extractKeywords(text: string): string[] {
  // Extract meaningful words (length > 3, not stop words)
  const stopWords = new Set([
    'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have',
    'are', 'was', 'were', 'been', 'will', 'would', 'could', 'should',
    'what', 'when', 'where', 'which', 'who', 'how', 'into', 'onto',
    'then', 'than', 'them', 'they', 'their', 'there', 'here',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .filter((v, i, arr) => arr.indexOf(v) === i); // unique
}

export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const matches = a.filter(w => setB.has(w)).length;
  return matches / Math.max(a.length, b.length);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const chars = maxTokens * 4; // approximate
  if (text.length <= chars) return text;
  return text.slice(0, chars) + '\n\n[...truncated to fit token budget...]';
}

// ─── JSON safe parse ──────────────────────────────────────────────────────────

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }
}

// ─── Time formatting ──────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function uuid(): string {
  return createHash('sha256').update(Date.now() + Math.random().toString()).digest('hex').slice(0, 32);
}
