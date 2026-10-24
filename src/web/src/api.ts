import type { GraphNode, GraphPayload, GraphState, ProposalDiff, ProposalReview, ProposalSummary } from "./types.js";
import type { GraphOverview, NeighborPage } from "./graph/GraphModel.js";

export interface AuthSettings {
  mode: "local" | "remote";
  provider?: "local" | "managedIdentity" | "service_token";
  tokenRequired: boolean;
  managedIdentityRequired?: boolean;
  readOnly: boolean;
  hasToken: boolean;
  serviceTokenConfigured?: boolean;
  endpoint: string;
  flags?: {
    graph: { engine: "legacy" | "sigma"; universe: boolean };
  };
  hosted?: {
    enabled: boolean;
    authProvider: string;
    managedIdentityProjectId: string | null;
    serviceTokenConfigured?: boolean;
    serviceTokenCount?: number;
    betaAccess?: {
      enabled: boolean;
      allowed: boolean;
      reason: string;
      matched?: string;
      allowlistSize: number;
      allowedDomains?: string[];
      allowedEmailsMasked?: string[];
    };
    tenantId: string;
    spaceId: string;
    roles: string[];
    uid: string;
    email: string | null;
    organizationId?: string | null;
    organizationName?: string | null;
    membershipRole?: string | null;
  };
  user: {
    displayName: string;
    role: "owner" | "operator" | "viewer";
    allowWrites: boolean;
    actor?: Record<string, unknown>;
  };
}

export interface BillingAccess {
  enabled: boolean;
  authenticated: boolean;
  entitled: boolean;
  plan: string;
  status: string;
  email?: string;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  reason: string;
  plans: Array<{
    id: "personal" | "pro" | "team";
    name: string;
    amount: number;
    currency: "usd";
    interval: "month";
    configured: boolean;
  }>;
  launchOffer: { code: string; percentOff: number; months: number; configured: boolean };
}

export class ApiClient {
  private token = localStorage.getItem("neurakeep_token") ?? "";
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapComplete = false;
  private tenantId = localStorage.getItem("neurakeep_tenant") ?? "";
  private spaceId = localStorage.getItem("neurakeep_space") ?? "";

  setToken(token: string): void {
    this.token = token.trim();
    if (this.token) localStorage.setItem("neurakeep_token", this.token);
    else localStorage.removeItem("neurakeep_token");
  }

  getToken(): string {
    return this.token;
  }

  setWorkspace(tenantId = "", spaceId = ""): void {
    this.tenantId = tenantId.trim();
    this.spaceId = spaceId.trim();
    if (this.tenantId) localStorage.setItem("neurakeep_tenant", this.tenantId);
    else localStorage.removeItem("neurakeep_tenant");
    if (this.spaceId) localStorage.setItem("neurakeep_space", this.spaceId);
    else localStorage.removeItem("neurakeep_space");
  }

  getWorkspace(): { tenantId: string; spaceId: string } {
    return { tenantId: this.tenantId, spaceId: this.spaceId };
  }

  async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.ensureBootstrapToken();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.tenantId) headers["x-neurakeep-tenant"] = this.tenantId;
    if (this.spaceId) headers["x-neurakeep-space"] = this.spaceId;
    const response = await fetch(path, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error ?? response.statusText);
    }
    return data as T;
  }

  private async ensureBootstrapToken(): Promise<void> {
    if (this.bootstrapComplete) return;
    this.bootstrapPromise ??= fetch("/api/auth/bootstrap")
      .then(async (response) => {
        if (response.status === 404) {
          this.bootstrapComplete = true;
          return;
        }
        if (!response.ok) throw new Error(`Bootstrap failed with HTTP ${response.status}`);
        const body = (await response.json()) as { token?: unknown };
        if (typeof body.token !== "string" || !body.token) throw new Error("Bootstrap returned no token");
        this.token = body.token;
        this.bootstrapComplete = true;
      })
      .finally(() => {
        this.bootstrapPromise = null;
      });
    try {
      await this.bootstrapPromise;
    } catch (error) {
      // A stored hosted credential can proceed; local requests without a token must fail closed and retry later.
      if (!this.token) throw error;
    }
  }

  async mcp<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.api<{ result?: { structuredContent?: T }; error?: { message?: string } }>("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (result.error) throw new Error(result.error.message ?? "MCP error");
    return (result.result?.structuredContent ?? result.result ?? {}) as T;
  }
}

export const apiClient = new ApiClient();

