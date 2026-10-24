# Changelog

## 0.3.3 - 2026-10-24

### Added

- You can now move through the local app using grouped Explore, Workflow, and System navigation.
- You can explore related memory in a Sigma knowledge graph with progressive expansion, clustering, search, keyboard access, and saved layouts.

### For contributors

- Added regression coverage for the modern interface, graph branch collapse, responsive controls, and hosted-auth response compatibility.

### Changed

- The Sigma knowledge graph is now the default, while the legacy graph remains available as an override.
- The public package includes only working graph capabilities; the incomplete Universe experiment remains excluded.
- The CLI, MCP server card, package manifest, and registry metadata now consistently report version 0.3.3.

### Fixed

- Graph interactions now handle stale requests, nested branch cursors, rejected actions, narrow-desktop toolbars, and obsolete context menus safely.
- Hosted-auth controls once again use the public Firebase response contract, and private workspace-specific strings no longer appear in the package.
