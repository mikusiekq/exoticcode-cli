---
name: commit
description: Create a clean git commit of the current work with a good message that follows the repository's conventions. Use when the user asks to commit, "save this in git", "make a commit", or to prepare a commit message.
---

# Commit

Only commit when the user asked for it. Never push, force-push, amend published commits or change git config unless the user explicitly asks.

## 1. Inspect
- `git status` — what is modified, staged and untracked.
- `git diff` and `git diff --staged` — read the actual changes.
- `git log --oneline -10` — learn the message style (Conventional Commits like `feat:`/`fix:`, plain imperative, language, ticket prefixes).
- If on the default branch and the repo uses feature branches, mention it and offer to create a branch first.

## 2. Check before committing
- Do not commit secrets: `.env`, keys, tokens, credentials, large binaries or build output. If something like that is staged, stop and tell the user.
- Unrelated changes mixed together → suggest splitting into separate commits.
- If the project has a quick lint/test step, run it.

## 3. Stage
Stage only the files that belong to this change (`git add <paths>`), not blindly `git add -A`.

## 4. Message
- Subject: imperative mood, ≤ 72 characters, describes the *why*/effect ("Fix crash when config file is empty").
- Body (when useful): what changed and why, wrapped at ~72 characters.
- Follow the style found in `git log`.
- On Windows PowerShell pass multi-line messages with a here-string or several `-m` arguments.

## 5. Commit and report
Run `git commit`. If a pre-commit hook fails, fix the issue and create a new commit — never skip hooks with `--no-verify`. Report the commit hash and subject.
