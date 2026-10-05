---
name: run-app
description: Figure out how to build and run the project, launch it and check that a change actually works (not just that it compiles). Use when the user asks to run/start the app, "does it work?", "check it in practice", or after implementing a feature that should be verified end-to-end.
---

# Run the app

## 1. Detect the project type
Read the manifest and README to find the real commands:
- Node: `package.json` scripts (`dev`, `start`, `build`, `test`); package manager from the lockfile (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun).
- Python: `pyproject.toml`, `requirements.txt`, `manage.py` (Django), `app.py`/`main.py` (Flask/FastAPI: `uvicorn main:app`).
- Others: `Cargo.toml` (`cargo run`), `go.mod` (`go run .`), `Makefile`, `docker-compose.yml`, `*.csproj` (`dotnet run`).
- Missing dependencies → install them with the project's package manager (ask first if it is a large install).

## 2. Run it the right way
- CLI or script: run it directly with representative arguments and read the output.
- Long-running server (dev server, API): it never exits on its own. Start it with a timeout or in the background, wait until it prints that it is listening, then test it (e.g. `curl http://localhost:PORT/...` or PowerShell `Invoke-WebRequest`), then stop it. Never leave the bash tool blocked on a server forever.
- Tests: run the relevant test command as a final check.

## 3. Verify the change
- Exercise the exact feature that was changed (the endpoint, the command, the page) with realistic input.
- Check the output, status codes and logs for errors or warnings.

## 4. Report
The commands you used, what you observed, and whether the change works. If something could not be checked (needs a browser, credentials, hardware), say exactly what remains unverified.
