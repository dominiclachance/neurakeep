import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  rmSync,
  type FSWatcher
} from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraphState, writeGraphState } from "../app/state.js";
import type { VaultPaths } from "../core/paths.js";
import { migrateDatabase, openDatabase, type UmosDatabase } from "../db/client.js";
import { exportStaticApp, buildGraph, buildGraphView } from "../app/export.js";
import { ingestFile } from "../ingest/ingest.js";
import { redactSensitiveContent, scanContentForSafety } from "../ingest/security.js";
import {
  appendWatcherHistory,
  readPersistedWatcherState,
  writePersistedWatcherState
} from "../ingest/watcher-state.js";
import { listProfileFiles, resolveWatcherProfile, watcherProfiles } from "../ingest/watcher-profiles.js";
import { scoreExtraction } from "../memory/extraction-eval.js";
import { listExtractionReports, recordExtractionReport } from "../memory/extraction-reports.js";
import { loadExtractionInput, type ExtractedMemory } from "../memory/extractor.js";
import {
  factsSnapshot,
  listGovernorAudit,
  recordGovernorAudit,
  supersedeTimeline,
  undoGovernorAudit
} from "../memory/governor-audit.js";
import { governProposalDiff } from "../memory/governor.js";
import { applyProposal, proposeSourceExtraction } from "../memory/proposals.js";
import { inspectMemoryQuality } from "../memory/quality.js";
import { queueSelfMemorySummary } from "../memory/self-loop.js";
import { selfMemoryPolicy } from "../memory/self-policy.js";
import { retrievalGuidance, searchSections, type SearchResult } from "../search/fts.js";
import { handleJsonRpcRequest } from "./server.js";
import { neurakeepServerCard } from "./manifest.js";
import {
  ensureHostedDefaults,
  listHostedAudit,
  listHostedAuditSummary,
  listHostedMembers,
  listHostedSpaces,
  listRecentDeniedBetaAccess,
  recordHostedAudit
} from "../hosted/audit.js";
import { betaAccessPolicyFromEnv, betaAccessStatus, type BetaAccessPolicy } from "../hosted/beta-access.js";
import {
  applyStripeEvent,
  billingAccessStatus,
  billingConfigFromEnv,
  constructStripeEvent,
  createBillingPortal,
  createCheckout
} from "../hosted/billing.js";
import {
  hostedAuthConfigFromEnv,
  localActor,
  verifyFirebaseRequest,
  type HostedActor
} from "../hosted/firebase-auth.js";
import { isolateHostedActor, openHostedVault, type HostedVaultContext } from "../hosted/tenant-vault.js";
import {
  authenticateHostedAccessToken,
  issueHostedAccessToken,
  listHostedAccessTokens,
  rotateHostedAccessToken,
  revokeHostedAccessToken
} from "../hosted/access-tokens.js";
import {
  authorizationDenied,
  exchangeOAuthToken,
  issueAuthorizationCode,
  OAuthError,
  registerOAuthClient,
  validateAuthorizationRequest
} from "../hosted/oauth.js";
import { tenantIdForServiceTokenHash } from "../hosted/tenant-id.js";
import { hostedVaultGrant, type HostedGrantScope } from "../hosted/firebase-auth.js";
import { recoveryKeyProviderFromEnv, type RecoveryKeyProvider } from "../security/key-provider.js";
import { getOrCreateSpaceKey, recoverSpaceKey } from "../security/space-keys.js";
import { hostedArtifactStore } from "../security/artifact-store.js";
import { secureAtomicWrite, secureDirectory } from "../security/filesystem.js";
import { assertHostedCapability, capabilityForApi, capabilityForMcpTool } from "../hosted/authorization.js";
import {
  acceptOrganizationInvitation,
  createOrganization,
  createOrganizationSpace,
  deletePendingOrganization,
  inviteOrganizationMember,
  listOrganizationMembers,
  listOrganizationsForUser,
  listOrganizationSpaces,
  organizationPolicy,
  resolveOrganizationActor,
  updateOrganizationMember,
  updateOrganizationPolicy
} from "../hosted/organizations.js";
import {
  authenticateScimToken,
  discoverEnterpriseProviders,
  issueScimToken,
  organizationSsoStatus,
  updateOrganizationSso
} from "../hosted/enterprise-auth.js";

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  token?: string;
  serviceTokens?: string[];
  readOnly: boolean;
  serveUi: boolean;
  hosted?: {
    enabled: boolean;
    firebaseProjectId?: string;
    verifyRequest?: (req: IncomingMessage) => Promise<HostedActor | null>;
  };
}

interface WatchState {
  watchers: FSWatcher[];
  folders: string[];
  debounceMs: number;
  running: boolean;
  startedAt: string;
  queuedAt?: string;
  lastRunAt?: string;
  lastResult?: Record<string, unknown>;
  lastError?: string;
  runCount: number;
  recursive: boolean;
  profileId?: string;
  policy?: IngestPolicy;
  timer?: ReturnType<typeof setTimeout>;
}

const watchStates = new Map<string, WatchState>();

interface IngestPolicy {
  space: "personal" | "project" | "system";
  trustLevel: "untrusted" | "observed" | "trusted" | "verified";
  sourceOrigin: "manual" | "local_file" | "session" | "agent" | "connector" | "import" | "system";
  visibility: "private" | "space" | "team" | "client" | "public";
  sensitivity: "normal" | "internal" | "confidential" | "secret";
}

interface AuthSettingsFile {
  mode: "local" | "remote";
  user: {
    displayName: string;
    role: "owner" | "operator" | "viewer";
    allowWrites: boolean;
  };
}

export function runHttpMcpServer(paths: VaultPaths, options: HttpMcpServerOptions): Server {
  assertSecureHttpBinding(options);
  if (options.hosted?.enabled && process.platform !== "win32") process.umask(0o077);
  const controlDb = openDatabase(paths.dbPath);
  const tenantVaults = new Map<string, HostedVaultContext>();
  migrateDatabase(controlDb);
  const recoveryKeyProvider = options.hosted?.enabled ? recoveryKeyProviderFromEnv() : undefined;
  restorePersistedWatcher(controlDb, paths);

  const server = createServer(async (req, res) => {
    try {
      setCors(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${options.host}:${options.port}`}`);

      if (requestUrl.pathname === "/.well-known/mcp/server-card.json" && req.method === "GET") {
        sendJson(res, 200, neurakeepServerCard());
        return;
      }

      if (requestUrl.pathname === "/.well-known/oauth-protected-resource" || requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
        sendJson(res, 200, oauthProtectedResourceMetadata(req, options));
        return;
      }

      if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(res, 200, oauthAuthorizationServerMetadata(req, options));
        return;
      }

      if (options.hosted?.enabled && ["/oauth/register", "/register"].includes(requestUrl.pathname) && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          sendJsonNoStore(res, 201, registerOAuthClient(controlDb, body));
        } catch (error) {
          sendOAuthError(res, error);
        }
        return;
      }

      if (options.hosted?.enabled && ["/oauth/authorize", "/authorize"].includes(requestUrl.pathname) && req.method === "GET") {
        try {
          const request = validateAuthorizationRequest(controlDb, requestUrl.searchParams, `${publicBaseUrl(req, options)}/mcp`);
          const consentUrl = new URL(`${publicBaseUrl(req, options)}/app/`);
          consentUrl.searchParams.set("oauth", "1");
          for (const [name, value] of requestUrl.searchParams) consentUrl.searchParams.set(name, value);
          consentUrl.searchParams.set("client_name", request.clientName);
          res.writeHead(302, { location: consentUrl.toString(), "cache-control": "no-store", pragma: "no-cache" });
          res.end();
        } catch (error) {
          sendOAuthError(res, error);
        }
        return;
      }

      if (options.hosted?.enabled && requestUrl.pathname === "/oauth/authorize/complete" && req.method === "POST") {
        try {
          const actor = await authorizeRequest(req, controlDb, options);
          if (!actor) throw new OAuthError("access_denied", "Sign in to NeuraKeep before approving this connector.", 401);
          const billing = billingAccessStatus(controlDb, actor);
          if (!billing.entitled) throw new OAuthError("access_denied", "An active NeuraKeep subscription is required.", 403);
          const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          const params = new URLSearchParams();
          for (const name of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"]) {
            if (body[name] !== undefined) params.set(name, String(body[name]));
          }
          const request = validateAuthorizationRequest(controlDb, params, `${publicBaseUrl(req, options)}/mcp`);
          sendJson(res, 200, body.approved === false ? authorizationDenied(request) : issueAuthorizationCode(controlDb, actor, request));
        } catch (error) {
          sendOAuthError(res, error);
        }
        return;
      }

      if (options.hosted?.enabled && ["/oauth/token", "/token"].includes(requestUrl.pathname) && req.method === "POST") {
        try {
          if (!recoveryKeyProvider) throw new OAuthError("server_error", "Hosted key recovery is unavailable.", 500);
          const params = new URLSearchParams(await readBody(req));
          const tokens = exchangeOAuthToken(controlDb, params, headerValue(req.headers.authorization), recoveryKeyProvider, `${publicBaseUrl(req, options)}/mcp`);
          sendJsonNoStore(res, 200, tokens);
        } catch (error) {
          sendOAuthError(res, error);
        }
        return;
      }

      if (requestUrl.pathname === "/api/auth/sso/providers" && req.method === "GET") {
        sendJson(res, 200, { providers: discoverEnterpriseProviders(requestUrl.searchParams.get("email") ?? undefined) });
        return;
      }

      if (requestUrl.pathname.startsWith("/scim/v2/")) {
        await handleScimRequest(controlDb, req, res, requestUrl);
        return;
      }

      if (req.url === "/health" && req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          name: "neurakeep",
          transport: "http",
          mode: options.readOnly ? "read-only" : "read-write"
        });
        return;
      }

      if (req.url === "/mcp" && req.method === "GET") {
        sendJson(res, 200, {
          name: "neurakeep",
          endpoint: "/mcp",
          protocol: "json-rpc-over-http"
        });
        return;
      }

      if (req.url === "/mcp" && req.method === "POST") {
        const actor = await authorizeRequest(req, controlDb, options);
        if (!actor) {
          sendUnauthorized(res, req, options);
          return;
        }
        const billing = billingAccessStatus(controlDb, actor);
        if (options.hosted?.enabled && !billing.entitled) {
          sendJson(res, 402, { error: "subscription_required", billing });
          return;
        }
        const vault = requestVault(controlDb, paths, actor, options, tenantVaults, recoveryKeyProvider);
        try {
          const body = await readBody(req);
          const payload = JSON.parse(body) as unknown;
          const response = Array.isArray(payload)
            ? payload.map((item) => handleHttpRequest(vault.db, vault.paths, item, options.readOnly, actor)).filter(Boolean)
            : handleHttpRequest(vault.db, vault.paths, payload, options.readOnly, actor);
          recordHostedAudit(vault.db, {
            actor,
            action: "mcp.request",
            targetType: "mcp",
            status: "ok",
            metadata: { batch: Array.isArray(payload), readOnly: options.readOnly }
          });
          if (response === null || (Array.isArray(response) && response.length === 0)) {
            res.writeHead(202, { "cache-control": "no-store" });
            res.end();
            return;
          }
          sendJson(res, 200, response);
        } finally {
          vault.close();
        }
        return;
      }

      if (req.url?.startsWith("/api/")) {
        if (requestUrl.pathname === "/api/billing/webhook" && req.method === "POST") {
          await handleStripeWebhook(controlDb, req, res);
          return;
        }
        const actor = await authorizeRequest(req, controlDb, options);
        if (!actor) {
          sendUnauthorized(res, req, options);
          return;
        }
        if (requestUrl.pathname.startsWith("/api/billing/")) {
          await handleBillingRequest(controlDb, req, res, actor);
          return;
        }
        if (requestUrl.pathname.startsWith("/api/hosted/organizations") ||
            requestUrl.pathname.startsWith("/api/hosted/invitations") ||
            requestUrl.pathname.startsWith("/api/hosted/team")) {
          await handleOrganizationRequest(controlDb, req, res, actor, requestUrl, options.readOnly);
          return;
        }
        const billing = billingAccessStatus(controlDb, actor);
        if (options.hosted?.enabled && !billing.entitled) {
          sendJson(res, 402, { error: "subscription_required", billing });
          return;
        }
        if (requestUrl.pathname.startsWith("/api/hosted/tokens")) {
          await handleHostedTokenRequest(controlDb, req, res, actor, options.readOnly, recoveryKeyProvider);
          return;
        }
        const vault = requestVault(controlDb, paths, actor, options, tenantVaults, recoveryKeyProvider);
        try {
          await handleApiRequest(vault.db, vault.paths, req, res, options, actor, controlDb);
        } finally {
          vault.close();
        }
        return;
      }

      if (options.serveUi && req.method === "GET") {
        const served = tryServeUi(paths, req, res, Boolean(options.hosted?.enabled));
        if (served) {
          return;
        }
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      sendJson(res, error instanceof HttpStatusError ? error.status : Number((error as { statusCode?: number })?.statusCode ?? 500), {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(options.port, options.host, () => {
    process.stderr.write(
      `NeuraKeep HTTP MCP listening on http://${options.host}:${options.port}/mcp\n`
    );
  });

  const close = (): void => {
    server.close();
  };
  server.on("close", () => {
    stopAutoIngestWatcher(paths);
    for (const vault of tenantVaults.values()) {
      stopAutoIngestWatcher(vault.paths);
      if (vault.db.open) vault.db.close();
    }
    if (controlDb.open) controlDb.close();
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function handleBillingRequest(
  db: UmosDatabase,
  req: IncomingMessage,
  res: ServerResponse,
  actor: HostedActor
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/billing/status" && req.method === "GET") {
    sendJson(res, 200, billingAccessStatus(db, actor));
    return;
  }
  if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { plan?: string; offer?: string; organizationName?: string; seats?: number };
    let checkoutActor = body.plan === "team"
      ? actor
      : isolateHostedActor({ ...actor, organizationId: undefined, organizationName: undefined, membershipRole: undefined });
    let createdOrganizationId: string | undefined;
    if (body.plan === "team" && !actor.organizationId) {
      const organization = createOrganization(db, actor, String(body.organizationName ?? ""), Number(body.seats ?? 2));
      const space = listOrganizationSpaces(db, organization.id)[0];
      checkoutActor = resolveOrganizationActor(db, actor, organization.id, space.id);
      createdOrganizationId = organization.id;
    }
    let result;
    try {
      result = await createCheckout(db, checkoutActor, String(body.plan ?? ""), body.offer);
    } catch (error) {
      if (createdOrganizationId) deletePendingOrganization(db, actor, createdOrganizationId);
      throw error;
    }
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === "/api/billing/portal" && req.method === "POST") {
    sendJson(res, 200, await createBillingPortal(db, actor));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function handleOrganizationRequest(
  db: UmosDatabase,
  req: IncomingMessage,
  res: ServerResponse,
  actor: HostedActor,
  url: URL,
  readOnly: boolean
): Promise<void> {
  if (url.pathname === "/api/hosted/organizations" && req.method === "GET") {
    sendJson(res, 200, { organizations: listOrganizationsForUser(db, actor) });
    return;
  }
  if (url.pathname === "/api/hosted/organizations" && req.method === "POST") {
    assertWritable(readOnly, "organization creation");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; seats?: number };
    const organization = createOrganization(db, actor, String(body.name ?? ""), Number(body.seats ?? 2));
    sendJson(res, 201, { organization, spaces: listOrganizationSpaces(db, organization.id) });
    return;
  }
  if (url.pathname === "/api/hosted/invitations/accept" && req.method === "POST") {
    assertWritable(readOnly, "invitation acceptance");
    const body = JSON.parse((await readBody(req)) || "{}") as { token?: string };
    sendJson(res, 200, acceptOrganizationInvitation(db, actor, String(body.token ?? "")));
    return;
  }
  if (!actor.organizationId) throw new HttpStatusError(400, "Select a team workspace first.");
  if (url.pathname === "/api/hosted/team/spaces" && req.method === "GET") {
    sendJson(res, 200, { spaces: listOrganizationSpaces(db, actor.organizationId) });
    return;
  }
  if (url.pathname === "/api/hosted/team/spaces" && req.method === "POST") {
    assertWritable(readOnly, "space creation");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string };
    sendJson(res, 201, { space: createOrganizationSpace(db, actor, String(body.name ?? "")) });
    return;
  }
  if (url.pathname === "/api/hosted/team/members" && req.method === "GET") {
    sendJson(res, 200, { members: listOrganizationMembers(db, actor) });
    return;
  }
  if (url.pathname === "/api/hosted/team/invitations" && req.method === "POST") {
    assertWritable(readOnly, "member invitation");
    const body = JSON.parse((await readBody(req)) || "{}") as { email?: string; role?: string };
    sendJson(res, 201, inviteOrganizationMember(db, actor, String(body.email ?? ""), String(body.role ?? "viewer")));
    return;
  }
  const memberMatch = /^\/api\/hosted\/team\/members\/([^/]+)$/.exec(url.pathname);
  if (memberMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    assertWritable(readOnly, "member management");
    const body = req.method === "PATCH" ? JSON.parse((await readBody(req)) || "{}") as { role?: string; revoke?: boolean } : { revoke: true };
    const changed = updateOrganizationMember(db, actor, decodeURIComponent(memberMatch[1]), body.role, Boolean(body.revoke));
    sendJson(res, changed ? 200 : 404, changed ? { ok: true } : { error: "member_not_found" });
    return;
  }
  if (url.pathname === "/api/hosted/team/policy" && req.method === "GET") {
    sendJson(res, 200, { policy: organizationPolicy(db, actor) });
    return;
  }
  if (url.pathname === "/api/hosted/team/policy" && req.method === "PATCH") {
    assertWritable(readOnly, "organization policy update");
    sendJson(res, 200, { policy: updateOrganizationPolicy(db, actor, JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>) });
    return;
  }
  if (url.pathname === "/api/hosted/team/sso" && req.method === "GET") {
    sendJson(res, 200, { sso: organizationSsoStatus(db, actor) });
    return;
  }
  if (url.pathname === "/api/hosted/team/sso" && req.method === "PATCH") {
    assertWritable(readOnly, "SSO configuration update");
    sendJson(res, 200, { sso: updateOrganizationSso(db, actor, JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>) });
    return;
  }
  if (url.pathname === "/api/hosted/team/scim-tokens" && req.method === "POST") {
    assertWritable(readOnly, "SCIM token creation");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string };
    sendJson(res, 201, issueScimToken(db, actor, String(body.name ?? "SCIM provisioning")));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function handleScimRequest(db: UmosDatabase, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = bearerToken(req);
  const organizationId = token ? authenticateScimToken(db, token) : null;
  if (!organizationId) throw new HttpStatusError(401, "Invalid SCIM bearer token.");
  if (url.pathname === "/scim/v2/Users" && req.method === "GET") {
    const resources = db.prepare(`SELECT user_id AS id, email AS userName, display_name AS displayName,
      status = 'active' AS active, role FROM hosted_org_memberships WHERE organization_id = ? ORDER BY created_at ASC`)
      .all(organizationId);
    sendJson(res, 200, { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources });
    return;
  }
  if (url.pathname === "/scim/v2/Users" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { userName?: string; displayName?: string; externalId?: string; active?: boolean };
    const email = String(body.userName ?? "").trim().toLowerCase();
    if (!email.includes("@")) throw new HttpStatusError(400, "SCIM userName must be an email address.");
    const org = db.prepare("SELECT seat_count AS seatCount FROM hosted_organizations WHERE id = ?").get(organizationId) as { seatCount: number };
    const count = Number((db.prepare("SELECT COUNT(*) AS count FROM hosted_org_memberships WHERE organization_id = ? AND status = 'active'").get(organizationId) as { count: number }).count);
    if (count >= org.seatCount) throw new HttpStatusError(409, "No licensed Team seat is available.");
    const id = `scim_${sha256(String(body.externalId ?? email)).slice(0, 32)}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO hosted_org_memberships (organization_id, user_id, email, display_name, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)
      ON CONFLICT(organization_id, user_id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name,
        status=excluded.status, updated_at=excluded.updated_at`)
      .run(organizationId, id, email, String(body.displayName ?? email).slice(0, 100), body.active === false ? "revoked" : "active", now, now);
    sendJson(res, 201, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id, userName: email, displayName: body.displayName ?? email, active: body.active !== false });
    return;
  }
  const match = /^\/scim\/v2\/Users\/([^/]+)$/.exec(url.pathname);
  if (match && req.method === "GET") {
    const user = db.prepare(`SELECT user_id AS id, email AS userName, display_name AS displayName,
      status = 'active' AS active, role FROM hosted_org_memberships WHERE organization_id = ? AND user_id = ?`)
      .get(organizationId, decodeURIComponent(match[1]));
    if (!user) throw new HttpStatusError(404, "SCIM user not found.");
    sendJson(res, 200, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], ...(user as Record<string, unknown>) });
    return;
  }
  if (match && (req.method === "PATCH" || req.method === "PUT")) {
    const body = JSON.parse((await readBody(req)) || "{}") as { userName?: string; displayName?: string; active?: boolean; Operations?: Array<{ op?: string; path?: string; value?: unknown }> };
    let active = body.active;
    for (const operation of body.Operations ?? []) {
      if (String(operation.path ?? "").toLowerCase() === "active") active = Boolean(operation.value);
    }
    const current = db.prepare("SELECT email, display_name AS displayName, status FROM hosted_org_memberships WHERE organization_id = ? AND user_id = ?")
      .get(organizationId, decodeURIComponent(match[1])) as { email?: string; displayName?: string; status: string } | undefined;
    if (!current) throw new HttpStatusError(404, "SCIM user not found.");
    const email = String(body.userName ?? current.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) throw new HttpStatusError(400, "SCIM userName must be an email address.");
    const status = active === undefined ? current.status : active ? "active" : "revoked";
    if (status === "active" && current.status !== "active") {
      const org = db.prepare("SELECT seat_count AS seatCount FROM hosted_organizations WHERE id = ?").get(organizationId) as { seatCount: number };
      const count = Number((db.prepare("SELECT COUNT(*) AS count FROM hosted_org_memberships WHERE organization_id = ? AND status = 'active'").get(organizationId) as { count: number }).count);
      if (count >= org.seatCount) throw new HttpStatusError(409, "No licensed Team seat is available.");
    }
    db.prepare("UPDATE hosted_org_memberships SET email = ?, display_name = ?, status = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?")
      .run(email, String(body.displayName ?? current.displayName ?? email).slice(0, 100), status, new Date().toISOString(), organizationId, decodeURIComponent(match[1]));
    sendJson(res, 200, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id: decodeURIComponent(match[1]), userName: email, displayName: body.displayName ?? current.displayName ?? email, active: status === "active" });
    return;
  }
  if (match && req.method === "DELETE") {
    const changed = db.prepare("UPDATE hosted_org_memberships SET status = 'revoked', updated_at = ? WHERE organization_id = ? AND user_id = ?")
      .run(new Date().toISOString(), organizationId, decodeURIComponent(match[1])).changes;
    if (!changed) throw new HttpStatusError(404, "SCIM user not found.");
    res.writeHead(204); res.end(); return;
  }
  throw new HttpStatusError(404, "SCIM resource not found.");
}

