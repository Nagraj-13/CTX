# CTX — Semantic Context Management System
## Product Requirements Document (PRD) + Technical Requirements Document (TRD)

**Version:** 1.0  
**Status:** Draft  
**Last Updated:** May 2026  
**Classification:** Internal Working Document

---

# PART ONE: PRODUCT REQUIREMENTS DOCUMENT (PRD)

---

## 1. Executive Summary

CTX is a local-first semantic context compilation system for AI coding agents. It transforms a repository's source code into incrementally-maintained, structured semantic artifacts — architecture summaries, module wikis, dependency graphs, and execution flows — that AI agents consume instead of scanning raw source files.

The core thesis: **context should be compiled, not retrieved.** Most tools treat project understanding as a retrieval problem (find the right file, chunk it, embed it). CTX treats it as a compilation problem — the same way a compiler transforms source into bytecode incrementally, CTX transforms source into reusable semantic cognition artifacts, recomputing only what changes.

**Target token reduction: 60–90% per AI agent session.**  
**Target incremental rebuild cost: <10% of a full build.**  
**Target context retrieval latency: <500ms.**

---

## 2. Problem Statement

### 2.1 The Core Problem

Every time a developer opens a new session with an AI coding agent (Claude Code, Cursor, Windsurf, Antigravity), the agent starts blind. To answer even a simple question — "where does the payment retry logic live?" — the agent reads dozens of files, constructs a mental model, answers the question, and then **forgets everything** when the session closes.

This is functionally equivalent to hiring a senior engineer, having them spend the first two hours reading your codebase, answering one question, and then wiping their memory before they leave. Then repeating this process every single day.

### 2.2 The Token Economics Problem

For a mid-size repository (50k–200k lines of code), an AI agent's initial orientation pass consumes approximately:

| Repository Size | Orientation Token Cost | % of Typical Session Budget |
|-----------------|------------------------|------------------------------|
| Small (< 20k LOC) | 15,000–40,000 tokens | 30–50% |
| Medium (20k–100k LOC) | 50,000–200,000 tokens | 60–80% |
| Large (100k–500k LOC) | 200,000–800,000 tokens | Often exceeds context window |
| Monorepo (> 500k LOC) | Context window overflow | Agent fails or hallucinates |

This cost is paid **on every session, for every developer, every day.** For a 10-person team using AI assistants heavily, this represents millions of wasted tokens per month.

### 2.3 The Statelessness Problem

Beyond token cost, statelessness damages quality. When an agent rebuilds understanding from scratch each session, it:

- Misses architectural decisions that were made in prior sessions
- Rediscovers the same bugs it identified and worked around before
- Loses track of partially-implemented features spanning multiple sessions
- Cannot build on prior reasoning to develop deeper architectural understanding
- Gives inconsistent advice across sessions about the same subsystem

### 2.4 The Context Relevance Problem

Even when context is injected manually (via CLAUDE.md, AGENTS.md, or skill files), these artifacts are:

- Written once and rarely updated
- Flat and non-hierarchical — no way to query "just the payment module context"
- Not linked to actual code — they drift from reality as the codebase evolves
- Global rather than task-scoped — a bug fix in auth doesn't need the full payments wiki

### 2.5 Problem Taxonomy

| Problem | Root Cause | Current Impact |
|---------|-----------|----------------|
| Repeated codebase scanning | No persistent semantic memory | 50–80% token waste per session |
| Stale CLAUDE.md / AGENTS.md | Manual authoring, no code linkage | Incorrect agent behavior |
| Context window overflow on large repos | Raw file injection | Agent failure or severe hallucination |
| Inconsistent cross-session behavior | Full statelessness | Developer frustration, rework |
| Long agent startup time | Cold orientation pass | Slow feedback loops |
| No team shared understanding | Per-developer context silos | Inconsistent team AI usage |

---

## 3. Vision and Product Goals

### 3.1 Vision Statement

CTX makes AI agents **knowledgeable by default** about any repository they work with. A developer who opens a new session should be able to ask "implement OAuth2 scopes in the auth module" and the agent should already understand the auth module's architecture, relevant dependencies, existing patterns, and past decisions — without reading a single source file during the session.

CTX is, in essence, **a brain for the repository** — one that updates incrementally as code changes, is fully inspectable by humans, works entirely offline, and serves exactly the right knowledge slice for any given task.

### 3.2 Primary Product Goals

**Goal 1 — Eliminate redundant repository scanning**  
Once a repository has been semantically built with CTX, agents should never need to read raw source files to understand the codebase. All architectural understanding lives in pre-compiled, versioned semantic artifacts.

**Goal 2 — Make context incremental**  
When a developer makes changes and runs `ctx build`, only the semantic artifacts affected by those changes should be recomputed. A one-file change should not trigger a full repository re-scan.

**Goal 3 — Make context task-scoped**  
When an agent is asked to fix a bug in the payments module, CTX should surface only the payments-relevant semantic artifacts plus the dependency slice that bug might touch. Not the entire project wiki.

**Goal 4 — Make context persistent and versioned**  
Semantic understanding should survive session ends, team member changes, and repository forks. Like Git for code, CTX provides a versioned history of how the project's semantic understanding has evolved.

**Goal 5 — Remain fully offline-capable**  
No cloud dependency for core operation. All semantic artifacts are local filesystem objects. Teams in air-gapped environments, with strict data residency requirements, or simply preferring local-first tools can run CTX entirely on their own hardware.

**Goal 6 — Enable team-wide shared cognition**  
Semantic artifacts should be committable to Git, shareable across a team, and collaboratively evolvable. When one developer's session produces new architectural insight, that insight can be merged into the shared semantic baseline.

### 3.3 Non-Goals

CTX is explicitly **not**:

- A code version control system — it does not track code changes (Git does this)
- A chat memory system — it does not store conversation history
- A RAG/vector database — it does not chunk-and-embed raw files for retrieval
- A prompt library or AGENTS.md replacement — it produces living artifacts, not static files
- An autonomous coding agent — it provides context to agents, it does not act
- A hosted SaaS dependency — cloud is optional, never required
- A code search engine — it produces semantic understanding, not search indexes

---

## 4. Target Users and Personas

### 4.1 Primary Personas

**Persona 1: The Heavy AI User — "Priya"**  
Senior engineer at a 30-person startup. Uses Claude Code or Cursor for 60–70% of her coding work. Her biggest frustration: every morning she re-explains the codebase to the AI before getting anything useful done. She has written an extensive CLAUDE.md but it's six months stale. She would pay for anything that makes her AI assistant feel like it "already knows the codebase."

**Persona 2: The Team Lead — "Marcus"**  
Engineering lead at a scale-up with a 200k-LOC monorepo. Five engineers on his team use AI assistants, each with their own mental model of the codebase, injected via different AGENTS.md files. The AI gives different advice to different engineers about the same subsystem. Marcus wants a single source of semantic truth that all engineers' AI tools share.

**Persona 3: The Agentic Workflow Builder — "Yuki"**  
Staff engineer building internal AI tooling. She runs autonomous agents (via Antigravity or custom Codex pipelines) that implement features or fix bugs from tickets. These agents spend 70% of their context budget on orientation and still hallucinate about the codebase. She needs a context server that agents can query programmatically via MCP or REST.

