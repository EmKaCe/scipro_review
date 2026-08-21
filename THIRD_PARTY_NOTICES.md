# Third-Party Notices

This file documents the third-party software whose **docstrings** are
redistributed in the static, offline documentation index shipped with
**SciPro Review** (the student and teacher builds of the SvelteKit app in
`frontend/`). These notices satisfy the attribution requirements imposed by
the permissive licenses of the referenced projects.

The SciPro Review application itself — all original code, configuration, and
assets not listed below — is licensed under the GNU Affero General Public
License v3.0. The full text is in the repository's [`LICENSE`](LICENSE)
(AGPL-3.0).

The chunks in the offline docs index are **not** compiled, linked, or executed
binaries of these projects. They are documentation strings extracted from two
sources:

| Source | Extraction pipeline |
| ------ | -------------------- |
| Installed pinned Python wheels (`numpy`, `pandas`, `scipy`, `scikit-learn`, `matplotlib`, `seaborn`) | [`frontend/scripts/extract-docstrings.py`](frontend/scripts/extract-docstrings.py) |
| The Python 3.12 documentation archive zip | [`frontend/scripts/build-docs-index.mjs`](frontend/scripts/build-docs-index.mjs) |

Full canonical license texts for every license referenced below live in
[`LICENSES/`](LICENSES/).

## SciPy stack docstrings — BSD-3-Clause

The following SciPy-stack libraries are pinned in
[`frontend/scripts/docs-libraries.json`](frontend/scripts/docs-libraries.json).
Their docstrings are redistributed under the BSD-3-Clause License
(`LICENSES/BSD-3-Clause.txt`).

| Library | Pinned version | License | Copyright |
| ------- | -------------- | ------- | --------- |
| NumPy | 2.5.1 | BSD-3-Clause | Copyright (c) 2005-2025, NumPy Developers |
| pandas | 3.0.5 | BSD-3-Clause | Copyright (c) 2008-2025, the pandas development team |
| SciPy | 1.18.0 | BSD-3-Clause | Copyright (c) 2001-2002 Enthought, Inc. 2003-2025, SciPy Developers |
| scikit-learn | 1.9.0 | BSD-3-Clause | Copyright (c) 2007-2025 scikit-learn developers |
| Matplotlib | 3.11.1 | BSD-3-Clause | Copyright (c) 2012-2025 Matplotlib Development Team; All Rights Reserved |
| seaborn | 0.13.2 | BSD-3-Clause | Copyright (c) 2012-2025, Michael Waskom |

Versions are the exact pinned values from `docs-libraries.json`; this index is
rebuilt from those pins by CI, so the notices above track the same corpus.

## Python 3.12 documentation — PSF License Agreement

The standard-library, builtins, and typing doc pages in the offline index are
extracted from the Python 3.12 documentation archive:

- Archive: `python-3.12.6-docs-html.zip`
- SHA-256: `96522240bc5ab86febd1448b7d800a05f7b884d8071c958803d0bf5d271209c8`
- Covered pages: standard library (`library/math.html`, `library/statistics.html`,
  `library/random.html`, `library/os.html`, `library/sys.html`, `library/re.html`,
  `library/json.html`, `library/datetime.html`, `library/collections.html`,
  `library/itertools.html`, `library/functools.html`, `library/pathlib.html`,
  `library/operator.html`, `library/copy.html`, `library/string.html`,
  `library/decimal.html`, `library/fractions.html`, `library/heapq.html`,
  `library/bisect.html`), builtins (`library/functions.html`,
  `library/constants.html`, `library/builtins.html`), and typing
  (`library/typing.html`).

These pages are redistributed under the Python Software Foundation License
Agreement, version 2 (PSF-2.0), the full text of which is in
`LICENSES/PSF-2.0.txt`.

## No other redistributed documentation content

Apart from the docstrings listed above, SciPro Review bundles **no** other
third-party documentation content. All remaining content in this repository is
original work and is licensed under the GNU Affero General Public License v3.0
([`LICENSE`](LICENSE)).

> **Scope note.** The built app installs third-party npm packages (Svelte,
> Tailwind CSS, shadcn-svelte, lucide, etc. — see `frontend/package.json`);
> their licenses are managed by the package manager at install time. This
> document covers only the documentation content redistributed in the offline
> docs index.