async function handleStripeWebhook(db: UmosDatabase, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const signature = String(req.headers["stripe-signature"] ?? "");
  if (!signature) {
    sendJson(res, 400, { error: "missing_stripe_signature" });
    return;
  }
  const rawBody = await readBody(req);
  const event = constructStripeEvent(rawBody, signature, billingConfigFromEnv());
  sendJson(res, 200, { received: true, ...applyStripeEvent(db, event) });
}

async function handleHostedTokenRequest(
  db: UmosDatabase,
  req: IncomingMessage,
  res: ServerResponse,
  actor: HostedActor,
  readOnly: boolean,
  recoveryKeyProvider?: RecoveryKeyProvider
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  assertHostedCapability(actor, "manage_policy");
  if (url.pathname === "/api/hosted/tokens" && req.method === "GET") {
    sendJson(res, 200, { tokens: listHostedAccessTokens(db, actor) });
    return;
  }
  if (url.pathname === "/api/hosted/tokens" && req.method === "POST") {
    assertWritable(readOnly, "access token creation");
    if (!recoveryKeyProvider) throw new Error("Hosted recovery key provider is unavailable.");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; scopes?: HostedGrantScope[]; expiresInDays?: number };
    const spaceKey = getOrCreateSpaceKey(db, actor.tenantId, actor.spaceId, recoveryKeyProvider);
    try { sendJson(res, 201, issueHostedAccessToken(db, actor, { name: body.name, scopes: body.scopes, expiresInDays: body.expiresInDays, spaceKey })); }
    finally { spaceKey.key.fill(0); }
    return;
  }
  if (url.pathname === "/api/hosted/tokens/rotate" && req.method === "POST") {
    assertWritable(readOnly, "access token rotation");
    if (!recoveryKeyProvider) throw new Error("Hosted recovery key provider is unavailable.");
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; expiresInDays?: number };
    const spaceKey = recoverSpaceKey(db, actor.tenantId, actor.spaceId, recoveryKeyProvider);
    try { sendJson(res, 201, rotateHostedAccessToken(db, actor, String(body.id ?? ""), spaceKey, body.expiresInDays)); }
    finally { spaceKey.key.fill(0); }
    return;
  }
  if (url.pathname === "/api/hosted/tokens/revoke" && req.method === "POST") {
    assertWritable(readOnly, "access token revocation");
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: string };
    const revoked = revokeHostedAccessToken(db, actor, String(body.id ?? ""));
    sendJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "token_not_found" });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

function requestVault(
  controlDb: UmosDatabase,
  basePaths: VaultPaths,
  actor: HostedActor,
  options: HttpMcpServerOptions,
  tenantVaults: Map<string, HostedVaultContext>,
  recoveryKeyProvider?: RecoveryKeyProvider
): HostedVaultContext {
  if (options.hosted?.enabled && actor.provider !== "local") {
    const granted = actor[hostedVaultGrant];
    if (!granted && !recoveryKeyProvider) throw new Error("Hosted vault recovery is unavailable.");
    const resolved = granted ?? getOrCreateSpaceKey(controlDb, actor.tenantId, actor.spaceId, recoveryKeyProvider!);
    const vaultKey = `${actor.tenantId}:${actor.spaceId}:${resolved.keyVersion}`;
    let vault = tenantVaults.get(vaultKey);
    if (!vault) {
      vault = openHostedVault(basePaths, actor, resolved);
      tenantVaults.set(vaultKey, vault);
    }
    ensureHostedDefaults(vault.db, actor);
    return { db: vault.db, paths: vault.paths, close: () => undefined };
  }
  ensureHostedDefaults(controlDb, actor);
  return { db: controlDb, paths: basePaths, close: () => undefined };
}

