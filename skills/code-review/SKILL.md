---
name: code-review
description: Review the current changes (git diff), a branch or given files for correctness bugs, regressions and risky code. Use when the user asks for a code review, "check my changes", "review this PR/branch/file", or before committing important work.
---

# Code review

Goal: find real defects that would break behaviour — not style nitpicks.

## 1. Find what to review
- No target given → review uncommitted work: `git status`, `git diff` and `git diff --staged`.
- Branch given → `git diff <base>...<branch>` (base is usually `main` or `master`).
- Files given → read them fully.
- Not a git repo and no target → ask the user what to review.

## 2. Understand before judging
- Read every changed file in full, not just the hunks — bugs often live in how new code meets old code.
- Read the callers and callees of changed functions (use `grep` for the function name).
- Check how the project builds and tests (package.json, pyproject, Makefile) — run the tests or type-checker if it is cheap.

## 3. Look for
- Logic errors: wrong conditions, off-by-one, inverted checks, missing `await`, wrong variable.
- Edge cases: empty/null/undefined input, empty lists, unicode, large input, concurrent calls.
- Error handling: swallowed errors, missing cleanup, partial writes, unhandled promise rejections.
- Contract breaks: changed function signatures or return shapes with callers not updated.
- State and data: mutation of shared objects, stale caches, race conditions.
- Security: injection (SQL, shell, path), secrets in code, missing auth checks, unsafe deserialization.
- Resource leaks: unclosed files, sockets, timers, event listeners.

## 4. Verify each finding
For every suspected bug, re-read the code and construct a concrete failing scenario (input → wrong result). Drop anything you cannot back with a scenario. Mark uncertain ones as "possible".

## 5. Report
Order by severity. For each finding:

```
[high|medium|low] path/to/file.ext:LINE — one-sentence defect
  Scenario: concrete input/state → wrong output/crash
  Fix: short suggestion
```

End with a one-line verdict (e.g. "2 real bugs, safe after fixing them"). If nothing survived verification, say so plainly. Do not modify files unless the user asks you to fix the findings.
