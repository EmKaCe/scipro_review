# Open Design MCP Tools Reference

## Overview

Open Design exposes MCP tools via a stdio server run by `od mcp`. The daemon must be running locally for these tool calls to succeed. When the `project` parameter is omitted, tools default to the project and file currently open in the OD UI.

## Tool Reference

### `list_projects`

List all Open Design projects on the daemon.

- **Parameters**: None
- **Returns**: Array of project objects with `id`, `name`, and metadata

### `get_active_context`

Get the project and file the user currently has open in OD.

- **Parameters**: None
- **Returns**: `{ active: boolean, hint: string }` — Returns `{ active: false }` when no project is active (context expires ~5 min after last interaction)

### `get_project`

Single project metadata: name, active skill/design-system IDs, entry file, kind, timestamps.

- **Parameters**:
  - `project` (string, optional): Project ID (UUID) or name substring. Defaults to active project.
- **Returns**: Project metadata object

### `get_artifact`

**PREFER THIS** over multiple `get_file` calls. Bundles the entry file plus every sibling it references (HTML `<script>`/`<link>`/`<img>`/`srcset`, JSX `import`/`require`, CSS `url()`/`@import`) up to depth 3, skipping CDN/data URLs.

- **Parameters**:
  - `project` (string, optional): Project ID or name substring. Defaults to active.
  - `entry` (string, optional): Entry file path relative to project root. Defaults to active file or project's `metadata.entryFile`.
  - `include` (string, optional): `auto` (default) | `all` (every file) | `shallow` (just entry)
  - `maxBytes` (number, optional): Soft cap on total text bytes (default 1,500,000). Capped at 200 files.
- **Returns**: Entry file content plus all referenced sibling files

### `get_file`

Read one project file. Text mimes only (HTML, JSX, CSS, JSON, SVG, Markdown). Binary files return an error.

- **Parameters**:
  - `project` (string, optional): Project ID or name substring. Defaults to active.
  - `path` (string, optional): File path relative to project root. Defaults to active file.
  - `offset` (number, optional): 0-indexed starting line (default 0)
  - `limit` (number, optional): Max lines to return (default 2000)
- **Returns**: File content with line numbers. Long files include `[od:file-window ...]` marker for paging.

### `list_files`

Project file metadata: name, path, mime, kind, size, mtime, optional artifactManifest.

- **Parameters**:
  - `project` (string, optional): Project ID or name substring. Defaults to active.
  - `since` (number, optional): Unix-ms; only return files with `mtime > since`
- **Returns**: Array of file metadata objects

### `search_files`

Case-insensitive **literal substring** search across textual files in a project. Not regex.

- **Parameters**:
  - `query` (string, required): Literal substring to search for
  - `project` (string, optional): Project ID or name substring. Defaults to active.
  - `pattern` (string, optional): Glob on file name, e.g., `*.html`
  - `max` (number, optional): Cap on matches (default 200, hard cap 1000)
- **Returns**: Array of matches with file, 1-indexed line, and snippet

### `create_artifact`

Create a new artifact entry file. Rejects existing targets. HTML, Markdown, and SVG entries get a default manifest when `artifactManifest` is omitted.

- **Parameters**:
  - `name` (string, required): Output path relative to project root, e.g., `my-page/index.html`
  - `content` (string, required): Entry file contents
  - `project` (string, optional): Project ID or name substring. Defaults to active.
  - `encoding` (string, optional): `utf8` (default) | `base64`
  - `artifactManifest` (object, optional): Sidecar manifest. Inferred for HTML/Markdown/SVG if omitted.
- **Returns**: Created artifact metadata

## Usage Patterns

### Reading a full design bundle

```
get_artifact(entry="my-page/index.html", include="auto")
```

This pulls the HTML entry plus all CSS, JS, and image references in one call.

### Searching for color issues

```
search_files(query="#ffffff", pattern="*.html")
search_files(query="oklch(50%", pattern="*.html")
```

### Checking what changed recently

```
list_files(since=1716633600000)  # Unix ms timestamp
```

### Creating a new artifact

```
create_artifact(name="dashboard/index.html", content="<!doctype html>...")
```

## Project Resolution

The `project` parameter accepts either:
- A UUID (exact match): `7e9f48d1-4818-4767-8069-a85a3138ed44`
- A name substring (fuzzy match): `scipro` → resolves to "SciPro Review"

When a project is matched by substring, the response includes `resolvedProject: { id, name }` so you can confirm which project was resolved.

## Active Context Expiry

The active context (project + file from OD UI) expires approximately 5 minutes after the last user interaction with OD. After expiry, tools that default to the active context will return `{ active: false, hint: "..." }`.

To avoid this, pass the `project` parameter explicitly when you know the project ID.