async function handleApiRequest(
  db: UmosDatabase,
  paths: VaultPaths,
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpMcpServerOptions,
  actor: HostedActor = localActor(),
  controlDb: UmosDatabase = db
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const readOnly = options.readOnly;
  if (options.hosted?.enabled) assertHostedCapability(actor, capabilityForApi(url.pathname, req.method ?? "GET"));

  if (url.pathname === "/api/auth/settings" && req.method === "GET") {
    sendJson(res, 200, authSettings(paths, options, actor, db));
    return;
  }

  if (url.pathname === "/api/auth/settings" && req.method === "POST") {
    assertWritable(readOnly, "auth settings");
    const body = JSON.parse((await readBody(req)) || "{}") as Partial<AuthSettingsFile>;
    const result = writeAuthSettings(paths, body, options);
    recordHostedAudit(db, { actor, action: "auth.settings.update", targetType: "settings", status: "ok" });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/hosted/status" && req.method === "GET") {
    sendJson(res, 200, hostedStatus(options, actor));
    return;
  }

  if (url.pathname === "/api/hosted/spaces" && req.method === "GET") {
    sendJson(res, 200, { actor, spaces: listHostedSpaces(db, actor.tenantId) });
    return;
  }

  if (url.pathname === "/api/hosted/audit" && req.method === "GET") {
    sendJson(res, 200, { events: listHostedAudit(db, actor.tenantId, Number(url.searchParams.get("limit") ?? 50)) });
    return;
  }

  if (url.pathname === "/api/hosted/access" && req.method === "GET") {
    sendJson(res, 200, { actor, access: { allowed: true, reason: "authenticated_account", accessModel: "stripe_subscription" } });
    return;
  }

  if (url.pathname === "/api/hosted/storage" && req.method === "GET") {
    sendJson(res, 200, hostedStorageStatus(paths, options, actor));
    return;
  }

  if (url.pathname === "/api/hosted/ops" && req.method === "GET") {
    sendJson(res, 200, hostedOpsStatus(db, paths, options, actor));
    return;
  }

  if (url.pathname === "/api/onboarding/launch-flow" && req.method === "GET") {
    sendJson(res, 200, betaLaunchFlow(db, paths, options, actor));
    return;
  }

  if (url.pathname === "/api/onboarding/sample-memory" && req.method === "POST") {
    assertWritable(readOnly, "sample memory import");
    const result = importFirstRunSampleMemory(db, paths, actor);
    recordHostedAudit(db, {
      actor,
      action: "onboarding.sample_memory.import",
      targetType: "source",
      targetId: String((result.ingest as { sourceId?: string } | undefined)?.sourceId ?? ""),
      status: "ok",
      metadata: { proposalId: (result.proposal as { proposalId?: string } | null)?.proposalId ?? null }
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/graph" && req.method === "GET") {
    const graph = buildGraphView(db, {
      focusId: url.searchParams.get("focus"),
      depth: Number(url.searchParams.get("depth") ?? 1),
      limit: Number(url.searchParams.get("limit") ?? 180)
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, { ...graph, state: readGraphState(paths) });
    return;
  }

  if (url.pathname === "/api/graph/overview" && req.method === "GET") {
    sendJson(res, 200, graphOverviewCompat(db, url.searchParams.get("clusterBy")));
    return;
  }

  if (url.pathname === "/api/graph/neighbors" && req.method === "GET") {
    sendJson(res, 200, graphNeighborsCompat(db, url.searchParams));
    return;
  }

  if (url.pathname === "/api/graph/locate" && req.method === "GET") {
    sendJson(res, 200, graphLocateCompat(db, url.searchParams));
    return;
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const result = searchMemory(db, url.searchParams);
    recordHostedAudit(db, {
      actor,
      action: "memory.search",
      targetType: "search",
      status: "ok",
      metadata: {
        queryHash: shortHash(url.searchParams.get("query") ?? ""),
        resultCount: Array.isArray(result.results) ? result.results.length : 0,
        memoryType: url.searchParams.get("memoryType") ?? "all"
      }
    });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/integrations/status" && req.method === "GET") {
    sendJson(res, 200, integrationStatus(db, paths, options, actor));
    return;
  }

  if (url.pathname === "/api/workflow/daily-loop" && req.method === "GET") {
    sendJson(res, 200, dailyWorkflowStatus(db, paths, options, actor));
    return;
  }

  if (url.pathname === "/api/workflow/daily-loop" && req.method === "POST") {
    assertWritable(readOnly, "daily workflow loop");
    assertLocalFilesystemAccess(options, actor, "workspace memory sync");
    const body = JSON.parse((await readBody(req)) || "{}") as { queueSummary?: boolean; reason?: string };
    const result = body.queueSummary === false ? null : queueSelfMemorySummary(db, paths, "session-close");
    const sync = syncWorkspaceMemoryFiles(db, paths);
    exportStaticApp(db, paths);
    sendJson(res, 200, {
      ok: true,
      queued: result,
      sync,
      status: dailyWorkflowStatus(db, paths, options, actor),
      queueOnly: true
    });
    return;
  }

  if (url.pathname === "/api/search/presets" && req.method === "GET") {
    sendJson(res, 200, { presets: readSearchPresets(paths) });
    return;
  }

  if (url.pathname === "/api/search/presets" && req.method === "POST") {
    assertWritable(readOnly, "search presets");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; query?: string; filters?: Record<string, unknown> };
    sendJson(res, 200, { presets: saveSearchPreset(paths, body) });
    return;
  }

  if (url.pathname === "/api/search/presets/delete" && req.method === "POST") {
    assertWritable(readOnly, "search presets");
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string };
    sendJson(res, 200, { presets: deleteSearchPreset(paths, String(body.name ?? "")) });
    return;
  }

  if (url.pathname === "/api/graph/state" && req.method === "GET") {
    sendJson(res, 200, readGraphState(paths));
    return;
  }

  if (url.pathname === "/api/graph/state" && req.method === "POST") {
    assertWritable(readOnly, "save graph state");
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    sendJson(res, 200, writeGraphState(paths, body));
    return;
  }

  if (url.pathname === "/api/inbox" && req.method === "GET") {
    sendJson(res, 200, { files: listInboxFiles(paths) });
    return;
  }

  if (url.pathname === "/api/ingest" && req.method === "POST") {
    assertWritable(readOnly, "ingest");
    const body = JSON.parse(await readBody(req)) as { path?: string; kind?: string };
    const sourcePath = requireInboxPath(paths, String(body.path ?? ""));
    const result = ingestFile(db, paths, {
      path: sourcePath,
      kind: normalizeIngestKind(body.kind),
      space: "project",
      trustLevel: "observed",
      sourceOrigin: "manual",
      visibility: "private",
      sensitivity: "normal"
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/import" && req.method === "POST") {
    assertWritable(readOnly, "manual import");
    assertLocalFilesystemAccess(options, actor, "server-side path import");
    const body = JSON.parse((await readBody(req)) || "{}") as { path?: string; kind?: string };
    const sourcePath = requireManualImportPath(paths, String(body.path ?? ""));
    const kind = body.kind && body.kind !== "auto" ? normalizeIngestKind(body.kind) : kindFromExtension(sourcePath);
    const ingest = ingestFile(db, paths, {
      path: sourcePath,
      kind,
      space: "project",
      trustLevel: "observed",
      sourceOrigin: "manual",
      visibility: "private",
      sensitivity: "internal"
    });
    const proposal = ingest.skipped ? null : proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths });
    recordHostedAudit(db, {
      actor,
      action: "memory.import",
      targetType: "source",
      targetId: ingest.sourceId,
      status: "ok",
      metadata: {
        kind,
        skipped: Boolean(ingest.skipped),
        proposalId: (proposal as { proposalId?: string } | null)?.proposalId ?? null
      }
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, { ingest, proposal, queueOnly: true });
    return;
  }

  if (url.pathname === "/api/import/upload" && req.method === "POST") {
    assertWritable(readOnly, "manual upload");
    const body = JSON.parse((await readBody(req, 35_000_000)) || "{}") as {
      fileName?: string;
      kind?: string;
      contentBase64?: string;
    };
    const fileName = safeUploadName(String(body.fileName ?? "memory-upload.txt"));
    const uploadContent = Buffer.from(String(body.contentBase64 ?? ""), "base64");
    enforceOrganizationUploadPolicy(controlDb, actor, "internal", uploadContent.toString("utf8"));
    const uploadDir = join(paths.inboxDir, "manual-uploads");
    const hostedStore = hostedArtifactStore(paths.root);
    if (hostedStore) secureDirectory(uploadDir); else mkdirSync(uploadDir, { recursive: true });
    const uploadPath = join(uploadDir, `${Date.now()}-${fileName}`);
    if (hostedStore) secureAtomicWrite(uploadPath, uploadContent); else writeFileSync(uploadPath, uploadContent);
    const kind = body.kind && body.kind !== "auto" ? normalizeIngestKind(body.kind) : kindFromExtension(uploadPath);
    let ingest;
    try {
      ingest = ingestFile(db, paths, {
        path: uploadPath,
        kind,
        space: "project",
        trustLevel: "observed",
        sourceOrigin: "manual",
        visibility: "private",
        sensitivity: "internal"
      });
    } finally {
      if (hostedStore) rmSync(uploadPath, { force: true });
    }
    const proposal = ingest.skipped ? null : proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths });
    recordHostedAudit(db, {
      actor,
      action: "memory.import.upload",
      targetType: "source",
      targetId: ingest.sourceId,
      status: "ok",
      metadata: {
        kind,
        skipped: Boolean(ingest.skipped),
        proposalId: (proposal as { proposalId?: string } | null)?.proposalId ?? null,
        fileName
      }
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, { uploadPath: hostedStore ? null : uploadPath, ingest, proposal, queueOnly: true });
    return;
  }

  if (url.pathname === "/api/import/ocr-health" && req.method === "GET") {
    sendJson(res, 200, ocrHealth());
    return;
  }

  if (url.pathname === "/api/import/supported" && req.method === "GET") {
    sendJson(res, 200, importSupport(paths, options, actor));
    return;
  }

  if (url.pathname === "/api/auto-ingest" && req.method === "POST") {
    assertWritable(readOnly, "auto-ingest");
    assertLocalFilesystemAccess(options, actor, "server-side auto-ingest");
    const body = JSON.parse((await readBody(req)) || "{}") as { profileId?: string };
    const profile = resolveWatcherProfile(paths, body.profileId);
    const result = autoIngestQueue(db, paths, {
      extraFolders: profile?.folders,
      recursive: profile?.recursive,
      policy: profile?.policy,
      profileId: profile?.id
    });
    appendWatcherHistory(paths, {
      at: new Date().toISOString(),
      profileId: profile?.id,
      folders: profile?.folders ?? [paths.inboxDir],
      recursive: Boolean(profile?.recursive),
      ok: true,
      ingested: Array.isArray(result.ingested) ? result.ingested.length : 0,
      proposals: Array.isArray(result.proposals) ? result.proposals.length : 0
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/watch/profiles" && req.method === "GET") {
    assertLocalFilesystemAccess(options, actor, "server-side watcher profiles");
    sendJson(res, 200, { profiles: watcherProfiles(paths) });
    return;
  }

  if (url.pathname === "/api/watch/status" && req.method === "GET") {
    assertLocalFilesystemAccess(options, actor, "server-side watcher status");
    sendJson(res, 200, watchStatus(paths));
    return;
  }

  if (url.pathname === "/api/watch/start" && req.method === "POST") {
    assertWritable(readOnly, "watch start");
    assertLocalFilesystemAccess(options, actor, "server-side watcher start");
    const body = JSON.parse((await readBody(req)) || "{}") as {
      folders?: string[];
      debounceMs?: number;
      profileId?: string;
      recursive?: boolean;
    };
    sendJson(res, 200, startAutoIngestWatcher(db, paths, body));
    return;
  }

  if (url.pathname === "/api/watch/stop" && req.method === "POST") {
    assertWritable(readOnly, "watch stop");
    assertLocalFilesystemAccess(options, actor, "server-side watcher stop");
    sendJson(res, 200, stopAutoIngestWatcher(paths));
    return;
  }

  if (url.pathname === "/api/self-policy" && req.method === "GET") {
    sendJson(res, 200, { policy: selfMemoryPolicy });
    return;
  }

  if (url.pathname === "/api/write-summary" && req.method === "POST") {
    assertWritable(readOnly, "write summary");
    assertLocalFilesystemAccess(options, actor, "workspace summary");
    const result = writeWorkspaceSummary(db, paths);
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/self-memory/queue" && req.method === "POST") {
    assertWritable(readOnly, "self memory queue");
    assertLocalFilesystemAccess(options, actor, "workspace self-memory queue");
    const body = JSON.parse((await readBody(req)) || "{}") as { reason?: string };
    const reason = body.reason === "heartbeat" || body.reason === "session-close" ? body.reason : "manual";
    const result = queueSelfMemorySummary(db, paths, reason);
    const sync = reason === "heartbeat" || reason === "session-close" ? syncWorkspaceMemoryFiles(db, paths) : null;
    exportStaticApp(db, paths);
    sendJson(res, 200, { ...result, sync });
    return;
  }

  if (url.pathname === "/api/self-memory/session-close" && req.method === "POST") {
    assertWritable(readOnly, "session close memory queue");
    assertLocalFilesystemAccess(options, actor, "workspace session-close sync");
    const result = queueSelfMemorySummary(db, paths, "session-close");
    const sync = syncWorkspaceMemoryFiles(db, paths);
    exportStaticApp(db, paths);
    sendJson(res, 200, { ...result, sync });
    return;
  }

  if (url.pathname === "/api/memory/sync" && req.method === "POST") {
    assertWritable(readOnly, "workspace memory sync");
    assertLocalFilesystemAccess(options, actor, "workspace memory sync");
    const result = syncWorkspaceMemoryFiles(db, paths);
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/memory/dedupe" && req.method === "POST") {
    assertWritable(readOnly, "memory dedupe");
    const result = collapseDuplicateFacts(db, paths);
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/memory/dedupe/fuzzy" && req.method === "POST") {
    assertWritable(readOnly, "fuzzy memory dedupe");
    const body = JSON.parse((await readBody(req)) || "{}") as { groupIds?: string[] };
    const result = collapseFuzzyDuplicateFacts(db, paths, body.groupIds);
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/memory/dedupe/fuzzy-preview" && req.method === "GET") {
    sendJson(res, 200, { groups: fuzzyDuplicateFactPreview(db) });
    return;
  }

  const proposalMatch = /^\/api\/proposals\/([^/]+)$/.exec(url.pathname);
  if (url.pathname === "/api/proposals" && req.method === "GET") {
    sendJson(res, 200, {
      proposals: listProposalSummaries(db, paths, url.searchParams.get("status") ?? "pending", url.searchParams.get("filter") ?? "all")
    });
    return;
  }

  if (url.pathname === "/api/proposals/groups" && req.method === "GET") {
    sendJson(res, 200, { groups: proposalGroups(db, paths) });
    return;
  }

  if (url.pathname === "/api/proposals/bulk-status" && req.method === "POST") {
    assertWritable(readOnly, "bulk proposal status");
    const body = JSON.parse((await readBody(req)) || "{}") as { ids?: string[]; status?: string };
    const status = String(body.status ?? "");
    if (!["archived", "rejected"].includes(status)) {
      throw new Error("Bulk status supports archived or rejected only.");
    }
    const ids = Array.from(new Set((body.ids ?? []).map(String).filter(Boolean))).slice(0, 250);
    const update = db.prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'");
    let changed = 0;
    const tx = db.transaction(() => {
      for (const id of ids) {
        changed += update.run(status, id).changes;
      }
    });
    tx();
    sendJson(res, 200, { ok: true, status, requested: ids.length, changed });
    return;
  }

  if (url.pathname === "/api/proposals/archive-duplicates" && req.method === "POST") {
    assertWritable(readOnly, "archive duplicate proposals");
    sendJson(res, 200, archiveDuplicateProposals(db, paths));
    return;
  }

  if (url.pathname === "/api/proposals/apply-high-value-clean" && req.method === "POST") {
    assertWritable(readOnly, "apply high-value proposals");
    const body = JSON.parse((await readBody(req)) || "{}") as { limit?: number };
    const result = applyHighValueCleanProposals(db, paths, Math.max(1, Math.min(Number(body.limit ?? 25), 50)));
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/proposals/triage-noisy" && req.method === "POST") {
    assertWritable(readOnly, "triage noisy proposals");
    const body = JSON.parse((await readBody(req)) || "{}") as { archive?: boolean; limit?: number };
    const result = triageNoisyWarningProposals(db, paths, {
      archive: body.archive === true,
      limit: Math.max(1, Math.min(Number(body.limit ?? 50), 100))
    });
    sendJson(res, 200, result);
    return;
  }

  if (proposalMatch && req.method === "GET") {
    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalMatch[1]);
    sendJson(res, proposal ? 200 : 404, proposal ? { proposal } : { error: "not_found" });
    return;
  }

  const proposalStatusMatch = /^\/api\/proposals\/([^/]+)\/status$/.exec(url.pathname);
  if (proposalStatusMatch && req.method === "POST") {
    assertWritable(readOnly, "proposal status");
    const body = JSON.parse((await readBody(req)) || "{}") as { status?: string };
    const status = String(body.status ?? "");
    if (!["pending", "archived", "rejected"].includes(status)) {
      throw new Error("Unsupported proposal status.");
    }
    db.prepare("UPDATE proposals SET status = ? WHERE id = ? AND status != 'applied'").run(status, proposalStatusMatch[1]);
    sendJson(res, 200, { ok: true, proposalId: proposalStatusMatch[1], status });
    return;
  }

  const saveProposalMatch = /^\/api\/proposals\/([^/]+)\/save$/.exec(url.pathname);
  if (saveProposalMatch && req.method === "POST") {
    assertWritable(readOnly, "save proposal");
    const body = JSON.parse(await readBody(req)) as { diff?: unknown };
    db.prepare("UPDATE proposals SET diff_json = ? WHERE id = ? AND status = 'pending'").run(
      JSON.stringify(body.diff ?? {}),
      saveProposalMatch[1]
    );
    sendJson(res, 200, { ok: true, proposalId: saveProposalMatch[1] });
    return;
  }

  const governorProposalMatch = /^\/api\/proposals\/([^/]+)\/governor$/.exec(url.pathname);
  if (governorProposalMatch && req.method === "GET") {
    const proposal = db.prepare("SELECT diff_json FROM proposals WHERE id = ?").get(governorProposalMatch[1]) as
      | { diff_json: string }
      | undefined;
    if (!proposal) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, governProposalDiff(db, JSON.parse(proposal.diff_json)));
    return;
  }

  const extractionScoreMatch = /^\/api\/proposals\/([^/]+)\/extraction-score$/.exec(url.pathname);
  if (extractionScoreMatch && req.method === "GET") {
    const proposal = db
      .prepare("SELECT diff_json, source_ids_json FROM proposals WHERE id = ?")
      .get(extractionScoreMatch[1]) as { diff_json: string; source_ids_json: string } | undefined;
    if (!proposal) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const sourceIds = safeJsonArray(proposal.source_ids_json);
    const sourceId = sourceIds[0];
    if (!sourceId) {
      sendJson(res, 200, { score: null, warnings: ["Proposal has no source id."] });
      return;
    }
    const input = loadExtractionInput(db, sourceId);
    const score = scoreExtraction(JSON.parse(proposal.diff_json) as ExtractedMemory, input.deterministicDraft);
    const report = recordExtractionReport(paths, {
      proposalId: extractionScoreMatch[1],
      sourceId,
      extractor: "unknown",
      score
    });
    sendJson(res, 200, { score, report });
    return;
  }

  const applyProposalMatch = /^\/api\/proposals\/([^/]+)\/apply$/.exec(url.pathname);
  if (applyProposalMatch && req.method === "POST") {
    assertWritable(readOnly, "apply proposal");
    const bodyText = await readBody(req);
    if (bodyText.trim()) {
      const body = JSON.parse(bodyText) as { diff?: unknown };
      if (body.diff) {
        db.prepare("UPDATE proposals SET diff_json = ? WHERE id = ? AND status = 'pending'").run(
          JSON.stringify(body.diff),
          applyProposalMatch[1]
        );
      }
    }
    const result = applyProposal(db, paths, applyProposalMatch[1]);
    recordHostedAudit(db, {
      actor,
      action: "proposal.apply",
      targetType: "proposal",
      targetId: applyProposalMatch[1],
      status: "ok",
      metadata: { inserted: result.inserted }
    });
    exportStaticApp(db, paths);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/quality" && req.method === "GET") {
    sendJson(res, 200, inspectMemoryQuality(db));
    return;
  }

  if (url.pathname === "/api/quality/dashboard" && req.method === "GET") {
    sendJson(res, 200, qualityDashboard(db, paths));
    return;
  }

  if (url.pathname === "/api/extraction/reports" && req.method === "GET") {
    sendJson(res, 200, { reports: listExtractionReports(paths).slice(-100).reverse() });
    return;
  }

  const citationPreviewMatch = /^\/api\/citations\/([^/]+)\/preview$/.exec(url.pathname);
  if (citationPreviewMatch && req.method === "GET") {
    const preview = citationPreview(db, decodeURIComponent(citationPreviewMatch[1]));
    sendJson(res, preview ? 200 : 404, preview ? { preview } : { error: "not_found" });
    return;
  }

  if (url.pathname === "/api/governor/resolve" && req.method === "POST") {
    assertWritable(readOnly, "governor resolve");
    const body = JSON.parse(await readBody(req)) as {
      action?: string;
      winnerId?: string;
      loserIds?: string[];
      factIds?: string[];
    };
    sendJson(res, 200, resolveGovernorAction(db, paths, body));
    return;
  }

  if (url.pathname === "/api/governor/audit" && req.method === "GET") {
    sendJson(res, 200, { entries: listGovernorAudit(paths) });
    return;
  }

  if (url.pathname === "/api/governor/timeline" && req.method === "GET") {
    sendJson(res, 200, { timeline: supersedeTimeline(db) });
    return;
  }

  if (url.pathname === "/api/governor/undo" && req.method === "POST") {
    assertWritable(readOnly, "governor undo");
    const body = JSON.parse((await readBody(req)) || "{}") as { auditId?: string };
    sendJson(res, 200, undoGovernorAudit(db, paths, String(body.auditId ?? "")));
    return;
  }

  if (url.pathname === "/api/governor/preview" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { factIds?: string[] };
    sendJson(res, 200, { facts: factsSnapshot(db, body.factIds ?? []) });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function searchMemory(db: UmosDatabase, params: URLSearchParams): Record<string, unknown> {
  const query = params.get("query") ?? "";
  const limit = Math.max(1, Math.min(Number(params.get("limit") ?? 20), 50));
  const memoryType = params.get("memoryType") ?? "all";
  const failuresOnly = params.get("failuresOnly") === "true" || memoryType === "failure";

  if (failuresOnly) {
    const results = searchFailures(db, query, limit);
    return {
      results,
      guidance: failureSearchGuidance(results),
      filters: Object.fromEntries(params.entries())
    };
  }

  let results = searchSections(db, {
    query,
    limit: Math.min(limit * 4, 50),
    neighbors: Number(params.get("neighbors") ?? 1),
    includeSecret: params.get("includeSecret") === "true",
    project: params.get("project") || undefined
  });

  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  const sensitivity = params.get("sensitivity") ?? "all";
  const sourceOrigin = params.get("sourceOrigin") ?? "all";

  results = results.filter((row) => {
    if (dateFrom && Date.parse(row.capturedAt) < Date.parse(dateFrom)) return false;
    if (dateTo && Date.parse(row.capturedAt) > Date.parse(`${dateTo}T23:59:59.999Z`)) return false;
    if (sensitivity !== "all" && row.sensitivity !== sensitivity) return false;
    if (sourceOrigin !== "all" && row.sourceOrigin !== sourceOrigin) return false;
    if (memoryType === "decision" && !/\b(decision|decided|chosen|direction|recommendation)\b/i.test(`${row.heading ?? ""} ${row.body}`)) return false;
    return true;
  });

  if (memoryType === "source") {
    const seen = new Set<string>();
    results = results.filter((row) => {
      if (seen.has(row.sourceId)) return false;
      seen.add(row.sourceId);
      row.id = row.sourceId;
      return true;
    });
  }

  return {
    results: results.slice(0, limit),
    guidance: retrievalGuidance(results.slice(0, limit)),
    filters: Object.fromEntries(params.entries())
  };
}

function searchFailures(db: UmosDatabase, query: string, limit: number): Array<Record<string, unknown>> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, attempted, failed_because, do_not_repeat, confidence, created_at, space, trust_level, sensitivity, source_ids_json, section_ids_json
       FROM failures
       ORDER BY created_at DESC
       LIMIT 300`
    )
    .all() as Array<{
    id: string;
    attempted: string;
    failed_because: string;
    do_not_repeat: string;
    confidence: number;
    created_at: string;
    space: string;
    trust_level: string;
    sensitivity: string;
    source_ids_json: string;
    section_ids_json: string;
  }>;

  return rows
    .map((row) => {
      const text = `${row.attempted} ${row.failed_because} ${row.do_not_repeat}`.toLowerCase();
      const matches = tokens.filter((token) => text.includes(token)).length;
      return { row, matches };
    })
    .filter((item) => item.matches > 0)
    .sort((a, b) => b.matches - a.matches || b.row.confidence - a.row.confidence)
    .slice(0, limit)
    .map(({ row, matches }) => ({
      id: row.id,
      heading: row.attempted,
      sourceTitle: "Failure memory",
      snippet: `${row.failed_because} Do not repeat: ${row.do_not_repeat}`,
      score: matches + row.confidence,
      capturedAt: row.created_at,
      space: row.space,
      trustLevel: row.trust_level,
      sensitivity: row.sensitivity,
      sourceIds: safeJsonArray(row.source_ids_json),
      sectionIds: safeJsonArray(row.section_ids_json),
      relatedFailures: [{ id: row.id, doNotRepeat: row.do_not_repeat }]
    }));
}

function failureSearchGuidance(results: Array<Record<string, unknown>>): Record<string, unknown> {
  const doNotRepeat = results
    .flatMap((row) => Array.isArray(row.relatedFailures) ? row.relatedFailures : [])
    .map((failure) => String((failure as Record<string, unknown>).doNotRepeat ?? ""))
    .filter(Boolean)
    .slice(0, 5);
  return {
    confidence: results.length === 0 ? "none" : results.length >= 3 ? "high" : "medium",
    resultCount: results.length,
    citationCount: new Set(results.flatMap((row) => [...stringArray(row.sourceIds), ...stringArray(row.sectionIds)])).size,
    relatedFailureCount: doNotRepeat.length,
    doNotRepeat,
    recommendedNextStep: results.length === 0
      ? "No matching failure memory found. Search by the exact project, incident, or error phrase."
      : "Treat these as known failed paths. Read the cited failure/source before repeating a similar action."
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function proposalGroups(db: UmosDatabase, paths: VaultPaths): Array<Record<string, unknown>> {
  const summaries = listProposalSummaries(db, paths, "pending", "all");
  const groups = new Map<string, { ids: string[]; clean: number; warnings: number; blocked: number; label: string }>();
  for (const row of summaries) {
    const date = String(row.createdAt ?? "").slice(0, 10) || "unknown-date";
    const risk = Number(row.blockedCount) > 0 ? "blocked" : Number(row.warningCount) > 0 ? "warnings" : "clean";
    const space = String(row.space ?? "space");
    const sensitivity = String(row.sensitivity ?? "normal");
    const key = `${date}|${space}|${sensitivity}|${risk}`;
    const group = groups.get(key) ?? { ids: [], clean: 0, warnings: 0, blocked: 0, label: `${date} / ${space} / ${sensitivity} / ${risk}` };
    group.ids.push(String(row.id));
    if (risk === "clean") group.clean += 1;
    if (risk === "warnings") group.warnings += 1;
    if (risk === "blocked") group.blocked += 1;
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .map(([key, group]) => ({ key, ...group, count: group.ids.length }))
    .sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

function archiveDuplicateProposals(db: UmosDatabase, paths: VaultPaths): Record<string, unknown> {
  const rows = db
    .prepare("SELECT id, created_at, diff_json, source_ids_json FROM proposals WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as Array<{ id: string; created_at: string; diff_json: string; source_ids_json: string }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const signature = createHash("sha256")
      .update(`${normalizeJson(row.source_ids_json)}|${normalizeJson(row.diff_json)}`)
      .digest("hex");
    groups.set(signature, [...(groups.get(signature) ?? []), row]);
  }
  const archived: string[] = [];
  const update = db.prepare("UPDATE proposals SET status = 'archived' WHERE id = ? AND status = 'pending'");
  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      for (const duplicate of group.slice(1)) {
        if (update.run(duplicate.id).changes > 0) archived.push(duplicate.id);
      }
    }
  });
  tx();
  if (archived.length > 0) {
    recordGovernorAudit(paths, {
      action: "archive_duplicate_proposals",
      targetIds: archived,
      before: [],
      after: []
    });
  }
  return { ok: true, archived, duplicateGroups: Array.from(groups.values()).filter((group) => group.length > 1).length };
}

function applyHighValueCleanProposals(db: UmosDatabase, paths: VaultPaths, limit: number): Record<string, unknown> {
  const summaries = listProposalSummaries(db, paths, "pending", "clean")
    .filter((row) => isHighValueProposal(row))
    .slice(0, limit);
  const applied: string[] = [];
  const skipped: Array<{ id: string; error: string }> = [];
  for (const row of summaries) {
    const id = String(row.id ?? "");
    if (!id) continue;
    try {
      applyProposal(db, paths, id);
      applied.push(id);
    } catch (error) {
      skipped.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (applied.length > 0) {
    recordGovernorAudit(paths, {
      action: "apply_high_value_clean_proposals",
      targetIds: applied,
      before: [],
      after: []
    });
  }
  return { ok: true, applied, skipped, considered: summaries.length };
}

function isHighValueProposal(row: Record<string, unknown>): boolean {
  if (!row.clean || row.status !== "pending") return false;
  const counts = row.counts as { events?: number; facts?: number; failures?: number } | undefined;
  const itemCount = Number(counts?.events ?? 0) + Number(counts?.facts ?? 0) + Number(counts?.failures ?? 0);
  if (itemCount === 0) return false;
  const text = `${row.summary ?? ""} ${row.space ?? ""} ${row.sensitivity ?? ""}`.toLowerCase();
  if (Number(counts?.failures ?? 0) > 0) return true;
  return /\b(neurakeep|memory|production|decision|decided|policy|mcp|openclaw|codex|claude|pdf|watcher|sync|dedupe|failure|do not repeat|client|security|scheduler)\b/i.test(text);
}

function triageNoisyWarningProposals(
  db: UmosDatabase,
  paths: VaultPaths,
  options: { archive: boolean; limit: number }
): Record<string, unknown> {
  const warnings = listProposalSummaries(db, paths, "pending", "warnings");
  const noisy = warnings.filter((row) => isNoisyWarningProposal(row)).slice(0, options.limit);
  const keepReview = warnings.filter((row) => !isNoisyWarningProposal(row)).slice(0, options.limit);
  const archived: string[] = [];
  if (options.archive && noisy.length > 0) {
    const update = db.prepare("UPDATE proposals SET status = 'archived' WHERE id = ? AND status = 'pending'");
    const tx = db.transaction(() => {
      for (const row of noisy) {
        const id = String(row.id ?? "");
        if (id && update.run(id).changes > 0) archived.push(id);
      }
    });
    tx();
    recordGovernorAudit(paths, {
      action: "archive_noisy_warning_proposals",
      targetIds: archived,
      before: [],
      after: []
    });
  }
  return {
    ok: true,
    archived,
    noisy: noisy.map(proposalTriageSummary),
    keepForReview: keepReview.map(proposalTriageSummary),
    totalWarnings: warnings.length
  };
}

function isNoisyWarningProposal(row: Record<string, unknown>): boolean {
  const counts = row.counts as { events?: number; facts?: number; failures?: number } | undefined;
  const itemCount = Number(counts?.events ?? 0) + Number(counts?.facts ?? 0) + Number(counts?.failures ?? 0);
  const text = `${row.summary ?? ""} ${(row.sourceIds as string[] | undefined)?.join(" ") ?? ""}`.toLowerCase();
  const highValue = isHighValueProposal({ ...row, clean: true, status: "pending" });
  if (Number(row.blockedCount ?? 0) > 0) return true;
  if (itemCount > 90 && /\bmemory\.md|daily|2026-|workspace memory|extract \d+ events/i.test(text)) return true;
  if (Number(row.warningCount ?? 0) >= 8 && !highValue) return true;
  if (/generic_api_key|secret|poisoning/i.test(text) && !highValue) return true;
  return false;
}

function proposalTriageSummary(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    summary: row.summary,
    createdAt: row.createdAt,
    counts: row.counts,
    warningCount: row.warningCount,
    blockedCount: row.blockedCount,
    sensitivity: row.sensitivity
  };
}

function collapseDuplicateFacts(db: UmosDatabase, paths: VaultPaths): Record<string, unknown> {
  const rows = db
    .prepare("SELECT id, subject, predicate, object, confidence, created_at, supersedes_json FROM facts WHERE valid_until IS NULL")
    .all() as Array<{
    id: string;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    created_at: string;
    supersedes_json: string;
  }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = normalizeText(`${row.subject}|${row.predicate}|${row.object}`);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const collapsed: Array<{ winnerId: string; loserIds: string[] }> = [];
  const now = new Date().toISOString();
  const beforeIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length > 1) beforeIds.push(...group.map((row) => row.id));
  }
  const before = factsSnapshot(db, beforeIds);
  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => b.confidence - a.confidence || String(b.created_at).localeCompare(a.created_at));
      const winner = sorted[0];
      const losers = sorted.slice(1);
      const loserIds = losers.map((row) => row.id);
      const supersedes = Array.from(new Set([...safeJsonArray(winner.supersedes_json), ...loserIds]));
      db.prepare("UPDATE facts SET supersedes_json = ? WHERE id = ?").run(JSON.stringify(supersedes), winner.id);
      const markLoser = db.prepare("UPDATE facts SET valid_until = ?, review_after = ? WHERE id = ?");
      for (const loser of losers) {
        markLoser.run(now, now, loser.id);
      }
      collapsed.push({ winnerId: winner.id, loserIds });
    }
  });
  tx();
  if (collapsed.length > 0) {
    recordGovernorAudit(paths, {
      action: "collapse_duplicate_facts",
      targetIds: beforeIds,
      before,
      after: factsSnapshot(db, beforeIds)
    });
  }
  return { ok: true, collapsedGroups: collapsed.length, collapsedFacts: collapsed.reduce((sum, group) => sum + group.loserIds.length, 0), groups: collapsed };
}

function fuzzyDuplicateFactPreview(db: UmosDatabase): Array<Record<string, unknown>> {
  const rows = db
    .prepare("SELECT id, subject, predicate, object, confidence, created_at, supersedes_json FROM facts WHERE valid_until IS NULL")
    .all() as Array<{
    id: string;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    created_at: string;
    supersedes_json: string;
  }>;
  const groups = fuzzyDuplicateGroups(rows);
  return groups.map((group) => {
    const sorted = [...group].sort((a, b) => b.confidence - a.confidence || String(b.created_at).localeCompare(a.created_at));
    const winner = sorted[0];
    const losers = sorted.slice(1);
    const similarity = losers.length > 0 ? textSimilarity(factText(winner), factText(losers[0])) : 1;
    const exactObject = losers.every((row) => normalizeText(row.object) === normalizeText(winner.object));
    const groupId = createHash("sha256").update(sorted.map((row) => row.id).sort().join("|")).digest("hex").slice(0, 16);
    return {
      groupId,
      similarity,
      exactObject,
      safeAutoSelectable: exactObject && similarity >= 0.98,
      reviewRecommendation: exactObject && similarity >= 0.98 ? "safe_exact_duplicate" : "manual_review_required",
      winner,
      losers,
      ids: sorted.map((row) => row.id)
    };
  });

}

function fuzzyDuplicateGroups(rows: Array<{
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  created_at: string;
  supersedes_json: string;
}>): Array<typeof rows> {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${tokenSignature(row.subject)}|${tokenSignature(row.predicate)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const groups: Array<typeof rows> = [];
  for (const candidates of grouped.values()) {
    const used = new Set<string>();
    for (const row of candidates) {
      if (used.has(row.id)) continue;
      const similar = candidates.filter((other) => {
        if (used.has(other.id)) return false;
        return textSimilarity(`${row.subject} ${row.predicate} ${row.object}`, `${other.subject} ${other.predicate} ${other.object}`) >= 0.84;
      });
      if (similar.length > 1) {
        similar.forEach((item) => used.add(item.id));
        groups.push(similar);
      }
    }
  }
  return groups;
}

function collapseFuzzyDuplicateFacts(db: UmosDatabase, paths: VaultPaths, groupIds?: string[]): Record<string, unknown> {
  const preview = fuzzyDuplicateFactPreview(db);
  const selected = new Set((groupIds ?? []).map(String).filter(Boolean));
  if (selected.size === 0) {
    throw new Error("Fuzzy duplicate collapse requires explicit groupIds from preview.");
  }
  const selectedGroups = preview.filter((group) => selected.has(String(group.groupId)));
  const groups = selectedGroups.map((group) => [group.winner, ...(group.losers as unknown[])] as Array<{
    id: string;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    created_at: string;
    supersedes_json: string;
  }>);
  const targetIds = groups.flatMap((group) => group.map((row) => row.id));
  const before = factsSnapshot(db, targetIds);
  const collapsed: Array<{ winnerId: string; loserIds: string[]; similarity: number }> = [];
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const group of groups) {
      const sorted = [...group].sort((a, b) => b.confidence - a.confidence || String(b.created_at).localeCompare(a.created_at));
      const winner = sorted[0];
      const losers = sorted.slice(1);
      const loserIds = losers.map((row) => row.id);
      const supersedes = Array.from(new Set([...safeJsonArray(winner.supersedes_json), ...loserIds]));
      db.prepare("UPDATE facts SET supersedes_json = ? WHERE id = ?").run(JSON.stringify(supersedes), winner.id);
      const markLoser = db.prepare("UPDATE facts SET valid_until = ?, review_after = ? WHERE id = ?");
      for (const loser of losers) {
        markLoser.run(now, now, loser.id);
      }
      collapsed.push({ winnerId: winner.id, loserIds, similarity: textSimilarity(factText(winner), factText(losers[0])) });
    }
  });
  tx();
  if (collapsed.length > 0) {
    recordGovernorAudit(paths, {
      action: "collapse_fuzzy_duplicate_facts",
      targetIds,
      before,
      after: factsSnapshot(db, targetIds)
    });
  }
  return { ok: true, collapsedGroups: collapsed.length, collapsedFacts: collapsed.reduce((sum, group) => sum + group.loserIds.length, 0), groups: collapsed };
}

function syncWorkspaceMemoryFiles(db: UmosDatabase, paths: VaultPaths): Record<string, unknown> {
  const workspaceRoot = resolve(paths.root, "..", "..", "..");
  const candidates = [
    join(workspaceRoot, "MEMORY.md"),
    ...safeListMarkdown(join(workspaceRoot, "memory"))
  ].filter((path) => existsSync(path) && statSync(path).isFile());
  const ingested: unknown[] = [];
  const proposals: unknown[] = [];
  const skipped: unknown[] = [];
  for (const path of candidates) {
    const ingest = ingestFile(db, paths, {
      path,
      kind: "markdown",
      space: "system",
      trustLevel: "observed",
      sourceOrigin: "agent",
      visibility: "private",
      sensitivity: "internal"
    });
    if (ingest.skipped) {
      skipped.push({ path, sourceId: ingest.sourceId, reason: "already_ingested" });
      continue;
    }
    ingested.push({ path, ...ingest });
    proposals.push(proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths }));
  }
  return { ok: true, considered: candidates.length, ingested, proposals, skipped, queueOnly: true };
}

function ocrHealth(): Record<string, unknown> {
  const pdftoppm = findBinary("pdftoppm");
  const tesseract = findBinary("tesseract");
  return {
    ok: Boolean(pdftoppm && tesseract),
    tools: {
      pdftoppm: pdftoppm ? { installed: true, path: pdftoppm } : { installed: false },
      tesseract: tesseract ? { installed: true, path: tesseract } : { installed: false }
    },
    install: {
      windows: "Install Poppler for Windows and Tesseract OCR, then add both bin folders to PATH. With Chocolatey: choco install poppler tesseract",
      mac: "brew install poppler tesseract",
      linux: "sudo apt-get install poppler-utils tesseract-ocr"
    }
  };
}

function importSupport(paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor): Record<string, unknown> {
  const hostedCustomer = Boolean(options.hosted?.enabled) && actor.provider !== "local" && !actor.roles.includes("system");
  const workspaceRoot = resolve(paths.root, "..", "..", "..");
  return {
    supportedKinds: [
      { kind: "markdown", extensions: [".md", ".markdown"], proposalReviewed: true },
      { kind: "note", extensions: [".txt"], proposalReviewed: true },
      { kind: "session", extensions: [".jsonl"], proposalReviewed: true },
      { kind: "pdf", extensions: [".pdf"], proposalReviewed: true, ocrFallback: true }
    ],
    approvedRoots: hostedCustomer ? [] : [resolve(paths.root), workspaceRoot, homedir()],
    inbox: hostedCustomer ? "tenant://inbox" : paths.inboxDir,
    uploadOnly: hostedCustomer,
    policy: {
      rawSourcesAutoIndexed: true,
      durableMemoryAutoApplied: false,
      queueOnly: true
    },
    ocr: ocrHealth()
  };
}

function enforceOrganizationUploadPolicy(controlDb: UmosDatabase, actor: HostedActor, sensitivity: string, content: string): void {
  if (!actor.organizationId) return;
  const policy = organizationPolicy(controlDb, actor);
  const levels = ["normal", "internal", "confidential", "secret"];
  const maximum = levels.indexOf(String(policy.maxSensitivity ?? "secret"));
  const requested = levels.indexOf(sensitivity);
  if (maximum >= 0 && requested > maximum) {
    throw new HttpStatusError(422, `This organization does not allow ${sensitivity} content in this space.`);
  }
  if (policy.dlpBlockSecrets !== false) {
    const scan = scanContentForSafety(content);
    if (scan.secretHints.length > 0) throw new HttpStatusError(422, `DLP blocked this upload: ${scan.secretHints.join(", ")}.`);
  }
}

function hostedStorageStatus(paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor): Record<string, unknown> {
  const provider = process.env.NEURAKEEP_STORAGE_PROVIDER || (options.hosted?.enabled ? "object-storage-required" : "local-vault");
  const hostedCustomer = Boolean(options.hosted?.enabled) && actor.provider !== "local" && !actor.roles.includes("system");
  return {
    ok: provider !== "object-storage-required",
    provider,
    bucket: hostedCustomer ? null : process.env.NEURAKEEP_STORAGE_BUCKET || null,
    rawRoot: hostedCustomer ? "tenant://raw" : join(paths.root, "raw"),
    inboxRoot: hostedCustomer ? "tenant://inbox" : paths.inboxDir,
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    policy: {
      rawUploads: "immutable",
      durableMemory: "proposal-reviewed",
      generatedArtifacts: "not releasable",
      envFiles: "not releasable"
    },
    missingForHosted: provider === "object-storage-required"
      ? ["Set NEURAKEEP_STORAGE_PROVIDER and NEURAKEEP_STORAGE_BUCKET before enabling hosted accounts."]
      : []
  };
}

const betaAllowedEmailsKey = "hosted_beta_allowed_emails_json";

function betaAccessPolicy(db?: UmosDatabase): BetaAccessPolicy {
  const policy = betaAccessPolicyFromEnv();
  const dbEmails = db ? readBetaAllowedEmails(db) : [];
  const allowedEmails = Array.from(new Set([...policy.allowedEmails, ...dbEmails].map(normalizeEmail).filter(Boolean)));
  return {
    enabled: policy.enabled || dbEmails.length > 0,
    allowedEmails,
    allowedDomains: policy.allowedDomains
  };
}

function betaTesterAdminStatus(db: UmosDatabase, actor: HostedActor): Record<string, unknown> {
  const policy = betaAccessPolicy(db);
  const editableEmails = readBetaAllowedEmails(db);
  const members = listHostedMembers(db, actor.tenantId);
  const deniedSignIns = listRecentDeniedBetaAccess(db, 25).map((row) => ({
    ...row,
    actorEmailMasked: maskEmail(String(row.actorEmail ?? "")),
    reason: metadataValue(row.metadataJson, "reason")
  }));
  const testerActivity = betaTesterActivity(db, actor.tenantId, members, editableEmails);
  return {
    actor,
    access: betaAccessStatus(actor, policy),
    policy: {
      enabled: policy.enabled,
      allowlistSize: policy.allowedEmails.length + policy.allowedDomains.length,
      editableEmails,
      editableEmailsMasked: editableEmails.map(maskEmail),
      envEmailsMasked: betaAccessPolicyFromEnv().allowedEmails.map(maskEmail),
      allowedDomains: policy.allowedDomains.map((domain) => `@${domain}`)
    },
    metrics: betaTesterMetrics(db, actor.tenantId, policy, members, deniedSignIns),
    members,
    testerActivity,
    deniedSignIns,
    recentAuditEvents: listHostedAudit(db, actor.tenantId, 30)
  };
}

function betaTesterMetrics(
  db: UmosDatabase,
  tenantId: string,
  policy: BetaAccessPolicy,
  members: Array<Record<string, unknown>>,
  deniedSignIns: Array<Record<string, unknown>>
): Record<string, unknown> {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent = listHostedAuditSummary(db, tenantId, 500);
  const recent24h = recent.filter((row) => Date.parse(String(row.createdAt ?? "")) >= since24h);
  return {
    allowlistEmails: policy.allowedEmails.length,
    allowlistDomains: policy.allowedDomains.length,
    signedInMembers: members.length,
    deniedSignIns: deniedSignIns.length,
    deniedLast24h: deniedSignIns.filter((row) => Date.parse(String(row.createdAt ?? "")) >= since24h).length,
    searchesLast24h: recent24h.filter((row) => row.action === "memory.search").length,
    importsLast24h: recent24h.filter((row) => String(row.action ?? "").startsWith("memory.import") || row.action === "beta.sample_memory.import").length,
    proposalsAppliedLast24h: recent24h.filter((row) => row.action === "proposal.apply").length
  };
}

function betaTesterActivity(
  db: UmosDatabase,
  tenantId: string,
  members: Array<Record<string, unknown>>,
  editableEmails: string[]
): Array<Record<string, unknown>> {
  const byEmail = new Map<string, Record<string, unknown>>();
  const seed = (email: string, source: string, member?: Record<string, unknown>): void => {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    byEmail.set(normalized, {
      email: normalized,
      emailMasked: maskEmail(normalized),
      source,
      displayName: member?.displayName ?? "",
      userId: member?.userId ?? "",
      lastSeenAt: member?.updatedAt ?? null,
      auditEvents: 0,
      searches: 0,
      imports: 0,
      proposalsApplied: 0,
      denied: 0,
      errors: 0
    });
  };
  for (const email of editableEmails) seed(email, "dashboard");
  for (const member of members) seed(String(member.email ?? ""), "signed-in", member);

  for (const row of listHostedAuditSummary(db, tenantId, 1000)) {
    const email = normalizeEmail(row.actorEmail);
    if (!email) continue;
    if (!byEmail.has(email)) seed(email, "audit");
    const entry = byEmail.get(email)!;
    entry.auditEvents = Number(entry.auditEvents ?? 0) + 1;
    if (row.action === "memory.search") entry.searches = Number(entry.searches ?? 0) + 1;
    if (String(row.action ?? "").startsWith("memory.import") || row.action === "beta.sample_memory.import") {
      entry.imports = Number(entry.imports ?? 0) + 1;
    }
    if (row.action === "proposal.apply") entry.proposalsApplied = Number(entry.proposalsApplied ?? 0) + 1;
    if (row.status === "denied") entry.denied = Number(entry.denied ?? 0) + 1;
    if (row.status === "error") entry.errors = Number(entry.errors ?? 0) + 1;
    const createdAt = String(row.createdAt ?? "");
    if (!entry.lastSeenAt || Date.parse(createdAt) > Date.parse(String(entry.lastSeenAt))) {
      entry.lastSeenAt = createdAt;
    }
  }

  return Array.from(byEmail.values()).sort((a, b) => Date.parse(String(b.lastSeenAt ?? 0)) - Date.parse(String(a.lastSeenAt ?? 0)));
}

function metadataValue(value: unknown, key: string): unknown {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
    return parsed[key];
  } catch {
    return undefined;
  }
}

function readBetaAllowedEmails(db: UmosDatabase): string[] {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(betaAllowedEmailsKey) as { value?: string } | undefined;
  try {
    const parsed = JSON.parse(row?.value ?? "[]") as unknown;
    return Array.isArray(parsed) ? Array.from(new Set(parsed.map((item) => normalizeEmail(item)).filter(Boolean))) : [];
  } catch {
    return [];
  }
}

function writeBetaAllowedEmails(db: UmosDatabase, emails: string[]): string[] {
  const normalized = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean))).sort();
  db.prepare(
    `
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
  ).run(betaAllowedEmailsKey, JSON.stringify(normalized));
  return normalized;
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  const prefix = name.length <= 2 ? `${name.slice(0, 1)}*` : `${name.slice(0, 2)}***`;
  return `${prefix}@${domain}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function betaLaunchFlow(db: UmosDatabase, paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor): Record<string, unknown> {
  const quality = qualityDashboard(db, paths);
  const counts = quality.counts as Record<string, unknown>;
  const storage = hostedStorageStatus(paths, options, actor);
  const integrations = integrationStatus(db, paths, options, actor);
  const hostedEnabled = Boolean(options.hosted?.enabled);
  const autonomousGrantsReady = Number((db.prepare(`SELECT COUNT(*) AS count FROM hosted_access_tokens token
    JOIN hosted_agent_grants grant ON grant.token_id = token.id
    WHERE token.revoked_at IS NULL AND grant.revoked_at IS NULL AND token.expires_at > ?`).get(new Date().toISOString()) as { count: number }).count) > 0;
  const steps = [
    betaStep("signup", hostedEnabled, "Google sign-in is enabled through Firebase Auth."),
    betaStep("tenant_space", listHostedSpaces(db, actor.tenantId).length > 0, "An isolated tenant vault and personal space exist for the account."),
    betaStep("hosted_storage", Boolean(storage.ok), "Hosted storage provider/bucket is configured."),
    betaStep("remote_mcp", hostedEnabled && autonomousGrantsReady, "Remote MCP has at least one active, expiring per-space autonomous-agent grant."),
    betaStep("import_memory", Number(counts.sources ?? 0) > 0, "Memory sources are indexed."),
    betaStep("review_proposals", Number(counts.warningProposals ?? 0) === 0 && Number(counts.blockedProposals ?? 0) === 0, "Proposal queue has no warning or blocked items."),
    betaStep("search_read", Number(counts.sections ?? 0) > 0, "Search/read memory surface has indexed sections.")
  ];
  return {
    ok: steps.every((step) => step.ready),
    updatedAt: new Date().toISOString(),
    actor,
    steps,
    signup: {
      mode: hostedEnabled ? "firebase" : "local",
      firebaseProjectId: options.hosted?.firebaseProjectId ?? null,
      access: { allowed: true, reason: "authenticated_account" }
    },
    onboarding: {
      queueOnly: true,
      durableAutoApply: false,
      recommendedFlow: ["Sign in", "Choose a plan", "Create isolated tenant vault", "Import sample or real memory", "Connect MCP", "Review proposals", "Search/read memory"]
    },
    storage,
    remoteMcp: integrations.remoteMcp,
    quality
  };
}

function importFirstRunSampleMemory(db: UmosDatabase, paths: VaultPaths, actor: HostedActor): Record<string, unknown> {
  const sampleDir = join(paths.inboxDir, "first-run");
  mkdirSync(sampleDir, { recursive: true });
  const samplePath = join(sampleDir, "neurakeep-first-run-sample.md");
  writeFileSync(
    samplePath,
    [
      "# NeuraKeep First-Run Sample",
      "",
      `Imported by: ${actor.email ?? actor.uid}`,
      `Imported at: ${new Date().toISOString()}`,
      "",
      "## Decision",
      "",
      "Use NeuraKeep as a source-cited, proposal-reviewed memory layer for AI agents.",
      "",
      "## Workflow",
      "",
      "Raw memory sources are searchable immediately. Durable facts, decisions, and failures must be reviewed as proposals before apply.",
      "",
      "## Failed Path",
      "",
      "Do not expose the hosted graph shell before authentication and subscription checks pass."
    ].join("\n"),
    "utf8"
  );
  const ingest = ingestFile(db, paths, {
    path: samplePath,
    kind: "markdown",
    space: "project",
    trustLevel: "trusted",
    sourceOrigin: "manual",
    visibility: "private",
    sensitivity: "internal"
  });
  const proposal = ingest.skipped ? null : proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths });
  return { ok: true, samplePath, ingest, proposal, queueOnly: true };
}

function hostedOpsStatus(db: UmosDatabase, paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor): Record<string, unknown> {
  const storage = hostedStorageStatus(paths, options, actor);
  const auditRecent = listHostedAudit(db, actor.tenantId, 10);
  if (options.hosted?.enabled && actor.provider !== "local" && !actor.roles.includes("system")) {
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      health: { database: true, hosted: true, storageOk: Boolean(storage.ok) },
      storage,
      tenantIsolation: "dedicated_vault",
      recentAuditEvents: auditRecent
    };
  }
  const serviceTokens = serviceTokenConfigs(options);
  const backupHints = [
    process.env.NEURAKEEP_BACKUP_PATH || "/var/backups/neurakeep",
    storage.bucket ? `gs://${storage.bucket}` : null
  ].filter(Boolean);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    health: {
      http: true,
      database: scalarCount(db, "SELECT COUNT(*) AS count FROM metadata") >= 0,
      hosted: Boolean(options.hosted?.enabled),
      storageOk: Boolean(storage.ok)
    },
    backup: {
      configured: Boolean(storage.bucket || process.env.NEURAKEEP_BACKUP_BUCKET || process.env.NEURAKEEP_BACKUP_PATH),
      bucket: process.env.NEURAKEEP_BACKUP_BUCKET || storage.bucket || null,
      localPath: process.env.NEURAKEEP_BACKUP_PATH || null,
      hints: backupHints,
      verification: "Verify backups with your deployment procedure and perform regular restore drills."
    },
    alerting: {
      pm2Process: process.env.NEURAKEEP_PM2_PROCESS || "neurakeep-hosted",
      webhookConfigured: Boolean(process.env.NEURAKEEP_ALERT_WEBHOOK_URL),
      reminder: "Configure monitoring for /health and use a dedicated, read-only, expiring per-space grant for authenticated MCP checks."
    },
    serviceTokens: {
      configured: serviceTokens.length > 0,
      count: serviceTokens.length,
      rotationRecommendedDays: Number(process.env.NEURAKEEP_SERVICE_TOKEN_ROTATION_DAYS ?? 30),
      rotateWith: "npm run token:issue -- --out <secure-env-file>, then deploy only NEURAKEEP_SERVICE_TOKENS=sha256:<hash>."
    },
    access: { allowed: true, reason: "authenticated_account", accessModel: "stripe_subscription" },
    recentAuditEvents: auditRecent
  };
}

