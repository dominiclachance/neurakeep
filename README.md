# NeuraKeep

NeuraKeep is a local-first memory system for AI agents.

It gives Claude Desktop, Claude Code, Codex, OpenClaw, Cursor-style tools, and other MCP clients
a shared, source-cited memory layer that runs on your own machine.

## What It Does

- Imports Markdown, text, JSONL, and PDFs into a local vault
- Preserves raw sources and extracts cited memory proposals
- Lets you review memory before it becomes durable
- Searches across sources, facts, events, failures, and decisions
- Organizes the local app into grouped Explore, Workflow, and System navigation
- Shows a Sigma knowledge graph with progressive expansion, clustering, search, keyboard access, and saved layouts
- Exposes MCP tools for agents:
  - `memory_search`
  - `memory_read`
  - `memory_explain_sources`
  - `memory_save` (stores new text immediately and queues structured memory for review)
  - `memory_propose_update`
  - `memory_apply_update`

The core rule is simple: agents can save new source memory immediately, but extracted durable facts
remain reviewable and source-cited.

## Local Install

Requirements:

- Node.js 22+
- npm

```bash
npm install
npm run build:all
node dist/cli/index.js init --root .umos
node dist/cli/index.js serve --root .umos --host 127.0.0.1 --port 8765 --ui --read-write
```

Open:

```text
http://127.0.0.1:8765/index.html
```

## Start Free Locally

Use the local core when you want private, source-cited memory on your own machine:

- import Markdown, text, JSONL, or PDFs
- review extraction proposals before durable memory is applied
- connect Claude, Codex, OpenClaw, or another MCP client over stdio

## Hosted NeuraKeep

Use the hosted app when you need Google or enterprise SAML/OIDC sign-in, private personal vaults,
isolated shared Team spaces, remote MCP over HTTPS, managed storage, backups, and Stripe-managed
billing. Team workspaces include owner/admin/reviewer/editor/viewer roles, email-bound invitations,
audit history, licensed seats, and SCIM provisioning. Hosted access requires an active individual or
Team subscription. OAuth-capable remote MCP clients use browser sign-in and explicit space consent with
PKCE and rotating refresh tokens; space-bound, scoped, expiring manual grants remain available for
non-interactive clients. Hosted autonomous spaces use application-level encryption at rest, but are not
zero-knowledge because the authorized runtime decrypts them while working.

The public package contains the complete local-first core. Managed authentication, Stripe billing,
Team tenancy, SSO, SCIM, deployment automation, and production credentials remain part of the
hosted service and are not required to run NeuraKeep locally.

## CLI Examples

```bash
node dist/cli/index.js ingest README.md --root .umos --kind markdown --space personal --trust-level trusted --origin manual --sensitivity internal
node dist/cli/index.js search "what should my agents remember?" --root .umos --space personal --neighbors 1
node dist/cli/index.js propose latest --root .umos
node dist/cli/index.js apply <proposal-id> --root .umos
node dist/cli/index.js mcp --root .umos
```

## Local MCP Setup

Example stdio MCP config:

```json
{
  "command": "node",
  "args": [
    "C:/path/to/neurakeep/dist/cli/index.js",
    "mcp",
    "--root",
    "C:/path/to/neurakeep/.umos"
  ]
}
```

Local HTTP mode:

```bash
node dist/cli/index.js serve --root .umos --host 127.0.0.1 --port 8765 --ui
```

Use `--token` or `NEURAKEEP_MCP_TOKEN` before exposing any HTTP endpoint outside your machine.

## Free vs Paid

The open-source version is for local, self-managed memory. The hosted product adds managed auth,
team spaces, remote connectors, shared storage, backups, and administration. See
[NeuraKeep pricing](https://www.neurakeep.com/#pricing) for the current hosted plans.

## Docs

- [Manual Imports](docs/MANUAL_IMPORTS.md)
- [MCP Integrations](docs/MCP_INTEGRATIONS.md)
- [Open Source Core](docs/OPEN_SOURCE.md)
- [Public Package Boundary](OSS_PACKAGE.md)

## Development Checks

```bash
npm run typecheck
npm run build:all
npm test
npm run e2e
npm run check:secrets
```

## License

Apache-2.0
