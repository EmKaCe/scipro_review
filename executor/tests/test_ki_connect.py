"""KI Connect client tests (mocked httpx) — Phase 3b Task 8."""

import json
from unittest.mock import Mock, patch

from ki_connect import KiConnectClient, KiConnectError


def test_analyze_returns_parsed_json():
    client = KiConnectClient(api_key="test-key")
    fake_response = Mock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "choices": [{"message": {"content": json.dumps({"tasks": []})}}]
    }

    with patch("httpx.Client.post", return_value=fake_response):
        result = client.analyze(notebook_cells=[{"source": "print(1)"}])
    assert result == {"tasks": []}


def test_analyze_returns_none_without_api_key():
    client = KiConnectClient(api_key="")
    assert client.analyze(notebook_cells=[]) is None


def test_analyze_returns_none_on_http_error():
    client = KiConnectClient(api_key="test-key")
    fake_response = Mock()
    fake_response.status_code = 500
    fake_response.text = "boom"

    with patch("httpx.Client.post", return_value=fake_response):
        result = client.analyze(notebook_cells=[])
    assert result is None


def test_autofix_returns_skipped_without_api_key():
    client = KiConnectClient(api_key="")
    assert client.autofix("x = ", "SyntaxError") == {"skipped": True}


def test_chat_completion_raises_on_401():
    client = KiConnectClient(api_key="wrong-key")
    fake_response = Mock()
    fake_response.status_code = 401

    with patch("httpx.Client.post", return_value=fake_response):
        try:
            client._chat_completion("sys", "user")
            assert False, "expected KiConnectError"
        except KiConnectError:
            pass
