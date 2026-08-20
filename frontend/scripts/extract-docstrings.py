#!/usr/bin/env python3
"""
extract-docstrings.py — extract API-reference chunks from INSTALLED packages'
docstrings (the exact pinned versions the grading executor runs), emitting
the same chunk shape build-docs-index.mjs embeds. This replaces the website
crawl (matplotlib/seaborn) and the HTML-doc zips (numpy/pandas/scipy/sklearn)
with a fully reproducible, version-exact source: `uv pip install <lib>==<pin>`
then introspect with inspect. No network at extract time beyond the install.

Usage:
  <venv>/bin/python extract-docstrings.py --out <chunks.json> --libs numpy,pandas,seaborn

  --libs <list>   comma list (default: all six)
  --out <path>    JSON output: {"<lib>": [ {title,url,text} ]}
  --min-chars N   drop docstrings shorter than N chars (default 60)
  --versions      optional map, e.g. "numpy=2.5.1;pandas=3.0.5" — only used to
                  stamp the version string into each chunk header.

Each chunk:
  ## <qualname> (<lib> <ver>)
  Signature: <inspect.signature or __text_signature__ fallback>
  <full docstring (with any inline >>> examples)>

url: built per-library from the object's qualname.
"""
import argparse
import importlib
import inspect
import json
import os
import pkgutil
import sys
import warnings

LIBS = {
    "numpy":     {"base": "https://numpy.org/doc/stable/reference/generated/",     "url_fmt": "{name}.html",              "deny": {"core", "distutils", "numpy.f2py"}},
    "pandas":    {"base": "https://pandas.pydata.org/docs/reference/api/",         "url_fmt": "{name}.html",              "deny": {"core", "util", "compat", "pandas.io.formats"}},
    "scipy":     {"base": "https://docs.scipy.org/doc/scipy/reference/generated/", "url_fmt": "{name}.html",              "deny": set()},
    "sklearn":   {"base": "https://scikit-learn.org/stable/modules/generated/",    "url_fmt": "{name}.html",              "deny": {"externals"}},
    "matplotlib":{"base": "https://matplotlib.org/stable/api/",                     "url_fmt": "_as_gen/{name}.html",     "deny": {"backends", "testing", "cbook", "ft2font", "mathtext", "sphinxext", "type1font", "dviread", "afm", "matplotlib.pylab"}},
    "seaborn":   {"base": "https://seaborn.pydata.org/generated/",                  "url_fmt": "{name}.html",              "deny": set()},
}

MIN_CHARS = 60


def is_public(name: str) -> bool:
    return not name.startswith("_")


def doc_parts(obj):
    """Return (signature_str, docstring) with tolerant fallbacks. Never raises."""
    try:
        sig = str(inspect.signature(obj))
    except (ValueError, TypeError):
        ts = getattr(obj, "__text_signature__", None)
        sig = ts if ts else ""
    try:
        doc = inspect.getdoc(obj) or ""
    except Exception:
        doc = ""
    return sig, doc


def name_of(obj):
    mod = getattr(obj, "__module__", "") or ""
    qn = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None) or "?"
    return f"{mod}.{qn}" if mod else str(qn)