**Persona 4: The OSS Maintainer — "David"**  
Maintains a popular open-source library with 80k stars. New contributors and AI agents both struggle with the codebase's unusual architecture. He wants to ship a `.ctx/` directory in the repo so that any contributor who uses AI tools gets instant architectural context.

### 4.2 Secondary Personas

- Autonomous coding system operators who need reliable context delivery at scale
- AI infrastructure engineers building context management layers for enterprise deployments
- Developer tooling teams building products on top of CTX's context resolution API

---

## 5. User Workflows and Journeys

### 5.1 Initial Setup

```
Developer installs CTX CLI
│
├── ctx init
│   ├── Detects repository root
│   ├── Prompts for LLM provider (OpenAI / Groq / NVIDIA NIM / Ollama / custom)
│   ├── Prompts for model selection
│   ├── Prompts for API key (or local endpoint for Ollama)
│   ├── Prompts for build preferences (depth, language hints, excluded paths)
│   └── Creates .ctx/config.yaml (gitignore sensitive keys, commit structure)
│
└── ctx doctor
    ├── Validates provider connectivity
    ├── Checks repository structure
    └── Reports estimated build cost (token estimate)
```

### 5.2 First Build

```
ctx build
│
├── Phase 1: Repository Scan
│   ├── Walk file tree (respects .ctxignore and .gitignore)
│   ├── Detect languages (Tree-sitter registry)
│   ├── Fingerprint all source files (SHA-256)
│   └── Build raw file manifest
│
├── Phase 2: AST Parsing
│   ├── Parse all source files via Tree-sitter
│   ├── Extract: symbols, imports, exports, function signatures, class hierarchies
│   └── Store AST summaries (not full ASTs) in .ctx/graph/
│
├── Phase 3: Dependency Graph Construction
│   ├── Resolve import relationships → directed dependency graph
│   ├── Assign modules to feature domains (heuristic + LLM-assisted)
│   └── Persist graph to .ctx/graph/deps.json
│
├── Phase 4: Semantic Extraction (LLM)
│   ├── Batch modules by dependency cluster
│   ├── LLM generates per-module semantic summaries
│   ├── LLM generates architecture overview
│   ├── LLM generates feature domain descriptions
│   └── LLM generates execution flow descriptions for key paths
│
├── Phase 5: Wiki Artifact Generation (Karpathy-style)
│   ├── Index.md — master table of contents
│   ├── Per-module wiki pages (architecture/purpose/patterns/gotchas)
│   ├── Architecture.md — system-wide overview
│   ├── Decisions.md — extracted architectural decisions
│   └── Flows.md — critical execution path descriptions
│
└── Phase 6: Snapshot Persistence
    ├── Write semantic artifacts to .ctx/artifacts/
    ├── Write build manifest (hashes, timestamps, artifact map)
    └── ctx status → reports build completeness
```

**User experience during first build:**
```bash
$ ctx build
→ Scanning repository... 847 files, 12 languages detected
→ Parsing ASTs... 847/847 ✓
→ Building dependency graph... 2,341 relationships
→ Generating semantic artifacts... [████████░░] 73% (module 31/43)
  Current: src/payments/retry.ts
→ Writing wiki artifacts...
✓ Build complete in 4m 12s
  Artifacts: 43 module pages, 1 architecture doc, 6 flow docs
  Estimated token savings: ~85,000 tokens/session
  Next: run `ctx resolve "your task"` to verify context quality
```

### 5.3 Agent Task Execution

```
Developer opens AI agent session
│
├── Agent reads .ctx/CONTEXT_PRIMER.md (auto-injected, ~500 tokens)
│   └── Contains: project overview, architecture snapshot, how to use CTX
│
├── Developer asks: "fix the payment retry exponential backoff bug"
│
├── Agent calls: ctx resolve "fix payment retry exponential backoff"
│   └── CTX returns: compressed context package
│       ├── payments/retry module semantic summary
│       ├── payments/retry dependency slice (scheduler, queue, config)
│       ├── RetryPolicy execution flow description
│       ├── Related architectural decisions
│       └── Known gotchas in retry module
│       Total: ~3,000–8,000 tokens (vs ~60,000 raw)
│
└── Agent implements fix with full architectural understanding
    └── No raw file scanning required
```

### 5.4 Incremental Update After Code Changes

```
Developer makes code changes → git commit
│
└── ctx build (or ctx build --watch in background)
    ├── Compare file fingerprints vs last snapshot
    ├── Detect changed files: [src/payments/retry.ts, src/payments/config.ts]
    ├── Propagate invalidation through dependency graph
    │   └── Invalidated: retry module, retry tests, payment orchestrator
    ├── Regenerate only invalidated semantic artifacts (3 of 43)
    └── Update snapshot
    
Time: ~18 seconds vs 4 minutes for full rebuild (~93% faster)
```

### 5.5 Team Collaboration

```
Developer A pushes new feature branch
│
├── Includes updated .ctx/artifacts/ in commit
│
└── Developer B pulls branch
    ├── ctx status → reports semantic artifacts are current
    ├── Agent session immediately benefits from Developer A's build
    └── No re-scan required
    
Team Lead creates shared semantic baseline:
├── ctx build --full on main branch in CI
├── Artifacts committed to repo under .ctx/
└── All developers benefit from CI-maintained semantic knowledge
```

---

## 6. Feature Specifications

### 6.1 Semantic Build Engine

The build engine transforms raw source into semantic artifacts through a deterministic multi-phase pipeline.

**Core outputs:**

| Artifact Type | Description | Format | Update Trigger |
|--------------|-------------|--------|----------------|
| Module Summary | Purpose, responsibilities, public API, key patterns | Markdown | Module file changes |
| Architecture Overview | System-wide structure, major subsystems, design philosophy | Markdown | Multiple module changes |
| Dependency Map | Directed graph of import/call relationships | JSON | Any import change |
| Feature Domain Map | Which modules belong to which product features | JSON + Markdown | Structural changes |
| Execution Flows | Step-by-step descriptions of critical code paths | Markdown | Flow-touching changes |
| Architectural Decisions | Extracted design choices and their rationale | Markdown | Manual or LLM-extracted |
| Symbol Index | Functions, classes, types with semantic descriptions | JSON | Symbol-level changes |
| Gotcha Registry | Known pitfalls, non-obvious behaviors, edge cases | Markdown | LLM-extracted + manual |

**Build configuration options** (`.ctx/config.yaml`):

```yaml
provider:
  type: openai          # openai | groq | nvidia_nim | ollama | custom
  model: gpt-4o-mini    # model identifier
  api_key: ${CTX_API_KEY}
  base_url: ~           # custom base URL for OpenAI-compatible providers

build:
  depth: standard       # minimal | standard | deep
  languages:            # explicit language hints (auto-detected if omitted)
    - typescript
    - python
  exclude_paths:        # in addition to .gitignore
    - "**/__generated__/**"
    - "**/*.test.ts"
    - "**/vendor/**"
  max_tokens_per_module: 2000
  parallel_workers: 4
  batch_size: 10        # modules per LLM batch call

features:
  wiki_generation: true
  flow_extraction: true
  decision_extraction: false  # experimental
  gotcha_registry: true

storage:
  compress: true        # zstd compression for artifacts
  content_addressed: true
```

