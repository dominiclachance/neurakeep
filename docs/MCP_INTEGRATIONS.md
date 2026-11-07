# NeuraKeep MCP Integrations

NeuraKeep exposes the same memory tools over stdio MCP and local HTTP MCP.

## Tools

- `memory_search` - ranked search with citations, confidence guidance, related failures, and neighbor context.
- `memory_read` - read a source, section, event, fact, failure, or proposal.
- `memory_explain_sources` - inspect citation provenance.
- `memory_save` - save new text as a searchable source and queue a structured-memory proposal for review.
- `memory_propose_update` - create a pending proposal from an ingested source.
- `memory_apply_update` - apply a reviewed pending proposal.

## Local Diagnostics

When `umos serve --ui` is running, use:

```http
GET /api/integrations/status
GET /api/workflow/daily-loop
```

`/api/integrations/status` reports the local HTTP endpoint, stdio command, known client config files, available tools, and smoke-test prompts.
`/api/workflow/daily-loop` combines integration status, watcher status, import/OCR support, quality backlog, and recommended next actions.

To queue a session-close summary and sync workspace memory without applying durable facts:

```http
POST /api/workflow/daily-loop
{
  "queueSummary": true,
  "reason": "session-close"
}
```

The workflow loop is queue-first. It indexes raw sources and creates proposals; it does not auto-apply durable memory.

## OpenClaw

Use stdio MCP for local agent memory. The command should point at the built CLI:

```json
{
  "mcpServers": {
    "neurakeep": {
      "command": "node",
      "args": ["C:/path/to/neurakeep/dist/cli/index.js", "mcp", "--root", "C:/path/to/your-vault/.umos"]
    }
  }
}
```

For requests such as "remember this," agents should call `memory_save`. The source is searchable immediately, while extracted facts stay queue-first and review-gated. Use `memory_propose_update` only when the source is already ingested and its `source_id` is known.

Directory clients must never automatically collect, scan, or import Claude, ChatGPT, or other conversation history. Call `memory_save` only for specific content the user explicitly asks NeuraKeep to remember.

## Claude Code

Use:

```powershell
claude mcp add neurakeep node C:/path/to/neurakeep/dist/cli/index.js mcp --root C:/path/to/your-vault/.umos
claude mcp get neurakeep
```

Smoke expectation: `claude mcp get neurakeep` reports connected, and `tools/list` includes the six NeuraKeep tools above.

## Claude Desktop

Add the same stdio command to `claude_desktop_config.json`. Restart Claude Desktop after editing. Prefer stdio locally; use HTTP only for browser/tunnel testing.

## Remote MCP For Hosted NeuraKeep

Hosted deployments expose JSON-RPC over HTTPS at `/mcp`.

Authentication options:

- Interactive remote connectors: OAuth 2.1 browser sign-in and consent with PKCE S256, dynamic client registration, one-hour access tokens, and rotating refresh tokens
- Browser/user sessions: `Authorization: Bearer <Google ID token verified by Firebase Auth>`
- Customer agent sessions: `Authorization: Bearer <tenant-bound token created in Settings>`
- Automated health sessions: `Authorization: Bearer <read-only, expiring per-space grant>`

Customer MCP tokens are stored only as SHA-256 hashes, inherit the owner's Stripe entitlement, and
resolve to the same isolated tenant vault as the owner's Firebase session. Revocation takes effect on
the next request. A token from one account cannot select or read another account's vault.

Start a hosted server with Google sign-in/Firebase Auth, Stripe entitlements, and managed autonomous-agent grants:

```powershell
$env:NEURAKEEP_PUBLIC_URL = "https://app.neurakeep.com"
$env:NEURAKEEP_SERVICE_TOKENS = "sha256:<sha256-of-issued-token>"
node dist/cli/index.js serve --root .umos --host 127.0.0.1 --port 8765 --hosted --firebase-project <project-id>
```

Discovery endpoints:

```http
GET /.well-known/oauth-protected-resource/mcp
GET /.well-known/oauth-authorization-server
GET /api/billing/status
GET /api/hosted/storage
```

Smithery and other registries can read the public, metadata-only server card without authenticating to a memory vault:

```http
GET /.well-known/mcp/server-card.json
```

The card is generated from the same manifest as MCP `tools/list`, declares OAuth2 authentication, and contains only server metadata and tool input schemas. It must never include credentials, user identifiers, source content, or example memory records.

Claude and other compatible remote clients discover NeuraKeep's OAuth endpoints, register dynamically,
open the browser for NeuraKeep/Firebase sign-in, and ask the user to approve the selected space and
scopes. The standard hosted OAuth consent requests `memory:read`, `memory:propose`, and `memory:apply`
so all six advertised tools are available after explicit consent. A connector may still request a
smaller scope set; a read/propose-only grant receives a structured JSON-RPC permission error if it
attempts to apply a proposal. Signed-in customers can still create and revoke manual tenant-bound grants in Settings for
clients that need non-interactive bearer-token configuration. Raw grant values are displayed once and
must never be committed to a repository.

## Codex

For local Codex workflows, expose NeuraKeep through the same MCP stdio command when the MCP host supports it. If using HTTP, run:

```powershell
node dist/cli/index.js serve --root .umos --ui --read-write --host 127.0.0.1 --port 8765
```

Then call `/mcp` with JSON-RPC. Read-only mode disables proposal/apply tools; read-write mode still produces proposals first.

For OAuth-capable remote connectors such as Claude, configure only the HTTPS `/mcp` URL and complete
the browser authorization flow. For non-interactive Codex/OpenClaw integrations, pass a customer-created
tenant-bound grant as a bearer token. `NEURAKEEP_SERVICE_TOKENS` is reserved for deployment health and
administration, not shared customer access.

## Smoke Test

1. Build: `npm run build:all`
2. Stdio initialize: send JSON-RPC `initialize`
3. Tool list: send JSON-RPC `tools/list`
4. Search: call `memory_search` for `do not repeat`
5. Read: call `memory_read` for one result ID
6. Save a canary with `memory_save`, inspect it with `memory_explain_sources`, and create a second proposal with `memory_propose_update`
7. Apply only that explicitly reviewed canary proposal with `memory_apply_update`

Do not mark an integration healthy unless all six tools are advertised, every call returns a valid
JSON-RPC response, and the search response includes structured content, citation IDs, and
`guidance.recommendedNextStep`.
