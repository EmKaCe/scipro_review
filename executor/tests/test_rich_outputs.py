"""B11 tests: rich notebook outputs (image/png + text/html) preserved for the
teacher preview, capped via env vars.

Covers the runner's cell output extractor (`_extract_cell_output`) and the
app-layer conversion (`_cells_to_response` → CellResult.outputs):
  - image/png preserved as base64
  - text/html preserved as a raw string (including list-joined form)
  - an image over `RICH_OUTPUT_MAX_IMAGE_BYTES` is dropped (not stored)
  - `output_text` stays TEXT-ONLY (rich data never leaks into it)

Unit-level against synthetic cell dicts — no kernel needed. Mirrors the
test_auto_fix.py style (module-level helpers, monkeypatch for env caps).
"""

from __future__ import annotations

import app as app_module
import runner as runner_module
from runner import CellOutput, _extract_cell_output
from runner import RICH_OUTPUT_MAX_IMAGE_BYTES, RICH_OUTPUT_MAX_HTML_CHARS

PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def _cell_with_data(data: dict) -> dict:
    """A display_data cell carrying the given mime-type → value map."""
    return {
        "cell_type": "code",
        "source": "x = 1",
        "outputs": [{"output_type": "display_data", "data": data, "metadata": {}}],
    }


# ---------------------------------------------------------------------------
# image/png
# ---------------------------------------------------------------------------


def test_image_png_preserved_as_base64():
    cell = _cell_with_data(
        {"text/plain": "A small plot", "image/png": PNG_B64}
    )
    output_text, outputs, error, traceback = _extract_cell_output(cell)

    assert error is None and traceback is None
    assert output_text == "A small plot"
    assert outputs == [{"mime_type": "image/png", "data": PNG_B64}]
    # The base64 image never leaks into the text view (byte-identity contract).
    assert PNG_B64 not in output_text


def test_image_png_from_execute_result():
    cell = {
        "cell_type": "code",
        "source": "plt.plot(x)",
        "outputs": [
            {
                "output_type": "execute_result",
                "data": {"text/plain": "42", "image/png": PNG_B64},
                "metadata": {},
                "execution_count": 3,
            }
        ],
    }
    output_text, outputs, _, _ = _extract_cell_output(cell)
    assert output_text == "42"
    assert outputs == [{"mime_type": "image/png", "data": PNG_B64}]


def test_image_over_cap_is_dropped(monkeypatch):
    monkeypatch.setattr(runner_module, "RICH_OUTPUT_MAX_IMAGE_BYTES", 10)
    cell = _cell_with_data(
        {"text/plain": "Big plot", "image/png": PNG_B64}
    )
    output_text, outputs, _, _ = _extract_cell_output(cell)
    # Image dropped; text preserved.
    assert outputs == []
    assert output_text == "Big plot"


def test_default_image_cap_is_five_megabytes():
    # The snapshot default guards against accidental cap regressions.
    assert RICH_OUTPUT_MAX_IMAGE_BYTES == 5 * 1024 * 1024


# ---------------------------------------------------------------------------
# text/html
# ---------------------------------------------------------------------------


def test_text_html_preserved_as_raw_string():
    html = "<table><tr><td>R^2</td><td>0.9794</td></tr></table>"
    cell = _cell_with_data({"text/html": html, "text/plain": "R^2 = 0.9794"})
    output_text, outputs, _, _ = _extract_cell_output(cell)

    assert output_text == "R^2 = 0.9794"
    assert outputs == [{"mime_type": "text/html", "data": html}]
    assert html not in output_text


def test_text_html_list_joined():
    # nbformat may split long HTML across a list of strings.
    cell = _cell_with_data({"text/html": ["<b>a</b>", "<i>b</i>"]})
    _, outputs, _, _ = _extract_cell_output(cell)
    assert outputs == [{"mime_type": "text/html", "data": "<b>a</b><i>b</i>"}]


def test_text_html_truncated_to_cap(monkeypatch):
    monkeypatch.setattr(runner_module, "RICH_OUTPUT_MAX_HTML_CHARS", 20)
    cell = _cell_with_data({"text/html": "x" * 100})
    _, outputs, _, _ = _extract_cell_output(cell)
    assert outputs == [{"mime_type": "text/html", "data": "x" * 20}]


def test_default_html_cap():
    assert RICH_OUTPUT_MAX_HTML_CHARS == 200_000


# ---------------------------------------------------------------------------
# output_text stays text-only across a mixed cell
# ---------------------------------------------------------------------------


def test_output_text_unaffected_by_rich_media():
    cell = {
        "cell_type": "code",
        "source": "",
        "outputs": [
            {"output_type": "stream", "text": "first\n"},
            {
                "output_type": "display_data",
                "data": {
                    "text/plain": "plain view",
                    "image/png": PNG_B64,
                    "text/html": "<script>pwn(1)</script>",
                },
                "metadata": {},
            },
        ],
    }
    output_text, outputs, _, _ = _extract_cell_output(cell)
    assert "first" in output_text
    assert "plain view" in output_text
    assert PNG_B64 not in output_text
    assert "<script>" not in output_text
    mimes = [o["mime_type"] for o in outputs]
    assert "image/png" in mimes and "text/html" in mimes


# ---------------------------------------------------------------------------
# app-layer conversion (CellResult.outputs)
# ---------------------------------------------------------------------------


def test_cells_to_response_carries_outputs():
    runner_cells = [
        CellOutput(
            cell_index=0,
            execution_count=1,
            source="x = 1",
            output_text="plain",
            outputs=[
                {"mime_type": "image/png", "data": PNG_B64},
                {"mime_type": "text/html", "data": "<p>hi</p>"},
            ],
        )
    ]
    results = app_module._cells_to_response(runner_cells)
    assert len(results) == 1
    cell = results[0]
    assert cell.output_text == "plain"
    assert [
        {"mime_type": o.mime_type, "data": o.data} for o in cell.outputs
    ] == [
        {"mime_type": "image/png", "data": PNG_B64},
        {"mime_type": "text/html", "data": "<p>hi</p>"},
    ]


def test_cells_to_response_empty_outputs_default():
    runner_cells = [CellOutput(cell_index=0, execution_count=None, source="", output_text="")]
    results = app_module._cells_to_response(runner_cells)
    assert results[0].outputs == []
