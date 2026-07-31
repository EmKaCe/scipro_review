"""KI Connect LLM client for notebook analysis and auto-fix.

OpenAI-compatible HTTP client for the KI Connect NRW API.
Model: qwen3-30b-a3b-instruct-2507
Base URL: https://chat.kiconnect.nrw/api/v1

Usage:
    client = KiConnectClient()
    result = client.analyze(cells, context)
    fix = client.autofix(source, error, context_cells)
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("ki_connect")

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_BASE_URL = "https://chat.kiconnect.nrw/api/v1"
DEFAULT_MODEL = "qwen3-30b-a3b-instruct-2507"
DEFAULT_TIMEOUT = 60.0  # seconds

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

ANALYSIS_SYSTEM_PROMPT = """\
You are an expert programming teaching assistant analyzing Jupyter notebook \
submissions for a Scientific Programming course. Your task is to analyze the \
student's notebook structure and provide structured annotations.

Analyze the notebook cells and provide:
1. Task segmentation — group cells into logical task groups based on the \
assignment context
2. Per-cell annotations — describe what each cell does
3. Issues detected — any problematic patterns (missing imports, incorrect \
approaches)

Return your analysis as a JSON object exactly matching this structure:
{
  "tasks": [
    {
      "id": 1,
      "title": "Task name",
      "cell_indices": [0, 1, 2],
      "description": "Brief description of what this task does"
    }
  ],
  "cell_annotations": [
    {
      "index": 0,
      "purpose": "What this cell does",
      "issues": ["any issues detected"] or null
    }
  ],
  "notebook_summary": "One-sentence summary of the notebook",
  "cell_count": 37,
  "has_errors": false
}
"""

AUTOFIX_SYSTEM_PROMPT = """\
You are an expert Python debugger helping a student fix a broken Jupyter \
notebook cell. Analyze the error, the cell source, and the surrounding \
context cells. Provide a fix suggestion.

Return a JSON object exactly matching this structure:
{
  "suggestion": "The corrected cell source code",
  "explanation": "Brief explanation of what was wrong and how the fix works",
  "confidence": 0.95,
  "fix_type": "import_fix" | "syntax_fix" | "logic_fix" | "api_fix" | "other"
}
"""

SEGMENTATION_SYSTEM_PROMPT = """\
You are an expert programming teaching assistant. Analyze a Jupyter notebook \
and segment its cells into logical task groups.

Examine the notebook's structure — markdown headings, code content transitions, \
comments — and determine how the work is organized into tasks.

