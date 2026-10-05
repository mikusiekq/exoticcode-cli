---
name: write-tests
description: Write or extend automated tests for a function, module or recent change using the project's existing test framework, then run them. Use when the user asks for tests, "add test coverage", "test this function", or wants a regression test for a fixed bug.
---

# Write tests

## 1. Learn the project's testing setup
- Find the framework and conventions: `package.json` scripts and devDependencies (vitest, jest, mocha, node:test, playwright), `pyproject.toml`/`pytest.ini`, `go test`, `cargo test`, etc.
- Look at 1–2 existing test files and copy their structure: file naming and location, imports, helpers, fixtures, mocking style.
- No test setup at all → ask the user before adding a framework; suggest the lightest option (e.g. `node:test` for Node, `pytest` for Python).

## 2. Decide what to test
- Read the code under test fully. List its behaviours: normal cases, edge cases (empty, null, zero, very large, unicode), error cases and side effects.
- Prefer testing public behaviour over private implementation details.
- For a bug fix, write the test that fails without the fix first.

## 3. Write
- One behaviour per test, descriptive names ("returns empty list when input has no matches").
- Arrange / act / assert; no logic in tests beyond what is needed.
- Mock only real boundaries (network, clock, filesystem when needed), not the code under test.
- Keep tests deterministic: no real network, fixed dates/random seeds.

## 4. Run
- Run the new tests and then the related suite. Fix failing tests — if a test exposes a real bug in the code, report it instead of weakening the test.

## 5. Report
Which file(s) you added, what behaviours are covered, and the test run result (pass/fail counts).
