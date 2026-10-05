---
name: debug
description: Systematic debugging of a failing test, crash, error message or wrong behaviour — reproduce, isolate, find the root cause, fix and verify. Use when the user reports a bug, pastes an error/stack trace, says "it doesn't work", "why does X happen" or a test fails.
---

# Debug

Fix the root cause, not the symptom. Never claim a fix works without running it.

## 1. Reproduce
- Get the exact failing command, input and error. If the user gave a stack trace, read every frame that points into the project.
- Run it yourself. If you cannot reproduce, say so and gather more information (versions, env, input) instead of guessing.

## 2. Locate
- Start at the deepest project frame in the stack trace, read the surrounding function fully.
- Use `grep` to find where the failing value comes from and who calls the code.
- Check recent changes: `git log -p -5 -- <file>` and `git diff` often explain a regression.

## 3. Hypothesize and test
- Write down 1–3 concrete hypotheses ("`user` is undefined because the cache returns before the fetch resolves").
- Test the most likely one cheaply: a minimal script, a focused test, or a temporary log line. Change one thing at a time.
- If a hypothesis is wrong, discard it explicitly and move to the next.

## 4. Fix
- Fix the cause with the smallest correct change, matching the code style.
- Consider the same bug elsewhere (same pattern, sibling functions).
- Remove any temporary debug logging you added.

## 5. Verify
- Re-run the original failing command — it must pass now.
- Run the related tests (or the whole suite if it is fast) to check nothing else broke.
- Add a regression test when the project has tests.

## 6. Report
Root cause (1–2 sentences), the fix (file:line), and how you verified it — including any check you could not run.
