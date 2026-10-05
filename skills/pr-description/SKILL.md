---
name: pr-description
description: Write a clear pull request title and description (summary, changes, testing, risks) from the branch's commits and diff. Use when the user asks for a PR description, "write the PR", release notes for a branch, or a changelog entry.
---

# PR description

## 1. Gather
- Base branch: usually `main`/`master` (`git remote show origin` or `git branch -a` if unsure).
- `git log --oneline <base>..HEAD` — the commits.
- `git diff <base>...HEAD --stat` and the full diff — what actually changed.
- Linked issue numbers from commit messages or the branch name.

## 2. Write

```
Title: <imperative, ≤ 70 chars, what the PR does>

## Summary
1–3 sentences: the problem and how this PR solves it.

## Changes
- Grouped bullet list of the meaningful changes (not every file).

## How to test
- Steps or commands a reviewer can run, and what they should see.

## Risks / notes
- Breaking changes, migrations, config/env changes, follow-ups. Omit if none.
```

- Describe behaviour and intent, not line-by-line edits.
- Mention screenshots/recordings for UI changes.
- Match the language and template of the repository if it has one (`.github/pull_request_template.md`).

## 3. Deliver
Print the title and body ready to paste. Only create the PR (e.g. with `gh pr create`) if the user asks.