Return your segmentation as a JSON object exactly matching this structure:
{
  "tasks": [
    {
      "id": 1,
      "title": "Task name",
      "cell_range": [0, 4],
      "confidence": 0.95
    }
  ],
  "unassigned_cells": [],
  "notebook_structure": "well_structured" | "single_cell" | "no_headings" | "mangled"
}
"""


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class KiConnectError(Exception):
    """Raised when KI Connect API returns an error or is unreachable."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class KiConnectClient:
    """OpenAI-compatible client for KI Connect NRW LLM API.

    Thread-safe for read operations. Each HTTP call creates its own
    httpx.Client instance.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.api_key = api_key or os.getenv("KI_CONNECT_API_KEY", "")
        self.base_url = (
            base_url or os.getenv("KI_CONNECT_BASE_URL", DEFAULT_BASE_URL)
        ).rstrip("/")
        self.model = model or os.getenv("KI_CONNECT_MODEL", DEFAULT_MODEL)
        self.timeout = timeout

        if not self.api_key:
            logger.info(
                "KI_CONNECT_API_KEY not set — client will return skipped results"
            )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze(
        self,
        notebook_cells: list[dict[str, Any]],
        assignment_context: str | None = None,
    ) -> dict[str, Any] | None:
        """Analyze notebook cells and return structured analysis.

        Returns None if the API is unavailable or returns an error.
        """
        if not self.api_key:
            logger.debug("KI Connect analyze skipped (no API key)")
            return None

        cells_text = self._format_cells_for_prompt(notebook_cells)
        user_prompt = f"Analyze this Jupyter notebook:\n\n{cells_text}"
        if assignment_context:
            user_prompt = (
                f"Assignment context:\n{assignment_context}\n\n"
                f"{cells_text}"
            )

        try:
            response = self._chat_completion(
                system=ANALYSIS_SYSTEM_PROMPT,
                user=user_prompt,
                temperature=0.1,
                response_format={"type": "json_object"},
            )
            return response
        except KiConnectError:
            logger.exception("KI Connect analysis failed")
            return None

    def autofix(
        self,
        cell_source: str,
        cell_error: str,
        context_cells: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Suggest a fix for a broken cell.

        Returns {"skipped": true} on failure or if API is unavailable.
        """
        if not self.api_key:
            logger.debug("KI Connect autofix skipped (no API key)")
            return {"skipped": True}

        context_text = ""
        if context_cells:
            context_text = (
                "Context cells (surrounding the broken cell):\n"
                + self._format_cells_for_prompt(context_cells)
            )

        user_prompt = (
            f"Fix this broken cell:\n\n"
            f"```python\n{cell_source}\n```\n\n"
            f"Error:\n```\n{cell_error}\n```\n\n"
            f"{context_text}"
        )

        try:
            response = self._chat_completion(
                system=AUTOFIX_SYSTEM_PROMPT,
                user=user_prompt,
                temperature=0.2,
                response_format={"type": "json_object"},
            )
            return response
        except KiConnectError:
            logger.exception("KI Connect autofix failed")
            return {"skipped": True}

    def segment_tasks(
        self,
        notebook_cells: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Segment a notebook into logical task groups (cell comparison stage 1).

        **Phase 4 scaffolding only** — the two-stage segmentation pipeline was
        archived in the Phase 3 plan (cell comparison is deferred to Phase 4
        pre-evaluation). Do not call this from Phase 3 code paths.
        """
        if not self.api_key:
            logger.debug("KI Connect segmentation skipped (no API key)")
            return None

        cells_text = self._format_cells_for_prompt(notebook_cells)
        user_prompt = (
            "Segment this Jupyter notebook into logical task groups:\n\n"
            f"{cells_text}"
        )

        try:
            response = self._chat_completion(
                system=SEGMENTATION_SYSTEM_PROMPT,
                user=user_prompt,
                temperature=0.1,
                response_format={"type": "json_object"},
            )
            return response
        except KiConnectError:
            logger.exception("KI Connect segmentation failed")
            return None

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------

    def _chat_completion(
        self,
        system: str,
        user: str,
        temperature: float = 0.1,
        response_format: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Call the chat completions endpoint and return parsed JSON response."""
        url = f"{self.base_url}/chat/completions"

        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        if response_format:
            body["response_format"] = response_format

        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(
                    url,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                )
        except httpx.TimeoutException:
            raise KiConnectError("KI Connect request timed out")
        except httpx.RequestError as e:
            raise KiConnectError(f"KI Connect request failed: {e}")

        if resp.status_code == 401:
            raise KiConnectError(
                "KI Connect: authentication failed (check KI_CONNECT_API_KEY)"
            )
        elif resp.status_code == 429:
            raise KiConnectError("KI Connect: rate limited (429)")
        elif 400 <= resp.status_code < 500:
            detail = resp.text[:500]
            logger.warning("KI Connect %d: %s", resp.status_code, detail)
            raise KiConnectError(f"KI Connect returned {resp.status_code}")
        elif resp.status_code >= 500:
            detail = resp.text[:500]
            logger.warning("KI Connect server error %d: %s", resp.status_code, detail)
            raise KiConnectError(f"KI Connect server error {resp.status_code}")

        try:
            data = resp.json()
        except Exception as e:
            raise KiConnectError(f"KI Connect: invalid JSON response: {e}")

        content = (
            data.get("choices", [{}])[0].get("message", {}).get("content", "")
        )
        if not content:
            raise KiConnectError("KI Connect: empty response content")

        try:
            return json.loads(content)
        except json.JSONDecodeError:
            # Not JSON — return as raw text wrapper
            return {"raw_response": content}

    # ------------------------------------------------------------------
    # Static helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _format_cells_for_prompt(
        cells: list[dict[str, Any]],
    ) -> str:
        """Format notebook cells for inclusion in an LLM prompt.

        Truncates individual cells at 2000 characters to stay within
        context limits.
        """
        lines: list[str] = []
        for i, cell in enumerate(cells):
            cell_type = cell.get("type") or cell.get("cell_type", "code")
            raw_source = cell.get("source", "")
            if isinstance(raw_source, list):
                raw_source = "".join(raw_source)

            if len(raw_source) > 2000:
                raw_source = raw_source[:2000] + "\n# ... [truncated]"

            lines.append(f"[Cell {i}] type={cell_type}")
            lines.append(raw_source)
            lines.append("---")
        return "\n".join(lines)
