import { ExtractedSymbols, ImportStatement, SymbolExport, SymbolKind } from './types.js';
import { sha256 } from '../utils/helpers.js';
import path from 'path';

// ─── Language-specific parsers ────────────────────────────────────────────────

type Parser = (content: string, filePath: string, repoRoot: string) => Omit<ExtractedSymbols, 'filePath' | 'language' | 'signatureHash'>;

// ─── TypeScript / JavaScript ──────────────────────────────────────────────────

const tsParser: Parser = (content, filePath, repoRoot) => {
  const imports: ImportStatement[] = [];
  const exports: SymbolExport[] = [];
  const internals: SymbolExport[] = [];

  // Import statements
  const importRegexes = [
    // import { X, Y } from 'module'
    /import\s+(?:type\s+)?(?:\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g,
    // import X from 'module'
    /import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    // import * as X from 'module'
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    // import 'module' (side-effect)
    /import\s+['"]([^'"]+)['"]/g,
    // dynamic import
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // require
    /(?:const|let|var)\s+(?:\{([^}]*)\}|\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  const seenSources = new Set<string>();

  // Named imports: import { A, B } from 'x'
  const namedImportRe = /import\s+(type\s+)?\{\s*([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = namedImportRe.exec(content)) !== null) {
    const isTypeOnly = !!m[1];
    const names = m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const source = m[3];
    if (!seenSources.has(source + ':named')) {
      seenSources.add(source + ':named');
      imports.push({
        source,
        resolvedPath: resolveImportPath(source, filePath, repoRoot),
        symbols: names,
        isTypeOnly,
        isDynamic: false,
        isExternal: !source.startsWith('.') && !source.startsWith('/'),
      });
    }
  }

  // Default imports: import X from 'y'
  const defaultImportRe = /import\s+(type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = defaultImportRe.exec(content)) !== null) {
    const source = m[3];
    if (!seenSources.has(source + ':default')) {
      seenSources.add(source + ':default');
      imports.push({
        source,
        resolvedPath: resolveImportPath(source, filePath, repoRoot),
        symbols: [m[2]],
        isTypeOnly: !!m[1],
        isDynamic: false,
        isExternal: !source.startsWith('.') && !source.startsWith('/'),
      });
    }
  }

  // Dynamic imports
  const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    const source = m[1];
    if (!seenSources.has(source + ':dyn')) {
      seenSources.add(source + ':dyn');
      imports.push({
        source,
        resolvedPath: resolveImportPath(source, filePath, repoRoot),
        symbols: [],
        isTypeOnly: false,
        isDynamic: true,
        isExternal: !source.startsWith('.') && !source.startsWith('/'),
      });
    }
  }

  // Exported functions
  const lines = content.split('\n');

  // export function X(...) / export async function X(...)
  const exportFnRe = /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)/;
  // export const X = (...) =>
  const exportArrowRe = /^export\s+const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/;
  // export class X
  const exportClassRe = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;
  // export interface X
  const exportInterfaceRe = /^export\s+(?:default\s+)?interface\s+(\w+)/;
  // export type X
  const exportTypeRe = /^export\s+type\s+(\w+)/;
  // export enum X
  const exportEnumRe = /^export\s+(?:const\s+)?enum\s+(\w+)/;
  // export const X (non-function)
  const exportConstRe = /^export\s+(?:readonly\s+)?const\s+(\w+)\s*(?::\s*\w+)?\s*=/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let name = '';
    let kind: SymbolKind = 'function';
    let signature = '';

    if (exportFnRe.test(line)) {
      const mm = exportFnRe.exec(line)!;
      name = mm[1]; kind = 'function';
      signature = collectSignature(lines, i, 'function');
    } else if (exportArrowRe.test(line)) {
      const mm = exportArrowRe.exec(line)!;
      name = mm[1]; kind = 'function';
      signature = line.slice(0, 120);
    } else if (exportClassRe.test(line)) {
      const mm = exportClassRe.exec(line)!;
      name = mm[1]; kind = 'class';
      signature = line.slice(0, 120);
    } else if (exportInterfaceRe.test(line)) {
      const mm = exportInterfaceRe.exec(line)!;
      name = mm[1]; kind = 'interface';
      signature = collectBlock(lines, i, 5);
    } else if (exportTypeRe.test(line)) {
      const mm = exportTypeRe.exec(line)!;
      name = mm[1]; kind = 'type';
      signature = line.slice(0, 120);
    } else if (exportEnumRe.test(line)) {
      const mm = exportEnumRe.exec(line)!;
      name = mm[1]; kind = 'enum';
      signature = collectBlock(lines, i, 3);
    } else if (exportConstRe.test(line)) {
      const mm = exportConstRe.exec(line)!;
      name = mm[1]; kind = 'const';
      signature = line.slice(0, 120);
    }

    if (name) {
      exports.push({
        name, kind, signature,
        signatureHash: sha256(signature),
        lineStart: i + 1,
        lineEnd: i + 1,
        isExported: true,
      });
    }
  }

  // Internal functions (not exported)
  const internalFnRe = /^(?:async\s+)?function\s+(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (internalFnRe.test(line) && !line.startsWith('export')) {
      const mm = internalFnRe.exec(line)!;
      internals.push({
        name: mm[1], kind: 'function',
        signature: line.slice(0, 80),
        signatureHash: sha256(line.slice(0, 80)),
        lineStart: i + 1, lineEnd: i + 1,
        isExported: false,
      });
    }
  }

  return { imports, exports, internals };
};

