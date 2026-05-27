# CTX — Semantic Context Management for AI Coding Agents

> **Stop paying the token tax. Compile your codebase once. Pay almost nothing forever.**

CTX is a local-first semantic context compilation system. It transforms your repository into incrementally-maintained, structured knowledge artifacts — so AI agents (Claude Code, Cursor, Antigravity, etc.) understand your codebase instantly, without scanning a single source file.

---

## The Problem

Every AI coding session starts the same way:

```
You: Fix the payment retry bug
Agent: Reading src/... Reading payments/... Reading config/... 
       [~60,000 tokens later]
Agent: Found it! The backoff multiplier is...
```

Then the session ends. The agent forgets everything. Tomorrow you repeat it.

**CTX breaks this cycle.**

---

## How It Works

```
ctx build           →  Compile project semantics once (like `tsc`)
ctx resolve "task"  →  Get 3-8K tokens of hyper-relevant context
                       (instead of 60K+ tokens of raw files)
```

After a build, CTX stores structured semantic artifacts — module summaries, architecture overviews, dependency relationships, execution flows — in a `.ctx/` directory that lives alongside your code.

Incremental rebuilds update only what changed. A 1-file change triggers ~3 seconds of work, not a full re-scan.

---

## Installation

```bash
npm install -g ctx-semantic
# or run locally
npx ctx init
```

---

## Quick Start

```bash
# 1. Initialize in your repo
ctx init

# 2. Compile semantic artifacts (first time ~2-5 min for medium repos)
ctx build

# 3. Use in any agent session
ctx resolve "fix the exponential backoff in payment retry"
# → Returns ~4,000 tokens of precisely relevant context

# 4. After code changes, only update what changed
ctx build     # ~10-30 seconds incremental
```

---

## CLI Reference

### `ctx init`
Initialize CTX in the current repository. Interactive setup for provider, model, and API key.

```bash
ctx init
ctx init --provider groq --model llama-3.3-70b-versatile --yes
ctx init --provider ollama  # fully local, no API key needed
```

### `ctx build`
Compile or incrementally update semantic artifacts.

```bash
ctx build              # incremental (fast)
ctx build --full       # force complete rebuild
ctx build --watch      # watch mode — rebuild on file changes
ctx build --dry-run    # preview what would be rebuilt
ctx build --verbose    # detailed progress
```

### `ctx resolve`
Get compressed, task-relevant semantic context. **The main interface for agents.**

```bash
ctx resolve "fix payment retry exponential backoff"
ctx resolve "add OAuth2 scopes to auth" --op feature_add
ctx resolve "refactor the scheduler" --files src/scheduler/index.ts
ctx resolve "explain how requests flow" --budget 12000
ctx resolve "add tests for payment module" --format json
```

Operation types (`--op`): `bug_fix` · `feature_add` · `refactor` · `test` · `explain` · `auto`

### `ctx module`
Show the full semantic summary for a specific file.

```bash
ctx module src/payments/retry.ts
ctx module retry     # fuzzy match
```

### `ctx search`
Search across all semantic artifacts.

```bash
ctx search "retry logic"
ctx search "authentication" --type module_summary --limit 5
```

### `ctx architecture`
Show the system-wide architecture overview.

```bash
ctx architecture
ctx arch          # alias
```

### `ctx status`
Check build freshness and stats.

```bash
ctx status
```

### `ctx cost`
Estimate token cost and savings before building.

```bash
ctx cost
```

### `ctx branch`
Manage semantic branches for experimental interpretations.

```bash
ctx branch create feature/payments-v2
ctx branch list
ctx branch add-context feature/payments-v2 --context "This module is being migrated to event sourcing"
ctx branch add-context feature/payments-v2 --module src/payments/retry.ts --context "RetryPolicy will accept EventEmitter in v2"
ctx branch delete feature/payments-v2
```

### `ctx merge`
Merge a semantic branch back into main with LLM-assisted conflict resolution.

```bash
ctx merge feature/payments-v2 --auto      # LLM resolves conflicts
ctx merge feature/payments-v2 --review    # interactive review
```

### `ctx diff`
Inspect build history and artifact versions.

```bash
ctx diff
ctx diff --module src/payments/retry.ts
```

### `ctx doctor`
Validate your full setup.

```bash
ctx doctor
```

### `ctx mcp`
Start the MCP server for IDE and agent integrations.

```bash
ctx mcp
```

### `ctx gc`
Clean up old history snapshots.

```bash
ctx gc
```

---

# ctx ui — Visual Dashboard

Adds a browser-based context dashboard to CTX via `ctx ui`.


###  Run it
```bash
ctx ui                    # opens http://localhost:7331
ctx ui --port 8080        # custom port
ctx ui --no-open          # don't auto-open browser
```

## Dashboard features

| Panel | What it shows |
|-------|---------------|
| **Dependency Graph** | Force-directed D3 graph of all modules. Click a node to inspect. Drag to rearrange. Zoom with scroll. |
| **Module Explorer** | Full semantic summary for any module + blast radius sidebar |
| **Blast Radius** | BFS traversal of `importedBy` edges — shows every module affected if the selected file changes |
| **Architecture** | Renders the `.ctx/artifacts/architecture.md` overview |
| **Search** | Keyword search across all artifacts (calls `ArtifactStore.searchArtifacts`) |
| **Build Stats** | Token usage, language breakdown, module groups, build metadata |

## API endpoints (served by server.ts)

| Endpoint | Returns |
|----------|---------|
| `GET /api/manifest` | Build manifest JSON |
| `GET /api/graph` | D3-compatible nodes + links |
| `GET /api/modules` | All module metadata (no content) |
| `GET /api/module?path=…` | Single module with full content |
| `GET /api/architecture` | Architecture artifact |
| `GET /api/blast-radius?path=…` | BFS impact list |
| `GET /api/search?q=…&limit=n` | Search results |
| `GET *` | Serves dashboard.html |

