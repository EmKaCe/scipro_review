"""Phase 3b tests: assignment-scoped sandbox, path normalization
annotations, cell_edits/original_source, modified input-data detection."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import (
    _assignment_from_path,
    _build_preprocessing_info,
    _discover_data_files,
)
from preprocessor import (
    _comment_shell_commands,
    _normalize_paths,
    _strip_colab_imports,
    preprocess_notebook,
)
from runner import cleanup_sandbox, create_sandbox, execute_notebook


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_notebook(nb_path: Path, source_lines: list[str]) -> None:
    """Write a minimal-but-valid nbformat 4.5 notebook with one code cell."""
    nb = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "id": "cell-0",
                "metadata": {},
                "outputs": [],
                "source": source_lines,
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python", "version": "3.12"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    nb_path.write_text(json.dumps(nb), encoding="utf-8")


# ---------------------------------------------------------------------------
# Task 1 — sandbox scopes by assignment, preserves directory structure
# ---------------------------------------------------------------------------


def test_sandbox_scopes_by_assignment(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    # Assignment "soil": its input data
    soil_data = data_dir / "materials" / "soil" / "input_data"
    soil_data.mkdir(parents=True)
    (soil_data / "soil_samples.csv").write_text("a,b\n1,2")

    # Assignment "other": different data — must NOT appear in sandbox
    other_data = data_dir / "materials" / "other" / "input_data"
    other_data.mkdir(parents=True)
    (other_data / "other_secret.csv").write_text("x,y\n3,4")

    # Notebook for assignment "soil"
    nb_dir = data_dir / "submissions" / "soil"
    nb_dir.mkdir(parents=True)
    nb = nb_dir / "2026SS_03.ipynb"
    nb.write_text("{}")

    sandbox, dest_nb = create_sandbox(nb, data_dir, assignment_id="soil")
    try:
        assert (sandbox / "soil_samples.csv").exists()       # assignment data present
        assert not (sandbox / "other_secret.csv").exists()   # other assignment absent
        assert dest_nb.exists()
    finally:
        cleanup_sandbox(sandbox)


def test_sandbox_subdirectory_preserved(tmp_path):
    data_dir = tmp_path / "data"
    sub = data_dir / "materials" / "soil" / "input_data" / "nested"
    sub.mkdir(parents=True)
    (sub / "reference.csv").write_text("c,d\n3,4")

    nb_dir = data_dir / "submissions" / "soil"
    nb_dir.mkdir(parents=True)
    nb = nb_dir / "2026SS_07.ipynb"
    nb.write_text("{}")

    sandbox, dest_nb = create_sandbox(nb, data_dir, assignment_id="soil")
    try:
        assert (sandbox / "nested" / "reference.csv").exists()
    finally:
        cleanup_sandbox(sandbox)


# ---------------------------------------------------------------------------
# Task 2 + 3 — Windows absolute paths, inline annotations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path,expected_file",
    [
        (r"C:\\Users\\emre\\soil.csv", "soil.csv"),
        (r"C:/Users/emre/soil.csv", "soil.csv"),
        (r"d:\\data\\test.csv", "test.csv"),
        (r"D:/data/test.csv", "test.csv"),
        (r"C:\Users\emre\soil.csv", "soil.csv"),
        (r"d:\data\test.csv", "test.csv"),
    ],
)
def test_windows_absolute_path_normalized(path, expected_file):
    source = f"df = pd.read_csv('{path}')"
    result, changes = _normalize_paths(source)
    assert len(changes) == 1
    assert changes[0][1] == expected_file
    # The corrected line is executable and keeps the bare filename
    assert f"pd.read_csv('{expected_file}')" in result


def test_linux_absolute_path_normalized():
    source = "df = pd.read_csv('/content/drive/soil.csv')"
    result, changes = _normalize_paths(source)
    assert len(changes) == 1
    assert changes[0] == ("/content/drive/soil.csv", "soil.csv")


def test_absolute_path_annotation():
    source = "df = pd.read_csv('/content/drive/soil.csv')"
    result, changes = _normalize_paths(source)
    assert len(changes) == 1
    assert "SciPro: normalized_absolute_path" in result
    assert "# df = pd.read_csv('/content/drive/soil.csv')" in result
    assert "pd.read_csv('soil.csv')" in result


def test_relative_and_dynamic_paths_left_as_is():
    """D3/D5: bare filenames, subdirectory paths, and dynamic paths are
    never annotated — the sandbox's structure preservation handles them."""
    source = (
        "df = pd.read_csv('soil.csv')\n"
        "df2 = pd.read_csv('data/soil.csv')\n"
        "df3 = pd.read_csv(path_variable)\n"
        "df4 = pd.read_csv(f'data/{var}.csv')\n"
    )
    result, changes = _normalize_paths(source)
    assert changes == []
    assert result == source


