---
name: Bug report
about: Report something that isn't working as expected
title: ""
labels: bug
assignees: ""
---

## Describe the bug

A clear and concise description of what the bug is.

## Which build / mode

Which of these were you running? (check all that apply)

- [ ] **Teacher mode** (Node/Docker, port 4174) — grading dashboard, executor, copilot
- [ ] **Student mode** (static GitHub Pages) — peer-review SPA
- [ ] If teacher mode: raw `pnpm dev:teacher`/`pnpm start:teacher` **or** Docker `docker compose up`?
- [ ] Browser and version (e.g. Firefox 128, Chrome 126)

## To reproduce

Steps to reproduce the behavior:

1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

## Expected behavior

A clear and concise description of what you expected to happen.

## Actual behavior

What actually happened. Include the full error message and any console output.

## Screenshots / logs

If applicable, add screenshots or paste logs to help explain your problem.

## Environment

- OS: [e.g. Linux, macOS, Windows]
- Node version (if teacher mode from source): [e.g. 22.5]
- Docker version (if using Docker): [e.g. 27.1]
- Provider: [e.g. KI Connect, OpenRouter, other OpenAI-compatible endpoint]

## Honest context

The docs-RAG semantic/paraphrase leg degrades to BM25-only when the embedder is
unavailable or the vector space (4096-dim) doesn't match — it logs a `loadNote`
but never throws. If your issue is about a paraphrase/semantic search not
matching, note that here, because it may be expected degradation rather than a
bug.

## Additional context

Add any other context about the problem here.
