"""In-memory ring buffer for executor pipeline logs (teacher-facing).

The teacher dashboard polls ``GET /logs`` while a batch runs and renders a
live "Pipeline log" panel, so the teacher can see what the pipeline did:
preprocessing edits, per-notebook progress, autofix attempts, LLM calls.

Records are captured at the logger level (``basicConfig`` in ``app.py``), so
the executor should run at INFO (the ``EXECUTOR_LOG_LEVEL`` default) for the
panel to be useful.

Only pipeline loggers are captured — uvicorn access lines are request noise,
not pipeline activity.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from typing import Any

CAPTURED_LOGGERS = (
    "executor",
    "runner",
    "preprocessor",
    "auto_fix",
    "ki_connect",
    "uvicorn.error",
)

MAX_ENTRIES = 500


class RingBufferLogHandler(logging.Handler):
    """A logging.Handler that keeps the most recent records in memory."""

    def __init__(self, maxlen: int = MAX_ENTRIES) -> None:
        super().__init__(level=logging.DEBUG)
        self.maxlen = maxlen
        self._entries: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._next_id = 1
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
        except Exception:  # pragma: no cover — defensive, format never fails here
            message = record.getMessage()
        entry: dict[str, Any] = {
            "id": self._next_id,
            "ts": round(record.created, 3),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": message,
        }
        with self._lock:
            self._next_id += 1
            self._entries.append(entry)

    def snapshot(self, limit: int | None = None) -> list[dict[str, Any]]:
        """Return captured entries oldest → newest, optionally the last ``limit``."""
        with self._lock:
            entries = list(self._entries)
        if limit is not None and limit > 0:
            entries = entries[-limit:]
        return entries

    @property
    def total(self) -> int:
        with self._lock:
            return len(self._entries)


def _should_capture(record: logging.LogRecord) -> bool:
    return record.name.startswith(CAPTURED_LOGGERS)


# Module-level singleton — one buffer for the whole executor process.
_handler = RingBufferLogHandler()
_handler.addFilter(_should_capture)


def install() -> None:
    """Attach the ring buffer to the root logger (idempotent).

    Also pins the captured pipeline loggers to INFO. The logger-level check
    happens before handlers run, so without this the panel would silently
    lose INFO records whenever the root logger is at WARNING (e.g. an
    ``EXECUTOR_LOG_LEVEL=warning`` console setting, or a host app that
    already configured root). Pipeline telemetry is independent of console
    verbosity.
    """
    root = logging.getLogger()
    if _handler not in root.handlers:
        root.addHandler(_handler)
    for name in CAPTURED_LOGGERS:
        logging.getLogger(name).setLevel(logging.INFO)


def snapshot(limit: int | None = None) -> list[dict[str, Any]]:
    return _handler.snapshot(limit)


def total() -> int:
    return _handler.total