# ---------------------------------------------------------------------------
# Task 6 — colab/shell annotation format + edit_type token alignment
# ---------------------------------------------------------------------------


def test_colab_import_annotated():
    source = "from google.colab import drive\nprint('hi')\n"
    result, was_modified = _strip_colab_imports(source)
    assert was_modified
    assert "SciPro: removed_colab_import" in result
    assert "# from google.colab import drive" in result
    assert "print('hi')" in result


def test_colab_import_skips_student_comments():
    source = "# from google.colab import drive\nprint('hi')\n"
    result, was_modified = _strip_colab_imports(source)
    assert not was_modified
    assert result == source


def test_shell_command_annotation_marker():
    source = "!pip install pandas\nprint('ok')\n"
    result, commented = _comment_shell_commands(source)
    assert commented == ["pip install pandas"]
    assert "# SciPro: commented_shell_cmd — shell commands unavailable in" in result
    assert "# !pip install pandas" in result


def test_cell_edits_use_annotation_tokens():
    """sanitize_cell edit_types must match the # SciPro annotation tokens."""
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "source": [
                    "from google.colab import drive\n",
                    "df = pd.read_csv('/content/soil.csv')\n",
                    "!wget http://example.com/x.csv\n",
                ],
            },
        ]
    }
    result = preprocess_notebook(notebook)
    types = {e.edit_type for e in result.edits}
    assert types == {
        "removed_colab_import",
        "normalized_absolute_path",
        "commented_shell_cmd",
    }


# ---------------------------------------------------------------------------
# Task 4 — assignment derivation + available_paths for LLM context
# ---------------------------------------------------------------------------


def test_assignment_derived_from_notebook_path():
    assert _assignment_from_path(Path("submissions/soil/2026SS_03.ipynb")) == "soil"
    assert _assignment_from_path(Path("/app/data/submissions/soil/2026SS_03.ipynb")) == "soil"
    assert _assignment_from_path(Path("other/place.ipynb")) is None


def test_available_paths_passed_to_llm_context(tmp_path):
    data_dir = tmp_path / "data"
    input_dir = data_dir / "materials" / "soil" / "input_data"
    input_dir.mkdir(parents=True)
    (input_dir / "soil.csv").write_text("a,b\n1,2")
    nested = input_dir / "nested"
    nested.mkdir(parents=True)
    (nested / "ref.txt").write_text("x")

    available = _discover_data_files("soil", data_dir)
    assert "soil.csv" in available
    assert "nested/ref.txt" in available

    # A different assignment sees none of soil's files
    assert _discover_data_files("other", data_dir) == set()


# ---------------------------------------------------------------------------
# Task 5 — cell_edits in PreprocessingInfo + original_source preserved
# ---------------------------------------------------------------------------