### 6.2 Incremental Rebuild Engine

The incremental rebuild engine is CTX's core technical differentiator. It mirrors how an incremental compiler (like TypeScript's `tsc --watch` or Rust's incremental compilation) avoids recomputing unchanged work.

**Invalidation Algorithm:**

```
Given: set of changed files F
Step 1: For each file f in F:
  - Recompute file hash
  - Compare with stored hash in .ctx/snapshot/manifest.json
  - If changed: mark f as dirty

Step 2: Symbol-level diffing (for semantic changes only):
  - Re-parse AST of dirty files
  - Compare exported symbol signatures vs stored
  - If only implementation changed (no signature change): 
      mark as "impl-dirty" (affects this module only)
  - If signatures changed:
      mark as "sig-dirty" (propagate to dependents)

Step 3: Dependency propagation:
  - For each sig-dirty file, traverse reverse dependency graph
  - Mark all direct importers as "dep-dirty"
  - Continue transitively up to configurable depth (default: 2 hops)

Step 4: Artifact invalidation:
  - module_summary[f] → rebuild if f is dirty
  - architecture_overview → rebuild if >3 modules dirty OR core module dirty
  - dependency_map → rebuild if any import statement changed
  - flows → rebuild if any flow-participating module is sig-dirty
  - symbol_index[f] → rebuild if f is sig-dirty

Step 5: Selective LLM regeneration:
  - Only call LLM for invalidated artifacts
  - Use prior artifact as context ("here is the previous summary, 
    update it for these specific changes: ...")
```

**Rebuild cost model:**

| Change Type | Expected Artifact Rebuilds | Expected Token Cost |
|------------|---------------------------|---------------------|
| Single impl change (no signature) | 1 module summary | 500–1,500 tokens |
| Single signature change | 1–3 module summaries + dep updates | 2,000–6,000 tokens |
| New module added | 1 new summary + architecture update | 3,000–8,000 tokens |
| Large refactor (10+ files) | 10–20 summaries + architecture | 15,000–40,000 tokens |
| Full rebuild (baseline) | All artifacts | 80,000–300,000 tokens |

### 6.3 Context Resolution Engine

Given a task description and optionally a set of target files, the resolution engine returns the minimum sufficient semantic context for the task.

**Resolution inputs:**
```json
{
  "task": "fix the exponential backoff in payment retry logic",
  "target_files": ["src/payments/retry.ts"],
  "operation_type": "bug_fix",
  "depth": "standard"
}
```

**Resolution algorithm:**

```
1. Semantic task analysis:
   - Extract domain keywords from task description
   - Match keywords against module semantic summaries
   - Identify candidate modules (similarity scoring)

2. Graph-based expansion:
   - Start from target_files (if provided) or top candidate modules
   - Traverse dependency graph outward (breadth-first, configurable depth)
   - Prioritize: direct dependencies > transitive > architectural

3. Operation-type filtering:
   - bug_fix: include gotcha registry entries, error handling flows
   - feature_add: include architecture overview, integration patterns
   - refactor: include full dependency map for affected region
   - test: include module summaries + existing test patterns

4. Context assembly and compression:
   - Collect all relevant semantic artifacts
   - Compress: remove redundant sections, summarize low-relevance modules
   - Token budget enforcement: trim to max_context_tokens (default: 8,000)
   - Order by relevance: most relevant artifacts first

5. Return structured context package:
   {
     "primary": [module summaries directly relevant],
     "supporting": [dependency context],
     "architecture": [relevant architectural overview section],
     "flows": [relevant execution flow descriptions],
     "gotchas": [relevant known pitfalls],
     "token_count": 4250,
     "excluded": ["list of relevant but trimmed artifacts due to budget"]
   }
```

**CLI usage:**
```bash
ctx resolve "fix exponential backoff in payment retry"
ctx resolve --files src/payments/retry.ts --op bug_fix --format mcp
ctx resolve --task "add OAuth2 scopes to auth" --depth deep --budget 12000
```

### 6.4 Semantic Branching

Semantic branching allows developers to create alternative interpretations of the codebase's architecture. This is primarily useful for:

- Experimental architectural refactors where you want the AI to reason about the "future state"
- Feature branches where a large feature hasn't been built yet but you want to plan in context
- Onboarding: creating simplified branch views for new team members

```bash
ctx branch create feature/payments-v2
  └── Creates .ctx/branches/feature-payments-v2/ as overlay of main artifacts

ctx branch checkout feature/payments-v2
  └── Agent sessions now receive artifacts from this branch

ctx branch add-context "The payments module is being refactored to use event sourcing"
  └── Appends human-authored semantic context to branch (not LLM-generated)

ctx branch list
  └── Shows all branches, their divergence from main, and last update

ctx branch merge feature/payments-v2 --into main
  └── Triggers LLM-assisted semantic merge (see 6.5)
```

**Branch storage model:**
Each branch maintains a sparse overlay — it only stores artifacts that differ from the parent branch. Unchanged artifacts are served from the parent. This keeps branch storage lightweight.

### 6.5 LLM-Assisted Semantic Merging

When two semantic branches are merged, they may have conflicting descriptions of the same module (e.g., main branch says "the retry module uses fixed-interval backoff" while the feature branch says "the retry module uses exponential backoff"). The merge engine resolves these conflicts.

**Merge process:**

```
Step 1: Diff artifact sets
  - Find artifacts present in both branches with different content
  - Categorize conflicts: additive (new info) vs contradictory (conflicting info)

Step 2: Additive conflicts (auto-resolve):
  - Branch A says module X is 400 lines
  - Branch B says module X was extended to 520 lines
  - Resolution: use Branch B (more recent), note the change in artifact history

Step 3: Contradictory conflicts (LLM-resolve):
  - Prompt: "These two descriptions of the same module conflict. 
    Branch A says: [artifact_a]. Branch B says: [artifact_b].
    The actual current code is: [source_excerpt].
    Write a reconciled description that is accurate."
  - Store reconciled artifact + both source versions for audit trail

Step 4: Human review gate (optional, configurable):
  - ctx merge --review: presents each resolved conflict for human approval
  - ctx merge --auto: applies all LLM resolutions without review

Step 5: Merge commit:
  - Creates new snapshot with merged artifacts
  - Records merge provenance in .ctx/history/
```

### 6.6 Agent Integration Layer

CTX exposes context to AI agents through multiple integration surfaces:

**MCP Server (primary integration):**
```json
{
  "name": "ctx",
  "tools": [
    {
      "name": "ctx_resolve",
      "description": "Get compressed semantic context for a coding task",
      "parameters": {
        "task": "string",
        "files": "string[]",
        "operation": "bug_fix|feature_add|refactor|test|explain"
      }
    },
    {
      "name": "ctx_module",
      "description": "Get the full semantic summary for a specific module",
      "parameters": { "path": "string" }
    },
    {
      "name": "ctx_search",
      "description": "Search semantic artifacts by keyword or concept",
      "parameters": { "query": "string", "type": "module|flow|decision|gotcha" }
    },
    {
      "name": "ctx_status",
      "description": "Check if semantic artifacts are current",
      "parameters": {}
    }
  ]
}
```

