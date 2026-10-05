---
name: simplify
description: Clean up recently changed code — remove duplication, reuse existing helpers, simplify logic and fix inefficiencies, then apply the changes. Use when the user says "simplify", "clean this up", "make it simpler/shorter", "refactor what you just wrote", or after a large change.
---

# Simplify

Quality pass on the changed code. This is not a bug hunt (use code-review for that) and must not change behaviour.

## 1. Scope
- Default scope: uncommitted changes (`git diff`, `git diff --staged`) or the files you just edited in this conversation.
- Read the changed files fully and the modules they import from.

## 2. Look for
- **Reuse:** new code that re-implements something already in the codebase (search with `grep` for similar function names, constants, utilities). Use the existing helper.
- **Duplication:** the same block repeated 2+ times in the change → extract a small function, but only if it makes the code clearer.
- **Over-engineering:** abstractions, options or layers with a single caller; config for things that never change; defensive checks for impossible states.
- **Simpler logic:** nested conditionals that can be early returns, manual loops that are a `map`/`filter`/`find`, boolean expressions that can be reduced.
- **Dead code:** unused variables, imports, parameters, commented-out code, leftover debug logging.
- **Efficiency:** repeated work inside loops, N+1 queries/reads, reading a file many times, unnecessary copies of large data.
- **Altitude:** comments that restate the code; names that don't say what something is.

## 3. Apply
- Make the changes with edit_file, keeping the surrounding style (naming, formatting, comment density).
- Keep each change small and behaviour-preserving. Do not reformat untouched code.
- Run the tests / build / linter afterwards if the project has them, and fix anything you broke.

## 4. Report
A short list of what you changed and why (one line each), plus anything you deliberately left alone.
