---
name: explain-codebase
description: Explore an unfamiliar repository and explain its architecture, main flows and where things live, as an onboarding overview. Use when the user asks "what is this project", "how does this codebase work", "explain the architecture", "where is X handled" or is new to a repo.
---

# Explain the codebase

## 1. Map it
- `list_dir` the root, read README, the manifest (package.json, pyproject, go.mod…) and any docs folder.
- Find entry points: `main`, `bin`, `index`, `app`, server start files, CLI definitions, route tables.
- Use `glob` to see the shape (`src/**/*.ts`, `**/*.py`) and note the main directories.

## 2. Follow the important flows
- Pick 1–3 core flows (e.g. "HTTP request → handler → database", "CLI command → output") and trace them through the code with `grep` and `read_file`.
- Note the key modules, data models and external services (databases, APIs, queues).

## 3. Explain
Write a compact overview:
1. **What it is** — one paragraph.
2. **Tech stack** — languages, frameworks, key libraries.
3. **Structure** — the main directories and what lives in each (path → purpose).
4. **How it works** — the traced flows, step by step, with `path:line` references.
5. **How to run / test** — the commands.
6. **Where to start** — files worth reading first, plus anything surprising or fragile you noticed.

Keep it skimmable; the user can ask for depth on any part.