**CONTEXT_PRIMER.md (automatic injection):**  
CTX generates a `.ctx/CONTEXT_PRIMER.md` that can be referenced in CLAUDE.md/AGENTS.md as an `@include`. This provides agents with project overview and CTX usage instructions at session start (~500 tokens):

```markdown
# Project: [name] — Semantic Context Available

This project uses CTX for semantic context management.
Architecture: [2-3 sentence overview]
Key modules: [top-level module list]
Current branch: main (built: 2 hours ago)

Use the ctx_resolve tool before working on any task.
Example: ctx_resolve("fix payment retry bug") → returns compressed task context
Full module details: ctx_module("src/payments/retry.ts")
```

**REST API (optional, for autonomous agents):**
```
GET  /ctx/status          → build status, staleness
POST /ctx/resolve         → context resolution endpoint
GET  /ctx/module/:path    → module semantic summary
GET  /ctx/search?q=...    → semantic search across artifacts
```

### 6.7 Provider Abstraction Layer

CTX uses an OpenAI-compatible interface with provider-specific configuration for:

| Provider | Use Case | Notes |
|----------|----------|-------|
| OpenAI (GPT-4o-mini) | Default, best quality/cost | Recommended for teams |
| Groq (Llama-3.3-70B) | Speed-sensitive large repos | Fastest, 500+ tok/s |
| NVIDIA NIM | Enterprise/on-prem GPU | OpenAI-compatible endpoint |
| Ollama (local) | Air-gapped / privacy-first | Lower quality, higher privacy |
| Any OpenAI-compatible API | Custom deployments | Full flexibility |

The provider layer handles: model routing, retry with backoff, streaming, token counting, cost estimation, and fallback strategies.

---

## 7. Success Metrics

### 7.1 Core KPIs

| Metric | Baseline (no CTX) | Target with CTX | Measurement Method |
|--------|-------------------|-----------------|-------------------|
| Tokens consumed per agent session (medium repo) | 80,000–150,000 | 15,000–30,000 | Token counter in provider layer |
| Session startup time (time to first useful response) | 2–4 minutes | 15–30 seconds | Measured via agent benchmarks |
| Context accuracy (does agent understand the right module) | Varies widely | >90% task-relevant | Manual evaluation + SWE-Bench |
| Incremental rebuild time | N/A (always full) | <10% of full build | Build timer |
| Full build time (medium repo) | N/A | <5 minutes | Build timer |
| Context retrieval latency (ctx resolve) | N/A | <500ms | P95 latency |
| Agent task success rate improvement | Baseline | +15–25% | SWE-Bench style eval |
| Semantic artifact freshness (staleness at session start) | N/A | <30 min for active repos | Snapshot timestamp delta |

### 7.2 Adoption Metrics

- Time to first successful `ctx build` for new user: target <10 minutes
- Weekly active builds per repository: target >5 (signals active use)
- Semantic branch usage: target >20% of active repos use branching within 60 days
- Team adoption: target >50% of team members using shared artifacts within 30 days of first setup

---

## 8. Competitive Landscape and Differentiation

| Product | Approach | CTX Differentiation |
|---------|----------|---------------------|
| GCC (arXiv 2508.00031) | Git-style context versioning via COMMIT/BRANCH/MERGE on context files | CTX adds: AST-diff incremental rebuilds, LLM semantic merging, repository-native workflow |
| ByteRover | Memory management + "git for AI memory," IDE integrations | CTX differentiates on: source-code compilation model, AST-level incremental updates, local-first |
| Letta Context Repos | Git-based memory versioning for Letta agents | CTX is agent-agnostic, works with Claude Code/Cursor/Antigravity/any OpenAI-compatible agent |
| gitctx | Semantic similarity search over codebase | CTX compiles understanding (offline, persistent); gitctx searches live code (requires code access) |
| CLAUDE.md / AGENTS.md | Static hand-authored files | CTX auto-generates and incrementally updates; human editing remains as an overlay option |
| RAG systems (Codebase RAG) | Chunk-embed-retrieve over source files | CTX is a compilation model, not retrieval; no vector DB required; artifacts are human-readable |

**CTX's unique combination:** Compiler-model incrementality + LLM semantic merging + local-first filesystem storage + agent-agnostic MCP integration + human-readable artifacts. No existing tool delivers all five.

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| LLM-generated artifacts contain hallucinations | High | Artifacts link to source files; humans can audit and override; gotcha registry captures known issues |
| Incremental rebuild misses a changed semantic dependency | Medium | Configurable deep-scan mode; `ctx build --full` escape hatch; staleness warnings |
| Large monorepos exceed LLM context windows during build | High | Hierarchical chunking; module-level batching; sliding window with overlap |
| API costs for initial build of large repos | Medium | Local model (Ollama) support; cost estimation before build; incremental-only mode |
| Developer forgets to run `ctx build` after changes | Medium | Watch mode (`ctx build --watch`); CI integration; staleness indicator in CONTEXT_PRIMER |
| Provider API downtime during build | Low | Local artifact fallback; partial builds; build resumption |
| Semantic branch divergence becomes unmanageable | Low | Branch age warnings; automatic merge suggestions; branch pruning |

---

# PART TWO: TECHNICAL REQUIREMENTS DOCUMENT (TRD)

---

## 1. System Architecture Overview

CTX is structured as a layered local runtime. All layers communicate through well-defined interfaces. The runtime has no mandatory server process — most operations run as CLI commands against the local filesystem, with an optional MCP server process for agent integrations.

```
┌─────────────────────────────────────────────────────────────────┐
│                     INTEGRATION LAYER                           │
│  CLI  │  MCP Server  │  REST API (optional)  │  IDE Extensions  │
├───────────────────────────────────────────────────────────────-─┤
│                   CONTEXT RESOLUTION ENGINE                     │
│       Task analysis  │  Graph traversal  │  Budget enforcement  │
├──────────────────────┬──────────────────────────────────────────┤
│  SEMANTIC COMPILER   │         MERGE ENGINE                     │
│  LLM synthesis       │  Conflict detection  │  LLM resolution   │
├──────────────────────┼──────────────────────────────────────────┤
│  ARTIFACT STORE      │         SNAPSHOT MANAGER                 │
│  Semantic artifacts  │  File hashes  │  Build manifest          │
├──────────────────────┴──────────────────────────────────────────┤
│                   INCREMENTAL BUILD ENGINE                      │
│  Change detection  │  Graph invalidation  │  Rebuild scheduling │
├──────────────────────────────────────────────────────────────-─-┤
│               AST PARSING + DEPENDENCY ENGINE                   │
│  Tree-sitter  │  Symbol extraction  │  Import resolution        │
├──────────────────────────────────────────────────────────────-─-┤
│                     PROVIDER LAYER                              │
│  OpenAI  │  Groq  │  NVIDIA NIM  │  Ollama  │  Custom API       │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Local Filesystem (.ctx/)
```

---

## 2. Directory Structure