def test_cell_edits_in_response():
    notebook = {
        "cells": [
            {"cell_type": "code", "source": ["from google.colab import drive\n"]},
        ]
    }
    result = preprocess_notebook(notebook)
    info = _build_preprocessing_info(result)
    assert 0 in info.cell_edits
    assert len(info.cell_edits[0]) == 1
    assert info.cell_edits[0][0]["edit_type"] == "removed_colab_import"


def test_original_source_preserved():
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "source": ["from google.colab import drive\n", "print('hi')\n"],
            },
        ]
    }
    result = preprocess_notebook(notebook)
    # Original must be intact even though sanitization modified the dict
    assert "from google.colab import drive" in result.original_cells[0]
    assert "print('hi')" in result.original_cells[0]


# ---------------------------------------------------------------------------
# Task 7 — modified input-data detection (real kernel execution)
# ---------------------------------------------------------------------------


def test_modified_input_data_detected(tmp_path):
    data_dir = tmp_path / "data"
    input_dir = data_dir / "materials" / "soil" / "input_data"
    input_dir.mkdir(parents=True)
    original = input_dir / "soil_samples.csv"
    original.write_text("a,b\n1,2\n")

    nb_dir = data_dir / "submissions" / "soil"
    nb_dir.mkdir(parents=True)
    nb = nb_dir / "2026SS_03.ipynb"
    _write_notebook(
        nb,
        [
            "import pandas as pd\n",
            'df = pd.read_csv("soil_samples.csv")\n',
            'df.to_csv("soil_samples.csv")\n',
        ],
    )

    result = execute_notebook(
        nb, timeout=30, kernel_name="python3",
        data_dir=data_dir, assignment_id="soil",
    )
    assert "soil_samples.csv" in result.modified_files
    # The original on the shared volume stays untouched
    assert original.read_text() == "a,b\n1,2\n"


def test_untouched_input_data_not_reported(tmp_path):
    data_dir = tmp_path / "data"
    input_dir = data_dir / "materials" / "soil" / "input_data"
    input_dir.mkdir(parents=True)
    (input_dir / "soil_samples.csv").write_text("a,b\n1,2\n")

    nb_dir = data_dir / "submissions" / "soil"
    nb_dir.mkdir(parents=True)
    nb = nb_dir / "2026SS_03.ipynb"
    _write_notebook(
        nb,
        [
            "import pandas as pd\n",
            'df = pd.read_csv("soil_samples.csv")\n',
            "print(df.shape)\n",
        ],
    )

    result = execute_notebook(
        nb, timeout=30, kernel_name="python3",
        data_dir=data_dir, assignment_id="soil",
    )
    assert result.modified_files == []


def test_cell_type_preserved_in_response(tmp_path):
    """Markdown cells keep their original cell_type in the executor response."""
    from app import _cells_to_response

    nb_dir = tmp_path / "data" / "submissions" / "soil"
    nb_dir.mkdir(parents=True)
    nb = nb_dir / "2026SS_03.ipynb"

    nb_json = {
        "cells": [
            {
                "cell_type": "markdown",
                "execution_count": None,
                "id": "cell-0",
                "metadata": {},
                "outputs": [],
                "source": ["# Task 1\\n"],
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "id": "cell-1",
                "metadata": {},
                "outputs": [],
                "source": ["x = 1\\n"],
            },
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    nb.write_text(json.dumps(nb_json), encoding="utf-8")

    result = execute_notebook(
        nb, timeout=30, kernel_name="python3",
        data_dir=tmp_path / "data", assignment_id="soil",
    )
    # execute_notebook itself does not carry cell types — the response
    # builder must derive them from pre-processing, which is what the
    # /execute route does. Simulate that mapping here.
    cell_types = {0: "markdown", 1: "code"}
    cells = _cells_to_response(result.cells, cell_types=cell_types)

    assert cells[0].cell_type == "markdown"
    assert cells[1].cell_type == "code"
    # Missing type falls back to "code"
    cells_no_types = _cells_to_response(result.cells)
    assert cells_no_types[0].cell_type == "code"
