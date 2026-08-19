# AGENTS.md — executor/ (Python notebook-execution backend)

Executor-specific conventions for the Python backend. Read the
[root `AGENTS.md`](../AGENTS.md) first — the root file's layout, per-package
discipline, and invariants apply here too.

## What this is

The **notebook-execution backend** for SciPro Review: a FastAPI service that
executes Jupyter notebooks (`runner.py`), preprocesses them, applies
`auto_fix.py`, and calls the model via `ki_connect.py`. It speaks Python
(pinned via `.python-version`, currently 3.12; `requires-python` is `>=3.11`)
and is managed with **uv**.

## Commands

```bash
cd executor
uv sync                 # create the virtual env and install deps (uses uv.lock)
uv run python app.py    # run the backend
```

Under `uv`, use `uv run <cmd>` rather than activating a venv. Dependencies are
declared in `pyproject.toml`; `uv.lock` is a **local-only**, gitignored
lockfile — regenerate with `uv lock` / refresh with `uv sync` (it is NOT
committed). On Python-only changes you may need `uv sync` to refresh.

## Verification

The executor is **Python** — it is **not** part of the frontend's vitest
suite. Verify the whole project, including executor wiring, with the root
`hermes verify --json` recipe. Never add executor behavior to the vitest run.

## Notes

- Student notebook content is untrusted input — screen it before it reaches
  any prompt (see root `AGENTS.md` invariants).
- `.venv/` and `*.egg-info/` are gitignored.
