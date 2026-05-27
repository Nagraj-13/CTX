# Project Context

This project uses **CTX** for semantic context management.

## Using CTX

Before working on any task, get compressed relevant context:
```
ctx resolve "your task description"
```

For module-specific info:
```
ctx module src/path/to/file.ts
```

For architecture overview:
```
ctx architecture
```

> Full project context: see `.ctx/CONTEXT_PRIMER.md` (generated after `ctx build`)
