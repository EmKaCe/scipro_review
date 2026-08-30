# Security Policy

## Supported versions

SciPro Review is a small, self-hosted teacher tool — we patch the latest
release only.

| Version | Supported |
| ------- | --------- |
| 2.6.x   | ✅        |
| < 2.6   | ❌        |

## Reporting a vulnerability

**Please do not report security bugs through public GitHub issues.**

Use GitHub's private vulnerability reporting on this repository
(*Security → Report a vulnerability*), or contact the maintainers directly —
contact details are in the repository owner's profile.

You can expect an initial response within a week. If the issue is confirmed,
we will aim to release a fix and disclose it in the release notes.

## Security-relevant design notes

- **Student notebook content is untrusted input.** Submissions are screened
  server-side (injection screening in the LLM pipeline) before any content
  reaches a grading prompt. Notebook execution happens in the Python executor
 backend, not the web server.
- The teacher frontend ships two builds: the **student** build is a static
  GitHub Pages SPA and contains **no** server routes and **no** API access;
  all privileged functionality (grading, config, uploads) lives in the
  **teacher** Node build, which is meant to run on a trusted host (Docker
  compose). Do not expose the teacher build to untrusted networks without
  fronting it with authentication.
- LLM endpoints are configured via `KI_CONNECT_*` environment variables
  (see `.env.example`) — API keys belong in `.env`, which is gitignored.
  Never commit credentials.
- Runtime data (`data/submissions/`, `data/copilot/`, `data/plagiarism/`, …)
  is gitignored on purpose; grading artifacts may contain student work and
  must never be committed.

## Dependency security

Dependabot monitors npm (frontend), pip (executor), and GitHub Actions
dependencies. If you operate a deployment, prefer applying the automated
security PRs promptly — they are usually small transitive bumps.