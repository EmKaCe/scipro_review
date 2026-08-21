"""Ring-buffer pipeline logs + GET /logs endpoint tests.

The buffer is a process-wide singleton installed at app import, so tests
assert on behavior (markers appear, limits hold, access noise excluded)
rather than exact counts.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

import app as app_module
import logs as logs_module


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """TestClient with DATA_DIR pointed at a temp dir."""
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    with TestClient(app_module.app) as client:
        yield client


def test_ring_buffer_captures_pipeline_loggers():
    marker = f"marker-pipeline-log-{logs_module.total()}"
    logging.getLogger("runner").info(marker)
    entries = logs_module.snapshot()
    assert any(marker in e["message"] for e in entries)


def test_ring_buffer_excludes_access_noise():
    logging.getLogger("uvicorn.access").info("GET /health 200")
    entries = logs_module.snapshot()
    assert not any(e["logger"] == "uvicorn.access" for e in entries)


def test_snapshot_returns_oldest_to_newest_and_respects_limit():
    entries = logs_module.snapshot(limit=5)
    assert len(entries) <= 5
    ids = [e["id"] for e in entries]
    assert ids == sorted(ids)


def test_logs_endpoint_shape_and_limit(api_client):
    marker = f"marker-endpoint-log-{logs_module.total()}"
    logging.getLogger("executor").info(marker)

    resp = api_client.get("/logs?limit=1000")
    assert resp.status_code == 200
    body = resp.json()
    assert body["truncated"] is False
    assert any(marker in e["message"] for e in body["entries"])
    for entry in body["entries"]:
        assert {"id", "ts", "level", "logger", "message"} <= set(entry)

    limited = api_client.get("/logs?limit=3")
    assert limited.status_code == 200
    body = limited.json()
    assert len(body["entries"]) <= 3
    assert body["truncated"] is True


def test_logs_endpoint_clamps_limit(api_client):
    resp = api_client.get("/logs?limit=100000")
    assert resp.status_code == 200
    assert len(resp.json()["entries"]) <= 1000

    resp = api_client.get("/logs?limit=0")
    assert resp.status_code == 200
    assert len(resp.json()["entries"]) >= 1