```
.ctx/
├── config.yaml                    # User configuration (gitignore API keys)
├── config.local.yaml              # Machine-local overrides (gitignored)
├── CONTEXT_PRIMER.md              # Auto-generated session primer (committed)
│
├── snapshot/
│   ├── manifest.json              # File hashes, timestamps, build metadata
│   ├── graph.json                 # Serialized dependency graph
│   └── symbol_index.json          # Symbol-level index
│
├── artifacts/
│   ├── index.md                   # Master wiki index
│   ├── architecture.md            # System-wide architecture summary
│   ├── decisions.md               # Architectural decisions log
│   ├── flows.md                   # Key execution flows
│   ├── modules/
│   │   ├── {hash}/summary.md      # Per-module semantic summary
│   │   ├── {hash}/meta.json       # Module metadata (path, lang, dependencies)
│   │   └── {hash}/gotchas.md      # Module-specific gotchas
│   └── compressed/
│       └── *.ctx.zst              # Compressed artifact bundles (optional)
│
├── branches/
│   └── {branch-name}/
│       ├── manifest.json          # Branch-local overrides
│       └── artifacts/             # Sparse overlay — only changed artifacts
│
├── history/
│   └── {timestamp}/
│       ├── manifest.json          # Historical snapshots (for diff/rollback)
│       └── build.log              # Build log
│
└── .ctxignore                     # Paths to exclude from scanning
```

**Design principle:** The `.ctx/` directory is designed to be committed to Git. API keys are in `config.local.yaml` (gitignored). Artifacts are human-readable markdown and JSON — no binary blobs except optional compressed bundles.

---

## 3. Data Models

### 3.1 File Manifest Entry

```typescript
interface FileManifestEntry {
  path: string;                    // Relative path from repo root
  hash: string;                    // SHA-256 of file content
  size: number;                    // File size in bytes
  language: string;                // Detected language (tree-sitter grammar name)
  lastModified: string;            // ISO 8601 timestamp
  artifactId: string;              // ID of associated semantic artifact
  symbolHash: string;              // SHA-256 of extracted symbol signatures only
  dirty: boolean;                  // In-memory flag during build
  invalidationReason?: string;     // Why this file was invalidated
}
```

### 3.2 Dependency Graph Node

```typescript
interface GraphNode {
  id: string;                      // Unique ID (hash of file path)
  path: string;                    // Relative file path
  moduleGroup: string;             // Feature domain grouping
  imports: string[];               // IDs of nodes this file imports
  importedBy: string[];            // IDs of nodes that import this file
  symbolExports: SymbolExport[];   // Exported symbols with signatures
  semanticWeight: number;          // 0–1 score: how central is this module?
  lastSemanticChange: string;      // Timestamp of last signature change
}

interface SymbolExport {
  name: string;
  kind: 'function' | 'class' | 'type' | 'const' | 'interface';
  signature: string;               // Function signature or type definition
  signatureHash: string;           // Hash for change detection
  description?: string;            // LLM-generated description (optional)
}
```

### 3.3 Semantic Artifact

```typescript
interface SemanticArtifact {
  id: string;                      // Content-addressed ID (hash of content)
  type: ArtifactType;
  path: string;                    // Source file path (for module artifacts)
  content: string;                 // Markdown content
  metadata: {
    generatedAt: string;
    generatedBy: string;           // Provider + model used
    sourceHash: string;            // Hash of source file(s) used for generation
    tokenCount: number;            // Token count of this artifact
    version: number;               // Incremented on each regeneration
    confidence: number;            // 0–1 LLM confidence estimate
  };
  tags: string[];                  // Semantic tags for retrieval
}

type ArtifactType =
  | 'module_summary'
  | 'architecture_overview'
  | 'feature_domain'
  | 'execution_flow'
  | 'architectural_decision'
  | 'gotcha_entry'
  | 'symbol_description';
```

### 3.4 Build Manifest

```typescript
interface BuildManifest {
  buildId: string;                 // UUID
  timestamp: string;               // ISO 8601
  repositoryRoot: string;
  branch: string;                  // Git branch at build time
  commitHash: string;              // Git commit hash at build time
  files: Record<string, FileManifestEntry>;
  artifacts: Record<string, string>; // artifactId → artifact path
  graph: string;                   // Path to serialized graph
  buildStats: {
    totalFiles: number;
    totalModules: number;
    totalTokensConsumed: number;
    buildDurationMs: number;
    incrementalRebuild: boolean;
    modulesRebuilt: number;
  };
  providerConfig: {
    type: string;
    model: string;
    // Note: no API key stored here
  };
}
```

---

## 4. AST Parsing and Dependency Engine

### 4.1 Parser Architecture

CTX uses Tree-sitter as the primary parsing engine. Tree-sitter provides:
- Consistent parsing interface across 40+ languages
- Error-recovery parsing (works on incomplete/broken code)
- Incremental re-parsing (only re-parses changed regions)
- WASM compilation for cross-platform support

**Supported languages (v1.0):**
- TypeScript / JavaScript (tsx, jsx)
- Python
- Rust
- Go
- Java
- Ruby

**Language plugin interface:**

```typescript
interface LanguagePlugin {
  languageId: string;              // e.g., 'typescript'
  fileExtensions: string[];        // e.g., ['.ts', '.tsx']
  grammar: TreeSitterGrammar;
  
  extractSymbols(tree: SyntaxTree): SymbolExport[];
  extractImports(tree: SyntaxTree): ImportStatement[];
  extractExports(tree: SyntaxTree): ExportStatement[];
  
  // Optional: language-specific semantic hints
  extractDocComments?(tree: SyntaxTree): DocComment[];
  detectTestFile?(path: string, tree: SyntaxTree): boolean;
}
```

### 4.2 Symbol Extraction

For each source file, CTX extracts:

```typescript
interface ExtractedSymbols {
  filePath: string;
  imports: Array<{
    source: string;          // Import path (may be relative or package)
    resolvedPath?: string;   // Resolved absolute path (for local imports)
    symbols: string[];       // Named imports (empty = namespace import)
    isTypeOnly: boolean;
  }>;
  exports: Array<{
    name: string;
    kind: SymbolKind;
    signature: string;       // Signature string (for hash comparison)
    lineRange: [number, number];
  }>;
  // Internal symbols (functions/classes not exported) — for cross-file call analysis
  internals: Array<{
    name: string;
    kind: SymbolKind;
    referencedBy: string[];  // External symbols that reference this
  }>;
}
```

### 4.3 Import Resolution

Import resolution handles the complexity of module resolution algorithms:

```
For each import statement:
1. If absolute package import (e.g., 'lodash'):
   → Mark as external dependency (not a local module)
   → Store in dependency graph as external node
   
2. If relative import (e.g., '../payments/retry'):
   → Resolve relative to current file's directory
   → Check for .ts, .tsx, .js, .jsx, index.ts, index.js extensions
   → If resolved: create directed edge in dependency graph
   
3. If path alias (e.g., '@/utils/logger'):
   → Read tsconfig.json / paths config
   → Resolve alias to absolute path
   → Proceed as relative import

4. If dynamic import (e.g., import('./heavy-module')):
   → Mark as lazy edge in dependency graph
   → Include in graph but lower semantic weight
```

---

## 5. Incremental Build Engine — Detailed Specification

### 5.1 Change Detection Algorithm