export async function loadGraph(
  options: { focusId?: string; depth?: number; limit?: number } = {},
): Promise<GraphPayload> {
  const params = new URLSearchParams();
  if (options.focusId) params.set("focus", options.focusId);
  if (options.depth) params.set("depth", String(options.depth));
  if (options.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiClient.api<GraphPayload>(`/api/graph${suffix}`);
}

export async function saveGraphState(state: GraphState): Promise<GraphState> {
  return apiClient.api<GraphState>("/api/graph/state", { method: "POST", body: JSON.stringify(state) });
}

export async function loadGraphState(): Promise<GraphState> {
  return apiClient.api<GraphState>("/api/graph/state");
}

export function loadGraphOverview(clusterBy: string): Promise<GraphOverview> {
  return apiClient.api<GraphOverview>(`/api/graph/overview?clusterBy=${encodeURIComponent(clusterBy)}`);
}

export function loadGraphNeighbors(
  id: string,
  options: { limit?: number; cursor?: string | null; kinds?: string[]; direction?: "both" | "in" | "out" } = {},
): Promise<NeighborPage> {
  const params = new URLSearchParams({ id, limit: String(Math.min(2_000, options.limit ?? 200)) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.kinds?.length) params.set("kinds", options.kinds.join(","));
  if (options.direction) params.set("direction", options.direction);
  return apiClient.api<NeighborPage>(`/api/graph/neighbors?${params.toString()}`);
}

export function locateGraphNodes(query: string, limit = 20): Promise<{ nodes: GraphNode[] }> {
  return apiClient.api<{ nodes: GraphNode[] }>(
    `/api/graph/locate?q=${encodeURIComponent(query)}&limit=${Math.min(100, limit)}`,
  );
}

export async function loadProposal(id: string): Promise<ProposalReview> {
  const data = await apiClient.api<{ proposal: { id: string; summary: string; diff_json: string } }>(
    `/api/proposals/${encodeURIComponent(id)}`,
  );
  const governor = await apiClient.api<ProposalReview["governor"]>(`/api/proposals/${encodeURIComponent(id)}/governor`);
  return {
    proposalId: data.proposal.id,
    summary: data.proposal.summary,
    diff: JSON.parse(data.proposal.diff_json) as ProposalDiff,
    governor,
  };
}

export async function listProposals(status: string, filter: string): Promise<ProposalSummary[]> {
  const data = await apiClient.api<{ proposals: ProposalSummary[] }>(
    `/api/proposals?status=${encodeURIComponent(status)}&filter=${encodeURIComponent(filter)}`,
  );
  return data.proposals;
}

export async function authSettings(): Promise<AuthSettings> {
  return apiClient.api<AuthSettings>("/api/auth/settings");
}

export async function billingStatus(): Promise<BillingAccess> {
  return apiClient.api<BillingAccess>("/api/billing/status");
}

export async function startCheckout(
  plan: "personal" | "pro" | "team",
  offer?: string,
  team?: { organizationName: string; seats: number },
): Promise<{ url: string; sessionId: string; organizationId?: string; spaceId?: string }> {
  return apiClient.api<{ url: string; sessionId: string; organizationId?: string; spaceId?: string }>(
    "/api/billing/checkout",
    {
      method: "POST",
      body: JSON.stringify({ plan, offer, ...team }),
    },
  );
}

export async function openBillingPortal(): Promise<{ url: string }> {
  return apiClient.api<{ url: string }>("/api/billing/portal", { method: "POST", body: "{}" });
}

export interface HostedAccessToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  scopes: Array<"memory:read" | "memory:propose" | "memory:apply">;
  rotationFamilyId?: string;
}

export async function listHostedTokens(): Promise<HostedAccessToken[]> {
  return (await apiClient.api<{ tokens: HostedAccessToken[] }>("/api/hosted/tokens")).tokens;
}

export async function createHostedToken(
  name: string,
  scopes: HostedAccessToken["scopes"],
  expiresInDays: number,
): Promise<HostedAccessToken & { token: string; warning: string }> {
  return apiClient.api<HostedAccessToken & { token: string; warning: string }>("/api/hosted/tokens", {
    method: "POST",
    body: JSON.stringify({ name, scopes, expiresInDays }),
  });
}

export async function rotateHostedToken(
  id: string,
  expiresInDays: number,
): Promise<HostedAccessToken & { token: string; warning: string }> {
  return apiClient.api<HostedAccessToken & { token: string; warning: string }>("/api/hosted/tokens/rotate", {
    method: "POST",
    body: JSON.stringify({ id, expiresInDays }),
  });
}

export async function revokeHostedToken(id: string): Promise<void> {
  await apiClient.api("/api/hosted/tokens/revoke", { method: "POST", body: JSON.stringify({ id }) });
}

export async function completeOAuthAuthorization(
  request: Record<string, string>,
  approved: boolean,
): Promise<{ redirectTo: string }> {
  return apiClient.api<{ redirectTo: string }>("/oauth/authorize/complete", {
    method: "POST",
    body: JSON.stringify({ ...request, approved }),
  });
}

export interface HostedOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  seatCount: number;
  role: "owner" | "admin" | "reviewer" | "editor" | "viewer";
  spaces: Array<{ id: string; name: string; slug: string; status: string }>;
}

export async function listOrganizations(): Promise<HostedOrganization[]> {
  return (await apiClient.api<{ organizations: HostedOrganization[] }>("/api/hosted/organizations")).organizations;
}

export async function acceptInvitation(token: string): Promise<Record<string, unknown>> {
  return apiClient.api("/api/hosted/invitations/accept", { method: "POST", body: JSON.stringify({ token }) });
}

export async function createTeamSpace(name: string): Promise<Record<string, unknown>> {
  return apiClient.api("/api/hosted/team/spaces", { method: "POST", body: JSON.stringify({ name }) });
}

export async function listTeamMembers(): Promise<Array<Record<string, any>>> {
  return (await apiClient.api<{ members: Array<Record<string, any>> }>("/api/hosted/team/members")).members;
}

export async function inviteTeamMember(email: string, role: string): Promise<Record<string, any>> {
  return apiClient.api("/api/hosted/team/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
}

export async function updateTeamMember(userId: string, role: string, revoke = false): Promise<void> {
  await apiClient.api(`/api/hosted/team/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role, revoke }),
  });
}

export async function discoverSsoProviders(
  email: string,
): Promise<Array<{ id: string; type: "saml" | "oidc"; label: string }>> {
  return (
    await apiClient.api<{ providers: Array<{ id: string; type: "saml" | "oidc"; label: string }> }>(
      `/api/auth/sso/providers?email=${encodeURIComponent(email)}`,
    )
  ).providers;
}