def collect_module(module, public_path, cfg, out, visited, depth=0):
    """Collect public callables from a module, naming each by its PUBLIC traversal
    path. Public-path naming matters: many docs' API lives in private impl modules
    (e.g. `sklearn.linear_model._base.LinearRegression`, `scipy.stats._continuous
    _distns.norm_gen`) — using __qualname__ there would yield `._`-laden names that
    the build's pruneChunks (correctly) drops as internal. Naming by the path we
    walked keeps `sklearn.linear_model.LinearRegression` / `scipy.stats.norm`."""
    if depth > 3 or id(module) in visited:
        return
    visited.add(id(module))
    # Auto-descend into ALL public submodules (imported by full name), bounded by
    # depth. A curated list silently drifted and dropped whole subpackages
    # (scipy.special/ndimage/sparse/constants, several sklearn submodules,
    # matplotlib.widgets) that the old zips covered — pkgutil enumeration + depth
    # bound + visited-set keeps it complete without that drift. Private submodules
    # (names starting with `_`) are skipped so `._` qualnames can't sneak in.
    try:
        children = [m.name for m in pkgutil.iter_modules(module.__path__ or [])]
    except Exception:
        children = []
    for child in children:
        if not is_public(child):
            continue
        # Test packages are public-named but carry no user API (and drag in the
        # `pytest` dependency).
        if child in ("tests", "test", "conftest") or child.startswith("test"):
            continue
        full = f"{public_path}.{child}"
        # Deny implementation packages (public-named but not documented API) as
        # dotted prefixes — fail-closed on junk without reintroducing allow-list
        # drift: everything not denied is still auto-walked.
        deny = cfg.get("deny", set())
        if child in deny or any(full == d or full.startswith(d + ".") for d in deny):
            continue
        if full in out["_mods"] or full == public_path:
            continue
        out["_mods"].add(full)
        try:
            collect_module(importlib.import_module(full), full, cfg, out, visited, depth + 1)
        except Exception as e:
            print(f"[extract-docstrings] WARN: cannot import {full}: {e}", file=sys.stderr)
    names = getattr(module, "__all__", None)
    if names is None:
        names = [n for n in dir(module) if is_public(n)]
    for n in names:
        try:
            obj = getattr(module, n)
        except Exception:
            continue
        if inspect.ismodule(obj):
            continue  # handled via the explicit submodule list
        if not callable(obj):
            continue
        name = f"{public_path}.{n}"
        if name in out["_seen"]:
            continue
        sig, doc = doc_parts(obj)
        if len(doc) < MIN_CHARS:
            out["_seen"].add(name)
            continue
        out["chunks"].append({"name": name, "sig": sig, "doc": doc})
        out["_seen"].add(name)
        if inspect.isclass(obj):
            for m in dir(obj):
                if not is_public(m):
                    continue
                try:
                    member = getattr(obj, m)
                except Exception:
                    continue
                if not (inspect.isfunction(member) or inspect.ismethod(member) or inspect.ismethoddescriptor(member)):
                    continue
                mname = f"{name}.{m}"
                if mname in out["_seen"]:
                    continue
                msig, mdoc = doc_parts(member)
                if len(mdoc) < MIN_CHARS:
                    out["_seen"].add(mname)
                    continue
                out["chunks"].append({"name": mname, "sig": msig, "doc": mdoc})
                out["_seen"].add(mname)


def main():
    global MIN_CHARS
    ap = argparse.ArgumentParser()
    ap.add_argument("--libs", default="numpy,pandas,scipy,sklearn,matplotlib,seaborn")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-chars", type=int, default=MIN_CHARS)
    ap.add_argument("--versions", default="")
    args = ap.parse_args()
    MIN_CHARS = args.min_chars

    versions = {}
    for pair in [p for p in args.versions.split(";") if p]:
        k, _, v = pair.partition("=")
        versions[k.strip()] = v.strip()

    wanted = [s.strip() for s in args.libs.split(",") if s.strip()]
    # matplotlib imports need a non-interactive backend or pyplot import can hang.
    os.environ.setdefault("MPLBACKEND", "Agg")
    # Importing subpackages (notably scipy.constants) emits module-level
    # DeprecationWarnings that flood stderr — not actionable, suppress them.
    warnings.simplefilter("ignore", DeprecationWarning)
    result = {}
    for lib in wanted:
        cfg = LIBS[lib]
        try:
            root = importlib.import_module(lib)
        except Exception as e:
            print(f"[extract-docstrings] WARN: cannot import {lib}: {e}", file=sys.stderr)
            result[lib] = []
            continue
        state = {"_seen": set(), "_mods": set(), "chunks": []}
        try:
            collect_module(root, lib, cfg, state, set(), 0)
        except Exception as e:
            print(f"[extract-docstrings] WARN: {lib} walk aborted: {e}", file=sys.stderr)
        ver = versions.get(lib, "")
        chunks = []
        for c in state["chunks"]:
            header = f"## {c['name']} ({lib} {ver})".strip()
            sig = f"Signature: {c['sig']}" if c["sig"] else "Signature: (n/a)"
            chunks.append({
                "title": c["name"],
                "url": cfg["base"] + cfg["url_fmt"].format(name=c["name"]),
                "text": "\n\n".join([header, sig, c["doc"]]),
            })
        result[lib] = chunks
        print(f"[extract-docstrings] {lib}: {len(chunks)} chunks")
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