```typescript
async function detectChanges(
  currentManifest: BuildManifest,
  workingDirectory: string
): Promise<ChangeSet> {
  const changeSet: ChangeSet = {
    added: [],
    modified: [],
    deleted: [],
    signatureChanged: [],
    implOnlyChanged: []
  };

  // Walk current file tree
  const currentFiles = await walkDirectory(workingDirectory);
  
  for (const file of currentFiles) {
    const stored = currentManifest.files[file.path];
    
    if (!stored) {
      changeSet.added.push(file.path);
      continue;
    }
    
    const currentHash = await sha256(file);
    if (currentHash === stored.hash) continue; // No change
    
    // File changed — check if it's a signature change or impl-only change
    const currentSymbolHash = await extractSymbolHash(file);
    
    if (currentSymbolHash === stored.symbolHash) {
      changeSet.implOnlyChanged.push(file.path);
    } else {
      changeSet.signatureChanged.push(file.path);
    }
    changeSet.modified.push(file.path);
  }
  
  // Check for deleted files
  for (const path of Object.keys(currentManifest.files)) {
    if (!currentFiles.find(f => f.path === path)) {
      changeSet.deleted.push(path);
    }
  }
  
  return changeSet;
}
```

### 5.2 Graph Invalidation Propagation

```typescript
function propagateInvalidation(
  graph: DependencyGraph,
  changeSet: ChangeSet,
  maxDepth: number = 2
): Set<string> {
  const invalidated = new Set<string>();
  
  // All modified files are invalidated
  [...changeSet.added, ...changeSet.modified, ...changeSet.deleted]
    .forEach(p => invalidated.add(p));
  
  // Only signature changes propagate to dependents
  const queue: Array<{ path: string; depth: number }> = 
    changeSet.signatureChanged.map(p => ({ path: p, depth: 0 }));
  
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    
    if (depth >= maxDepth) continue;
    
    const node = graph.getNode(path);
    if (!node) continue;
    
    for (const importerPath of node.importedBy) {
      if (!invalidated.has(importerPath)) {
        invalidated.add(importerPath);
        queue.push({ path: importerPath, depth: depth + 1 });
      }
    }
  }
  
  return invalidated;
}
```

### 5.3 Selective Regeneration Scheduler

The scheduler batches invalidated modules for LLM calls to minimize API round-trips:

```typescript
async function scheduleRegeneration(
  invalidated: Set<string>,
  artifacts: ArtifactStore,
  provider: LLMProvider
): Promise<void> {
  // Sort by dependency order (topological sort)
  // Modules with no invalidated dependencies regenerate first
  const order = topologicalSort(invalidated);
  
  // Batch into groups of config.build.batch_size for parallel processing
  const batches = chunk(order, config.build.batch_size);
  
  for (const batch of batches) {
    await Promise.all(batch.map(async modulePath => {
      const previousArtifact = await artifacts.get(modulePath);
      const sourceContent = await readFile(modulePath);
      const dependencies = await resolveDependencyContext(modulePath);
      
      const prompt = buildIncrementalUpdatePrompt({
        modulePath,
        sourceContent,
        previousArtifact: previousArtifact?.content,
        changedSymbols: getChangedSymbols(modulePath),
        dependencyContext: dependencies
      });
      
      const newContent = await provider.complete(prompt);
      await artifacts.store(modulePath, newContent);
    }));
  }
  
  // Regenerate architecture overview if enough modules changed
  if (invalidated.size > 3 || containsCoreModule(invalidated)) {
    await regenerateArchitectureOverview(artifacts, provider);
  }
}
```

---

## 6. LLM Prompt Specifications

### 6.1 Module Summary Generation Prompt

```
SYSTEM:
You are a technical documentation expert specializing in codebases. 
You generate precise, structured semantic summaries for software modules.
Your summaries are consumed by AI coding agents to understand code without reading source files.
Be concrete, accurate, and practical. Focus on what the module does, how it's used, and what's non-obvious.
Do not add headers, just output the content in the structure provided.
Max output: {max_tokens} tokens.

USER:
Generate a semantic summary for this module.

MODULE PATH: {file_path}
LANGUAGE: {language}

SOURCE CODE:
```{language}
{source_content}
```

IMPORTED MODULES (for context):
{dependency_summaries}

OUTPUT STRUCTURE (use exactly these sections):
## Purpose
One paragraph: what this module does and why it exists.

## Public API
List each exported function/class/type with a one-line description.

## Key Patterns
2–4 notable implementation patterns, design choices, or non-obvious behaviors.

## Dependencies
Which external modules does this depend on, and what specifically does it use from each?

## Gotchas
1–3 things that trip up developers who are new to this module. If none, omit this section.

## Change Surface
What kinds of changes frequently happen to this module? (bug fixes to X, extension via Y, etc.)
```

### 6.2 Incremental Update Prompt

```
SYSTEM:
You are updating an existing semantic summary to reflect code changes.
Be surgical — only update what actually changed.
Preserve language and structure from the original summary.

USER:
Update this semantic summary to reflect the changes.

PREVIOUS SUMMARY:
{previous_summary}

CHANGES DETECTED:
{changed_symbols}

UPDATED SOURCE CODE:
```{language}
{source_content}
```

Output the full updated summary. Mark sections that changed with [UPDATED].
```

### 6.3 Architecture Overview Generation Prompt

```
SYSTEM:
You are generating a high-level architecture document for an AI coding agent.
This document helps agents understand the system before drilling into specifics.
Be architectural, not encyclopedic. Focus on structure, not details.

USER:
Generate an architecture overview for this repository.

REPOSITORY: {repo_name}
DETECTED LANGUAGES: {languages}
MODULE COUNT: {module_count}

MODULE SUMMARIES (grouped by feature domain):
{grouped_summaries}

DEPENDENCY GRAPH SUMMARY:
{graph_summary}

OUTPUT STRUCTURE:
## System Overview
2–3 paragraphs: what this system is, its purpose, its key architectural characteristics.

## Major Subsystems
For each major subsystem: name, purpose, key modules, internal structure.

## Data Flow
How data moves through the system for the 2–3 most important workflows.

## Technology Stack
Languages, major frameworks, infrastructure dependencies.

## Architectural Decisions
3–5 notable architectural choices (e.g., "event-driven over request-response", "single DB per service").

## Extension Points
How new features are typically added to this system.
```

### 6.4 Context Resolution Prompt

```
SYSTEM:
You select the minimum necessary semantic context for a coding task.
Be precise — include only what the developer will actually need.

USER:
Task: {task_description}
Operation: {operation_type}
Target files: {target_files}
Token budget: {budget}

Available semantic artifacts:
{artifact_index}

Return a JSON array of artifact IDs to include, ordered by relevance.
Include reasoning for each.
Format: [{"id": "...", "relevance": "..."}]
```

---

## 7. Context Resolution Engine — Detailed Specification

### 7.1 Scoring Algorithm

The resolution engine scores artifacts for relevance using a multi-factor model:

```typescript
interface RelevanceScore {
  artifactId: string;
  score: number;               // 0–1 composite score
  factors: {
    keywordMatch: number;      // Keyword overlap between task and artifact
    graphProximity: number;    // Distance from target files in dependency graph
    operationRelevance: number;// How relevant for this operation type
    recency: number;           // How recently this artifact was updated
    centralityBonus: number;   // Bonus for architecturally central modules
  };
}

function scoreArtifact(
  artifact: SemanticArtifact,
  task: ResolveRequest,
  graph: DependencyGraph
): RelevanceScore {
  // Keyword matching: extract nouns/verbs from task, match to artifact tags + content
  const keywordMatch = computeKeywordOverlap(
    extractKeywords(task.task),
    [...artifact.tags, ...extractKeywords(artifact.content)]
  );
  
  // Graph proximity: BFS distance from target files to this artifact's module
  const graphProximity = task.targetFiles
    ? computeGraphProximity(task.targetFiles, artifact.path, graph)
    : 0.5; // Default if no target files specified
  
  // Operation type weighting
  const operationRelevance = OPERATION_WEIGHTS[task.operation]?.[artifact.type] ?? 0.5;
  
  // Recency bonus (fresher artifacts are more reliable)
  const ageHours = (Date.now() - Date.parse(artifact.metadata.generatedAt)) / 3600000;
  const recency = Math.exp(-ageHours / 168); // Decay over 1 week
  
  // Centrality: modules with high in-degree in dependency graph get a bonus
  const node = graph.getNode(artifact.path);
  const centralityBonus = node ? Math.min(node.importedBy.length / 20, 0.3) : 0;
  
  const score = (
    keywordMatch * 0.35 +
    graphProximity * 0.30 +
    operationRelevance * 0.20 +
    recency * 0.10 +
    centralityBonus * 0.05
  );
  
  return { artifactId: artifact.id, score, factors: { keywordMatch, graphProximity, operationRelevance, recency, centralityBonus } };
}
```

### 7.2 Budget Enforcement

```typescript
async function assembleContext(
  scored: RelevanceScore[],
  artifacts: ArtifactStore,
  budget: number
): Promise<ContextPackage> {
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  const selected: SemanticArtifact[] = [];
  let tokenCount = 0;
  const excluded: string[] = [];
  
  for (const { artifactId } of scored) {
    const artifact = await artifacts.getById(artifactId);
    const artifactTokens = artifact.metadata.tokenCount;
    
    if (tokenCount + artifactTokens <= budget) {
      selected.push(artifact);
      tokenCount += artifactTokens;
    } else if (artifact.type === 'architecture_overview') {
      // Architecture overview always included, but truncated to 30% if over budget
      selected.push(truncateArtifact(artifact, Math.floor(budget * 0.3)));
      tokenCount += Math.floor(budget * 0.3);
    } else {
      excluded.push(artifactId);
    }
  }
  
  return {
    primary: selected.filter(a => a.type === 'module_summary' && scored.find(s => s.artifactId === a.id)!.score > 0.6),
    supporting: selected.filter(a => a.type === 'module_summary' && scored.find(s => s.artifactId === a.id)!.score <= 0.6),
    architecture: selected.find(a => a.type === 'architecture_overview'),
    flows: selected.filter(a => a.type === 'execution_flow'),
    gotchas: selected.filter(a => a.type === 'gotcha_entry'),
    tokenCount,
    excluded
  };
}
```

---

## 8. Provider Layer — Detailed Specification

### 8.1 Provider Interface

```typescript
interface LLMProvider {
  name: string;
  model: string;
  
  complete(prompt: CompletionRequest): Promise<string>;
  completeStream(prompt: CompletionRequest): AsyncIterable<string>;
  
  estimateTokens(text: string): number;
  getContextWindowSize(): number;
  getRateLimits(): RateLimitConfig;
}

interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;     // 0.1 for factual summaries, 0.3 for creative merges
  stopSequences?: string[];
}
```

### 8.2 Provider Configurations

```typescript
const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    contextWindow: 128000,
    costPer1kInputTokens: 0.00015,
    costPer1kOutputTokens: 0.00060,
    rateLimits: { requestsPerMinute: 3000, tokensPerMinute: 200000 }
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    contextWindow: 128000,
    costPer1kInputTokens: 0.00006,
    costPer1kOutputTokens: 0.00008,
    rateLimits: { requestsPerMinute: 30, tokensPerMinute: 30000 }
  },
  nvidia_nim: {
    baseURL: '${NVIDIA_NIM_ENDPOINT}/v1',
    defaultModel: 'meta/llama-3.1-70b-instruct',
    contextWindow: 128000,
    costPer1kInputTokens: 0,    // On-prem
    costPer1kOutputTokens: 0,
    rateLimits: { requestsPerMinute: 100, tokensPerMinute: 100000 }
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2:latest',
    contextWindow: 32000,
    costPer1kInputTokens: 0,    // Local
    costPer1kOutputTokens: 0,
    rateLimits: { requestsPerMinute: 10, tokensPerMinute: 10000 }
  }
};
```

### 8.3 Retry and Fallback Logic

```typescript
async function robustComplete(
  provider: LLMProvider,
  fallbackProvider: LLMProvider | null,
  request: CompletionRequest
): Promise<string> {
  const retryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 };
  
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await provider.complete(request);
    } catch (error) {
      if (isRateLimitError(error)) {
        const delay = Math.min(
          retryConfig.baseDelayMs * Math.pow(2, attempt),
          retryConfig.maxDelayMs
        );
        await sleep(delay + jitter(500));
        continue;
      }
      
      if (isContextLengthError(error)) {
        // Truncate and retry
        request = truncateRequest(request, 0.8);
        continue;
      }
      
      // Unrecoverable error — try fallback provider
      if (fallbackProvider && attempt === retryConfig.maxRetries) {
        return await fallbackProvider.complete(request);
      }
      
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## 9. Storage Model

### 9.1 Artifact Storage

Artifacts are stored as plain files on the filesystem:

```
.ctx/artifacts/modules/{sha256_of_path}/summary.md
```

Using content-addressed storage:
- Artifact ID = SHA-256 of artifact content
- If content hasn't changed (e.g., rebuild produces identical summary), no write occurs
- Deduplication is automatic

### 9.2 Compression

For large repositories, artifacts are optionally compressed using zstd:

```bash
# Compress all artifacts for storage/transport
ctx artifacts compress --level 3

# Decompress for inspection
ctx artifacts decompress
```

Compression ratios of 5:1 to 10:1 are typical for markdown semantic artifacts.

### 9.3 Snapshot History

CTX maintains a configurable number of historical snapshots:

```yaml
history:
  max_snapshots: 10
  retention_days: 30
  auto_gc: true
```

Historical snapshots allow:
- `ctx diff HEAD~3` — compare current semantic artifacts to 3 builds ago
- `ctx rollback {buildId}` — restore a previous semantic state
- Audit trail for LLM-generated content

---

## 10. CLI Specification

### 10.1 Command Reference

```
ctx init [--provider <name>] [--model <model>] [--no-interactive]
  Initialize CTX in the current repository.
  Creates .ctx/config.yaml and .ctxignore.

ctx build [--full] [--watch] [--dry-run] [--verbose]
  Build or incrementally update semantic artifacts.
  --full: Force complete rebuild regardless of changes
  --watch: Watch for file changes and rebuild continuously
  --dry-run: Show what would be rebuilt without doing it

ctx resolve <task> [--files <paths>] [--op <operation>] [--budget <tokens>] [--format <format>]
  Resolve a context package for the given task.
  --op: bug_fix | feature_add | refactor | test | explain (default: auto-detect)
  --budget: Token budget (default: 8000)
  --format: text | json | mcp (default: text)