function betaStep(id: string, ready: boolean, label: string): Record<string, unknown> {
  return { id, ready, label };
}

function integrationStatus(db: UmosDatabase, paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor = localActor()): Record<string, unknown> {
  const hostedCustomer = Boolean(options.hosted?.enabled) && actor.provider !== "local" && !actor.roles.includes("system");
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");
  const stdioCommand = {
    command: "node",
    args: [cliPath, "mcp", "--root", paths.root]
  };
  const clients = hostedCustomer ? [] : [
    configStatus("OpenClaw", join(homedir(), ".openclaw", "openclaw.json")),
    configStatus("Claude Desktop", join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")),
    configStatus(
      "Claude Desktop packaged",
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json")
    ),
    {
      name: "Claude Code",
      configured: null,
      configPath: null,
      note: "Verify with `claude mcp get neurakeep` because Claude Code stores MCP config outside this app."
    },
    {
      name: "Codex",
      configured: null,
      configPath: null,
      note: "Use the same stdio command in the MCP host or the local HTTP endpoint when available."
    }
  ];
  const toolNames = ["memory_search", "memory_read", "memory_explain_sources", "memory_save", "memory_propose_update", "memory_apply_update"];
  const serviceTokens = serviceTokenConfigs(options);
  const localBase = `http://${options.host}:${options.port}`;
  const publicBase = process.env.NEURAKEEP_PUBLIC_URL?.replace(/\/+$/, "") ?? localBase;
  return {
    ok: true,
    server: {
      name: "neurakeep",
      httpEndpoint: hostedCustomer ? `${publicBase}/mcp` : `${localBase}/mcp`,
      publicEndpoint: `${publicBase}/mcp`,
      uiEndpoint: hostedCustomer ? `${publicBase}/app` : options.serveUi ? `${localBase}/index.html` : null,
      mode: options.readOnly ? "read-only" : "read-write",
      tokenRequired: Boolean(options.token || serviceTokens.length > 0 || options.hosted?.enabled),
      serviceTokenConfigured: serviceTokens.length > 0,
      hosted: Boolean(options.hosted?.enabled)
    },
    remoteMcp: {
      endpoint: `${publicBase}/mcp`,
      authModes: ["Firebase-verified identity", "per-space autonomous-agent grant"],
      serviceTokenConfigured: serviceTokens.length > 0,
      protectedResourceMetadata: `${publicBase}/.well-known/oauth-protected-resource/mcp`,
      authorizationServerMetadata: `${publicBase}/.well-known/oauth-authorization-server`,
      clientHints: [
        "Use Authorization: Bearer <Google ID token> for browser/user sessions.",
        "Use Authorization: Bearer <autonomous-agent grant> for Claude/OpenClaw/Codex connectors.",
        "Prefer NEURAKEEP_SERVICE_TOKENS=sha256:<hash> in hosted deployments so raw tokens are not stored in process config."
      ]
    },
    vault: {
      root: hostedCustomer ? "tenant://vault" : paths.root,
      sourceCount: scalarCount(db, "SELECT COUNT(*) AS count FROM sources"),
      pendingProposals: scalarCount(db, "SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'")
    },
    stdioCommand: hostedCustomer ? null : stdioCommand,
    tools: toolNames,
    clients,
    smokeTests: [
      { name: "search", tool: "memory_search", arguments: { query: "deployment decisions and known failures", limit: 5, neighbors: 1 } },
      { name: "read", tool: "memory_read", note: "Use an id returned by memory_search." },
      { name: "save", tool: "memory_save", note: "Saves new text as a searchable source and queues a proposal; never auto-applies." },
      { name: "propose", tool: "memory_propose_update", note: "Creates a pending proposal only; review before applying." },
      { name: "apply", tool: "memory_apply_update", note: "Only use after explicit approval or a clean reviewed proposal." }
    ],
    policy: {
      durableAutoApply: false,
      queueFirst: true,
      readBeforeActing: true
    }
  };
}

function dailyWorkflowStatus(db: UmosDatabase, paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor = localActor()): Record<string, unknown> {
  const dashboard = qualityDashboard(db, paths);
  const pending = dashboard.counts as Record<string, unknown>;
  return {
    ok: true,
    lastCheckedAt: new Date().toISOString(),
    integration: integrationStatus(db, paths, options, actor),
    importSupport: importSupport(paths, options, actor),
    watcher: options.hosted?.enabled && actor.provider !== "local" ? { available: false, reason: "local_only" } : watchStatus(paths),
    policy: selfMemoryPolicy,
    quality: dashboard,
    recommendedActions: workflowRecommendations(pending, dashboard)
  };
}

function workflowRecommendations(counts: Record<string, unknown>, dashboard: Record<string, unknown>): string[] {
  const actions: string[] = [];
  if (Number(counts.pendingProposals ?? 0) > 0) {
    actions.push("Review pending proposals before applying durable memory.");
  }
  if (Number(counts.warningProposals ?? 0) > 0) {
    actions.push("Triage warning proposals in batches; archive noisy imports and prune useful ones before apply.");
  }
  if (Number(counts.fuzzyDuplicateFactGroups ?? 0) > 0) {
    actions.push("Use fuzzy preview and select only obvious duplicate groups for collapse.");
  }
  const ocr = (dashboard.ocr ?? ocrHealth()) as Record<string, unknown>;
  if (!ocr.ok) {
    actions.push("Install or repair local OCR tools before importing scanned PDFs.");
  }
  if (actions.length === 0) {
    actions.push("Queue today's session summary, then leave proposals pending for review.");
  }
  return actions;
}

function configStatus(name: string, configPath: string): Record<string, unknown> {
  const exists = existsSync(configPath);
  let containsNeuraKeep = false;
  let error: string | undefined;
  if (exists) {
    try {
      containsNeuraKeep = readFileSync(configPath, "utf8").toLowerCase().includes("neurakeep");
    } catch (readError) {
      error = readError instanceof Error ? readError.message : String(readError);
    }
  }
  return {
    name,
    configured: containsNeuraKeep,
    configPath,
    exists,
    error,
    note: containsNeuraKeep ? "Config references NeuraKeep." : "Config does not reference NeuraKeep."
  };
}

function qualityDashboard(db: UmosDatabase, paths: VaultPaths): Record<string, unknown> {
  const quality = inspectMemoryQuality(db);
  const pending = listProposalSummaries(db, paths, "pending", "all");
  const sourceCount = scalarCount(db, "SELECT COUNT(*) AS count FROM sources");
  const sectionCount = scalarCount(db, "SELECT COUNT(*) AS count FROM sections");
  const factCount = scalarCount(db, "SELECT COUNT(*) AS count FROM facts WHERE valid_until IS NULL");
  const failureCount = scalarCount(db, "SELECT COUNT(*) AS count FROM failures");
  const eventCount = scalarCount(db, "SELECT COUNT(*) AS count FROM events");
  const warningCount = pending.filter((row) => Number(row.warningCount) > 0 && Number(row.blockedCount) === 0).length;
  const blockedCount = pending.filter((row) => Number(row.blockedCount) > 0).length;
  const cleanCount = pending.filter((row) => Boolean(row.clean)).length;
  const topNoisyImports = pending
    .filter((row) => Number(row.warningCount) > 0 || Number(row.blockedCount) > 0)
    .sort((a, b) => Number(b.warningCount) + Number(b.blockedCount) * 3 - (Number(a.warningCount) + Number(a.blockedCount) * 3))
    .slice(0, 8)
    .map(proposalTriageSummary);
  return {
    counts: {
      sources: sourceCount,
      sections: sectionCount,
      activeFacts: factCount,
      failures: failureCount,
      events: eventCount,
      pendingProposals: pending.length,
      cleanProposals: cleanCount,
      warningProposals: warningCount,
      blockedProposals: blockedCount,
      duplicateFactGroups: quality.duplicateFacts.length,
      duplicateFailureGroups: quality.duplicateFailures.length,
      staleFacts: quality.staleFacts.length,
      fuzzyDuplicateFactGroups: fuzzyDuplicateFactPreview(db).length
    },
    warningRate: pending.length ? warningCount / pending.length : 0,
    topNoisyImports
  };
}

function scalarCount(db: UmosDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function findBinary(name: string): string | null {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(command, [name], { encoding: "utf8" });
  if (found.status !== 0) return null;
  return found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function safeListMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function safeUploadName(fileName: string): string {
  const base = basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
  return base || "memory-upload.txt";
}

function queryTokens(query: string): string[] {
  return Array.from(query.matchAll(/[\p{L}\p{N}_-]+/gu))
    .map((match) => match[0].toLowerCase())
    .filter((token) => token.length > 2)
    .slice(0, 10);
}

function normalizeJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSignature(value: string): string {
  return Array.from(new Set(queryTokens(value).filter((token) => !["the", "and", "for", "with", "this", "that"].includes(token))))
    .sort()
    .slice(0, 8)
    .join(" ");
}

function textSimilarity(a: string, b: string): number {
  const aTokens = new Set(queryTokens(a));
  const bTokens = new Set(queryTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const intersection = Array.from(aTokens).filter((token) => bTokens.has(token)).length;
  const union = new Set([...Array.from(aTokens), ...Array.from(bTokens)]).size;
  const jaccard = intersection / Math.max(1, union);
  const na = normalizeText(a);
  const nb = normalizeText(b);
  const containment = na.includes(nb) || nb.includes(na) ? 1 : 0;
  return Math.max(jaccard, containment);
}

function factText(row: { subject: string; predicate: string; object: string }): string {
  return `${row.subject} ${row.predicate} ${row.object}`;
}

function searchPresetPath(paths: VaultPaths): string {
  return join(paths.root, "state", "search-presets.json");
}

function readSearchPresets(paths: VaultPaths): Array<Record<string, unknown>> {
  const file = searchPresetPath(paths);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function writeSearchPresets(paths: VaultPaths, presets: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const file = searchPresetPath(paths);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(presets.slice(0, 50), null, 2), "utf8");
  return presets.slice(0, 50);
}

function saveSearchPreset(paths: VaultPaths, input: { name?: string; query?: string; filters?: Record<string, unknown> }): Array<Record<string, unknown>> {
  const name = normalizeText(String(input.name ?? "")).slice(0, 60);
  if (!name) throw new Error("Preset name is required.");
  const presets = readSearchPresets(paths).filter((preset) => normalizeText(String(preset.name ?? "")) !== name);
  presets.unshift({
    name,
    query: String(input.query ?? ""),
    filters: input.filters ?? {},
    updatedAt: new Date().toISOString()
  });
  return writeSearchPresets(paths, presets);
}

function deleteSearchPreset(paths: VaultPaths, name: string): Array<Record<string, unknown>> {
  const normalized = normalizeText(name);
  return writeSearchPresets(paths, readSearchPresets(paths).filter((preset) => normalizeText(String(preset.name ?? "")) !== normalized));
}

function handleHttpRequest(
  db: UmosDatabase,
  paths: VaultPaths,
  payload: unknown,
  readOnly: boolean,
  actor: HostedActor = localActor()
): unknown {
  if (!isJsonRpcObject(payload)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC request" }
    };
  }

  if (readOnly && payload.method === "tools/call") {
    const name = String((payload.params as Record<string, unknown> | undefined)?.name ?? "");
    if (name === "memory_save" || name === "memory_propose_update" || name === "memory_apply_update") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32001, message: `${name} is disabled in read-only HTTP mode` }
      };
    }
  }

  if (payload.method === "tools/call") {
    try {
      const name = String((payload.params as Record<string, unknown> | undefined)?.name ?? "");
      assertHostedCapability(actor, capabilityForMcpTool(name));
      return handleJsonRpcRequest(db, paths, payload);
    } catch (error) {
      if (payload.id === undefined) return null;
      const statusCode = Number((error as { statusCode?: number })?.statusCode ?? 500);
      return {
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: statusCode === 403 ? -32003 : -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  return handleJsonRpcRequest(db, paths, payload);
}

function isJsonRpcObject(value: unknown): value is {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
} {
  return typeof value === "object" && value !== null && typeof (value as { method?: unknown }).method === "string";
}

function oauthProtectedResourceMetadata(req: IncomingMessage, options: HttpMcpServerOptions): Record<string, unknown> {
  const baseUrl = publicBaseUrl(req, options);
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/docs/mcp`,
    scopes_supported: ["memory:read", "memory:propose", "memory:apply"],
    neurakeep: {
      endpoint: `${baseUrl}/mcp`,
      hosted: Boolean(options.hosted?.enabled),
      authModes: ["firebase_id_token", "service_token"],
      serviceTokenConfigured: serviceTokenConfigs(options).length > 0,
      readOnly: options.readOnly
    }
  };
}

function oauthAuthorizationServerMetadata(req: IncomingMessage, options: HttpMcpServerOptions): Record<string, unknown> {
  const baseUrl = publicBaseUrl(req, options);
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["memory:read", "memory:propose", "memory:apply"],
    service_documentation: `${baseUrl}/docs/mcp`,
    neurakeep: {
      note: "Hosted NeuraKeep accepts Firebase-verified identity and per-space, expiring autonomous-agent grants. The authorized runtime decrypts the selected space while serving a request.",
      protectedResourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource/mcp`
    }
  };
}

async function authorizeRequest(req: IncomingMessage, db: UmosDatabase, options: HttpMcpServerOptions): Promise<HostedActor | null> {
  const serviceActor = serviceTokenActor(req, db, options);
  if (serviceActor) {
    ensureHostedDefaults(db, serviceActor);
    return serviceActor;
  }

  if (options.hosted?.enabled) {
    let actor: HostedActor | null = null;
    try {
      actor = options.hosted.verifyRequest
        ? await options.hosted.verifyRequest(req)
        : await verifyFirebaseRequest(req, {
            ...hostedAuthConfigFromEnv(),
            enabled: true,
            projectId: options.hosted.firebaseProjectId ?? hostedAuthConfigFromEnv().projectId
          });
    } catch {
      return null;
    }
    if (!actor) return null;
    actor = isolateHostedActor(actor);
    const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (requestPath !== "/api/hosted/organizations" && requestPath !== "/api/hosted/invitations/accept") {
      actor = resolveOrganizationActor(
        db,
        actor,
        headerValue(req.headers["x-neurakeep-tenant"]),
        headerValue(req.headers["x-neurakeep-space"])
      );
    }
    recordHostedAudit(db, {
      actor,
      action: "auth.sign_in",
      targetType: "hosted_access",
      status: "ok",
      metadata: { tenantIsolated: true, organizationId: actor.organizationId ?? null, spaceId: actor.spaceId }
    });
    return actor;
  }

  if (!options.token) {
    return localActor();
  }
  const expected = `Bearer ${options.token}`;
  return req.headers.authorization === expected ? localActor() : null;
}

type CompatGraphNode = ReturnType<typeof buildGraph>["nodes"][number];
type CompatGraphEdge = ReturnType<typeof buildGraph>["edges"][number];
type CompatClusterBy = "type" | "space" | "trust" | "sensitivity";

function graphOverviewCompat(db: UmosDatabase, clusterByValue: string | null): Record<string, unknown> {
  const clusterBy = compatClusterBy(clusterByValue);
  const graph = compatContentGraph(db);
  const degree = compatDegrees(graph.edges);
  const grouped = new Map<string, CompatGraphNode[]>();
  for (const node of graph.nodes) {
    const key = compatClusterValue(node, clusterBy);
    grouped.set(key, [...(grouped.get(key) ?? []), node]);
  }
  const clusters = Array.from(grouped.entries())
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, nodes]) => ({
      id: compatClusterId(clusterBy, key),
      key,
      label: key.replaceAll(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      kind: clusterBy,
      count: nodes.length,
      sampleIds: nodes.slice(0, 5).map((node) => node.id)
    }));
  const clusterIds = new Set(clusters.map((cluster) => cluster.id));
  const hubs = graph.nodes
    .filter((node) => node.type !== "section")
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 20)
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
  const edges: Array<{ from: string; to: string; type: "root" | "cluster" }> = clusters.map((cluster) => ({
    from: "root:neurakeep",
    to: cluster.id,
    type: "root"
  }));
  for (const hub of hubs) {
    const clusterId = compatClusterId(clusterBy, compatClusterValue(hub, clusterBy));
    if (clusterIds.has(clusterId)) edges.push({ from: clusterId, to: hub.id, type: "cluster" });
  }
  return {
    root: { id: "root:neurakeep", label: "NeuraKeep", type: "root", count: graph.nodes.length },
    clusters,
    hubs,
    edges,
    generatedAt: new Date().toISOString()
  };
}