// ─── Python ───────────────────────────────────────────────────────────────────

const pythonParser: Parser = (content, filePath, repoRoot) => {
  const imports: ImportStatement[] = [];
  const exports: SymbolExport[] = [];
  const internals: SymbolExport[] = [];
  const lines = content.split('\n');
  const seenSources = new Set<string>();

  // import X / from X import Y
  const importRe = /^import\s+(\S+)/;
  const fromImportRe = /^from\s+(\S+)\s+import\s+(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (fromImportRe.test(line)) {
      const mm = fromImportRe.exec(line)!;
      const source = mm[1];
      const syms = mm[2].replace(/[()\\]/g, '').split(',').map(s => s.trim()).filter(Boolean);
      if (!seenSources.has(source)) {
        seenSources.add(source);
        imports.push({
          source,
          resolvedPath: source.startsWith('.') ? resolveImportPath(source, filePath, repoRoot) : undefined,
          symbols: syms,
          isTypeOnly: false, isDynamic: false,
          isExternal: !source.startsWith('.'),
        });
      }
    } else if (importRe.test(line)) {
      const mm = importRe.exec(line)!;
      const source = mm[1];
      if (!seenSources.has(source)) {
        seenSources.add(source);
        imports.push({
          source, symbols: [], isTypeOnly: false, isDynamic: false,
          isExternal: !source.startsWith('.'),
        });
      }
    }

    // def / class
    const defRe = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/;
    const classRe = /^class\s+(\w+)(?:\(([^)]*)\))?:/;

    if (defRe.test(line)) {
      const mm = defRe.exec(line)!;
      const name = mm[2];
      const isPublic = !name.startsWith('_');
      const sym: SymbolExport = {
        name, kind: 'function',
        signature: line.slice(0, 120),
        signatureHash: sha256(line.slice(0, 120)),
        lineStart: i + 1, lineEnd: i + 1,
        isExported: isPublic,
      };
      if (isPublic) exports.push(sym);
      else internals.push(sym);
    } else if (classRe.test(line)) {
      const mm = classRe.exec(line)!;
      const name = mm[1];
      const isPublic = !name.startsWith('_');
      const sym: SymbolExport = {
        name, kind: 'class',
        signature: line.slice(0, 120),
        signatureHash: sha256(line.slice(0, 120)),
        lineStart: i + 1, lineEnd: i + 1,
        isExported: isPublic,
      };
      if (isPublic) exports.push(sym);
      else internals.push(sym);
    }
  }

  return { imports, exports, internals };
};

// ─── Go ───────────────────────────────────────────────────────────────────────

const goParser: Parser = (content, filePath, repoRoot) => {
  const imports: ImportStatement[] = [];
  const exports: SymbolExport[] = [];
  const internals: SymbolExport[] = [];
  const lines = content.split('\n');

  // Single import: import "pkg"
  const singleImportRe = /^import\s+"([^"]+)"/;
  // Block import: import ( ... )
  const blockImportItemRe = /^\s*(?:\w+\s+)?"([^"]+)"/;

  let inImportBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === 'import (') { inImportBlock = true; continue; }
    if (inImportBlock && line.trim() === ')') { inImportBlock = false; continue; }

    if (inImportBlock && blockImportItemRe.test(line)) {
      const mm = blockImportItemRe.exec(line)!;
      imports.push({
        source: mm[1], symbols: [], isTypeOnly: false, isDynamic: false,
        isExternal: !mm[1].startsWith('.'),
      });
    } else if (singleImportRe.test(line)) {
      const mm = singleImportRe.exec(line)!;
      imports.push({
        source: mm[1], symbols: [], isTypeOnly: false, isDynamic: false,
        isExternal: !mm[1].startsWith('.'),
      });
    }

    // func X(...) — exported if starts with uppercase
    const funcRe = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/;
    const typeRe = /^type\s+(\w+)\s+/;
    if (funcRe.test(line)) {
      const mm = funcRe.exec(line)!;
      const name = mm[1];
      const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
      const sym: SymbolExport = {
        name, kind: 'function',
        signature: line.trim().slice(0, 120),
        signatureHash: sha256(line.trim().slice(0, 120)),
        lineStart: i + 1, lineEnd: i + 1, isExported,
      };
      if (isExported) exports.push(sym); else internals.push(sym);
    } else if (typeRe.test(line)) {
      const mm = typeRe.exec(line)!;
      const name = mm[1];
      const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
      const sym: SymbolExport = {
        name, kind: 'type',
        signature: line.trim().slice(0, 120),
        signatureHash: sha256(line.trim().slice(0, 120)),
        lineStart: i + 1, lineEnd: i + 1, isExported,
      };
      if (isExported) exports.push(sym); else internals.push(sym);
    }
  }

  return { imports, exports, internals };
};