ctx status
  Show build status: when artifacts were last updated, staleness per module.

ctx module <path>
  Show the semantic summary for a specific module.

ctx search <query> [--type <type>]
  Search across all semantic artifacts.
  --type: module | flow | decision | gotcha | all (default: all)

ctx diff [<buildId>] [--module <path>]
  Compare current artifacts to a previous build.

ctx branch create <name>
ctx branch checkout <name>
ctx branch list
ctx branch merge <source> [--into <target>] [--auto] [--review]
ctx branch delete <name>
  Manage semantic branches.

ctx merge <source-branch> [--into <target>] [--auto]
  Merge semantic artifacts from source branch into target.

ctx gc
  Garbage collect old snapshots and orphaned artifacts.

ctx doctor
  Validate configuration, provider connectivity, repository state.

ctx serve [--port <port>]
  Start the CTX REST API server.

ctx mcp
  Start the CTX MCP server (for IDE/agent integrations).

ctx cost [--full | --incremental]
  Estimate token/cost for a build without running it.

ctx export [--format <format>] [--output <path>]
  Export all semantic artifacts as a single bundle.
  --format: markdown | json | zip
```

### 10.2 Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error |
| 3 | Provider error (API key, connectivity) |
| 4 | Repository not initialized |
| 5 | Build error (partial failure) |
| 6 | Artifacts stale (warning) |

---

## 11. MCP Server Specification

### 11.1 Tool Definitions

```json
{
  "tools": [
    {
      "name": "ctx_resolve",
      "description": "Get compressed semantic context for a coding task. Use this before implementing any feature, fixing any bug, or making architectural changes.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "task": { "type": "string", "description": "Description of the task or question" },
          "files": { "type": "array", "items": { "type": "string" }, "description": "Target file paths (optional)" },
          "operation": { "type": "string", "enum": ["bug_fix", "feature_add", "refactor", "test", "explain", "auto"], "default": "auto" },
          "budget": { "type": "integer", "description": "Max token budget for returned context", "default": 8000 }
        },
        "required": ["task"]
      }
    },
    {
      "name": "ctx_module",
      "description": "Get full semantic summary for a specific module by file path",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "File path relative to repository root" }
        },
        "required": ["path"]
      }
    },
    {
      "name": "ctx_search",
      "description": "Search semantic artifacts by keyword or concept",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "type": { "type": "string", "enum": ["module", "flow", "decision", "gotcha", "all"], "default": "all" },
          "limit": { "type": "integer", "default": 5 }
        },
        "required": ["query"]
      }
    },
    {
      "name": "ctx_architecture",
      "description": "Get the system-wide architecture overview",
      "inputSchema": { "type": "object", "properties": {} }
    },
    {
      "name": "ctx_status",
      "description": "Check if semantic artifacts are current or stale",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ]
}
```

---

## 12. Security Model

### 12.1 API Key Handling

```yaml
# config.yaml (committed to Git)
provider:
  type: openai
  model: gpt-4o-mini
  api_key: ${CTX_API_KEY}       # Environment variable reference — not stored

# config.local.yaml (gitignored — machine local)
provider:
  api_key: sk-proj-...           # Actual key only here
```

CTX never writes API keys to committed files. The `ctx doctor` command warns if a raw key is detected in `config.yaml`.

### 12.2 Source Code Handling

**What CTX sends to LLMs:**
- Source file contents during build (for semantic extraction)
- Symbol signatures and import lists

**What CTX does NOT send:**
- Environment variables
- .env files
- Files matching patterns in .ctxignore
- Binary files
- Files larger than `max_file_size` (default: 500KB)

**Default .ctxignore:**
```
.env
.env.*
*.key
*.pem
*.p12
secrets/
credentials/
node_modules/
dist/
build/
.git/
```

### 12.3 Artifact Privacy

All semantic artifacts reside locally. When running with Ollama, **no source code ever leaves the machine.** For cloud providers, source code is sent only during `ctx build` — not during `ctx resolve` (which serves from local artifacts only).

---

## 13. Performance Requirements

| Operation | P50 Target | P95 Target | Hard Limit |
|-----------|-----------|-----------|------------|
| `ctx resolve` (cache hit) | 50ms | 200ms | 500ms |
| `ctx module` | 10ms | 50ms | 200ms |
| `ctx search` | 100ms | 400ms | 1000ms |
| `ctx build` (incremental, 1 file) | 5s | 30s | 120s |
| `ctx build` (incremental, 10 files) | 20s | 90s | 300s |
| `ctx build` (full, medium repo) | 2min | 6min | 15min |
| `ctx status` | 10ms | 100ms | 500ms |
| MCP tool call roundtrip | 30ms | 150ms | 500ms |

---

## 14. Testing Strategy

### 14.1 Unit Tests
- Symbol extraction accuracy per language
- Dependency graph construction correctness
- Change detection algorithm (hash + signature level)
- Invalidation propagation logic
- Context resolution scoring algorithm
- Budget enforcement

### 14.2 Integration Tests
- Full build pipeline on reference repositories
- Incremental rebuild on known change sets
- Provider layer (mocked responses)
- MCP server tool calls
- CLI command outputs

### 14.3 Semantic Quality Evaluation
- Maintain a curated set of 10 reference repositories (small, medium, large, monorepo)
- For each, maintain ground-truth "correct" context packages for 20 standard tasks
- After each build, evaluate ctx_resolve output against ground truth (semantic similarity)
- Target: >85% semantic overlap with ground-truth context packages

### 14.4 Benchmark Repositories

| Repository | Size | Languages | Purpose |
|-----------|------|-----------|---------|
| expressjs/express | ~50k LOC | JavaScript | Web framework, clear architecture |
| tiangolo/fastapi | ~30k LOC | Python | API framework, typed |
| tokio-rs/tokio | ~100k LOC | Rust | Async runtime, complex |
| spring-projects/spring-petclinic | ~10k LOC | Java | Small enterprise app |
| Custom synthetic monorepo | ~500k LOC | Mixed | Stress test |

---

## 15. Release Roadmap

### Phase 1 — Core Engine (v0.1)
- `ctx init`, `ctx build`, `ctx status`, `ctx module`
- TypeScript + Python support
- OpenAI provider
- Single-threaded build pipeline
- Basic markdown artifact output

### Phase 2 — Incremental + Resolution (v0.2)
- Incremental rebuild engine
- `ctx resolve` with graph-based context assembly
- MCP server
- Multi-language support (Rust, Go, Java, Ruby)
- Groq + Ollama providers

### Phase 3 — Branching + Merging (v0.3)
- `ctx branch` and `ctx merge`
- LLM-assisted semantic merging
- Historical snapshots + `ctx diff`
- REST API
- Watch mode

### Phase 4 — Team + CI (v0.4)
- CI integration guide + GitHub Actions example
- `ctx export` for artifact bundles
- NVIDIA NIM provider
- Compression pipeline
- `ctx gc` and artifact lifecycle management

### Phase 5 — Quality + Scale (v0.5+)
- Monorepo optimizations (lazy loading, domain partitioning)
- Semantic quality scoring per artifact
- Team analytics dashboard
- Plugin SDK for custom language support
- Cross-repository understanding (experimental)

---

*Document maintained by the CTX core team. For questions, refer to the project wiki.*
