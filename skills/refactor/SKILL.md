---
name: refactor
description: Safely restructure existing code (rename, extract, split files, change an API, migrate a pattern) without changing behaviour, verifying with tests at each step. Use when the user asks to refactor, rename across the codebase, split a large file, move code, or migrate from one library/pattern to another.
---

# Refactor

Behaviour must stay the same. Small verified steps beat one big rewrite.

## 1. Prepare
- Understand the code and all its usages first: `grep` for every symbol you will touch (including strings, dynamic imports, config, tests and docs).
- Find the safety net: existing tests, type-checker, build. Run them before you start so you know the baseline (note tests that already fail).
- If there are no tests around the code, say so, and consider adding a few characterization tests first.

## 2. Plan
Break the refactor into steps that each leave the code working, e.g.:
1. Introduce the new function/module next to the old one.
2. Move callers over one group at a time.
3. Remove the old code once nothing uses it.

Share the plan briefly before large refactors (many files).

## 3. Execute
- One step at a time with edit_file; keep the existing style.
- For renames, update every reference found by grep — imports, re-exports, tests, docs, config.
- After each step run the type-checker/tests (or at least the build) and fix breakage before continuing.

## 4. Finish
- Search once more for leftovers of the old name/pattern.
- Run the full test suite.
- Report what moved where, and the verification result.