// ─── Rust ─────────────────────────────────────────────────────────────────────

const rustParser: Parser = (content, filePath, repoRoot) => {
  const imports: ImportStatement[] = [];
  const exports: SymbolExport[] = [];
  const internals: SymbolExport[] = [];
  const lines = content.split('\n');

  const useRe = /^use\s+([\w:]+(?:::\{[^}]*\})?(?:::\*)?)/;
  const pubFnRe = /^pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)/;
  const fnRe = /^(?:async\s+)?fn\s+(\w+)/;
  const pubStructRe = /^pub(?:\([^)]*\))?\s+struct\s+(\w+)/;
  const pubEnumRe = /^pub(?:\([^)]*\))?\s+enum\s+(\w+)/;
  const pubTraitRe = /^pub(?:\([^)]*\))?\s+trait\s+(\w+)/;
  const pubTypeRe = /^pub(?:\([^)]*\))?\s+type\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (useRe.test(line)) {
      const mm = useRe.exec(line)!;
      imports.push({
        source: mm[1], symbols: [], isTypeOnly: false, isDynamic: false,
        isExternal: !mm[1].startsWith('crate') && !mm[1].startsWith('super') && !mm[1].startsWith('self'),
      });
    }

    const tryExport = (re: RegExp, kind: SymbolKind, isExported: boolean) => {
      if (re.test(line)) {
        const mm = re.exec(line)!;
        const sym: SymbolExport = {
          name: mm[1], kind,
          signature: line.slice(0, 120),
          signatureHash: sha256(line.slice(0, 120)),
          lineStart: i + 1, lineEnd: i + 1, isExported,
        };
        if (isExported) exports.push(sym); else internals.push(sym);
        return true;
      }
      return false;
    };

    tryExport(pubFnRe, 'function', true) ||
    tryExport(fnRe, 'function', false) ||
    tryExport(pubStructRe, 'class', true) ||
    tryExport(pubEnumRe, 'enum', true) ||
    tryExport(pubTraitRe, 'interface', true) ||
    tryExport(pubTypeRe, 'type', true);
  }

  return { imports, exports, internals };
};

// ─── Generic fallback ──────────────────────────────────────────────────────────

const genericParser: Parser = (content) => ({
  imports: [], exports: [], internals: [],
});

// ─── Parser registry ──────────────────────────────────────────────────────────

const PARSERS: Record<string, Parser> = {
  typescript: tsParser,
  javascript: tsParser,
  python: pythonParser,
  go: goParser,
  rust: rustParser,
};

// ─── Main parse function ──────────────────────────────────────────────────────

export function parseFile(
  content: string,
  filePath: string,
  language: string,
  repoRoot: string,
): ExtractedSymbols {
  const parser = PARSERS[language] || genericParser;
  const { imports, exports, internals } = parser(content, filePath, repoRoot);

  // Compute signature hash from all exported symbol signatures
  const sigString = exports.map(e => e.signature).sort().join('\n');
  const signatureHash = sha256(sigString);

  return { filePath, language, imports, exports, internals, signatureHash };
}

// ─── Import path resolution ───────────────────────────────────────────────────

function resolveImportPath(importPath: string, fromFile: string, repoRoot: string): string | undefined {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return undefined;
  const fromDir = path.dirname(fromFile);
  const resolved = path.resolve(repoRoot, fromDir, importPath);
  return path.relative(repoRoot, resolved);
}

// ─── Signature collectors ─────────────────────────────────────────────────────

function collectSignature(lines: string[], startLine: number, _kind: string): string {
  // Collect the function signature up to the opening brace
  let sig = '';
  for (let i = startLine; i < Math.min(startLine + 6, lines.length); i++) {
    sig += (i === startLine ? '' : ' ') + lines[i].trim();
    if (sig.includes('{') || sig.includes('=>')) break;
  }
  return sig.split('{')[0].split('=>')[0].trim().slice(0, 150);
}

function collectBlock(lines: string[], startLine: number, maxLines: number): string {
  return lines.slice(startLine, startLine + maxLines).join('\n').slice(0, 300);
}
