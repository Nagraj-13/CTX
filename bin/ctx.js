#!/usr/bin/env node
import('../dist/cli/index.js').catch(e => {
  // Dev fallback: try tsx
  import('child_process').then(({ execSync }) => {
    execSync('tsx ' + new URL('../src/cli/index.ts', import.meta.url).pathname + ' ' + process.argv.slice(2).join(' '), { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname });
  }).catch(() => { console.error(e.message); process.exit(1); });
});