function graphNeighborsCompat(db: UmosDatabase, params: URLSearchParams): Record<string, unknown> {
  const id = String(params.get("id") ?? "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const limit = Math.max(1, Math.min(2_000, Math.trunc(Number(params.get("limit") ?? 200)) || 200));
  const graph = compatContentGraph(db);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const degree = compatDegrees(graph.edges);
  const cluster = compatParseClusterId(id);
  let candidates: CompatGraphNode[];
  let relevantEdges: CompatGraphEdge[] = [];
  if (cluster) {
    candidates = graph.nodes.filter((node) => compatClusterValue(node, cluster.clusterBy) === cluster.key);
  } else {
    if (!nodeById.has(id)) throw Object.assign(new Error("graph node not found"), { statusCode: 404 });
    const neighborIds = new Set<string>();
    relevantEdges = graph.edges.filter((edge) => {
      if (edge.from === id) {
        neighborIds.add(edge.to);
        return true;
      }
      if (edge.to === id) {
        neighborIds.add(edge.from);
        return true;
      }
      return false;
    });
    candidates = Array.from(neighborIds, (neighborId) => nodeById.get(neighborId)).filter(
      (node): node is CompatGraphNode => Boolean(node)
    );
  }
  candidates.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const offset = Math.max(0, Math.trunc(Number(params.get("cursor") ?? 0)) || 0);
  const page = candidates.slice(offset, offset + limit).map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
  const pageIds = new Set(page.map((node) => node.id));
  const edges = cluster
    ? page.map((node) => ({ from: id, to: node.id, type: "cluster" as const }))
    : relevantEdges
        .filter((edge) => pageIds.has(edge.from === id ? edge.to : edge.from))
        .map((edge) => ({ ...edge, type: edge.type === "next" ? "contains" : edge.type }));
  const consumed = Math.min(candidates.length, offset + page.length);
  return {
    nodes: page,
    edges,
    nextCursor: consumed < candidates.length ? String(consumed) : null,
    remaining: Math.max(0, candidates.length - consumed),
    total: candidates.length
  };
}

function graphLocateCompat(db: UmosDatabase, params: URLSearchParams): Record<string, unknown> {
  const id = params.get("id")?.trim();
  const query = params.get("q")?.trim().toLocaleLowerCase() ?? "";
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(params.get("limit") ?? 20)) || 20));
  const graph = compatContentGraph(db);
  const degree = compatDegrees(graph.edges);
  const matches = graph.nodes
    .filter((node) => id ? node.id === id : query && (node.id.toLocaleLowerCase().startsWith(query) || node.label.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
  return { nodes: matches };
}

function compatContentGraph(db: UmosDatabase): ReturnType<typeof buildGraph> {
  const graph = buildGraph(db);
  const nodes = graph.nodes.filter((node) => node.type !== "root");
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

function compatDegrees(edges: CompatGraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

function compatClusterBy(value: string | null): CompatClusterBy {
  if (!value || value === "type") return "type";
  if (value === "space" || value === "trust" || value === "sensitivity") return value;
  throw Object.assign(new Error("clusterBy must be type, space, trust, or sensitivity"), { statusCode: 400 });
}

function compatClusterValue(node: CompatGraphNode, clusterBy: CompatClusterBy): string {
  if (clusterBy === "type") return node.type;
  if (clusterBy === "space") return node.space ?? "unknown";
  if (clusterBy === "trust") return node.trustLevel ?? "unknown";
  return node.sensitivity ?? "unknown";
}

function compatClusterId(clusterBy: CompatClusterBy, key: string): string {
  return `cluster:${clusterBy}:${Buffer.from(key, "utf8").toString("base64url")}`;
}

function compatParseClusterId(id: string): { clusterBy: CompatClusterBy; key: string } | null {
  const match = /^cluster:(type|space|trust|sensitivity):([A-Za-z0-9_-]+)$/.exec(id);
  return match ? { clusterBy: match[1] as CompatClusterBy, key: Buffer.from(match[2], "base64url").toString("utf8") } : null;
}

function authSettings(paths: VaultPaths, options: HttpMcpServerOptions, actor: HostedActor = localActor(), db?: UmosDatabase): Record<string, unknown> {
  const saved = readAuthSettings(paths);
  const serviceTokens = serviceTokenConfigs(options);
  return {
    mode: options.hosted?.enabled ? "remote" : saved.mode,
    provider: actor.provider,
    tokenRequired: Boolean(options.token || serviceTokens.length > 0 || options.hosted?.enabled),
    firebaseRequired: Boolean(options.hosted?.enabled),
    readOnly: options.readOnly,
    hasToken: Boolean(options.token),
    serviceTokenConfigured: serviceTokens.length > 0,
    endpoint: "/mcp",
    flags: {
      graph: {
        engine: process.env.NEURAKEEP_FLAG_GRAPH_ENGINE === "legacy" ? "legacy" : "sigma",
        universe: ["1", "true"].includes((process.env.NEURAKEEP_FLAG_GRAPH_UNIVERSE ?? "").toLowerCase())
      }
    },
    hosted: hostedStatus(options, actor, db),
    user: {
      ...saved.user,
      actor,
      allowWrites: saved.user.allowWrites && !options.readOnly
    }
  };
}

function hostedStatus(options: HttpMcpServerOptions, actor: HostedActor, db?: UmosDatabase): Record<string, unknown> {
  const serviceTokens = serviceTokenConfigs(options);
  return {
    enabled: Boolean(options.hosted?.enabled),
    authProvider: options.hosted?.enabled ? "firebase" : serviceTokens.length > 0 ? "service_token" : "local",
    firebaseProjectId: options.hosted?.firebaseProjectId ?? null,
    serviceTokenConfigured: serviceTokens.length > 0,
    serviceTokenCount: serviceTokens.length,
    accessModel: options.hosted?.enabled ? "stripe_subscription" : "local",
    tenantIsolation: options.hosted?.enabled && actor.provider === "firebase" ? (actor.organizationId ? "organization_space_vault" : "per_user_vault") : "single_vault",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    roles: actor.roles,
    uid: actor.uid,
    email: actor.email ?? null,
    organizationId: actor.organizationId ?? null,
    organizationName: actor.organizationName ?? null,
    membershipRole: actor.membershipRole ?? null
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const next = Array.isArray(value) ? value[0] : value;
  return next?.trim() || undefined;
}

function serviceTokenActor(req: IncomingMessage, db: UmosDatabase, options: HttpMcpServerOptions): HostedActor | null {
  const token = bearerToken(req);
  if (!token) return null;
  const managed = authenticateHostedAccessToken(db, token);
  if (managed) return managed;
  if (options.hosted?.enabled && process.env.NEURAKEEP_ALLOW_LEGACY_SERVICE_TOKENS !== "1") return null;
  const configs = serviceTokenConfigs(options);
  if (configs.length === 0) return null;
  const tokenHash = sha256(token);
  const matched = configs.some((config) => config === token || config === `sha256:${tokenHash}`);
  if (!matched) return null;
  const tenantId = tenantIdForServiceTokenHash(tokenHash);
  const spaceId = process.env.NEURAKEEP_SERVICE_SPACE || "personal";
  return {
    provider: "service_token",
    uid: `service:${tokenHash.slice(0, 16)}`,
    name: "NeuraKeep service token",
    tenantId,
    spaceId,
    roles: Array.from(new Set([...serviceRoles(), "system"]))
  };
}

function serviceTokenConfigs(options: HttpMcpServerOptions): string[] {
  return Array.from(new Set([...(options.serviceTokens ?? [])].map((token) => token.trim()).filter(Boolean)));
}

function serviceRoles(): string[] {
  const roles = (process.env.NEURAKEEP_SERVICE_ROLES ?? "operator,mcp")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return roles.length > 0 ? roles : ["operator", "mcp"];
}

function bearerToken(req: IncomingMessage): string | null {
  const header = String(req.headers.authorization ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicBaseUrl(req: IncomingMessage, options: HttpMcpServerOptions): string {
  const configured = process.env.NEURAKEEP_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `${options.host}:${options.port}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

function readAuthSettings(paths: VaultPaths): AuthSettingsFile {
  const fallback: AuthSettingsFile = {
    mode: "local",
    user: {
      displayName: "Local NeuraKeep User",
      role: "owner",
      allowWrites: true
    }
  };
  const file = authSettingsPath(paths);
  if (!existsSync(file)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AuthSettingsFile>;
    const role = parsed.user?.role === "viewer" || parsed.user?.role === "operator" || parsed.user?.role === "owner"
      ? parsed.user.role
      : fallback.user.role;
    return {
      mode: parsed.mode === "remote" ? "remote" : "local",
      user: {
        displayName: String(parsed.user?.displayName ?? fallback.user.displayName),
        role,
        allowWrites: Boolean(parsed.user?.allowWrites ?? fallback.user.allowWrites)
      }
    };
  } catch {
    return fallback;
  }
}

function writeAuthSettings(paths: VaultPaths, body: Partial<AuthSettingsFile>, options: HttpMcpServerOptions): Record<string, unknown> {
  const current = readAuthSettings(paths);
  const next: AuthSettingsFile = {
    mode: body.mode === "remote" ? "remote" : body.mode === "local" ? "local" : current.mode,
    user: {
      displayName: String(body.user?.displayName ?? current.user.displayName),
      role: body.user?.role === "viewer" || body.user?.role === "operator" || body.user?.role === "owner"
        ? body.user.role
        : current.user.role,
      allowWrites: Boolean(body.user?.allowWrites ?? current.user.allowWrites)
    }
  };
  mkdirSync(join(paths.root, "state"), { recursive: true });
  writeFileSync(authSettingsPath(paths), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return authSettings(paths, options);
}

function authSettingsPath(paths: VaultPaths): string {
  return join(paths.root, "state", "auth-settings.json");
}

function readBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new HttpStatusError(413, "Request body too large"));
      return;
    }
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > maxBytes) {
        settled = true;
        body = "";
        req.resume();
        reject(new HttpStatusError(413, "Request body too large"));
      }
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export function assertSecureHttpBinding(options: HttpMcpServerOptions): void {
  const authenticated = Boolean(options.hosted?.enabled || options.token || serviceTokenConfigs(options).length > 0);
  if (!isLoopbackHost(options.host) && !authenticated) {
    throw new Error("Refusing to bind NeuraKeep to a non-loopback host without authentication. Set --token, --service-token, or enable hosted authentication.");
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function tryServeUi(paths: VaultPaths, req: IncomingMessage, res: ServerResponse, hosted = false): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = uiPathname(url.pathname);
  const relative = normalize(pathname.replace(/^\/+/, ""));
  if (relative.startsWith("..")) {
    return false;
  }

  const uiRoot = hosted
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-dist")
    : join(paths.root, "app");
  const filePath = join(uiRoot, relative);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    const content = readFileSync(filePath);
    const headers: Record<string, string> = { "content-type": contentType(filePath) };
    if (url.pathname === "/app" || url.pathname.startsWith("/app/") || extname(filePath).toLowerCase() === ".html") {
      headers["x-robots-tag"] = "noindex, nofollow, noarchive";
      headers["cache-control"] = "no-store";
    }
    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function uiPathname(pathname: string): string {
  if (pathname === "/" || pathname === "/app" || pathname === "/app/") {
    return "/index.html";
  }
  if (pathname.startsWith("/app/")) {
    return pathname.slice("/app".length);
  }
  return pathname;
}

function listInboxFiles(paths: VaultPaths): Array<Record<string, unknown>> {
  try {
    return readdirSync(paths.inboxDir)
      .filter((name) => name !== "pending-updates")
      .map((name) => join(paths.inboxDir, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => {
        const stat = statSync(path);
        const kind = kindFromExtension(path);
        const scan = kind === "pdf"
          ? { riskFlags: [], secretHints: [], poisoningHints: [] }
          : scanContentForSafety(readFileSync(path, "utf8").slice(0, 200_000));
        return {
          path,
          name: relative(paths.inboxDir, path),
          bytes: stat.size,
          kind,
          riskFlags: scan.riskFlags,
          trustHint: scan.riskFlags.length > 0 ? "review-first" : "normal",
          sourceHint: path.includes("self-memory") || path.includes("workspace-summary") ? "self-memory" : "inbox"
        };
      });
  } catch {
    return [];
  }
}

function kindFromExtension(path: string): "markdown" | "session" | "pdf" {
  const extension = extname(path).toLowerCase();
  if (extension === ".jsonl") return "session";
  if (extension === ".pdf") return "pdf";
  return "markdown";
}

function normalizeIngestKind(value: unknown): "markdown" | "session" | "note" | "pdf" {
  if (value === "session" || value === "note" || value === "pdf") {
    return value;
  }
  return "markdown";
}

function autoIngestQueue(
  db: UmosDatabase,
  paths: VaultPaths,
  options: {
    extraFolders?: string[];
    recursive?: boolean;
    policy?: IngestPolicy;
    profileId?: string;
  } = {}
): Record<string, unknown> {
  const files = [
    ...listInboxFiles(paths),
    ...listProfileFiles(paths, options.extraFolders ?? [], Boolean(options.recursive))
  ];
  const ingested: unknown[] = [];
  const proposals: unknown[] = [];
  const skipped: unknown[] = [];
  const seen = new Set<string>();
  const policy = options.policy ?? {
    space: "project",
    trustLevel: "observed",
    sourceOrigin: "manual",
    visibility: "private",
    sensitivity: "normal"
  };
  for (const file of files) {
    const path = String(file.path ?? "");
    if (!path) {
      continue;
    }
    const prepared = prepareWatcherIngestFile(paths, path, policy, String(file.kind ?? "markdown"));
    const dedupeKey = prepared.contentHash;
    if (seen.has(dedupeKey)) {
      skipped.push({ path, reason: "duplicate_content", contentHash: dedupeKey });
      continue;
    }
    seen.add(dedupeKey);
    const kind = prepared.kind;
    const ingest = ingestFile(db, paths, {
      path: prepared.path,
      kind,
      space: policy.space,
      trustLevel: prepared.trustLevel,
      sourceOrigin: policy.sourceOrigin,
      visibility: policy.visibility,
      sensitivity: prepared.sensitivity
    });
    ingested.push({ ...ingest, originalPath: path, redactions: prepared.redactions, riskFlags: prepared.riskFlags });
    if (!ingest.skipped) {
      proposals.push(proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths }));
    }
  }
  return { ingested, proposals, skipped, profileId: options.profileId ?? null, recursive: Boolean(options.recursive), queueOnly: true };
}

function prepareWatcherIngestFile(
  paths: VaultPaths,
  sourcePath: string,
  policy: IngestPolicy,
  requestedKind: string
): {
  path: string;
  kind: "markdown" | "session" | "note" | "pdf";
  contentHash: string;
  trustLevel: IngestPolicy["trustLevel"];
  sensitivity: IngestPolicy["sensitivity"];
  riskFlags: string[];
  redactions: string[];
} {
  const kind = normalizeIngestKind(requestedKind);
  const isPdf = kind === "pdf";
  const contentBuffer = readFileSync(sourcePath);
  const content = isPdf ? "" : contentBuffer.toString("utf8");
  const scan = scanContentForSafety(content);
  const redacted = redactSensitiveContent(content);
  const shouldRedact = redacted.redactions.length > 0 && policy.sourceOrigin !== "manual";
  const finalContent = shouldRedact ? redacted.redacted : content;
  const contentHash = createHash("sha256").update(isPdf ? contentBuffer : finalContent).digest("hex");
  const trustLevel = scan.poisoningHints.length > 0 || redacted.redactions.length > 0 ? "untrusted" : policy.trustLevel;
  const sensitivity = redacted.redactions.length > 0 ? "confidential" : policy.sensitivity;
  if (!shouldRedact) {
    return {
      path: sourcePath,
      kind,
      contentHash,
      trustLevel,
      sensitivity,
      riskFlags: scan.riskFlags,
      redactions: []
    };
  }
  const redactedDir = join(paths.inboxDir, "pending-updates", "redacted");
  mkdirSync(redactedDir, { recursive: true });
  const extension = kind === "session" ? ".jsonl" : ".md";
  const redactedPath = join(redactedDir, `${contentHash.slice(0, 16)}${extension}`);
  writeFileSync(
    redactedPath,
    [
      `# Redacted Watcher Import`,
      ``,
      `Original: ${sourcePath}`,
      `Risk flags: ${scan.riskFlags.join(", ") || "none"}`,
      `Redactions: ${redacted.redactions.join(", ")}`,
      ``,
      finalContent
    ].join("\n"),
    "utf8"
  );
  return {
    path: redactedPath,
    kind: "markdown",
    contentHash,
    trustLevel,
    sensitivity,
    riskFlags: scan.riskFlags,
    redactions: redacted.redactions
  };
}

function startAutoIngestWatcher(
  db: UmosDatabase,
  paths: VaultPaths,
  options: {
    folders?: string[];
    debounceMs?: number;
    profileId?: string;
    recursive?: boolean;
  }
): Record<string, unknown> {
  stopAutoIngestWatcher(paths);
  const profile = resolveWatcherProfile(paths, options.profileId);
  const folders = resolveWatchFolders(paths, options.folders && options.folders.length > 0 ? options.folders : profile?.folders);
  const debounceMs = Math.max(500, Math.min(Number(options.debounceMs ?? 1500), 30000));
  const state: WatchState = {
    watchers: [],
    folders,
    debounceMs,
    running: true,
    startedAt: new Date().toISOString(),
    runCount: 0,
    recursive: Boolean(options.recursive ?? profile?.recursive),
    profileId: profile?.id,
    policy: profile?.policy
  };
  const key = paths.root;
  const schedule = (): void => {
    state.queuedAt = new Date().toISOString();
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      try {
        state.lastRunAt = new Date().toISOString();
        state.lastResult = autoIngestQueue(db, paths, {
          extraFolders: state.folders,
          recursive: state.recursive,
          policy: state.policy,
          profileId: state.profileId
        });
        state.lastError = undefined;
        state.runCount += 1;
        appendWatcherHistory(paths, {
          at: state.lastRunAt,
          profileId: state.profileId,
          folders: state.folders,
          recursive: state.recursive,
          ok: true,
          ingested: Array.isArray(state.lastResult.ingested) ? state.lastResult.ingested.length : 0,
          proposals: Array.isArray(state.lastResult.proposals) ? state.lastResult.proposals.length : 0
        });
        exportStaticApp(db, paths);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        appendWatcherHistory(paths, {
          at: new Date().toISOString(),
          profileId: state.profileId,
          folders: state.folders,
          recursive: state.recursive,
          ok: false,
          ingested: 0,
          proposals: 0,
          error: state.lastError
        });
      }
    }, debounceMs);
  };

  for (const folder of folders) {
    const watcher = watch(folder, { persistent: false }, schedule);
    watcher.on("error", (error) => {
      state.lastError = error.message;
    });
    state.watchers.push(watcher);
  }
  watchStates.set(key, state);
  const persisted = readPersistedWatcherState(paths);
  writePersistedWatcherState(paths, {
    ...persisted,
    running: true,
    folders,
    debounceMs,
    recursive: state.recursive,
    profileId: state.profileId,
    startedAt: state.startedAt,
    stoppedAt: undefined
  });
  return watchStatus(paths);
}

function stopAutoIngestWatcher(paths: VaultPaths): Record<string, unknown> {
  const state = watchStates.get(paths.root);
  if (!state) {
    const persisted = readPersistedWatcherState(paths);
    writePersistedWatcherState(paths, { ...persisted, running: false, stoppedAt: new Date().toISOString() });
    return { running: false, folders: persisted.folders, history: persisted.history };
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  for (const watcher of state.watchers) {
    watcher.close();
  }
  watchStates.delete(paths.root);
  const stoppedAt = new Date().toISOString();
  const persisted = readPersistedWatcherState(paths);
  writePersistedWatcherState(paths, {
    ...persisted,
    running: false,
    folders: state.folders,
    debounceMs: state.debounceMs,
    recursive: state.recursive,
    profileId: state.profileId,
    stoppedAt
  });
  return { running: false, folders: state.folders, stoppedAt, history: persisted.history };
}

function watchStatus(paths: VaultPaths): Record<string, unknown> {
  const persisted = readPersistedWatcherState(paths);
  const state = watchStates.get(paths.root);
  if (!state) {
    return { ...persisted, running: false };
  }
  return {
    running: state.running,
    folders: state.folders,
    debounceMs: state.debounceMs,
    recursive: state.recursive,
    profileId: state.profileId,
    policy: state.policy,
    startedAt: state.startedAt,
    queuedAt: state.queuedAt,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    runCount: Math.max(state.runCount, persisted.runCount ?? 0),
    history: persisted.history
  };
}

function restorePersistedWatcher(db: UmosDatabase, paths: VaultPaths): void {
  const state = readPersistedWatcherState(paths);
  if (!state.running || state.folders.length === 0) {
    return;
  }
  try {
    startAutoIngestWatcher(db, paths, {
      folders: state.folders,
      debounceMs: state.debounceMs,
      profileId: state.profileId,
      recursive: state.recursive
    });
  } catch (error) {
    writePersistedWatcherState(paths, {
      ...state,
      running: false,
      stoppedAt: new Date().toISOString(),
      history: [
        ...(state.history ?? []),
        {
          at: new Date().toISOString(),
          profileId: state.profileId,
          folders: state.folders,
          recursive: state.recursive,
          ok: false,
          ingested: 0,
          proposals: 0,
          error: error instanceof Error ? error.message : String(error)
        }
      ].slice(-50)
    });
  }
}

function resolveWatchFolders(paths: VaultPaths, requestedFolders: string[] | undefined): string[] {
  const workspaceRoot = resolve(paths.root, "..", "..", "..");
  const roots = [resolve(paths.root), workspaceRoot];
  const folders = requestedFolders && requestedFolders.length > 0 ? requestedFolders : [paths.inboxDir];
  return Array.from(
    new Set(
      folders.map((folder) => {
        const resolved = resolve(folder);
        if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`))) {
          throw new Error(`Watch folder is outside approved local roots: ${folder}`);
        }
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          throw new Error(`Watch folder does not exist: ${folder}`);
        }
        return resolved;
      })
    )
  );
}

function listProposalSummaries(db: UmosDatabase, paths: VaultPaths, status: string, filter: string): Array<Record<string, unknown>> {
  const safeStatus = ["pending", "applied", "archived", "rejected", "all"].includes(status) ? status : "pending";
  const rows = (safeStatus === "all"
    ? db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200").all()
    : db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(safeStatus)) as Array<{
    id: string;
    created_at: string;
    status: string;
    kind: string;
    summary: string;
    diff_json: string;
    source_ids_json: string;
    section_ids_json: string;
    space: string;
    trust_level: string;
    sensitivity: string;
  }>;
  return rows
    .map((row) => proposalSummary(db, paths, row))
    .filter((row) => {
      if (filter === "clean") {
        return Number(row.warningCount) === 0 && Number(row.blockedCount) === 0;
      }
      if (filter === "warnings") {
        return Number(row.warningCount) > 0 && Number(row.blockedCount) === 0;
      }
      if (filter === "blocked") {
        return Number(row.blockedCount) > 0;
      }
      return true;
    });
}

function proposalSummary(
  db: UmosDatabase,
  paths: VaultPaths,
  row: {
    id: string;
    created_at: string;
    status: string;
    kind: string;
    summary: string;
    diff_json: string;
    source_ids_json: string;
    section_ids_json: string;
    space: string;
    trust_level: string;
    sensitivity: string;
  }
): Record<string, unknown> {
  let diff: ExtractedMemory = { events: [], facts: [], failures: [] };
  try {
    diff = JSON.parse(row.diff_json) as ExtractedMemory;
  } catch {
    diff = { events: [], facts: [], failures: [] };
  }
  const governor = governProposalDiff(db, diff);
  const extractionReport = latestExtractionReport(paths, row.id);
  const extractionWarnings = extractionReport?.score?.warnings?.length ?? 0;
  const extractionBlocked = extractionReport?.score?.gate?.passed === false ? 1 : 0;
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    kind: row.kind,
    summary: row.summary,
    sourceIds: safeJsonArray(row.source_ids_json),
    sectionIds: safeJsonArray(row.section_ids_json),
    space: row.space,
    trustLevel: row.trust_level,
    sensitivity: row.sensitivity,
    counts: {
      events: diff.events.length,
      facts: diff.facts.length,
      failures: diff.failures.length
    },
    warningCount: governor.warnings.length + extractionWarnings,
    blockedCount: governor.blocked.length + extractionBlocked,
    clean: governor.warnings.length === 0 && governor.blocked.length === 0 && extractionWarnings === 0 && extractionBlocked === 0,
    extractionGate: extractionReport?.score?.gate
  };
}

function latestExtractionReport(paths: VaultPaths, proposalId: string) {
  return listExtractionReports(paths).filter((row) => row.proposalId === proposalId).at(-1);
}

function citationPreview(db: UmosDatabase, id: string): Record<string, unknown> | null {
  const source = db
    .prepare("SELECT id, title, uri, raw_path, captured_at, space, trust_level, sensitivity FROM sources WHERE id = ?")
    .get(id) as
    | {
        id: string;
        title: string | null;
        uri: string;
        raw_path: string;
        captured_at: string;
        space: string;
        trust_level: string;
        sensitivity: string;
      }
    | undefined;
  if (source) {
    const section = db
      .prepare("SELECT heading, body FROM sections WHERE source_id = ? ORDER BY ordinal LIMIT 1")
      .get(id) as { heading: string | null; body: string } | undefined;
    return {
      id,
      type: "source",
      title: source.title ?? source.uri,
      subtitle: source.raw_path,
      capturedAt: source.captured_at,
      space: source.space,
      trustLevel: source.trust_level,
      sensitivity: source.sensitivity,
      markdown: section ? `${section.heading ? `# ${section.heading}\n\n` : ""}${section.body}` : "",
      snippet: snippet(section?.body ?? source.raw_path)
    };
  }

  const section = db
    .prepare(
      "SELECT s.id, s.heading, s.body, s.source_id, s.space, s.trust_level, s.sensitivity, src.title AS source_title FROM sections s LEFT JOIN sources src ON src.id = s.source_id WHERE s.id = ?"
    )
    .get(id) as
    | {
        id: string;
        heading: string | null;
        body: string;
        source_id: string;
        space: string;
        trust_level: string;
        sensitivity: string;
        source_title: string | null;
      }
    | undefined;
  if (section) {
    return {
      id,
      type: "section",
      title: section.heading ?? "Section",
      subtitle: section.source_title ?? section.source_id,
      sourceId: section.source_id,
      space: section.space,
      trustLevel: section.trust_level,
      sensitivity: section.sensitivity,
      markdown: section.body,
      snippet: snippet(section.body)
    };
  }

  const event = db
    .prepare("SELECT id, summary, timestamp, source_ids_json, section_ids_json FROM events WHERE id = ?")
    .get(id) as { id: string; summary: string; timestamp: string; source_ids_json: string; section_ids_json: string } | undefined;
  if (event) {
    return {
      id,
      type: "event",
      title: event.summary,
      subtitle: event.timestamp,
      sourceIds: safeJsonArray(event.source_ids_json),
      sectionIds: safeJsonArray(event.section_ids_json),
      markdown: event.summary,
      snippet: snippet(event.summary)
    };
  }

  const fact = db
    .prepare("SELECT id, subject, predicate, object, confidence, source_ids_json, section_ids_json FROM facts WHERE id = ?")
    .get(id) as
    | { id: string; subject: string; predicate: string; object: string; confidence: number; source_ids_json: string; section_ids_json: string }
    | undefined;
  if (fact) {
    const text = `${fact.subject} ${fact.predicate} ${fact.object}`;
    return {
      id,
      type: "fact",
      title: text,
      subtitle: `confidence ${fact.confidence}`,
      sourceIds: safeJsonArray(fact.source_ids_json),
      sectionIds: safeJsonArray(fact.section_ids_json),
      markdown: text,
      snippet: snippet(text)
    };
  }

  const failure = db
    .prepare("SELECT id, attempted, failed_because, do_not_repeat, source_ids_json, section_ids_json FROM failures WHERE id = ?")
    .get(id) as
    | {
        id: string;
        attempted: string;
        failed_because: string;
        do_not_repeat: string;
        source_ids_json: string;
        section_ids_json: string;
      }
    | undefined;
  if (failure) {
    const text = `Attempted: ${failure.attempted}\nFailed because: ${failure.failed_because}\nDo not repeat: ${failure.do_not_repeat}`;
    return {
      id,
      type: "failure",
      title: failure.attempted,
      subtitle: failure.failed_because,
      sourceIds: safeJsonArray(failure.source_ids_json),
      sectionIds: safeJsonArray(failure.section_ids_json),
      markdown: text,
      snippet: snippet(text)
    };
  }

  return null;
}

function snippet(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 900);
}

function resolveGovernorAction(
  db: UmosDatabase,
  paths: VaultPaths,
  body: { action?: string; winnerId?: string; loserIds?: string[]; factIds?: string[] }
): Record<string, unknown> {
  const now = new Date().toISOString();
  if (body.action === "merge" && body.winnerId) {
    const loserIds = body.loserIds ?? [];
    const targetIds = [body.winnerId, ...loserIds];
    const before = factsSnapshot(db, targetIds);
    const row = db.prepare("SELECT supersedes_json FROM facts WHERE id = ?").get(body.winnerId) as
      | { supersedes_json: string }
      | undefined;
    const existing = row ? safeJsonArray(row.supersedes_json) : [];
    const supersedes = Array.from(new Set([...existing, ...loserIds]));
    db.prepare("UPDATE facts SET supersedes_json = ? WHERE id = ?").run(
      JSON.stringify(supersedes),
      body.winnerId
    );
    if (loserIds.length > 0) {
      const updateLoser = db.prepare("UPDATE facts SET valid_until = ?, review_after = ? WHERE id = ?");
      for (const id of loserIds) {
        updateLoser.run(now, now, id);
      }
    }
    const after = factsSnapshot(db, targetIds);
    const audit = recordGovernorAudit(paths, {
      action: "merge",
      targetIds,
      before,
      after
    });
    return { ok: true, action: "merge", winnerId: body.winnerId, loserIds, audit };
  }

  if (body.action === "mark_stale") {
    const factIds = body.factIds ?? [];
    const before = factsSnapshot(db, factIds);
    const update = db.prepare("UPDATE facts SET review_after = ? WHERE id = ?");
    for (const id of factIds) {
      update.run(now, id);
    }
    const after = factsSnapshot(db, factIds);
    const audit = recordGovernorAudit(paths, {
      action: "mark_stale",
      targetIds: factIds,
      before,
      after
    });
    return { ok: true, action: "mark_stale", factIds, audit };
  }

  if (body.action === "review_later") {
    const factIds = body.factIds ?? [];
    const reviewAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const before = factsSnapshot(db, factIds);
    const update = db.prepare("UPDATE facts SET review_after = ? WHERE id = ?");
    for (const id of factIds) {
      update.run(reviewAt, id);
    }
    const after = factsSnapshot(db, factIds);
    const audit = recordGovernorAudit(paths, {
      action: "review_later",
      targetIds: factIds,
      before,
      after
    });
    return { ok: true, action: "review_later", factIds, reviewAt, audit };
  }

  if (body.action === "keep_both") {
    const audit = recordGovernorAudit(paths, {
      action: "keep_both",
      targetIds: body.factIds ?? [],
      before: [],
      after: []
    });
    return { ok: true, action: "keep_both", audit };
  }

  throw new Error("Unsupported governor action");
}

function writeWorkspaceSummary(db: UmosDatabase, paths: VaultPaths): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const workspaceRoot = resolve(paths.root, "..", "..", "..");
  const memoryPath = join(workspaceRoot, "memory", `${today}.md`);
  const content = existsSync(memoryPath)
    ? readFileSync(memoryPath, "utf8")
    : `# ${today}\n\nNo workspace daily memory file found.`;
  const summaryPath = join(paths.inboxDir, `workspace-summary-${today}.md`);
  writeFileSync(
    summaryPath,
    `# Workspace Summary ${today}\n\nSource: ${memoryPath}\nPolicy: queue-only proposal under NeuraKeep Self-Memory Policy v${selfMemoryPolicy.version}\n\n${content.slice(0, 12000)}\n`,
    "utf8"
  );
  const ingest = ingestFile(db, paths, {
    path: summaryPath,
    kind: "markdown",
    space: "system",
    trustLevel: "observed",
    sourceOrigin: "agent",
    visibility: "private",
    sensitivity: "internal"
  });
  const proposal = ingest.skipped ? null : proposeSourceExtraction(db, ingest.sourceId, { reportPaths: paths });
  return { summaryPath, ingest, proposal, policy: selfMemoryPolicy };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function requireInboxPath(paths: VaultPaths, path: string): string {
  const resolved = resolve(path);
  const inbox = resolve(paths.inboxDir);
  if (!resolved.startsWith(inbox)) {
    throw new Error("Only files inside the NeuraKeep inbox can be ingested from the UI.");
  }
  return resolved;
}

function requireManualImportPath(paths: VaultPaths, path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Manual import file does not exist: ${path}`);
  }
  const workspaceRoot = resolve(paths.root, "..", "..", "..");
  const roots = [resolve(paths.root), workspaceRoot, homedir()].map((root) => resolve(root));
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`))) {
    throw new Error("Manual imports are limited to the workspace, the NeuraKeep vault, or the user home directory.");
  }
  return resolved;
}

function assertWritable(readOnly: boolean, action: string): void {
  if (readOnly) {
    throw new Error(`${action} is disabled in read-only HTTP mode`);
  }
}

function assertLocalFilesystemAccess(options: HttpMcpServerOptions, actor: HostedActor, action: string): void {
  if (options.hosted?.enabled && actor.provider !== "local" && !actor.roles.includes("system")) {
    throw new HttpStatusError(403, `${action} is disabled for hosted accounts; upload the source into your isolated tenant inbox instead.`);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendJsonNoStore(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" });
  res.end(JSON.stringify(value));
}

function sendOAuthError(res: ServerResponse, error: unknown): void {
  const oauth = error instanceof OAuthError ? error : new OAuthError("server_error", "The OAuth request could not be completed.", 500);
  if (oauth.status === 401) res.setHeader("www-authenticate", 'Basic realm="NeuraKeep OAuth"');
  sendJsonNoStore(res, oauth.status, { error: oauth.error, error_description: oauth.message });
}

function sendUnauthorized(res: ServerResponse, req: IncomingMessage, options: HttpMcpServerOptions): void {
  const metadata = `${publicBaseUrl(req, options)}/.well-known/oauth-protected-resource/mcp`;
  res.setHeader("www-authenticate", `Bearer resource_metadata="${metadata}", scope="memory:read memory:propose memory:apply"`);
  sendJson(res, 401, { error: "unauthorized" });
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-neurakeep-tenant,x-neurakeep-space");
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