## Agent Integration

### Claude Code / CLAUDE.md

Add to your `CLAUDE.md`:

```markdown
## Context Management

This project uses CTX. Before any task, run:
\`\`\`
ctx resolve "your task description"
\`\`\`

For module details: `ctx module <path>`
For architecture: `ctx architecture`
```

### Cursor / AGENTS.md

```markdown
# Project Context

Use CTX for semantic context before any implementation task.
Command: ctx resolve "describe your task"
```

### MCP Integration (Claude Code, Windsurf)

Add to your MCP config:

```json
{
  "mcpServers": {
    "ctx": {
      "command": "ctx",
      "args": ["mcp"],
      "cwd": "/path/to/your/repo"
    }
  }
}
```

Available MCP tools:
- `ctx_resolve` — get task context (use before every coding task)
- `ctx_module` — get module summary by path
- `ctx_search` — keyword search across all artifacts
- `ctx_architecture` — system overview
- `ctx_status` — build freshness check

---

## Configuration

`.ctx/config.yaml` (committed to git, no secrets):

```yaml
provider:
  type: openai          # openai | groq | nvidia_nim | ollama | custom
  model: gpt-4o-mini
  api_key: ${CTX_API_KEY}   # always use env var, never hardcode
  # base_url: http://localhost:11434/v1  # for ollama or custom

build:
  depth: standard       # minimal | standard | deep
  exclude_paths:
    - "**/__generated__/**"
    - "**/vendor/**"
  max_tokens_per_module: 2000
  parallel_workers: 4

features:
  wiki_generation: true
  flow_extraction: true
  gotcha_registry: true
```

Set your API key via environment:

```bash
export CTX_API_KEY=sk-...          # works for any provider
export OPENAI_API_KEY=sk-...       # also detected automatically
export GROQ_API_KEY=gsk_...        # also detected automatically
```

---

## Supported Providers

| Provider | Model | Speed | Cost | Privacy |
|----------|-------|-------|------|---------|
| OpenAI | gpt-4o-mini (default) | Fast | ~$0.02/build | Cloud |
| Groq | llama-3.3-70b-versatile | Fastest | ~$0.01/build | Cloud |
| NVIDIA NIM | meta/llama-3.1-70b | Fast | On-prem free | On-prem |
| Ollama | llama3.2:latest | Slower | Free | Local |
| Custom | any OpenAI-compatible | Varies | Varies | Varies |

All providers use the OpenAI-compatible API format.

---

## What Gets Built

After `ctx build`, your `.ctx/` directory contains:

```
.ctx/
├── config.yaml              # Your config (commit this)
├── CONTEXT_PRIMER.md        # Auto-generated session primer for agents
├── artifacts/
│   ├── index.md             # Master knowledge index
│   ├── architecture.md      # System-wide architecture overview
│   ├── flows.md             # Key execution flow descriptions
│   ├── decisions.md         # Extracted architectural decisions
│   └── modules/
│       └── {hash}/
│           ├── summary.md   # Per-module semantic summary
│           └── meta.json    # Module metadata
└── snapshot/
    ├── manifest.json        # File hashes for incremental builds
    └── graph.json           # Dependency graph
```

All artifacts are **human-readable markdown**. You can read, edit, or override any of them.

---

## Token Economics (Real Numbers)

For a 50-module TypeScript codebase:

| Operation | Without CTX | With CTX | Savings |
|-----------|-------------|----------|---------|
| Session startup | ~80,000 tokens | ~500 tokens | 99% |
| Per-task context | ~60,000 tokens | ~4,000 tokens | 93% |
| Incremental build cost | N/A (always full) | ~2,000 tokens | — |
| Full build cost | N/A | ~50,000 tokens (once) | — |

**Break-even: ~5 sessions after first build.**

---

## Supported Languages

| Language | Symbol extraction | Import resolution |
|----------|------------------|-------------------|
| TypeScript / TSX | ✓ | ✓ |
| JavaScript / JSX | ✓ | ✓ |
| Python | ✓ | ✓ |
| Go | ✓ | ✓ |
| Rust | ✓ | ✓ |
| Other | partial (LLM-based) | ✗ |

---

## Team Usage

CTX artifacts are designed to be committed to Git:

```bash
# Build in CI, commit artifacts for the whole team
ctx build --full
git add .ctx/artifacts .ctx/CONTEXT_PRIMER.md
git commit -m "chore: update semantic context"
git push
```

Every teammate and every AI session benefits from the shared semantic build.

---

## Privacy

- **Ollama mode**: zero data leaves your machine. Source code never sent anywhere.
- **Cloud providers**: source code is sent to the provider only during `ctx build` for summary generation. It is never sent during `ctx resolve` (artifacts are local).
- API keys are stored in `.ctx/config.local.yaml` (auto-gitignored).
- Files matching `.ctxignore` patterns are never processed or sent.

---

## Architecture

```
CLI Commands
     │
     ▼
Build Engine ──────────────────────────────────────────────────┐
     │                                                          │
     ├── Scanner (fast-glob + .gitignore/.ctxignore)            │
     ├── Parser (regex-based, multi-language)                   │
     ├── Graph Builder (dependency edges)                       │  LLM Provider
     ├── Change Detector (SHA-256 hash + symbol hash)           │  (OpenAI compat)
     └── Semantic Compiler ───────────────────────────────────►│
                                                                │
Context Resolver ◄─────── Artifact Store (.ctx/artifacts/)      │
     │                                                          │
     └── MCP Server / CLI output ◄──────────────────────────────┘
```

---

## License

MIT — use freely, modify freely, ship it.
