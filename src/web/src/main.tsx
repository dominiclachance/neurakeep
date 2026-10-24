/* eslint-disable react-hooks/rules-of-hooks -- local useToken action is not a React hook */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  apiClient,
  acceptInvitation,
  authSettings,
  billingStatus,
  completeOAuthAuthorization,
  createHostedToken,
  createTeamSpace,
  discoverSsoProviders,
  inviteTeamMember,
  listOrganizations,
  listTeamMembers,
  listHostedTokens,
  listProposals,
  loadGraph,
  loadGraphState,
  loadProposal,
  openBillingPortal,
  revokeHostedToken,
  rotateHostedToken,
  saveGraphState,
  startCheckout,
  updateTeamMember,
  type AuthSettings,
  type BillingAccess,
  type HostedAccessToken,
  type HostedOrganization,
} from "./api.js";
import {
  computeLayout,
  defaultPhysics,
  graphWorldSize,
  type LayoutPoint,
  type PhysicsSettings,
} from "./graphEngine.js";
import { trackCtaEvent } from "./analytics.js";
import { Markdown } from "./markdown.js";
import {
  managedIdentityConfigured,
  signInWithEnterpriseProvider,
  signInWithManagedIdentity,
  signOutOfManagedIdentity,
} from "./managedIdentityAuth.js";
import type {
  GraphEdge,
  GraphNode,
  GraphPayload,
  GraphState,
  ProposalDiff,
  ProposalReview,
  ProposalSummary,
  RouteName,
  Toast,
} from "./types.js";
import "./styles.css";

const SigmaGraphView = React.lazy(() => import("./graph/GraphView.js"));
const UniverseView = React.lazy(() => import("./graph/UniverseView.js"));

const colors: Record<GraphNode["type"], string> = {
  root: "#d6b2ff",
  cluster: "#9a7fd1",
  source: "#4da3ff",
  section: "#6bd78f",
  event: "#f4c84a",
  decision: "#e5a93d",
  fact: "#e7dc79",
  failure: "#ff6b6b",
};

const pinnedSearchPresets = [
  { name: "Failures", query: "do not repeat", filters: { memoryType: "failure", failuresOnly: true } },
  { name: "Decisions", query: "decision direction chosen", filters: { memoryType: "decision", failuresOnly: false } },
  { name: "Promarkia", query: "Promarkia", filters: { project: "Promarkia", failuresOnly: false } },
  { name: "NeuraKeep", query: "NeuraKeep memory graph", filters: { project: "NeuraKeep", failuresOnly: false } },
  {
    name: "Recent",
    query: "recent memory",
    filters: { dateFrom: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10), failuresOnly: false },
  },
] as const;

function App(): React.ReactElement {
  const oauthRequest = useMemo(() => oauthRequestFromLocation(), []);
  const desktopViewport = useDesktopViewport();
  const [route, setRoute] = useState<RouteName>(() => routeFromHash());
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [], state: {} });
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [focusIds, setFocusIds] = useState<Set<string> | null>(null);
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sourceId, setSourceId] = useState("latest");
  const [proposalId, setProposalId] = useState("");
  const [graphDepth, setGraphDepth] = useState(1);
  const [graphLimit, setGraphLimit] = useState(180);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    dateFrom: "",
    dateTo: "",
    project: "",
    sensitivity: "all",
    sourceOrigin: "all",
    memoryType: "all",
    failuresOnly: false,
  });
  const [auth, setAuth] = useState<AuthSettings | null>(null);
  const [billing, setBilling] = useState<BillingAccess | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const modalReturnFocusRef = useRef<HTMLElement | null>(null);
  const [searching, setSearching] = useState(false);

  const closeModal = useCallback(() => {
    setModal(null);
    window.requestAnimationFrame(() => modalReturnFocusRef.current?.focus());
  }, []);

  const toast = useCallback((message: string, type: Toast["type"] = "ok") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((rows) => [...rows, { id, message, type }]);
    window.setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== id)), 3600);
  }, []);

  const refreshGraph = useCallback(
    async (options: { focusId?: string } = {}) => {
      if (auth?.flags?.graph.engine === "sigma") {
        window.dispatchEvent(new Event("neurakeep:graph-change"));
        return;
      }
      const data = await loadGraph({ focusId: options.focusId, depth: graphDepth, limit: graphLimit });
      setGraph(data);
    },
    [auth?.flags?.graph.engine, graphDepth, graphLimit],
  );

  const resetRootGraph = useCallback(async () => {
    const data = await loadGraph({ depth: graphDepth, limit: graphLimit });
    setGraph(rootOverviewPayload(data));
    setFocusIds(null);
    setSelected(null);
    setExpandedBranches(new Set());
  }, [graphDepth, graphLimit]);

  const authenticate = useCallback(async () => {
    setAuthChecking(true);
    try {
      const inviteToken = new URLSearchParams(window.location.search).get("invite");
      if (inviteToken && apiClient.getToken()) {
        const accepted = (await acceptInvitation(inviteToken)) as {
          organization?: { id?: string };
          spaces?: Array<{ id?: string }>;
        };
        if (accepted.organization?.id && accepted.spaces?.[0]?.id)
          apiClient.setWorkspace(accepted.organization.id, accepted.spaces[0].id);
        const cleaned = new URL(window.location.href);
        cleaned.searchParams.delete("invite");
        window.history.replaceState({}, "", cleaned);
      }
      const access = await billingStatus();
      setBilling(access);
      if (!access.entitled) {
        setAuth(null);
        setAuthError("");
        setGraph({ nodes: [], edges: [], state: {} });
        return;
      }
      const next = await authSettings();
      setAuth(next);
      setAuthError("");
      if (next.flags?.graph.engine === "sigma") {
        const state = await loadGraphState();
        setGraph({ nodes: [], edges: [], state });
      } else {
        const data = await loadGraph({ depth: graphDepth, limit: graphLimit });
        setGraph(rootOverviewPayload(data));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Authentication failed";
      setAuth(null);
      setBilling(null);
      setAuthError(message);
      setGraph({ nodes: [], edges: [], state: {} });
      if (!/unauthorized/i.test(message)) toast(message, "error");
    } finally {
      setAuthChecking(false);
    }
  }, [graphDepth, graphLimit, toast]);

  useEffect(() => {
    authenticate().catch((error) => toast(error.message, "error"));
  }, [authenticate, toast]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (route !== "graph" || auth?.flags?.graph.engine === "sigma") return;
    const focusId = localStorage.getItem("neurakeep_graph_focus");
    if (!focusId) return;
    localStorage.removeItem("neurakeep_graph_focus");
    void loadGraph({ focusId, depth: graphDepth, limit: graphLimit })
      .then((payload) => {
        setGraph(payload);
        setSelected(payload.nodes.find((node) => node.id === focusId) ?? null);
      })
      .catch((error: Error) => toast(error.message, "error"));
  }, [auth?.flags?.graph.engine, graphDepth, graphLimit, route, toast]);

  const updateState = useCallback(async (state: GraphState) => {
    const saved = await saveGraphState(state);
    setGraph((current) => ({ ...current, state: saved }));
  }, []);

  const runSearch = async (): Promise<void> => {
    if (!query.trim()) return;
    if (document.activeElement instanceof HTMLElement) modalReturnFocusRef.current = document.activeElement;
    setSearching(true);
    try {
      const params = new URLSearchParams({
        query,
        limit: "20",
        neighbors: "1",
        memoryType: searchFilters.memoryType,
        sensitivity: searchFilters.sensitivity,
        sourceOrigin: searchFilters.sourceOrigin,
        failuresOnly: String(searchFilters.failuresOnly),
      });
      if (searchFilters.dateFrom) params.set("dateFrom", searchFilters.dateFrom);
      if (searchFilters.dateTo) params.set("dateTo", searchFilters.dateTo);
      if (searchFilters.project.trim()) params.set("project", searchFilters.project.trim());
      const data = await apiClient.api<{ results?: SearchResult[]; guidance?: RetrievalGuidance }>(
        `/api/search?${params.toString()}`,
      );
      setModal({
        title: "Search Results",
        body: (
          <SearchResults
            results={data.results ?? []}
            guidance={data.guidance}
            openRecord={openRecord}
            focusNode={focusNode}
          />
        ),
      });
    } finally {
      setSearching(false);
    }
  };

  const applyPinnedSearch = (preset: (typeof pinnedSearchPresets)[number]): void => {
    setQuery(preset.query);
    setSearchFilters((old) => ({
      ...old,
      dateFrom: "dateFrom" in preset.filters ? String(preset.filters.dateFrom ?? "") : old.dateFrom,
      project: "project" in preset.filters ? String(preset.filters.project ?? "") : old.project,
      memoryType: "memoryType" in preset.filters ? String(preset.filters.memoryType ?? old.memoryType) : old.memoryType,
      failuresOnly: Boolean(preset.filters.failuresOnly),
    }));
    setRoute("search");
    window.location.hash = "search";
    toast(`Pinned search loaded: ${preset.name}`);
  };

  const openRecord = async (id: string): Promise<void> => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]'))
      modalReturnFocusRef.current = document.activeElement;
    setModal({ title: id, body: <div className="meta">Loading record...</div> });
    const data = await apiClient.mcp<{ record?: MemoryRecord }>("memory_read", { id });
    const record = data.record;
    setModal({
      title: recordTitle(record, id),
      body: <RecordView record={record} focusNode={focusNode} openRecord={openRecord} />,
    });
  };

  const focusNode = (id: string): void => {
    const ids = new Set<string>([id]);
    for (const edge of graph.edges) {
      if (edge.from === id) ids.add(edge.to);
      if (edge.to === id) ids.add(edge.from);
    }
    setFocusIds(ids);
    setGraph((current) => ({ ...current, state: { ...current.state, mode: "focused" } }));
    setRoute("graph");
    window.location.hash = "graph";
    closeModal();
  };

  const expandNode = async (id: string): Promise<void> => {
    const data = await loadGraph({ focusId: id, depth: graphDepth, limit: graphLimit });
    setGraph((current) => mergeGraphPayload(current, data));
    setFocusIds((old) => new Set([...(old ? Array.from(old) : []), ...data.nodes.map((node) => node.id)]));
    setExpandedBranches((old) => new Set([...Array.from(old), id]));
  };

  const collapseBranch = async (id: string): Promise<void> => {
    const branches = new Set(graph.state.collapsedBranches ?? []);
    if (branches.has(id)) branches.delete(id);
    else branches.add(id);
    const state = { ...graph.state, collapsedBranches: Array.from(branches) };
    setGraph((current) => ({ ...current, state }));
    setExpandedBranches((old) => {
      const next = new Set(old);
      next.delete(id);
      return next;
    });
    await updateState(state);
  };

  const proposeUpdate = async (): Promise<void> => {
    const proposal = await apiClient.mcp<ProposalReview>("memory_propose_update", {
      source_id: sourceId,
      extractor: "deterministic",
    });
    setProposalId(proposal.proposalId);
    toast("Proposal created");
    setRoute("proposals");
    window.location.hash = "proposals";
  };

  const applyCurrentProposal = async (): Promise<void> => {
    if (!proposalId.trim()) return;
    await apiClient.mcp("memory_apply_update", { proposal_id: proposalId.trim() });
    toast("Proposal applied");
    await refreshGraph();
  };

  const logout = useCallback(async () => {
    await signOutOfManagedIdentity().catch(() => null);
    apiClient.setToken("");
    apiClient.setWorkspace();
    setAuth(null);
    setBilling(null);
    setGraph({ nodes: [], edges: [], state: {} });
    setSelected(null);
    setFocusIds(null);
    setExpandedBranches(new Set());
    setAuthError("signed out");
    toast("Signed out");
  }, [toast]);

  const state = graph.state ?? {};

  if (authChecking && !auth && !billing) {
    return <AuthLoading />;
  }

  if (billing?.authenticated && !billing.entitled) {
    return <SubscriptionGate billing={billing} refresh={authenticate} logout={logout} toast={toast} toasts={toasts} />;
  }

  if (!auth) {
    return <AuthGate error={authError} onAuthenticated={authenticate} toast={toast} toasts={toasts} />;
  }

  if (oauthRequest) {
    return <OAuthConsent auth={auth} request={oauthRequest} toast={toast} toasts={toasts} />;
  }

  if (!desktopViewport) {
    return (
      <section className="desktopRequired" data-testid="desktop-required" aria-labelledby="desktop-required-title">
        <img src="/assets/icon.svg" alt="" width="42" height="42" />
        <span>NeuraKeep workspace</span>
        <h1 id="desktop-required-title">Open the app on a desktop</h1>
        <p>The working graph and review tools are designed for a keyboard, pointer, and a screen at least 900px wide.</p>
      </section>
    );
  }

  return (
    <div className="app" data-route={route}>
      <aside>
        <h1 className="appBrand">
          <img src="/assets/icon.svg" alt="" width="30" height="30" />
          <span>NeuraKeep</span>
        </h1>
        <div className="sessionBar">
          <div className="sessionIdentity">
            <b>{sessionLabel(auth)}</b>
            <span>
              {auth.provider ?? "local"} / {auth.readOnly ? "read-only" : "read-write"}
            </span>
          </div>
          <WorkspaceSwitcher
            currentTenant={auth.hosted?.tenantId ?? ""}
            currentSpace={auth.hosted?.spaceId ?? ""}
            refresh={authenticate}
            toast={toast}
          />
          <button
            className="logoutButton"
            onClick={() => {
              trackCtaEvent("hosted_logout_click", { section: "header" });
              logout().catch((error) => toast(error.message, "error"));
            }}
          >
            Log out
          </button>
        </div>
        <nav className="routes" aria-label="Workspace sections">
          {[
            {
              label: "Explore",
              routes: ["graph", ...(auth.flags?.graph.universe ? ["universe" as const] : []), "search"] as RouteName[],
            },
            { label: "Workflow", routes: ["inbox", "proposals", "quality"] as RouteName[] },
            { label: "System", routes: ["connect", "activity", "settings"] as RouteName[] },
          ].map((group) => (
            <React.Fragment key={group.label}>
              <span className="routeGroupLabel">{group.label}</span>
              {group.routes.map((name) => (
                <button
                  key={name}
                  className={route === name ? "active" : ""}
                  onClick={() => {
                    window.location.hash = name;
                    setRoute(name);
                  }}
                >
                  {routeLabel(name)}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        {route === "graph" && auth.flags?.graph.engine !== "sigma" && (
          <RailSection title="Graph">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" />
            <input
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              placeholder="Filter graph nodes/type"
            />
            <select
              value={state.mode ?? "all"}
              onChange={(event) =>
                setGraph((current) => ({ ...current, state: { ...current.state, mode: event.target.value } }))
              }
            >
              <option value="all">All</option>
              <option value="focused">Focused</option>
              <option value="source">Source-centric</option>
              <option value="failures">Failures-only</option>
              <option value="decisions">Decisions-only</option>
            </select>
            <select
              disabled={auth.readOnly}
              value={state.layoutMode ?? "graph"}
              onChange={(event) =>
                void updateState({ ...state, layoutMode: event.target.value as GraphState["layoutMode"] })
              }
            >
              <option value="graph">Graph layout</option>
              <option value="tree">Tree layout</option>
            </select>
            <label>
              Expand depth
              <select value={graphDepth} onChange={(event) => setGraphDepth(Number(event.target.value))}>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
              </select>
            </label>
            <label>
              Visible cap
              <select value={graphLimit} onChange={(event) => setGraphLimit(Number(event.target.value))}>
                <option value={120}>120</option>
                <option value={180}>180</option>
                <option value={260}>260</option>
                <option value={400}>400</option>
              </select>
            </label>
            <select
              value={state.clusterBy ?? "type"}
              onChange={(event) =>
                setGraph((current) => ({
                  ...current,
                  state: { ...current.state, clusterBy: event.target.value as GraphState["clusterBy"] },
                }))
              }
            >
              <option value="type">Cluster by type</option>
              <option value="space">Cluster by space</option>
              <option value="trust">Cluster by trust</option>
              <option value="sensitivity">Cluster by sensitivity</option>
            </select>
            <EdgeControls state={state} setGraph={setGraph} />
            <PhysicsControls state={state} setGraph={setGraph} />
            <div className="compactGrid">
              <button onClick={() => resetRootGraph().then(() => toast("Root overview loaded"))}>Overview</button>
              <button disabled={auth.readOnly} onClick={() => updateState(state).then(() => toast("Graph saved"))}>Save</button>
              <button
                disabled={auth.readOnly || !selected}
                onClick={() => selected && togglePin(selected.id, graph, setGraph, updateState, toast)}
              >
                Pin
              </button>
              <button
                disabled={auth.readOnly || !selected}
                onClick={() => selected && toggleCollapse(selected.id, graph, setGraph, updateState, toast)}
              >
                Collapse
              </button>
            </div>
            <PinnedSearchButtons apply={applyPinnedSearch} />
          </RailSection>
        )}
        {route === "search" && (
          <RailSection title="Search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" />
            <button
              disabled={!query.trim() || searching}
              onClick={() => runSearch().catch((error) => toast(error.message, "error"))}
            >
              {searching ? "Searching..." : "Search Modal"}
            </button>
            <PinnedSearchButtons apply={applyPinnedSearch} />
          </RailSection>
        )}
        {route === "proposals" && (
          <RailSection title="Proposal">
            <input
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              placeholder="source id or latest"
            />
            <button disabled={auth.readOnly} onClick={() => proposeUpdate().catch((error) => toast(error.message, "error"))}>Propose</button>
            <input
              value={proposalId}
              onChange={(event) => setProposalId(event.target.value)}
              placeholder="proposal id"
            />
            <button
              disabled={auth.readOnly || !proposalId.trim()}
              onClick={() => applyCurrentProposal().catch((error) => toast(error.message, "error"))}
            >
              Apply
            </button>
          </RailSection>
        )}
        {route === "settings" && (
          <RailSection title="Auth">
            <input
              defaultValue={apiClient.getToken()}
              placeholder="Bearer token"
              onChange={(event) => apiClient.setToken(event.target.value)}
            />
            <div className="meta">
              {auth
                ? `${auth.mode} / ${auth.readOnly ? "read-only" : "read-write"} / ${auth.user.role}`
                : "Auth loading..."}
            </div>
          </RailSection>
        )}
        {auth.flags?.graph.engine !== "sigma" && (
          <div className="actionLog">
            {graph.nodes.length} / {graph.meta?.totalNodes ?? graph.nodes.length} nodes, {graph.edges.length} /{" "}
            {graph.meta?.totalEdges ?? graph.edges.length} edges
          </div>
        )}
      </aside>
      <main>
        <div className="toolbar">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && runSearch()}
            placeholder="Search memory"
          />
          <button
            className="primary"
            disabled={!query.trim() || searching}
            onClick={() => runSearch().catch((error) => toast(error.message, "error"))}
          >
            {searching ? "Searching..." : "Search"}
          </button>
          <button className="secondary" onClick={closeModal}>
            Clear
          </button>
        </div>
        {route === "graph" && auth.flags?.graph.engine !== "sigma" && (
          <LegacyGraphView
            graph={graph}
            state={state}
            typeFilter={typeFilter}
            focusIds={focusIds}
            selectedId={selected?.id ?? ""}
            onSelect={(node) => {
              setSelected(node);
              expandNode(node.id).catch((error) => toast(error.message, "error"));
              openRecord(node.id).catch((error) => toast(error.message, "error"));
            }}
            onExpandBranch={(id) =>
              expandNode(id)
                .then(() => toast("Branch expanded"))
                .catch((error) => toast(error.message, "error"))
            }
            onCollapseBranch={(id) =>
              collapseBranch(id)
                .then(() => toast("Branch collapsed"))
                .catch((error) => toast(error.message, "error"))
            }
            onResetGraph={() =>
              resetRootGraph()
                .then(() => toast("Root overview loaded"))
                .catch((error) => toast(error.message, "error"))
            }
            onState={updateState}
            expandedBranches={expandedBranches}
            readOnly={auth.readOnly}
          />
        )}
        {route === "graph" && auth.flags?.graph.engine === "sigma" && (
          <React.Suspense fallback={<div className="viewSurface">Loading working graph…</div>}>
            <SigmaGraphView
              state={state}
              openRecord={openRecord}
              toast={toast}
              initialFocusId={selected?.id}
              readOnly={auth.readOnly}
            />
          </React.Suspense>
        )}
        {route === "universe" && auth.flags?.graph.universe && (
          <React.Suspense fallback={<div className="viewSurface">Loading universe…</div>}>
            <UniverseView openRecord={openRecord} toast={toast} readOnly={auth.readOnly} />
          </React.Suspense>
        )}
        {route === "universe" && !auth.flags?.graph.universe && (
          <section className="viewSurface">
            <h2>Universe mode is disabled</h2>
            <p>Enable the graph.universe feature flag, or return to the working graph.</p>
            <button
              onClick={() => {
                window.location.hash = "graph";
                setRoute("graph");
              }}
            >
              Back to working graph
            </button>
          </section>
        )}
        {route === "search" && (
          <SearchView
            query={query}
            setQuery={setQuery}
            runSearch={runSearch}
            searching={searching}
            toast={toast}
            filters={searchFilters}
            setFilters={setSearchFilters}
            readOnly={auth.readOnly}
          />
        )}
        {route === "inbox" && <InboxView toast={toast} refreshGraph={refreshGraph} readOnly={auth.readOnly} />}
        {route === "proposals" && (
          <ProposalsView toast={toast} refreshGraph={refreshGraph} openRecord={openRecord} readOnly={auth.readOnly} />
        )}
        {route === "connect" && <ConnectView toast={toast} />}
        {route === "activity" && <ActivityView toast={toast} />}
        {route === "quality" && (
          <QualityView toast={toast} openRecord={openRecord} refreshGraph={refreshGraph} readOnly={auth.readOnly} />
        )}
        {route === "settings" && <SettingsView auth={auth} billing={billing} setAuth={setAuth} toast={toast} />}
      </main>
      {modal && (
        <Modal title={modal.title} close={closeModal}>
          {modal.body}
        </Modal>
      )}
      <div className="toastStack">
        {toasts.map((row) => (
          <div key={row.id} className={`toast ${row.type ?? ""}`}>
            {row.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const update = (event: MediaQueryListEvent) => setDesktop(event.matches);
    setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return desktop;
}

function LegacyGraphView(props: {
  graph: GraphPayload;
  state: GraphState;
  typeFilter: string;
  focusIds: Set<string> | null;
  selectedId: string;
  onSelect: (node: GraphNode) => void;
  onExpandBranch: (id: string) => void;
  onCollapseBranch: (id: string) => void;
  onResetGraph: () => void;
  onState: (state: GraphState) => Promise<void>;
  expandedBranches: Set<string>;
  readOnly: boolean;
}): React.ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: 900, height: 700 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [drag, setDrag] = useState<{
    id?: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved?: boolean;
  } | null>(null);
  const [dragOverrides, setDragOverrides] = useState<Record<string, LayoutPoint>>({});
  const [workerPositions, setWorkerPositions] = useState<Map<string, LayoutPoint> | null>(null);
  const [viewName, setViewName] = useState("");
  const [savedViews, setSavedViews] = useState<GraphSavedView[]>(() => readGraphViews());
  const [selectedView, setSelectedView] = useState("");
  const layoutKeyRef = useRef("");
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const resize = () => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) setSize({ width: rect.width, height: rect.height });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const filtered = useMemo(() => {
    const modeIds = graphModeIds(props.graph, props.state.mode ?? "all", props.selectedId, props.focusIds);
    const collapsed = new Set(props.state.collapsed ?? []);
    const branchHidden = branchHiddenIds(props.graph, props.state.collapsedBranches ?? []);
    const q = props.typeFilter.toLowerCase();
    const rootOverview = !props.graph.meta?.focusId && !props.selectedId && !props.focusIds;
    return props.graph.nodes.filter((node) => {
      if (collapsed.has(node.id) && !(rootOverview && node.type === "root")) return false;
      if (branchHidden.has(node.id)) return false;
      if (modeIds && !modeIds.has(node.id)) return false;
      if (q && !`${node.label} ${node.type}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [props.graph, props.state, props.typeFilter, props.focusIds, props.selectedId]);

  const filteredIds = useMemo(() => new Set(filtered.map((node) => node.id)), [filtered]);
  const hiddenCounts = useMemo(() => hiddenNeighborCounts(props.graph, filteredIds), [props.graph, filteredIds]);
  const breadcrumb = useMemo(() => graphBreadcrumb(props.graph, props.selectedId), [props.graph, props.selectedId]);
  const layoutMode = props.state.layoutMode ?? "graph";
  const edges = useMemo(() => {
    const edgeTypes = new Set(props.state.edgeTypes ?? ["root", "contains", "cites", "next"]);
    return props.graph.edges.filter(
      (edge) => filteredIds.has(edge.from) && filteredIds.has(edge.to) && edgeTypes.has(edge.type),
    );
  }, [props.graph.edges, props.state.edgeTypes, filteredIds]);
  const graphWorld = useMemo(
    () => graphWorldSize(filtered.length, size.width, size.height),
    [filtered.length, size.width, size.height],
  );
  const treeWorld = useMemo(
    () => treeWorldSize(filtered, edges, size.width, size.height),
    [filtered, edges, size.width, size.height],
  );
  const world = layoutMode === "tree" ? treeWorld : graphWorld;
  const centerWorldView = useCallback(
    () => ({ x: size.width / 2 - world.width / 2, y: size.height / 2 - world.height / 2, scale: 1 }),
    [size.width, size.height, world.width, world.height],
  );

  const syncPositions = useMemo(() => {
    if (layoutMode === "tree") return computeTreeLayout(filtered, edges, world.width, world.height, props.selectedId);
    return filtered.length > 160 ? null : computeLayout(filtered, edges, world.width, world.height, props.state);
  }, [filtered, edges, world, props.state, layoutMode, props.selectedId]);
  useEffect(() => {
    if (layoutMode === "tree" || filtered.length <= 160) {
      setWorkerPositions(null);
      return;
    }
    let cancelled = false;
    try {
      const worker = new Worker(new URL("./graphLayoutWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ positions: Array<[string, LayoutPoint]> }>) => {
        if (!cancelled) setWorkerPositions(new Map(event.data.positions));
        worker.terminate();
      };
      worker.onerror = () => {
        if (!cancelled) setWorkerPositions(computeLayout(filtered, edges, world.width, world.height, props.state));
        worker.terminate();
      };
      worker.postMessage({ nodes: filtered, edges, width: world.width, height: world.height, state: props.state });
      return () => {
        cancelled = true;
        worker.terminate();
      };
    } catch {
      setWorkerPositions(computeLayout(filtered, edges, world.width, world.height, props.state));
    }
  }, [filtered, edges, world, props.state, layoutMode]);
  const positions = useMemo(() => {
    const next = new Map(syncPositions ?? workerPositions ?? new Map<string, LayoutPoint>());
    for (const [id, point] of Object.entries(dragOverrides)) next.set(id, point);
    return next;
  }, [syncPositions, workerPositions, dragOverrides]);

  useEffect(() => {
    const layoutKey = `${layoutMode}:${filtered.map((node) => node.id).join("|")}:${edges.length}:${world.width}x${world.height}`;
    if (layoutKeyRef.current === layoutKey) return;
    layoutKeyRef.current = layoutKey;
    setView(centerWorldView());
  }, [filtered, edges.length, world, centerWorldView]);

  const graphPoint = (event: { clientX: number; clientY: number }): LayoutPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    const x = (event.clientX - (rect?.left ?? 0) - view.x) / view.scale;
    const y = (event.clientY - (rect?.top ?? 0) - view.y) / view.scale;
    return { x, y };
  };

  const saveNode = async (id: string, point: LayoutPoint): Promise<void> => {
    if (props.readOnly) return;
    const pinned = Array.from(new Set([...(props.state.pinned ?? []), id]));
    await props.onState({
      ...props.state,
      pinned,
      layout: { ...(props.state.layout ?? {}), [id]: { ...point, pinned: true } },
    });
  };

  const centerSelected = (): void => {
    const point = positions.get(props.selectedId);
    if (!point) return;
    setView((old) => ({
      ...old,
      x: size.width / 2 - point.x * old.scale,
      y: size.height / 2 - point.y * old.scale,
    }));
  };

  const resetLayout = async (): Promise<void> => {
    setDragOverrides({});
    setView(centerWorldView());
    await props.onState({ ...props.state, layout: {}, pinned: [] });
  };

  const saveNamedView = (): void => {
    const name = viewName.trim() || `View ${savedViews.length + 1}`;
    const next = [
      ...savedViews.filter((item) => item.name !== name),
      { name, view, selectedId: props.selectedId, state: props.state },
    ];
    setSavedViews(next);
    setSelectedView(name);
    setViewName("");
    localStorage.setItem("neurakeep_graph_views", JSON.stringify(next));
  };

  const loadNamedView = (): void => {
    const saved = savedViews.find((item) => item.name === selectedView);
    if (!saved) return;
    setView(saved.view);
    void props.onState(saved.state);
  };

  return (
    <section className="graphWrap">
      <div className="graphControls">
        <button onClick={() => setView((old) => ({ ...old, scale: Math.max(0.35, old.scale / 1.2) }))}>-</button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button onClick={() => setView((old) => ({ ...old, scale: Math.min(4, old.scale * 1.2) }))}>+</button>
        <button
          className={layoutMode === "graph" ? "activeControl" : ""}
          disabled={props.readOnly}
          onClick={() => props.onState({ ...props.state, layoutMode: "graph" })}
        >
          Graph
        </button>
        <button
          className={layoutMode === "tree" ? "activeControl" : ""}
          disabled={props.readOnly}
          onClick={() => props.onState({ ...props.state, layoutMode: "tree" })}
        >
          Tree
        </button>
        <button
          onClick={() => {
            setView(centerWorldView());
            props.onResetGraph();
          }}
        >
          Reset
        </button>
        <button disabled={!props.selectedId} onClick={centerSelected}>
          Center
        </button>
      </div>
      <div className="graphInfoPanel">
        <h2>Legend</h2>
        <div className="legendGrid">
          {Object.entries(colors).map(([type, color]) => (
            <span key={type}>
              <i style={{ background: color }} />
              {type}
            </span>
          ))}
        </div>
        <h2>Node Details</h2>
        {breadcrumb.length > 0 && (
          <div className="breadcrumbs">
            {breadcrumb.map((node, index) => (
              <span key={node.id}>
                {index > 0 ? ">" : ""}
                {node.label}
              </span>
            ))}
          </div>
        )}
        <div className="meta">
          {props.selectedId
            ? `${props.selectedId} selected. Its connected neighborhood is loaded. Drag nodes to pin their position.`
            : "Overview mode shows a bounded set. Click a node to load connected nodes. Drag nodes to pin their position."}
        </div>
        <div className="meta">
          {props.graph.meta
            ? `${props.graph.meta.visibleNodes}/${props.graph.meta.totalNodes} nodes loaded, depth ${props.graph.meta.depth}, cap ${props.graph.meta.limit}${props.graph.meta.truncated ? " (trimmed)" : ""}`
            : `${filtered.length} nodes loaded`}
          . World canvas: {Math.round(world.width)}x{Math.round(world.height)}. Drag blank canvas to pan.
        </div>
        <div className="proposalTools">
          <button
            disabled={props.readOnly || !props.selectedId}
            onClick={() => props.selectedId && props.onExpandBranch(props.selectedId)}
          >
            Expand branch
          </button>
          <button
            disabled={!props.selectedId}
            onClick={() => props.selectedId && props.onExpandBranch(props.selectedId)}
          >
            Show related
          </button>
          <button
            disabled={!props.selectedId}
            onClick={() => props.selectedId && props.onCollapseBranch(props.selectedId)}
          >
            {props.selectedId && props.expandedBranches.has(props.selectedId) ? "Collapse branch" : "Hide branch"}
          </button>
          <button onClick={props.onResetGraph}>Root overview</button>
          <button disabled={props.readOnly} onClick={() => resetLayout().catch(() => null)}>Reset layout</button>
        </div>
      </div>
      <div className="graphSavedPanel">
        <h2>Views</h2>
        <input value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="View name" />
        <button onClick={saveNamedView}>Save view</button>
        <select value={selectedView} onChange={(event) => setSelectedView(event.target.value)}>
          <option value="">Saved views</option>
          {savedViews.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        <button disabled={props.readOnly || !selectedView} onClick={loadNamedView}>
          Load
        </button>
      </div>
      <svg
        ref={svgRef}
        data-testid="graph-svg"
        onWheel={(event) => {
          event.preventDefault();
          const factor = event.deltaY > 0 ? 0.9 : 1.1;
          setView((old) => ({ ...old, scale: Math.max(0.35, Math.min(4, old.scale * factor)) }));
        }}
        onMouseMove={(event) => {
          if (!drag) return;
          if (drag.id) {
            const point = graphPoint(event);
            const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
            if (distance > 4) suppressClickRef.current = true;
            setDrag((current) =>
              current && current.id === drag.id ? { ...current, moved: current.moved || distance > 4 } : current,
            );
            setDragOverrides((current) => ({ ...current, [drag.id!]: point }));
          } else {
            setView((old) => ({
              ...old,
              x: drag.startX + event.clientX - drag.x,
              y: drag.startY + event.clientY - drag.y,
            }));
          }
        }}
        onMouseUp={(event) => {
          if (drag?.id && (drag.moved || suppressClickRef.current))
            void saveNode(drag.id, dragOverrides[drag.id] ?? graphPoint(event));
          setDrag(null);
        }}
        onMouseLeave={() => {
          if (drag?.id && (drag.moved || suppressClickRef.current))
            void saveNode(drag.id, dragOverrides[drag.id] ?? { x: drag.startX, y: drag.startY });
          setDrag(null);
        }}
        onMouseDown={(event) => {
          if (event.target === svgRef.current)
            setDrag({ x: event.clientX, y: event.clientY, startX: view.x, startY: view.y });
        }}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge, index) => {
            const a = positions.get(edge.from);
            const b = positions.get(edge.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${edge.from}-${edge.to}-${index}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`edge ${edge.type}`}
              />
            );
          })}
          {filtered.map((node) => {
            const p = positions.get(node.id);
            if (!p) return null;
            return (
              <g
                key={node.id}
                className={`node ${props.selectedId === node.id ? "selected" : ""}`}
                onPointerDown={(event) => {
                  if (props.readOnly) return;
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  suppressClickRef.current = false;
                  setDrag({ id: node.id, x: event.clientX, y: event.clientY, startX: p.x, startY: p.y });
                }}
                onPointerMove={(event) => {
                  if (drag?.id !== node.id) return;
                  event.stopPropagation();
                  const point = graphPoint(event);
                  const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
                  if (distance > 4) suppressClickRef.current = true;
                  setDrag((current) =>
                    current?.id === node.id ? { ...current, moved: current.moved || distance > 4 } : current,
                  );
                  setDragOverrides((current) => ({ ...current, [node.id]: point }));
                }}
                onPointerUp={(event) => {
                  if (drag?.id !== node.id) return;
                  event.stopPropagation();
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  const moved = drag.moved || suppressClickRef.current;
                  if (moved) void saveNode(node.id, dragOverrides[node.id] ?? graphPoint(event));
                  setDrag(null);
                }}
                onPointerCancel={(event) => {
                  if (drag?.id !== node.id) return;
                  event.stopPropagation();
                  setDrag(null);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  props.onSelect(node);
                }}
              >
                <circle className="hit" cx={p.x} cy={p.y} r={15} />
                <circle cx={p.x} cy={p.y} r={8} fill={colors[node.type]} />
                <text x={p.x + 12} y={p.y + 4}>
                  {node.label.length > 28 ? `${node.label.slice(0, 27)}...` : node.label}
                </text>
                {(hiddenCounts.get(node.id) ?? 0) > 0 && (
                  <text className="hiddenBadge" x={p.x - 10} y={p.y - 13}>
                    +{hiddenCounts.get(node.id)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}

function ProposalsView({
  toast,
  refreshGraph,
  openRecord,
  readOnly,
}: {
  toast: (message: string, type?: Toast["type"]) => void;
  refreshGraph: () => Promise<void>;
  openRecord: (id: string) => Promise<void>;
  readOnly: boolean;
}): React.ReactElement {
  const [status, setStatus] = useState("pending");
  const [filter, setFilter] = useState("all");
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [review, setReview] = useState<ProposalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [groups, setGroups] = useState<
    Array<{
      key: string;
      label: string;
      ids: string[];
      count: number;
      clean: number;
      warnings: number;
      blocked: number;
    }>
  >([]);
  const [triage, setTriage] = useState<Record<string, any> | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setProposals(await listProposals(status, filter));
      const groupData = await apiClient.api<{ groups: typeof groups }>("/api/proposals/groups");
      setGroups(groupData.groups);
    } finally {
      setLoading(false);
    }
  }, [status, filter]);
  useEffect(() => {
    reload().catch((error) => toast(error.message, "error"));
  }, [reload, toast]);

  const setStatusFor = async (id: string, next: string): Promise<void> => {
    await apiClient.api(`/api/proposals/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify({ status: next }),
    });
    toast(`Proposal ${next}`);
    await reload();
  };
  const selectedList = () =>
    Object.entries(selectedIds)
      .filter(([, value]) => value)
      .map(([id]) => id);
  const bulkStatus = async (next: "archived" | "rejected"): Promise<void> => {
    const ids = selectedList();
    if (ids.length === 0) {
      toast("Select at least one proposal first.", "error");
      return;
    }
    await apiClient.api("/api/proposals/bulk-status", { method: "POST", body: JSON.stringify({ ids, status: next }) });
    setSelectedIds({});
    toast(`${ids.length} proposals ${next}`);
    await reload();
  };
  const applySelectedClean = async (): Promise<void> => {
    const cleanIds = proposals
      .filter((row) => selectedIds[row.id] && row.status === "pending" && row.clean)
      .map((row) => row.id);
    if (cleanIds.length === 0) {
      toast("No selected clean pending proposals to apply.", "error");
      return;
    }
    for (const id of cleanIds) {
      await apiClient.api(`/api/proposals/${encodeURIComponent(id)}/apply`, { method: "POST", body: "{}" });
    }
    setSelectedIds({});
    toast(`${cleanIds.length} clean proposals applied`);
    await refreshGraph();
    await reload();
  };
  const archiveDuplicates = async (): Promise<void> => {
    const result = await apiClient.api<{ archived: string[] }>("/api/proposals/archive-duplicates", {
      method: "POST",
      body: "{}",
    });
    toast(`${result.archived.length} duplicate proposals archived`);
    await reload();
  };
  const applyHighValueClean = async (): Promise<void> => {
    const result = await apiClient.api<{ applied: string[]; skipped: unknown[] }>(
      "/api/proposals/apply-high-value-clean",
      { method: "POST", body: JSON.stringify({ limit: 25 }) },
    );
    toast(
      `Applied ${result.applied.length} clean high-value proposals${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`,
    );
    await refreshGraph();
    await reload();
  };
  const triageWarnings = async (archive: boolean): Promise<void> => {
    const result = await apiClient.api<Record<string, any>>("/api/proposals/triage-noisy", {
      method: "POST",
      body: JSON.stringify({ archive, limit: 50 }),
    });
    setTriage(result);
    toast(
      archive
        ? `Archived ${result.archived?.length ?? 0} noisy warning proposals`
        : `Reviewed ${result.totalWarnings ?? 0} warning proposals`,
    );
    await reload();
  };

  return (
    <section className="viewSurface">
      <h2>Proposal Inbox</h2>
      <div className="filters">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="pending">pending</option>
          <option value="all">all</option>
          <option value="applied">applied</option>
          <option value="archived">archived</option>
          <option value="rejected">rejected</option>
        </select>
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">all</option>
          <option value="clean">clean</option>
          <option value="warnings">warnings</option>
          <option value="blocked">blocked</option>
        </select>
      </div>
      <div className="viewCard cleanupCard">
        <h3>Bulk Review</h3>
        <div className="proposalTools">
          <button onClick={() => setSelectedIds(Object.fromEntries(proposals.map((row) => [row.id, true])))}>
            Select page
          </button>
          <button
            onClick={() =>
              setSelectedIds(
                Object.fromEntries(
                  proposals.filter((row) => row.clean && row.status === "pending").map((row) => [row.id, true]),
                ),
              )
            }
          >
            Select clean
          </button>
          <button onClick={() => setSelectedIds({})}>Clear</button>
          <button disabled={readOnly} onClick={() => applySelectedClean().catch((error) => toast(error.message, "error"))}>
            Apply selected clean
          </button>
          <button disabled={readOnly} onClick={() => bulkStatus("archived").catch((error) => toast(error.message, "error"))}>
            Archive selected
          </button>
          <button disabled={readOnly} onClick={() => bulkStatus("rejected").catch((error) => toast(error.message, "error"))}>
            Reject selected
          </button>
          <button disabled={readOnly} onClick={() => archiveDuplicates().catch((error) => toast(error.message, "error"))}>
            Archive duplicates
          </button>
          <button disabled={readOnly} onClick={() => applyHighValueClean().catch((error) => toast(error.message, "error"))}>
            Apply clean high-value
          </button>
          <button disabled={readOnly} onClick={() => triageWarnings(false).catch((error) => toast(error.message, "error"))}>
            Preview noisy warnings
          </button>
          <button disabled={readOnly} onClick={() => triageWarnings(true).catch((error) => toast(error.message, "error"))}>
            Archive noisy warnings
          </button>
        </div>
        <div className="groupGrid">
          {groups.slice(0, 10).map((group) => (
            <button
              className="groupButton"
              key={group.key}
              onClick={() => setSelectedIds(Object.fromEntries(group.ids.map((id) => [id, true])))}
            >
              <b>{group.label}</b>
              <span>
                {group.count} total / {group.clean} clean / {group.warnings} warnings / {group.blocked} blocked
              </span>
            </button>
          ))}
        </div>
        {triage && (
          <div className="triagePreview">
            <div className="chips">
              <span>{triage.noisy?.length ?? 0} noisy</span>
              <span>{triage.keepForReview?.length ?? 0} keep for review</span>
              <span>{triage.archived?.length ?? 0} archived</span>
            </div>
            {(triage.keepForReview ?? []).slice(0, 6).map((row: Record<string, unknown>) => (
              <div className="result" key={String(row.id)}>
                <b>Review: {String(row.summary)}</b>
                <div className="meta">
                  {String(row.warningCount)} warnings / {String(row.blockedCount)} blocked
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <table className="viewTable">
        <thead>
          <tr>
            <th>Select</th>
            <th>Proposal</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={4} className="meta">
                Loading proposals...
              </td>
            </tr>
          )}
          {!loading && proposals.length === 0 && (
            <tr>
              <td colSpan={4} className="meta">
                No proposals match this filter. Ingestion and self-memory will queue new proposals here for review.
              </td>
            </tr>
          )}
          {proposals.map((row) => (
            <tr key={row.id}>
              <td>
                <input
                  type="checkbox"
                  checked={Boolean(selectedIds[row.id])}
                  onChange={(event) => setSelectedIds((old) => ({ ...old, [row.id]: event.target.checked }))}
                />
              </td>
              <td>
                <b>{row.summary}</b>
                <div className="meta">
                  {row.id} / {row.createdAt}
                </div>
                <div className="chips">
                  <span>{row.counts.events} events</span>
                  <span>{row.counts.facts} facts</span>
                  <span>{row.counts.failures} failures</span>
                  <span>{row.warningCount} warnings</span>
                  <span>{row.blockedCount} blocked</span>
                </div>
              </td>
              <td>{row.status}</td>
              <td className="rowActions">
                <button
                  onClick={() =>
                    loadProposal(row.id)
                      .then(setReview)
                      .catch((error) => toast(error.message, "error"))
                  }
                >
                  Review
                </button>
                <button
                  disabled={readOnly || row.status !== "pending" || !row.clean || row.blockedCount > 0}
                  title={row.clean ? "Apply this clean pending proposal." : "Review warnings before applying."}
                  onClick={() =>
                    apiClient
                      .api(`/api/proposals/${encodeURIComponent(row.id)}/apply`, { method: "POST", body: "{}" })
                      .then(refreshGraph)
                      .then(reload)
                      .then(() => toast("Clean proposal applied"))
                      .catch((error) => toast(error.message, "error"))
                  }
                >
                  Apply clean
                </button>
                <button
                  disabled={readOnly}
                  onClick={() => setStatusFor(row.id, "archived").catch((error) => toast(error.message, "error"))}
                >
                  Archive
                </button>
                <button
                  disabled={readOnly}
                  onClick={() => setStatusFor(row.id, "rejected").catch((error) => toast(error.message, "error"))}
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {review && (
        <ProposalReviewer
          proposal={review}
          toast={toast}
          refreshGraph={refreshGraph}
          openRecord={openRecord}
          readOnly={readOnly}
          afterApply={() => {
            setReview(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function ProposalReviewer({
  proposal,
  toast,
  refreshGraph,
  openRecord,
  afterApply,
  readOnly,
}: {
  proposal: ProposalReview;
  toast: (message: string, type?: Toast["type"]) => void;
  refreshGraph: () => Promise<void>;
  openRecord: (id: string) => Promise<void>;
  afterApply: () => void;
  readOnly: boolean;
}): React.ReactElement {
  const [diff, setDiff] = useState<ProposalDiff>(proposal.diff);
  const [selected, setSelected] = useState(() => selectedMap(proposal.diff, true));
  const original = proposal.diff;
  const governorItems = [...(proposal.governor?.warnings ?? []), ...(proposal.governor?.blocked ?? [])];

  useEffect(() => {
    setDiff(proposal.diff);
    setSelected(selectedMap(proposal.diff, true));
  }, [proposal]);

  const applySelected = async (): Promise<void> => {
    const reviewed = filterDiff(diff, selected);
    if (countItems(reviewed) === 0) {
      toast("Select at least one proposal item before applying.", "error");
      return;
    }
    await apiClient.api(`/api/proposals/${encodeURIComponent(proposal.proposalId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ diff: reviewed }),
    });
    toast("Reviewed proposal applied");
    await refreshGraph();
    afterApply();
  };

  return (
    <div className="reviewer" data-testid="proposal-reviewer">
      <h2>Review Proposal</h2>
      <div className="chips">
        <span>{proposal.proposalId}</span>
        <span>{proposal.governor?.warnings.length ?? 0} warnings</span>
        <span>{proposal.governor?.blocked.length ?? 0} blocked</span>
      </div>
      <ProposalReviewSummary diff={diff} selected={selected} warnings={governorItems} />
      <div className="proposalTools">
        <button onClick={() => setSelected(selectedMap(diff, true))}>Select all</button>
        <button onClick={() => setSelected(selectedMap(diff, false))}>Select none</button>
        <button onClick={() => setSelected(cleanSelected(diff, governorItems))}>Select clean</button>
        <button
          disabled={readOnly}
          onClick={() =>
            apiClient
              .api(`/api/proposals/${encodeURIComponent(proposal.proposalId)}/save`, {
                method: "POST",
                body: JSON.stringify({ diff }),
              })
              .then(() => toast("Review saved"))
              .catch((error) => toast(error.message, "error"))
          }
        >
          Save
        </button>
        <button disabled={readOnly} onClick={() => applySelected().catch((error) => toast(error.message, "error"))}>Apply selected</button>
      </div>
      <DiffPreview original={original} current={diff} />
      <ReviewTable
        title="Events"
        kind="events"
        rows={diff.events}
        selected={selected}
        setSelected={setSelected}
        update={(rows) => setDiff({ ...diff, events: rows })}
        warnings={governorItems}
        openRecord={openRecord}
      />
      <ReviewTable
        title="Facts"
        kind="facts"
        rows={diff.facts}
        selected={selected}
        setSelected={setSelected}
        update={(rows) => setDiff({ ...diff, facts: rows })}
        warnings={governorItems}
        openRecord={openRecord}
      />
      <ReviewTable
        title="Failures"
        kind="failures"
        rows={diff.failures}
        selected={selected}
        setSelected={setSelected}
        update={(rows) => setDiff({ ...diff, failures: rows })}
        warnings={governorItems}
        openRecord={openRecord}
      />
    </div>
  );
}

function ProposalReviewSummary({
  diff,
  selected,
  warnings,
}: {
  diff: ProposalDiff;
  selected: Record<string, boolean>;
  warnings: Array<{ severity?: string; itemId: string; message: string }>;
}): React.ReactElement {
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const total = countItems(diff);
  const citationCount = (["events", "facts", "failures"] as Array<keyof ProposalDiff>)
    .flatMap((kind) => diff[kind])
    .reduce((count, row) => count + new Set([...(row.sourceIds ?? []), ...(row.sectionIds ?? [])]).size, 0);
  const blocked = warnings.filter((warning) => warning.severity === "block").length;
  return (
    <div className="reviewSummary">
      <div className="metric">
        <b>{selectedCount}</b>
        <span>accepted</span>
      </div>
      <div className="metric">
        <b>{total - selectedCount}</b>
        <span>skipped</span>
      </div>
      <div className="metric">
        <b>{citationCount}</b>
        <span>citations</span>
      </div>
      <div className={blocked ? "metric warningMetric" : "metric"}>
        <b>{warnings.length}</b>
        <span>{blocked ? "needs review" : "warnings"}</span>
      </div>
    </div>
  );
}

function ReviewTable({
  title: titleText,
  kind,
  rows,
  selected,
  setSelected,
  update,
  warnings,
  openRecord,
}: {
  title: string;
  kind: keyof ProposalDiff;
  rows: Array<Record<string, any>>;
  selected: Record<string, boolean>;
  setSelected: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  update: (rows: any[]) => void;
  warnings: Array<{ severity?: string; itemId: string; message: string }>;
  openRecord: (id: string) => Promise<void>;
}): React.ReactElement {
  const bulkPrefix = `${kind}:`;
  return (
    <div className="reviewBlock">
      <h3>{titleText}</h3>
      <table className="viewTable">
        <tbody>
          {rows.map((row, index) => {
            const key = `${kind}:${index}`;
            const warning = warnings.find((item) => item.itemId === row.id);
            const accepted = selected[key] ?? true;
            return (
              <tr key={key}>
                <td>
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setSelected((old) => ({ ...old, [key]: event.target.checked }))}
                  />
                  <div className={accepted ? "acceptState" : "skipState"}>{accepted ? "Accept" : "Skip"}</div>
                </td>
                <td>
                  {Object.entries(row)
                    .filter(([field]) => !["sourceIds", "sectionIds", "id"].includes(field))
                    .map(([field, value]) => (
                      <label key={field}>
                        {field}
                        {String(value ?? "").length > 80 ? (
                          <textarea
                            value={String(value ?? "")}
                            onChange={(event) =>
                              update(
                                rows.map((item, rowIndex) =>
                                  rowIndex === index ? { ...item, [field]: event.target.value } : item,
                                ) as never[],
                              )
                            }
                          />
                        ) : (
                          <input
                            value={String(value ?? "")}
                            onChange={(event) =>
                              update(
                                rows.map((item, rowIndex) =>
                                  rowIndex === index ? { ...item, [field]: event.target.value } : item,
                                ) as never[],
                              )
                            }
                          />
                        )}
                      </label>
                    ))}
                  {warning && (
                    <div className="warn">
                      <b>{warning.severity === "block" ? "Blocked" : "Warning"}</b>
                      <p>{plainWarning(warning.message)}</p>
                    </div>
                  )}
                </td>
                <td>
                  <div className="meta">Citations</div>
                  <CitationButtons
                    ids={[...((row.sourceIds as string[]) ?? []), ...((row.sectionIds as string[]) ?? [])]}
                    openRecord={openRecord}
                  />
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td className="meta">No {bulkPrefix.slice(0, -1)} items.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DiffPreview({ original, current }: { original: ProposalDiff; current: ProposalDiff }): React.ReactElement {
  const before = countItems(original);
  const after = countItems(current);
  return (
    <div className="diffPreview">
      <b>Diff preview</b>
      <span>{before} original items</span>
      <span>{after} current items</span>
      <span>
        {after - before >= 0 ? "+" : ""}
        {after - before} net
      </span>
    </div>
  );
}

function SearchView({
  query,
  setQuery,
  runSearch,
  searching,
  toast,
  filters,
  setFilters,
  readOnly,
}: {
  query: string;
  setQuery: (value: string) => void;
  runSearch: () => Promise<void>;
  searching: boolean;
  toast: (message: string, type?: Toast["type"]) => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  readOnly: boolean;
}): React.ReactElement {
  const [presets, setPresets] = useState<Array<{ name: string; query: string; filters: SearchFilters }>>([]);
  const [presetName, setPresetName] = useState("");
  useEffect(() => {
    apiClient
      .api<{ presets: Array<{ name: string; query: string; filters: SearchFilters }> }>("/api/search/presets")
      .then((data) => setPresets(data.presets))
      .catch(() => null);
  }, []);
  const set = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) =>
    setFilters((old) => ({ ...old, [key]: value }));
  const savePreset = async (): Promise<void> => {
    const name = presetName.trim() || query.trim();
    if (!name) {
      toast("Name the preset first.", "error");
      return;
    }
    const result = await apiClient.api<{ presets: Array<{ name: string; query: string; filters: SearchFilters }> }>(
      "/api/search/presets",
      {
        method: "POST",
        body: JSON.stringify({ name, query, filters }),
      },
    );
    setPresets(result.presets);
    setPresetName("");
    toast("Search preset saved");
  };
  const applyPreset = (name: string): void => {
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    setQuery(preset.query);
    setFilters({ ...filters, ...(preset.filters ?? {}) });
    toast(`Preset loaded: ${preset.name}`);
  };
  return (
    <section className="viewSurface">
      <h2>Search</h2>
      <div className="viewCard">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && runSearch().catch((error) => toast(error.message, "error"))}
        />
        <div className="searchPresetBar">
          <select defaultValue="" onChange={(event) => applyPreset(event.target.value)}>
            <option value="" disabled>
              saved presets
            </option>
            {presets.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </select>
          <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Preset name" />
          <button disabled={readOnly} onClick={() => savePreset().catch((error) => toast(error.message, "error"))}>
            Save preset
          </button>
        </div>
        <div className="searchFilters">
          <label>
            From
            <input type="date" value={filters.dateFrom} onChange={(event) => set("dateFrom", event.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={filters.dateTo} onChange={(event) => set("dateTo", event.target.value)} />
          </label>
          <label>
            Project
            <input
              value={filters.project}
              onChange={(event) => set("project", event.target.value)}
              placeholder="optional"
            />
          </label>
          <label>
            Sensitivity
            <select value={filters.sensitivity} onChange={(event) => set("sensitivity", event.target.value)}>
              <option value="all">all</option>
              <option value="normal">normal</option>
              <option value="internal">internal</option>
              <option value="confidential">confidential</option>
              <option value="secret">secret</option>
            </select>
          </label>
          <label>
            Origin
            <select value={filters.sourceOrigin} onChange={(event) => set("sourceOrigin", event.target.value)}>
              <option value="all">all</option>
              <option value="manual">manual</option>
              <option value="agent">agent</option>
              <option value="session">session</option>
              <option value="import">import</option>
              <option value="connector">connector</option>
              <option value="system">system</option>
            </select>
          </label>
          <label>
            Type
            <select value={filters.memoryType} onChange={(event) => set("memoryType", event.target.value)}>
              <option value="all">all</option>
              <option value="source">source</option>
              <option value="decision">decision</option>
              <option value="failure">failure</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.failuresOnly}
              onChange={(event) => set("failuresOnly", event.target.checked)}
            />
            failures only
          </label>
        </div>
        <button
          disabled={!query.trim() || searching}
          onClick={() => runSearch().catch((error) => toast(error.message, "error"))}
        >
          {searching ? "Searching..." : "Open Search Modal"}
        </button>
        <p className="meta">
          Results stay in a modal so the graph area remains available. Use failures-only for "don't repeat this mistake"
          searches.
        </p>
      </div>
    </section>
  );
}

function InboxView({
  toast,
  refreshGraph,
  readOnly,
}: {
  toast: (message: string, type?: Toast["type"]) => void;
  refreshGraph: () => Promise<void>;
  readOnly: boolean;
}): React.ReactElement {
  const [files, setFiles] = useState<
    Array<{
      name: string;
      path: string;
      kind: string;
      bytes: number;
      riskFlags?: string[];
      trustHint?: string;
      sourceHint?: string;
    }>
  >([]);
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [manualPath, setManualPath] = useState("");
  const [manualKind, setManualKind] = useState("auto");
  const [dragging, setDragging] = useState(false);
  const [ocrHealth, setOcrHealth] = useState<Record<string, any> | null>(null);
  const [importSupport, setImportSupport] = useState<Record<string, any> | null>(null);
  const [pasteTitle, setPasteTitle] = useState("pasted-memory.md");
  const [pasteText, setPasteText] = useState("");
  const [lastImport, setLastImport] = useState<Record<string, any> | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setFiles((await apiClient.api<{ files: typeof files }>("/api/inbox")).files);
      setStatus(await apiClient.api("/api/watch/status"));
      setOcrHealth(await apiClient.api("/api/import/ocr-health"));
      setImportSupport(await apiClient.api("/api/import/supported"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload().catch((error) => toast(error.message, "error"));
  }, [reload, toast]);
  const importManual = async (): Promise<void> => {
    await apiClient.api("/api/import", {
      method: "POST",
      body: JSON.stringify({ path: manualPath, kind: manualKind }),
    });
    setManualPath("");
    await refreshGraph();
    await reload();
    toast("Manual memory imported and queued for proposal review");
  };
  const uploadFiles = async (fileList: FileList | File[]): Promise<void> => {
    const items = Array.from(fileList).slice(0, 6);
    for (const file of items) {
      const contentBase64 = await fileToBase64(file);
      await apiClient.api("/api/import/upload", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, kind: manualKind, contentBase64 }),
      });
    }
    await refreshGraph();
    await reload();
    toast(`${items.length} file${items.length === 1 ? "" : "s"} uploaded and queued for review`);
  };
  const importPastedMemory = async (): Promise<void> => {
    if (!pasteText.trim()) {
      toast("Paste memory text first.", "error");
      return;
    }
    const result = await apiClient.api<Record<string, any>>("/api/import/upload", {
      method: "POST",
      body: JSON.stringify({
        fileName: pasteTitle.trim() || "pasted-memory.md",
        kind: pasteTitle.toLowerCase().endsWith(".txt") ? "note" : "markdown",
        contentBase64: textToBase64(pasteText),
      }),
    });
    setPasteText("");
    setLastImport(result);
    await refreshGraph();
    await reload();
    toast(result.proposal?.proposalId ? "Pasted memory queued for proposal review" : "Pasted memory indexed");
  };
  const importSample = async (): Promise<void> => {
    trackCtaEvent("demo_sample_import_click", { section: "inbox" });
    const result = await apiClient.api<{ proposal?: { proposalId?: string } }>("/api/onboarding/sample-memory", {
      method: "POST",
      body: "{}",
    });
    await refreshGraph();
    await reload();
    toast(
      result.proposal?.proposalId ? "Sample memory imported and queued for review" : "Sample memory already indexed",
    );
  };
  return (
    <section className="viewSurface">
      <h2>Inbox</h2>
      <div className="viewGrid">
        <div className="viewCard importWizard">
          <h3>Memory Import Wizard</h3>
          <div className="wizardSteps">
            <span className="ready">1. Add source</span>
            <span className={pasteText.trim() || files.length ? "ready" : ""}>2. Index raw memory</span>
            <span className={lastImport?.proposal ? "ready" : ""}>3. Review proposal</span>
            <span>4. Apply selected facts</span>
          </div>
          <label>
            Title
            <input
              value={pasteTitle}
              onChange={(event) => setPasteTitle(event.target.value)}
              placeholder="customer-notes.md"
            />
          </label>
          <label>
            Paste memory
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={8}
              placeholder="Paste notes, decisions, failed paths, or session summary..."
            />
          </label>
          <div className="proposalTools">
            <button
              disabled={readOnly || !pasteText.trim()}
              onClick={() => importPastedMemory().catch((error) => toast(error.message, "error"))}
            >
              Queue pasted memory
            </button>
            <button disabled={readOnly} onClick={() => importSample().catch((error) => toast(error.message, "error"))}>
              Import first-run sample
            </button>
          </div>
          {lastImport && (
            <div className="result">
              <b>Queued</b>
              <div className="meta">
                Source: {String(lastImport.ingest?.sourceId ?? lastImport.uploadPath ?? "indexed")} / Proposal:{" "}
                {String(lastImport.proposal?.proposalId ?? "none")}
              </div>
            </div>
          )}
        </div>
        <div className="viewCard">
          <h3>Manual Import</h3>
          <div className="meta">
            Import a local markdown, text, session JSONL, or PDF from the workspace, vault, or your home folder.
          </div>
          <div
            className={`dropZone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (readOnly) return;
              void uploadFiles(event.dataTransfer.files).catch((error) => toast(error.message, "error"));
            }}
          >
            <b>Drop PDFs or notes here</b>
            <span>Files are copied to the local inbox, indexed, and queued as proposals.</span>
            <input
              type="file"
              disabled={readOnly}
              multiple
              accept=".pdf,.md,.txt,.jsonl"
              onChange={(event) =>
                event.target.files && uploadFiles(event.target.files).catch((error) => toast(error.message, "error"))
              }
            />
          </div>
          <label>
            File path
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="C:\\Users\\macro\\Downloads\\paper.pdf"
            />
          </label>
          <label>
            Kind
            <select value={manualKind} onChange={(event) => setManualKind(event.target.value)}>
              <option value="auto">auto</option>
              <option value="markdown">markdown</option>
              <option value="note">note</option>
              <option value="session">session</option>
              <option value="pdf">pdf</option>
            </select>
          </label>
          <button
            disabled={readOnly || !manualPath.trim()}
            onClick={() => importManual().catch((error) => toast(error.message, "error"))}
          >
            Import Memory
          </button>
          <button
            disabled={readOnly}
            onClick={() =>
              apiClient
                .api<{ ingested: unknown[]; skipped: unknown[] }>("/api/memory/sync", { method: "POST", body: "{}" })
                .then((result) =>
                  refreshGraph()
                    .then(reload)
                    .then(() => toast(`Memory sync: ${result.ingested.length} new, ${result.skipped.length} skipped`)),
                )
                .catch((error) => toast(error.message, "error"))
            }
          >
            Sync workspace memory
          </button>
        </div>
        <div className="viewCard">
          <h3>First-Run Sample</h3>
          <div className="meta">
            Creates a small source-cited sample and queues a proposal so a new account has something to review and
            search immediately.
          </div>
          <button disabled={readOnly} onClick={() => importSample().catch((error) => toast(error.message, "error"))}>
            Import sample memory
          </button>
        </div>
        <ImportSupportCard support={importSupport} />
        <OcrHealthCard health={ocrHealth} />
        <div className="viewCard">
          <h3>Files</h3>
          {loading && <div className="meta">Loading inbox...</div>}
          {!loading && files.length === 0 && (
            <div className="meta">
              No inbox files waiting. Watchers and self-memory summaries queue proposals here before anything becomes
              durable.
            </div>
          )}
          {files.map((file) => (
            <div className="result" key={file.path}>
              <b>{file.name}</b>
              <div className="meta">{file.path}</div>
              <div className="chips">
                <span>{file.kind}</span>
                <span>{Math.round(file.bytes / 1024)} KB</span>
                <span>{file.sourceHint ?? "inbox"}</span>
                <span>{file.trustHint ?? "normal"}</span>
                {(file.riskFlags ?? []).map((flag) => (
                  <span className="warnChip" key={flag}>
                    {flag}
                  </span>
                ))}
              </div>
              <button
                disabled={readOnly}
                onClick={() =>
                  apiClient
                    .api("/api/ingest", { method: "POST", body: JSON.stringify({ path: file.path, kind: file.kind }) })
                    .then(refreshGraph)
                    .then(reload)
                    .then(() => toast("File ingested and queued for proposal review"))
                    .catch((error) => toast(error.message, "error"))
                }
              >
                Ingest
              </button>
            </div>
          ))}
        </div>
        <div className="viewCard">
          <h3>Watcher</h3>
          <div className="meta">
            Watcher ingestion creates pending proposals only; it does not auto-apply durable memory. Session/profile
            imports are deduped and redacted before queueing when secrets are detected.
          </div>
          <div className="chips">
            <span>{String(status.running ? "running" : "stopped")}</span>
            <span>{String(status.runCount ?? 0)} runs</span>
          </div>
          <button
            disabled={readOnly || Boolean(status.running)}
            onClick={() =>
              apiClient
                .api("/api/watch/start", { method: "POST", body: "{}" })
                .then(reload)
                .then(() => toast("Watcher started"))
                .catch((error) => toast(error.message, "error"))
            }
          >
            Start Watcher
          </button>
          <button
            disabled={readOnly || !status.running}
            onClick={() =>
              apiClient
                .api("/api/watch/stop", { method: "POST", body: "{}" })
                .then(reload)
                .then(() => toast("Watcher stopped"))
                .catch((error) => toast(error.message, "error"))
            }
          >
            Stop Watcher
          </button>
          <pre>{JSON.stringify(status.history ?? [], null, 2)}</pre>
        </div>
      </div>
    </section>
  );
}

function OcrHealthCard({ health }: { health: Record<string, any> | null }): React.ReactElement {
  const tools = health?.tools ?? {};
  return (
    <div className="viewCard">
      <h3>OCR Health</h3>
      <div className="chips">
        <span className={health?.ok ? "" : "warnChip"}>{health?.ok ? "OCR ready" : "OCR tools missing"}</span>
        <span>pdftoppm: {tools.pdftoppm?.installed ? "installed" : "missing"}</span>
        <span>tesseract: {tools.tesseract?.installed ? "installed" : "missing"}</span>
      </div>
      <div className="meta">
        {health?.ok
          ? "Scanned PDFs can be OCR-indexed locally."
          : String(health?.install?.windows ?? "Install Poppler and Tesseract, then add both to PATH.")}
      </div>
    </div>
  );
}

function ImportSupportCard({ support }: { support: Record<string, any> | null }): React.ReactElement {
  const kinds = support?.supportedKinds ?? [];
  return (
    <div className="viewCard">
      <h3>Import Support</h3>
      <div className="chips">
        {kinds.map((row: Record<string, unknown>) => (
          <span key={String(row.kind)}>
            {String(row.kind)} {Array.isArray(row.extensions) ? row.extensions.join("/") : ""}
          </span>
        ))}
      </div>
      <div className="meta">Approved roots: {(support?.approvedRoots ?? []).join(" | ") || "loading"}</div>
      <div className="meta">
        Raw sources index immediately; durable facts, events, failures, and decisions stay proposal-reviewed.
      </div>
    </div>
  );
}

function ConnectView({ toast }: { toast: (message: string, type?: Toast["type"]) => void }): React.ReactElement {
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [smoke, setSmoke] = useState<Record<string, any> | null>(null);
  const reload = useCallback(
    async () => setStatus(await apiClient.api<Record<string, any>>("/api/integrations/status")),
    [],
  );
  useEffect(() => {
    reload().catch((error) => toast(error.message, "error"));
  }, [reload, toast]);
  const remote = status?.remoteMcp ?? {};
  const endpoint = String(remote.endpoint ?? `${window.location.origin}/mcp`);
  const protectedMetadata = String(
    remote.protectedResourceMetadata ?? `${window.location.origin}/.well-known/oauth-protected-resource/mcp`,
  );
  const config = {
    mcpServers: {
      neurakeep: {
        url: endpoint,
        headers: { Authorization: "Bearer <agent-grant-or-managedIdentity-id-token>" },
      },
    },
  };
  const testMcp = async (): Promise<void> => {
    const result = await apiClient.api<Record<string, any>>("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list" }),
    });
    setSmoke(result);
    toast(`MCP test returned ${(result.result?.tools ?? []).length} tools`);
  };
  return (
    <section className="viewSurface">
      <h2>MCP Connection</h2>
      <div className="viewGrid">
        <div className="viewCard">
          <h3>Remote Endpoint</h3>
          <div className="chips">
            <span>{remote.hosted ? "hosted" : "local"}</span>
            <span>{remote.serviceTokenConfigured ? "agent grant ready" : "token needed"}</span>
            <span>{status?.server?.readOnly ? "read-only" : "read-write"}</span>
            <span>{status?.tools?.length ?? 0} tools</span>
          </div>
          <label>
            Endpoint
            <input readOnly value={endpoint} />
          </label>
          <label>
            Protected resource metadata
            <input readOnly value={protectedMetadata} />
          </label>
          <div className="proposalTools">
            <button onClick={() => copyText(endpoint, toast)}>Copy endpoint</button>
            <button onClick={() => copyText(protectedMetadata, toast)}>Copy metadata URL</button>
            <button onClick={() => testMcp().catch((error) => toast(error.message, "error"))}>Test tools/list</button>
          </div>
          {smoke && <pre>{JSON.stringify(smoke.result ?? smoke, null, 2)}</pre>}
        </div>
        <div className="viewCard">
          <h3>Client Config</h3>
          <div className="meta">
            Use the same hosted endpoint for Claude, Codex, and other MCP clients. Tokens stay private and are never
            stored in this config snippet.
          </div>
          <pre>{JSON.stringify(config, null, 2)}</pre>
          <button onClick={() => copyText(JSON.stringify(config, null, 2), toast)}>Copy JSON</button>
        </div>
        <IntegrationStatusCard status={status} />
      </div>
    </section>
  );
}

function ActivityView({ toast }: { toast: (message: string, type?: Toast["type"]) => void }): React.ReactElement {
  const [hosted, setHosted] = useState<Array<Record<string, unknown>>>([]);
  const [governor, setGovernor] = useState<Array<Record<string, unknown>>>([]);
  const [ops, setOps] = useState<Record<string, any> | null>(null);
  const reload = useCallback(async () => {
    const [hostedData, governorData, opsData] = await Promise.all([
      apiClient.api<{ events: Array<Record<string, unknown>> }>("/api/hosted/audit?limit=100"),
      apiClient.api<{ entries: Array<Record<string, unknown>> }>("/api/governor/audit"),
      apiClient.api<Record<string, any>>("/api/hosted/ops"),
    ]);
    setHosted(hostedData.events ?? []);
    setGovernor(governorData.entries ?? []);
    setOps(opsData);
  }, []);
  useEffect(() => {
    reload().catch((error) => toast(error.message, "error"));
  }, [reload, toast]);
  const feed: Array<Record<string, unknown> & { kind: string; at: unknown }> = [
    ...hosted.map((row) => ({ ...row, kind: "hosted", at: row.createdAt })),
    ...governor.map((row) => ({ ...row, kind: "governor", at: row.createdAt })),
  ]
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
    .slice(0, 100);
  return (
    <section className="viewSurface">
      <h2>Activity</h2>
      <div className="viewGrid">
        <HostedOpsCard ops={ops} />
        <div className="viewCard activityFeed">
          <h3>Audit Feed</h3>
          <button onClick={() => reload().catch((error) => toast(error.message, "error"))}>Refresh</button>
          {feed.length === 0 && <div className="meta">No audit events yet.</div>}
          {feed.map((row, index) => (
            <div className="result" key={`${String(row.kind)}-${String(row.id ?? index)}`}>
              <b>
                {String(row.action ?? row.kind)} / {String(row.status ?? "ok")}
              </b>
              <div className="meta">
                {String(row.at ?? "")} / {String(row.kind)} / {String(row.actorEmail ?? row.actorUid ?? "")}
              </div>
              {Boolean(row.targetType) && (
                <div className="chips">
                  <span>{String(row.targetType)}</span>
                  {Boolean(row.targetId) ? <span>{String(row.targetId)}</span> : null}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function QualityView({
  toast,
  openRecord,
  refreshGraph,
  readOnly,
}: {
  toast: (message: string, type?: Toast["type"]) => void;
  openRecord: (id: string) => Promise<void>;
  refreshGraph: () => Promise<void>;
  readOnly: boolean;
}): React.ReactElement {
  const [report, setReport] = useState<Record<string, unknown>>({});
  const [dashboard, setDashboard] = useState<Record<string, any>>({});
  const [audit, setAudit] = useState<{ entries?: Array<Record<string, unknown>> }>({});
  const [timeline, setTimeline] = useState<{ timeline?: Array<Record<string, unknown>> }>({});
  const [fuzzyGroups, setFuzzyGroups] = useState<Array<Record<string, any>>>([]);
  const [selectedFuzzy, setSelectedFuzzy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await apiClient.api("/api/quality"));
      setDashboard(await apiClient.api("/api/quality/dashboard"));
      setAudit(await apiClient.api("/api/governor/audit"));
      setTimeline(await apiClient.api("/api/governor/timeline"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload().catch((error) => toast(error.message, "error"));
  }, [reload, toast]);
  const previewFuzzy = async (): Promise<void> => {
    const result = await apiClient.api<{ groups: Array<Record<string, any>> }>("/api/memory/dedupe/fuzzy-preview");
    setFuzzyGroups(result.groups);
    setSelectedFuzzy(
      Object.fromEntries(
        result.groups.slice(0, 20).map((group) => [String(group.groupId), Boolean(group.safeAutoSelectable)]),
      ),
    );
    toast(`Found ${result.groups.length} fuzzy duplicate groups`);
  };
  const applySelectedFuzzy = async (): Promise<void> => {
    const groupIds = Object.entries(selectedFuzzy)
      .filter(([, value]) => value)
      .map(([id]) => id);
    if (groupIds.length === 0) {
      toast("Select at least one fuzzy group first.", "error");
      return;
    }
    const result = await apiClient.api<{ collapsedGroups: number; collapsedFacts: number }>(
      "/api/memory/dedupe/fuzzy",
      {
        method: "POST",
        body: JSON.stringify({ groupIds }),
      },
    );
    setFuzzyGroups([]);
    setSelectedFuzzy({});
    await reload();
    await refreshGraph();
    toast(`Fuzzy-collapsed ${result.collapsedFacts} facts in ${result.collapsedGroups} groups`);
  };
  return (
    <section className="viewSurface">
      <h2>Quality</h2>
      {loading && <div className="meta">Loading quality checks...</div>}
      <QualityDashboard dashboard={dashboard} />
      <div className="viewGrid">
        <div className="viewCard">
          <h3>Memory Deduplication</h3>
          <div className="meta">
            Exact duplicate collapse can run directly. Fuzzy collapse requires preview and selected groups before
            stale/supersedes changes are committed.
          </div>
          <button
            disabled={readOnly}
            onClick={() =>
              apiClient
                .api<{ collapsedGroups: number; collapsedFacts: number }>("/api/memory/dedupe", {
                  method: "POST",
                  body: "{}",
                })
                .then((result) =>
                  reload()
                    .then(refreshGraph)
                    .then(() =>
                      toast(`Collapsed ${result.collapsedFacts} duplicate facts in ${result.collapsedGroups} groups`),
                    ),
                )
                .catch((error) => toast(error.message, "error"))
            }
          >
            Collapse exact duplicates
          </button>
          <button onClick={() => previewFuzzy().catch((error) => toast(error.message, "error"))}>
            Preview fuzzy duplicates
          </button>
          <button
            disabled={readOnly || Object.values(selectedFuzzy).filter(Boolean).length === 0}
            onClick={() => applySelectedFuzzy().catch((error) => toast(error.message, "error"))}
          >
            Apply selected fuzzy
          </button>
          <div className="chips">
            <span>{(report.duplicateFacts as unknown[] | undefined)?.length ?? 0} exact fact groups</span>
            <span>{dashboard.counts?.fuzzyDuplicateFactGroups ?? 0} fuzzy fact groups</span>
            <span>{(report.duplicateFailures as unknown[] | undefined)?.length ?? 0} duplicate failure groups</span>
          </div>
          {fuzzyGroups.length > 0 && (
            <div className="dedupePreview">
              {fuzzyGroups.slice(0, 20).map((group) => (
                <label className="dedupeGroup" key={String(group.groupId)}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedFuzzy[String(group.groupId)])}
                    onChange={(event) =>
                      setSelectedFuzzy((old) => ({ ...old, [String(group.groupId)]: event.target.checked }))
                    }
                  />
                  <b>Keep: {String(group.winner?.subject ?? group.winner?.id)}</b>
                  <span>
                    {Number(group.similarity ?? 0).toFixed(2)} similarity / stale {(group.losers ?? []).length}{" "}
                    duplicates
                  </span>
                  <span className={group.safeAutoSelectable ? "chip" : "warnChip"}>
                    {String(group.reviewRecommendation ?? "manual_review_required")}
                  </span>
                  <p>{String(group.winner?.object ?? "")}</p>
                </label>
              ))}
            </div>
          )}
        </div>
        <QualityBlock
          title="Conflicts"
          rows={report.conflictingFacts as Array<Record<string, unknown>>}
          openRecord={openRecord}
          toast={toast}
          readOnly={readOnly}
          refresh={async () => {
            await reload();
            await refreshGraph();
          }}
        />
        <QualityBlock
          title="Stale Review Queue"
          rows={report.staleFacts as Array<Record<string, unknown>>}
          openRecord={openRecord}
          toast={toast}
          readOnly={readOnly}
          refresh={async () => {
            await reload();
            await refreshGraph();
          }}
        />
        <div className="viewCard">
          <h3>Undo History</h3>
          {(audit.entries ?? []).length === 0 && <div className="meta">No governor actions yet.</div>}
          {(audit.entries ?? []).map((row) => (
            <div className="result" key={String(row.id)}>
              <b>
                {String(row.action)} {String(row.createdAt)}
              </b>
              <div className="meta">{(row.targetIds as string[] | undefined)?.join(", ")}</div>
              {row.undoable ? (
                <button
                  disabled={readOnly}
                  onClick={() =>
                    apiClient
                      .api("/api/governor/undo", { method: "POST", body: JSON.stringify({ auditId: row.id }) })
                      .then(reload)
                      .then(() => toast("Undo restored"))
                      .catch((error) => toast(error.message, "error"))
                  }
                >
                  Undo
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="viewCard">
          <h3>Timeline</h3>
          {(timeline.timeline ?? []).length === 0 && <div className="meta">No supersede or review timeline yet.</div>}
          {(timeline.timeline ?? []).slice(0, 20).map((row) => (
            <div className="result" key={String(row.id)}>
              <b>
                {String(row.subject)} {String(row.predicate)}
              </b>
              <div className="meta">
                {String(row.id)} / review {String(row.review_after ?? "none")} / valid until{" "}
                {String(row.valid_until ?? "current")}
              </div>
              <p>{String(row.object)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function QualityDashboard({ dashboard }: { dashboard: Record<string, any> }): React.ReactElement {
  const counts = dashboard.counts ?? {};
  const metrics = [
    ["Sources", counts.sources],
    ["Sections", counts.sections],
    ["Facts", counts.activeFacts],
    ["Failures", counts.failures],
    ["Pending", counts.pendingProposals],
    ["Clean", counts.cleanProposals],
    ["Warnings", counts.warningProposals],
    ["Stale", counts.staleFacts],
  ];
  return (
    <div className="qualityDashboard">
      <div className="metricGrid">
        {metrics.map(([label, value]) => (
          <div className="metric" key={String(label)}>
            <b>{String(value ?? 0)}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="viewCard">
        <h3>Top Noisy Imports</h3>
        {(dashboard.topNoisyImports ?? []).length === 0 ? (
          <div className="meta">No noisy pending imports.</div>
        ) : (
          dashboard.topNoisyImports.map((row: Record<string, unknown>) => (
            <div className="result" key={String(row.id)}>
              <b>{String(row.summary)}</b>
              <div className="meta">
                {String(row.warningCount)} warnings / {String(row.blockedCount)} blocked
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function QualityBlock({
  title: titleText,
  rows = [],
  openRecord,
  toast,
  refresh,
  readOnly,
}: {
  title: string;
  rows?: Array<Record<string, unknown>>;
  openRecord: (id: string) => Promise<void>;
  toast: (message: string, type?: Toast["type"]) => void;
  refresh: () => Promise<void>;
  readOnly: boolean;
}): React.ReactElement {
  return (
    <div className="viewCard">
      <h3>{titleText}</h3>
      {rows.length === 0 ? (
        <div className="meta">None.</div>
      ) : (
        rows.map((row, index) => {
          const values = row.values as Array<{ factId: string; object: string; confidence: number }> | undefined;
          if (Array.isArray(values) && values.length > 0) {
            const allIds = values.map((value) => value.factId);
            return (
              <div className="result" key={index}>
                <b>{String(row.key)}</b>
                <div className="compareGrid">
                  {values.map((value) => (
                    <div className="compareCell" key={value.factId}>
                      <div className="meta">
                        {value.factId} / confidence {Number(value.confidence ?? 0).toFixed(2)}
                      </div>
                      <p>{value.object}</p>
                      <button onClick={() => openRecord(value.factId)}>Open</button>
                      <button
                        disabled={readOnly}
                        onClick={() =>
                          apiClient
                            .api("/api/governor/resolve", {
                              method: "POST",
                              body: JSON.stringify({
                                action: "merge",
                                winnerId: value.factId,
                                loserIds: allIds.filter((id) => id !== value.factId),
                              }),
                            })
                            .then(refresh)
                            .then(() => toast("Merged facts"))
                            .catch((error) => toast(error.message, "error"))
                        }
                      >
                        Use this
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  disabled={readOnly}
                  onClick={() =>
                    apiClient
                      .api("/api/governor/resolve", {
                        method: "POST",
                        body: JSON.stringify({ action: "keep_both", factIds: allIds }),
                      })
                      .then(refresh)
                      .then(() => toast("Kept both facts"))
                      .catch((error) => toast(error.message, "error"))
                  }
                >
                  Keep both
                </button>
                <button
                  disabled={readOnly}
                  onClick={() =>
                    apiClient
                      .api("/api/governor/resolve", {
                        method: "POST",
                        body: JSON.stringify({ action: "review_later", factIds: allIds }),
                      })
                      .then(refresh)
                      .then(() => toast("Review scheduled"))
                      .catch((error) => toast(error.message, "error"))
                  }
                >
                  Review later
                </button>
              </div>
            );
          }
          const factId = String(row.factId ?? "");
          return (
            <div className="result" key={index}>
              <pre>{JSON.stringify(row, null, 2)}</pre>
              <button disabled={!factId} onClick={() => openRecord(factId)}>
                Open
              </button>
              <button
                disabled={readOnly || !factId}
                onClick={() =>
                  apiClient
                    .api("/api/governor/resolve", {
                      method: "POST",
                      body: JSON.stringify({ action: "mark_stale", factIds: [factId].filter(Boolean) }),
                    })
                    .then(refresh)
                    .then(() => toast("Marked stale"))
                    .catch((error) => toast(error.message, "error"))
                }
              >
                Mark stale
              </button>
              <button
                disabled={readOnly || !factId}
                onClick={() =>
                  apiClient
                    .api("/api/governor/resolve", {
                      method: "POST",
                      body: JSON.stringify({ action: "review_later", factIds: [factId].filter(Boolean) }),
                    })
                    .then(refresh)
                    .then(() => toast("Review scheduled"))
                    .catch((error) => toast(error.message, "error"))
                }
              >
                Review later
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

function SettingsView({
  auth,
  billing,
  setAuth,
  toast,
}: {
  auth: AuthSettings | null;
  billing: BillingAccess | null;
  setAuth: (auth: AuthSettings) => void;
  toast: (message: string, type?: Toast["type"]) => void;
}): React.ReactElement {
  const [reports, setReports] = useState<Array<Record<string, unknown>>>([]);
  const [mode, setMode] = useState<AuthSettings["mode"]>("local");
  const [displayName, setDisplayName] = useState("Local NeuraKeep User");
  const [role, setRole] = useState<AuthSettings["user"]["role"]>("owner");
  const [allowWrites, setAllowWrites] = useState(true);
  const [ocrHealth, setOcrHealth] = useState<Record<string, any> | null>(null);
  const [integration, setIntegration] = useState<Record<string, any> | null>(null);
  const [dailyLoop, setDailyLoop] = useState<Record<string, any> | null>(null);
  const [ops, setOps] = useState<Record<string, any> | null>(null);
  const [managedIdentityUser, setManagedIdentityUser] = useState("");
  useEffect(() => {
    apiClient
      .api<{ reports: Array<Record<string, unknown>> }>("/api/extraction/reports")
      .then((data) => setReports(data.reports))
      .catch(() => null);
  }, []);
  useEffect(() => {
    apiClient
      .api<Record<string, any>>("/api/import/ocr-health")
      .then(setOcrHealth)
      .catch(() => null);
  }, []);
  useEffect(() => {
    apiClient
      .api<Record<string, any>>("/api/integrations/status")
      .then(setIntegration)
      .catch(() => null);
  }, []);
  useEffect(() => {
    apiClient
      .api<Record<string, any>>("/api/workflow/daily-loop")
      .then(setDailyLoop)
      .catch(() => null);
  }, []);
  useEffect(() => {
    apiClient
      .api<Record<string, any>>("/api/hosted/ops")
      .then(setOps)
      .catch(() => null);
  }, []);
  useEffect(() => {
    if (!auth) return;
    setMode(auth.mode);
    setDisplayName(auth.user.displayName);
    setRole(auth.user.role);
    setAllowWrites(auth.user.allowWrites);
  }, [auth]);
  const save = async (): Promise<void> => {
    const next = await apiClient.api<AuthSettings>("/api/auth/settings", {
      method: "POST",
      body: JSON.stringify({ mode, user: { displayName, role, allowWrites } }),
    });
    setAuth(next);
    toast("Auth settings saved");
  };
  const runDailyLoop = async (): Promise<void> => {
    const result = await apiClient.api<Record<string, any>>("/api/workflow/daily-loop", {
      method: "POST",
      body: JSON.stringify({ queueSummary: true, reason: "session-close" }),
    });
    setDailyLoop(result.status ?? result);
    toast("Daily workflow queued summary and synced workspace memory");
  };
  const managedIdentityLogin = async (): Promise<void> => {
    const result = await signInWithManagedIdentity();
    apiClient.setToken(result.token);
    setManagedIdentityUser(result.user?.email ?? result.user?.displayName ?? "Google user");
    const next = await authSettings();
    setAuth(next);
    toast("Google sign-in connected");
  };
  const managedIdentityLogout = async (): Promise<void> => {
    await signOutOfManagedIdentity();
    apiClient.setToken("");
    setManagedIdentityUser("");
    toast("Google session cleared");
  };
  return (
    <section className="viewSurface">
      <h2>Settings</h2>
      <div className="viewGrid">
        <div className="viewCard">
          <h3>Auth / User</h3>
          <div className="chips">
            <span>{auth?.provider ?? "local"}</span>
            <span>{auth?.hosted?.enabled ? "hosted" : "local"}</span>
            <span>{auth?.hosted?.tenantId ?? "local"}</span>
            <span>{auth?.hosted?.spaceId ?? "personal"}</span>
          </div>
          <label>
            Bearer token / Google ID token
            <input defaultValue={apiClient.getToken()} onChange={(event) => apiClient.setToken(event.target.value)} />
          </label>
          <div className="proposalTools">
            <button
              disabled={!managedIdentityConfigured()}
              title={
                managedIdentityConfigured()
                  ? "Continue with Google through ManagedIdentity Auth."
                  : "Set VITE_MANAGED_IDENTITY_* public client config before building the hosted web app."
              }
              onClick={() => {
                trackCtaEvent("hosted_login_click", { section: "settings", method: "google" });
                managedIdentityLogin()
                  .then(() => trackCtaEvent("login", { section: "settings", method: "google" }))
                  .catch((error) => toast(error.message, "error"));
              }}
            >
              Continue with Google
            </button>
            <button
              onClick={() => {
                trackCtaEvent("hosted_logout_click", { section: "settings" });
                managedIdentityLogout().catch((error) => toast(error.message, "error"));
              }}
            >
              Sign out
            </button>
          </div>
          <div className="meta">
            {managedIdentityConfigured()
              ? `Google sign-in is secured by ManagedIdentity Auth${managedIdentityUser ? ` / ${managedIdentityUser}` : ""}`
              : "Google sign-in config is not present in this build. Local mode still works."}
          </div>
          <label>
            Mode
            <select value={mode} onChange={(event) => setMode(event.target.value as AuthSettings["mode"])}>
              <option value="local">local</option>
              <option value="remote">remote</option>
            </select>
          </label>
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value as AuthSettings["user"]["role"])}>
              <option value="owner">owner</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={allowWrites} onChange={(event) => setAllowWrites(event.target.checked)} />
            Allow writes when server is read-write
          </label>
          <button disabled={Boolean(auth?.readOnly)} onClick={() => save().catch((error) => toast(error.message, "error"))}>
            Save auth settings
          </button>
          <button
            onClick={() =>
              authSettings()
                .then(setAuth)
                .then(() => toast("Auth settings refreshed"))
                .catch((error) => toast(error.message, "error"))
            }
          >
            Refresh auth
          </button>
          <pre>{JSON.stringify(auth, null, 2)}</pre>
        </div>
        <BillingCard billing={billing} toast={toast} />
        <TeamManagementCard auth={auth} toast={toast} />
        <HostedCard auth={auth} />
        <IntegrationStatusCard status={integration} />
        <HostedOpsCard ops={ops} />
        <DailyLoopCard
          status={dailyLoop}
          run={() => runDailyLoop().catch((error) => toast(error.message, "error"))}
          disabled={Boolean(auth?.readOnly)}
        />
        <OcrHealthCard health={ocrHealth} />
        <div className="viewCard">
          <h3>Extraction Eval Reports</h3>
          {reports.length === 0 && <div className="meta">No extraction eval reports yet.</div>}
          {reports.map((row) => (
            <div className="result" key={String(row.id)}>
              <b>{String(row.proposalId)}</b>
              <pre>{JSON.stringify(row.score, null, 2)}</pre>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkspaceSwitcher({
  currentTenant,
  currentSpace,
  refresh,
  toast,
}: {
  currentTenant: string;
  currentSpace: string;
  refresh: () => Promise<void>;
  toast: (message: string, type?: Toast["type"]) => void;
}): React.ReactElement {
  const [organizations, setOrganizations] = useState<HostedOrganization[]>([]);
  useEffect(() => {
    listOrganizations()
      .then(setOrganizations)
      .catch(() => null);
  }, [currentTenant]);
  const current = currentTenant.startsWith("org_") ? `${currentTenant}:${currentSpace}` : "";
  const change = async (value: string): Promise<void> => {
    if (!value) apiClient.setWorkspace();
    else {
      const index = value.indexOf(":");
      apiClient.setWorkspace(value.slice(0, index), value.slice(index + 1));
    }
    await refresh();
    toast("Workspace switched");
  };
  return (
    <select
      className="workspaceSwitcher"
      aria-label="Workspace"
      value={current}
      onChange={(event) => change(event.target.value).catch((error) => toast(error.message, "error"))}
    >
      <option value="">Personal workspace</option>
      {organizations.flatMap((organization) =>
        organization.spaces.map((space) => (
          <option key={`${organization.id}:${space.id}`} value={`${organization.id}:${space.id}`}>
            {organization.name} / {space.name}
          </option>
        )),
      )}
    </select>
  );
}

function TeamManagementCard({
  auth,
  toast,
}: {
  auth: AuthSettings | null;
  toast: (message: string, type?: Toast["type"]) => void;
}): React.ReactElement {
  const organizationId = auth?.hosted?.organizationId;
  const role = auth?.hosted?.membershipRole ?? auth?.hosted?.roles?.[0];
  const canManage = !auth?.readOnly && (role === "owner" || role === "admin");
  const [members, setMembers] = useState<Array<Record<string, any>>>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteUrl, setInviteUrl] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const reload = useCallback(
    () => (canManage ? listTeamMembers().then(setMembers) : Promise.resolve()),
    [canManage, organizationId],
  );
  useEffect(() => {
    void reload().catch(() => null);
  }, [reload]);
  if (!organizationId) return <></>;
  const invite = async (): Promise<void> => {
    const result = await inviteTeamMember(email, inviteRole);
    setInviteUrl(`${window.location.origin}${String(result.inviteUrl)}`);
    setEmail("");
    await reload();
    toast("Invitation created");
  };
  const addSpace = async (): Promise<void> => {
    await createTeamSpace(spaceName);
    setSpaceName("");
    toast("Shared space created. Reload the workspace picker to open it.");
  };
  return (
    <div className="viewCard">
      <h3>Team workspace</h3>
      <div className="chips">
        <span>{auth?.hosted?.organizationName ?? organizationId}</span>
        <span>{role}</span>
        <span>{auth?.hosted?.spaceId}</span>
      </div>
      <div className="meta">
        Every shared space has its own physical vault. Roles are enforced on API and MCP requests.
      </div>
      {canManage && (
        <>
          <label>
            New shared space
            <input
              value={spaceName}
              onChange={(event) => setSpaceName(event.target.value)}
              placeholder="Client Alpha"
            />
          </label>
          <button
            disabled={spaceName.trim().length < 2}
            onClick={() => addSpace().catch((error) => toast(error.message, "error"))}
          >
            Create space
          </button>
          <div className="teamInvite">
            <label>
              Invite email
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label>
              Role
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                <option value="admin">Admin</option>
                <option value="reviewer">Reviewer</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <button
              disabled={!email.includes("@")}
              onClick={() => invite().catch((error) => toast(error.message, "error"))}
            >
              Create invitation
            </button>
          </div>
          {inviteUrl && (
            <div className="result">
              <b>Copy the invitation link now.</b>
              <pre>{inviteUrl}</pre>
              <button onClick={() => navigator.clipboard.writeText(inviteUrl)}>Copy link</button>
            </div>
          )}
          {members.map((member) => (
            <div className="result" key={String(member.userId)}>
              <b>{String(member.displayName ?? member.email ?? member.userId)}</b>
              <div className="meta">
                {String(member.email ?? "")} · {String(member.role)} · {String(member.status)}
              </div>
              {member.role !== "owner" && member.status === "active" && (
                <div className="proposalTools">
                  <select
                    value={String(member.role)}
                    onChange={(event) =>
                      updateTeamMember(String(member.userId), event.target.value)
                        .then(reload)
                        .catch((error) => toast(error.message, "error"))
                    }
                  >
                    <option value="admin">Admin</option>
                    <option value="reviewer">Reviewer</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    className="secondary"
                    onClick={() =>
                      updateTeamMember(String(member.userId), String(member.role), true)
                        .then(reload)
                        .catch((error) => toast(error.message, "error"))
                    }
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function AuthLoading(): React.ReactElement {
  return (
    <div className="authScreen">
      <div className="authPanel">
        <h1 className="appBrand">
          <img src="/assets/icon.svg" alt="" width="34" height="34" />
          <span>NeuraKeep</span>
        </h1>
        <h2>Hosted NeuraKeep</h2>
        <p>Checking your account...</p>
      </div>
    </div>
  );
}

function OAuthConsent({
  auth,
  request,
  toast,
  toasts,
}: {
  auth: AuthSettings;
  request: OAuthBrowserRequest;
  toast: (message: string, type?: Toast["type"]) => void;
  toasts: Toast[];
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const finish = async (approved: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await completeOAuthAuthorization(request.parameters, approved);
      window.location.assign(result.redirectTo);
    } finally {
      setBusy(false);
    }
  };
  const scopes = (request.parameters.scope || "memory:read memory:propose").split(/\s+/).filter(Boolean);
  return (
    <div className="authScreen">
      <div className="authPanel oauthConsent">
        <h1 className="appBrand">
          <img src="/assets/icon.svg" alt="" width="34" height="34" />
          <span>NeuraKeep</span>
        </h1>
        <h2>Connect {request.clientName}</h2>
        <p>
          {request.clientName} is asking to access the selected encrypted NeuraKeep space as an autonomous MCP client.
        </p>
        <div className="result">
          <b>Signed in as</b>
          <div className="meta">{sessionLabel(auth)}</div>
          <b>Space</b>
          <div className="meta">
            {auth.hosted?.organizationName ?? auth.hosted?.tenantId ?? "Personal"} /{" "}
            {auth.hosted?.spaceId ?? "personal"}
          </div>
          <b>Permissions</b>
          <div className="chips">
            {scopes.map((scope) => (
              <span key={scope}>{scope}</span>
            ))}
          </div>
        </div>
        <div className="warn">
          This creates a revocable authorization. NeuraKeep decrypts this space while the authorized client is working.
        </div>
        <div className="proposalTools">
          <button
            disabled={busy}
            onClick={() =>
              finish(true).catch((error) => {
                setBusy(false);
                toast(error.message, "error");
              })
            }
          >
            {busy ? "Connecting..." : "Allow connection"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              finish(false).catch((error) => {
                setBusy(false);
                toast(error.message, "error");
              })
            }
          >
            Deny
          </button>
        </div>
      </div>
      <div className="toastStack">
        {toasts.map((row) => (
          <div key={row.id} className={`toast ${row.type ?? ""}`}>
            {row.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function sessionLabel(auth: AuthSettings): string {
  const hostedEmail = auth.hosted?.email;
  const actor = auth.user.actor as { email?: string; uid?: string } | undefined;
  return hostedEmail ?? actor?.email ?? auth.user.displayName ?? actor?.uid ?? "Signed in";
}

function AuthGate({
  error,
  onAuthenticated,
  toast,
  toasts,
}: {
  error: string;
  onAuthenticated: () => Promise<void>;
  toast: (message: string, type?: Toast["type"]) => void;
  toasts: Toast[];
}): React.ReactElement {
  const [token, setToken] = useState(apiClient.getToken());
  const [workEmail, setWorkEmail] = useState("");
  const [providers, setProviders] = useState<Array<{ id: string; type: "saml" | "oidc"; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const login = async (): Promise<void> => {
    trackCtaEvent("hosted_login_click", { section: "auth_gate", method: "google" });
    setBusy(true);
    try {
      const result = await signInWithManagedIdentity();
      apiClient.setToken(result.token);
      await onAuthenticated();
      trackCtaEvent("login", { section: "auth_gate", method: "google" });
      toast("Signed in");
    } finally {
      setBusy(false);
    }
  };
  const useToken = async (): Promise<void> => {
    trackCtaEvent("hosted_login_click", { section: "auth_gate", method: "service_token" });
    setBusy(true);
    try {
      apiClient.setToken(token);
      await onAuthenticated();
      trackCtaEvent("login", { section: "auth_gate", method: "service_token" });
    } finally {
      setBusy(false);
    }
  };
  const findSso = async (): Promise<void> => {
    const discovered = await discoverSsoProviders(workEmail);
    setProviders(discovered);
    if (discovered.length === 0) toast("No enterprise SSO provider is configured for that domain.", "error");
  };
  const loginSso = async (provider: { id: string; type: "saml" | "oidc"; label: string }): Promise<void> => {
    setBusy(true);
    try {
      const result = await signInWithEnterpriseProvider(provider.id, provider.type);
      apiClient.setToken(result.token);
      await onAuthenticated();
      toast(`Signed in with ${provider.label}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="authScreen">
      <div className="authPanel">
        <h1 className="appBrand">
          <img src="/assets/icon.svg" alt="" width="34" height="34" />
          <span>NeuraKeep</span>
        </h1>
        <h2>Sign in to hosted NeuraKeep</h2>
        <p>Use Google for a personal or Team account, or discover your organization&apos;s SAML/OIDC sign-in.</p>
        <button
          disabled={!managedIdentityConfigured() || busy}
          onClick={() =>
            login().catch((loginError) =>
              toast(loginError instanceof Error ? loginError.message : "Google sign-in failed", "error"),
            )
          }
        >
          {busy ? "Checking..." : "Continue with Google"}
        </button>
        <div className="ssoDiscovery">
          <label>
            Enterprise SSO
            <input
              type="email"
              value={workEmail}
              onChange={(event) => setWorkEmail(event.target.value)}
              placeholder="you@company.com"
            />
          </label>
          <button
            className="secondary"
            disabled={!workEmail.includes("@") || busy}
            onClick={() => findSso().catch((nextError) => toast(nextError.message, "error"))}
          >
            Find SSO
          </button>
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => loginSso(provider).catch((nextError) => toast(nextError.message, "error"))}
            >
              Continue with {provider.label}
            </button>
          ))}
        </div>
        <div className="meta">
          {managedIdentityConfigured()
            ? "ManagedIdentity verifies every Google, SAML, and OIDC ID token before workspace authorization."
            : "ManagedIdentity client config is missing from this build."}
        </div>
        <details>
          <summary>Use an autonomous-agent grant</summary>
          <label>
            Agent grant token
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste autonomous-agent grant"
            />
          </label>
          <button
            disabled={!token.trim() || busy}
            onClick={() =>
              useToken().catch((tokenError) =>
                toast(tokenError instanceof Error ? tokenError.message : "Token rejected", "error"),
              )
            }
          >
            Continue with token
          </button>
        </details>
        {error && !/signed out/i.test(error) && <div className="warn">Sign-in check: {error}</div>}
      </div>
      <div className="toastStack">
        {toasts.map((row) => (
          <div key={row.id} className={`toast ${row.type ?? ""}`}>
            {row.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function SubscriptionGate({
  billing,
  refresh,
  logout,
  toast,
  toasts,
}: {
  billing: BillingAccess;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  toast: (message: string, type?: Toast["type"]) => void;
  toasts: Toast[];
}): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("plan") === "personal" ? "personal" : params.get("plan") === "team" ? "team" : "pro";
  const offer = params.get("offer") === "producthunt" ? "producthunt" : undefined;
  const checkoutState = params.get("checkout");
  const [busy, setBusy] = useState<"personal" | "pro" | "team" | "">("");
  const [teamName, setTeamName] = useState("");
  const [seats, setSeats] = useState(2);
  const [organizations, setOrganizations] = useState<HostedOrganization[]>([]);
  useEffect(() => {
    listOrganizations()
      .then(setOrganizations)
      .catch(() => null);
  }, []);
  const buy = async (plan: "personal" | "pro" | "team"): Promise<void> => {
    if (plan === "team" && !apiClient.getWorkspace().tenantId && teamName.trim().length < 2)
      throw new Error("Enter your team name before opening Checkout.");
    setBusy(plan);
    try {
      const session = await startCheckout(
        plan,
        offer,
        plan === "team" ? { organizationName: teamName, seats } : undefined,
      );
      if (session.organizationId && session.spaceId) apiClient.setWorkspace(session.organizationId, session.spaceId);
      window.location.assign(session.url);
    } finally {
      setBusy("");
    }
  };
  const openOrganization = async (organization: HostedOrganization): Promise<void> => {
    const space = organization.spaces[0];
    if (!space) throw new Error("This team has no active space.");
    apiClient.setWorkspace(organization.id, space.id);
    await refresh();
  };
  return (
    <div className="authScreen">
      <div className="authPanel subscriptionPanel">
        <h1 className="appBrand">
          <img src="/assets/icon.svg" alt="" width="34" height="34" />
          <span>NeuraKeep</span>
        </h1>
        <h2>Choose your hosted plan</h2>
        <p>Your account is signed in. Choose an individual vault or a licensed Team workspace.</p>
        {checkoutState === "success" && (
          <div className="successNotice">Payment received. BillingProvider is confirming your subscription now.</div>
        )}
        {checkoutState === "cancelled" && <div className="warn">Checkout was cancelled. Nothing was charged.</div>}
        {organizations.length > 0 && (
          <div className="existingTeams">
            <b>Your teams</b>
            {organizations.map((organization) => (
              <button
                key={organization.id}
                onClick={() => openOrganization(organization).catch((error) => toast(error.message, "error"))}
              >
                {organization.name} · {organization.status}
              </button>
            ))}
          </div>
        )}
        {billing.launchOffer.configured && (
          <div className="launchOffer">
            <b>Product Hunt launch: 50% off your first three months</b>
            <span>Offer code {billing.launchOffer.code} is applied automatically from the launch link.</span>
          </div>
        )}
        <div className="subscriptionPlans">
          {billing.plans.map((plan) => (
            <article className={plan.id === requested ? "subscriptionPlan selected" : "subscriptionPlan"} key={plan.id}>
              <h3>{plan.name}</h3>
              <div className="subscriptionPrice">
                ${plan.amount}
                <span>{plan.id === "team" ? "/user/month" : "/month"}</span>
              </div>
              <p>
                {plan.id === "personal"
                  ? "Encrypted hosted memory, remote MCP, expiring agent grants, and encrypted backups."
                  : plan.id === "pro"
                    ? "Higher limits for consultants, heavy AI users, PDFs, OCR, and advanced graph workflows."
                    : "Shared spaces, roles, team review, audit history, and enterprise identity options."}
              </p>
              {plan.id === "team" && (
                <div className="teamCheckoutFields">
                  <label>
                    Team name
                    <input
                      value={teamName}
                      onChange={(event) => setTeamName(event.target.value)}
                      placeholder="Acme AI"
                    />
                  </label>
                  <label>
                    Licensed seats
                    <input
                      type="number"
                      min={2}
                      max={250}
                      value={seats}
                      onChange={(event) => setSeats(Math.max(2, Math.min(250, Number(event.target.value))))}
                    />
                  </label>
                </div>
              )}
              <button
                disabled={!plan.configured || Boolean(busy)}
                onClick={() => buy(plan.id).catch((error) => toast(error.message, "error"))}
              >
                {busy === plan.id ? "Opening BillingProvider..." : plan.configured ? `Choose ${plan.name}` : "Coming soon"}
              </button>
            </article>
          ))}
        </div>
        <div className="proposalTools">
          <button onClick={() => refresh().catch((error) => toast(error.message, "error"))}>
            Refresh subscription
          </button>
          <button className="secondary" onClick={() => logout().catch((error) => toast(error.message, "error"))}>
            Sign out
          </button>
        </div>
        <a className="meta" href="https://github.com/dominiclachance/neurakeep">
          Prefer local? Use the open-source core free.
        </a>
      </div>
      <div className="toastStack">
        {toasts.map((row) => (
          <div key={row.id} className={`toast ${row.type ?? ""}`}>
            {row.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function HostedCard({ auth }: { auth: AuthSettings | null }): React.ReactElement {
  const hosted = auth?.hosted;
  return (
    <>
      <HostedAccessTokensCard auth={auth} />
      <div className="viewCard">
        <h3>Hosted Foundation</h3>
        <div className="chips">
          <span>{hosted?.enabled ? "enabled" : "disabled"}</span>
          <span>{hosted?.authProvider ?? "local"}</span>
          <span>{hosted?.managedIdentityProjectId ?? "no ManagedIdentity project"}</span>
          <span>{hosted?.tenantId ?? "account pending"}</span>
        </div>
        <div className="meta">
          Hosted mode uses ManagedIdentity-verified identity, a separately encrypted space vault, expiring MCP grants, BillingProvider
          entitlements, and server-side audit events. NeuraKeep decrypts the selected space in its authorized runtime
          while serving you or your autonomous agent; autonomous spaces are not zero-knowledge.
        </div>
        <pre>{JSON.stringify(hosted ?? {}, null, 2)}</pre>
      </div>
    </>
  );
}

function HostedAccessTokensCard({ auth }: { auth: AuthSettings | null }): React.ReactElement {
  const [tokens, setTokens] = useState<HostedAccessToken[]>([]);
  const [issued, setIssued] = useState("");
  const [name, setName] = useState("My MCP connector");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [allowApply, setAllowApply] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(
    () =>
      listHostedTokens()
        .then(setTokens)
        .catch((nextError) => setError(nextError.message)),
    [],
  );
  useEffect(() => {
    if (auth?.provider === "managedIdentity") void refresh();
  }, [auth?.provider, refresh]);
  if (auth?.provider !== "managedIdentity") return <></>;
  const create = async (): Promise<void> => {
    const scopes: HostedAccessToken["scopes"] = [
      "memory:read",
      "memory:propose",
      ...(allowApply ? ["memory:apply" as const] : []),
    ];
    const result = await createHostedToken(name, scopes, expiresInDays);
    setIssued(result.token);
    setError("");
    await refresh();
  };
  const revoke = async (id: string): Promise<void> => {
    await revokeHostedToken(id);
    await refresh();
  };
  const rotate = async (id: string): Promise<void> => {
    const result = await rotateHostedToken(id, expiresInDays);
    setIssued(result.token);
    await refresh();
  };
  return (
    <div className="viewCard">
      <h3>Autonomous MCP grants</h3>
      <div className="meta">
        Create a revocable, expiring decryption grant for Claude, Codex, OpenClaw, or another MCP client. It opens only
        the selected space. NeuraKeep decrypts that space while the authorized agent is working.
      </div>
      <label>
        Grant name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Expires in days
        <input
          type="number"
          min={1}
          max={90}
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(Math.max(1, Math.min(90, Number(event.target.value))))}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={allowApply} onChange={(event) => setAllowApply(event.target.checked)} />
        Allow the agent to apply approved memory updates
      </label>
      <button disabled={Boolean(auth?.readOnly)} onClick={() => create().catch((nextError) => setError(nextError.message))}>
        Create autonomous grant
      </button>
      {issued && (
        <div className="result">
          <b>Copy this token now—it will not be shown again.</b>
          <pre>{issued}</pre>
          <button onClick={() => navigator.clipboard.writeText(issued)}>Copy token</button>
        </div>
      )}
      {tokens.map((token) => (
        <div className="result" key={token.id}>
          <b>{token.name}</b>
          <div className="meta">
            {token.scopes?.join(", ")} / expires{" "}
            {token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : "invalid"}
            {token.lastUsedAt ? ` / last used ${new Date(token.lastUsedAt).toLocaleString()}` : " / never used"}
            {token.revokedAt ? " / revoked" : ""}
          </div>
          {!token.revokedAt && (
            <div className="proposalTools">
              <button
                className="secondary"
                disabled={Boolean(auth?.readOnly)}
                onClick={() => rotate(token.id).catch((nextError) => setError(nextError.message))}
              >
                Rotate
              </button>
              <button
                className="secondary"
                disabled={Boolean(auth?.readOnly)}
                onClick={() => revoke(token.id).catch((nextError) => setError(nextError.message))}
              >
                Revoke
              </button>
            </div>
          )}
        </div>
      ))}
      {error && <div className="warn">{error}</div>}
    </div>
  );
}

function BillingCard({
  billing,
  toast,
}: {
  billing: BillingAccess | null;
  toast: (message: string, type?: Toast["type"]) => void;
}): React.ReactElement {
  const manage = async (): Promise<void> => {
    const portal = await openBillingPortal();
    window.location.assign(portal.url);
  };
  return (
    <div className="viewCard">
      <h3>Subscription</h3>
      <div className="chips">
        <span>{billing?.plan ?? "local"}</span>
        <span>{billing?.status ?? "active"}</span>
        {billing?.currentPeriodEnd && <span>renews {new Date(billing.currentPeriodEnd).toLocaleDateString()}</span>}
      </div>
      <div className="meta">
        BillingProvider manages payment methods, invoices, and cancellation. Contact support to change plans.
      </div>
      {billing?.customerId ? (
        <button onClick={() => manage().catch((error) => toast(error.message, "error"))}>Manage billing</button>
      ) : null}
    </div>
  );
}

function IntegrationStatusCard({ status }: { status: Record<string, any> | null }): React.ReactElement {
  const clients = status?.clients ?? [];
  const remote = status?.remoteMcp ?? {};
  return (
    <div className="viewCard">
      <h3>Client Integrations</h3>
      <div className="chips">
        <span>{status?.server?.mode ?? "loading"}</span>
        <span>{status?.tools?.length ?? 0} tools</span>
        <span>{status?.server?.tokenRequired ? "token required" : "local open"}</span>
        <span>{remote.serviceTokenConfigured ? "agent grant ready" : "no agent grant"}</span>
      </div>
      <div className="meta">{remote.endpoint ?? "Remote MCP endpoint not loaded."}</div>
      {remote.protectedResourceMetadata && <div className="meta">{remote.protectedResourceMetadata}</div>}
      {clients.map((client: Record<string, unknown>) => (
        <div className="result" key={String(client.name)}>
          <b>{String(client.name)}</b>
          <div className="meta">
            {client.configured === null ? String(client.note) : client.configured ? "Configured" : "Not configured"}
            {client.configPath ? ` / ${String(client.configPath)}` : ""}
          </div>
        </div>
      ))}
      <pre>{JSON.stringify(status?.smokeTests ?? [], null, 2)}</pre>
    </div>
  );
}

function HostedOpsCard({ ops }: { ops: Record<string, any> | null }): React.ReactElement {
  const recent = ops?.recentAuditEvents ?? [];
  return (
    <div className="viewCard">
      <h3>Monitoring / Backups</h3>
      <div className="chips">
        <span>{ops?.health?.storageOk ? "storage ok" : "storage check"}</span>
        <span>{ops?.backup?.configured ? "backup configured" : "backup path only"}</span>
        <span>{ops?.alerting?.webhookConfigured ? "alerts hooked" : "webhook missing"}</span>
        <span>{ops?.serviceTokens?.configured ? "agent grants live" : "no agent grants"}</span>
      </div>
      <div className="meta">{ops?.backup?.verification ?? "Ops status loading."}</div>
      <div className="meta">{ops?.serviceTokens?.rotateWith ?? ""}</div>
      {recent.slice(0, 5).map((row: Record<string, unknown>) => (
        <div className="result" key={String(row.id)}>
          <b>
            {String(row.action)} / {String(row.status)}
          </b>
          <div className="meta">
            {String(row.createdAt)} / {String(row.actorEmail ?? row.actorUid)}
          </div>
        </div>
      ))}
    </div>
  );
}

function DailyLoopCard({
  status,
  run,
  disabled,
}: {
  status: Record<string, any> | null;
  run: () => void;
  disabled: boolean;
}): React.ReactElement {
  const actions = status?.recommendedActions ?? [];
  const counts = status?.quality?.counts ?? {};
  return (
    <div className="viewCard">
      <h3>Daily Workflow Loop</h3>
      <div className="chips">
        <span>{counts.pendingProposals ?? 0} pending</span>
        <span>{counts.warningProposals ?? 0} warnings</span>
        <span>{counts.fuzzyDuplicateFactGroups ?? 0} fuzzy groups</span>
      </div>
      <div className="meta">
        Queues a session-close summary and syncs workspace memory as proposals. Durable memory remains review-first.
      </div>
      {actions.map((action: string) => (
        <div className="result" key={action}>
          {action}
        </div>
      ))}
      <button disabled={disabled} onClick={run}>Queue daily summary</button>
    </div>
  );
}

function SearchResults({
  results,
  guidance,
  openRecord,
  focusNode,
}: {
  results: SearchResult[];
  guidance?: RetrievalGuidance;
  openRecord: (id: string) => Promise<void>;
  focusNode: (id: string) => void;
}): React.ReactElement {
  return (
    <div>
      <RetrievalGuidancePanel guidance={guidance} />
      {results.length === 0 ? (
        <div className="result">No results.</div>
      ) : (
        results.map((row) => (
          <article key={row.id} className="result searchResult">
            <button className="resultOpen" onClick={() => void openRecord(row.id)}>
              <b>{row.heading ?? row.sourceTitle ?? row.id}</b>
              <span className="meta">
                {row.id} / score {Number(row.score ?? 0).toFixed(2)}
              </span>
              <span className="resultSnippet">{row.snippet}</span>
            </button>
            <button
              className="secondary"
              onClick={() => focusNode(row.id)}
            >
              Focus graph
            </button>
            {row.relatedFailures?.map((failure) => (
              <div className="warn" key={failure.id}>
                <b>Known failed path</b>
                <p>{failure.doNotRepeat}</p>
              </div>
            ))}
          </article>
        ))
      )}
    </div>
  );
}

function RetrievalGuidancePanel({ guidance }: { guidance?: RetrievalGuidance }): React.ReactElement {
  if (!guidance) return <></>;
  return (
    <div className="guidancePanel">
      <div className="chips">
        <span>confidence: {guidance.confidence}</span>
        <span>{guidance.resultCount} results</span>
        <span>{guidance.citationCount} citations</span>
        <span>{guidance.relatedFailureCount} failure warnings</span>
      </div>
      <div className="meta">{guidance.recommendedNextStep}</div>
      {guidance.doNotRepeat.length > 0 && (
        <div className="warn">
          <b>Do not repeat</b>
          {guidance.doNotRepeat.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordView({
  record,
  focusNode,
  openRecord,
}: {
  record?: MemoryRecord;
  focusNode: (id: string) => void;
  openRecord: (id: string) => Promise<void>;
}): React.ReactElement {
  if (!record) return <div className="warn">No record found.</div>;
  const text = recordText(record);
  const citations = parseArray(record.source_ids_json).concat(parseArray(record.section_ids_json));
  return (
    <div className="record">
      <div className="chips">
        <span>{record.recordType}</span>
        <button onClick={() => focusNode(record.id)}>Focus graph</button>
      </div>
      <Markdown text={text} />
      <CitationButtons ids={citations} openRecord={openRecord} />
    </div>
  );
}

function CitationButtons({
  ids,
  openRecord,
}: {
  ids: string[];
  openRecord: (id: string) => Promise<void>;
}): React.ReactElement {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return <></>;
  return (
    <div className="chips">
      {uniqueIds.map((id) => (
        <button className="linkChip" key={id} onClick={() => void openRecord(id)}>
          {id}
        </button>
      ))}
    </div>
  );
}

function Modal({
  title: titleText,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);
  return (
    <div ref={dialogRef} className="modalBackdrop open" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal">
        <div className="modalHeader">
          <h2 id={titleId}>{titleText}</h2>
          <button aria-label="Close modal" onClick={close}>
            Close
          </button>
        </div>
        <div className="modalBody">{children}</div>
      </div>
    </div>
  );
}

function RailSection({ title: titleText, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="menuSection visible">
      <h2>{titleText}</h2>
      {children}
    </section>
  );
}

function PinnedSearchButtons({
  apply,
}: {
  apply: (preset: (typeof pinnedSearchPresets)[number]) => void;
}): React.ReactElement {
  return (
    <div className="pinnedSearches">
      <h2>Pinned</h2>
      {pinnedSearchPresets.map((preset) => (
        <button key={preset.name} onClick={() => apply(preset)}>
          {preset.name}
        </button>
      ))}
    </div>
  );
}

function EdgeControls({
  state,
  setGraph,
}: {
  state: GraphState;
  setGraph: React.Dispatch<React.SetStateAction<GraphPayload>>;
}): React.ReactElement {
  const selected = new Set(state.edgeTypes ?? ["root", "contains", "cites", "next"]);
  return (
    <div className="edgeFilters">
      {(["root", "contains", "cites", "next"] as const).map((edge) => (
        <label key={edge}>
          <input
            type="checkbox"
            checked={selected.has(edge)}
            onChange={(event) =>
              setGraph((current) => ({
                ...current,
                state: { ...current.state, edgeTypes: toggleInSet(selected, edge, event.target.checked) },
              }))
            }
          />
          {edge}
        </label>
      ))}
    </div>
  );
}

function PhysicsControls({
  state,
  setGraph,
}: {
  state: GraphState;
  setGraph: React.Dispatch<React.SetStateAction<GraphPayload>>;
}): React.ReactElement {
  const physics: PhysicsSettings = { ...defaultPhysics, ...(state.physics ?? {}) };
  const set = (key: keyof PhysicsSettings, value: number) =>
    setGraph((current) => ({ ...current, state: { ...current.state, physics: { ...physics, [key]: value } } }));
  return (
    <div className="physics">
      <label>
        Repel
        <input
          type="range"
          min="600"
          max="3200"
          value={physics.repulsion}
          onChange={(event) => set("repulsion", Number(event.target.value))}
        />
      </label>
      <label>
        Links
        <input
          type="range"
          min="80"
          max="260"
          value={physics.linkDistance}
          onChange={(event) => set("linkDistance", Number(event.target.value))}
        />
      </label>
    </div>
  );
}

function rootOverviewPayload(data: GraphPayload): GraphPayload {
  return {
    ...data,
    state: {
      ...(data.state ?? {}),
      mode: "all",
      collapsed: [],
      collapsedBranches: [],
    },
  };
}

function treeWorldSize(
  nodes: GraphNode[],
  edges: GraphEdge[],
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  const levels = treeLevels(nodes, edges);
  const maxRows = Math.max(1, ...levels.map((level) => level.length));
  return {
    width: Math.max(viewportWidth, levels.length * 280 + 180, viewportWidth * 1.4),
    height: Math.max(viewportHeight, maxRows * 82 + 140, viewportHeight * 1.2),
  };
}

function computeTreeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  selectedId: string,
): Map<string, LayoutPoint> {
  const levels = treeLevels(nodes, edges, selectedId);
  const positions = new Map<string, LayoutPoint>();
  const columnGap = Math.max(220, Math.min(320, (width - 160) / Math.max(1, levels.length - 1)));
  levels.forEach((level, depth) => {
    const sorted = [...level].sort(compareTreeNodes);
    const rowGap = Math.max(58, Math.min(96, (height - 120) / Math.max(1, sorted.length + 1)));
    const startY = height / 2 - ((sorted.length - 1) * rowGap) / 2;
    sorted.forEach((node, index) => {
      positions.set(node.id, {
        x: 90 + depth * columnGap,
        y: startY + index * rowGap,
      });
    });
  });
  return positions;
}

function treeLevels(nodes: GraphNode[], edges: GraphEdge[], selectedId = ""): GraphNode[][] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.length === 0) return [];
  const rootId = nodeById.has("root:neurakeep")
    ? "root:neurakeep"
    : selectedId && nodeById.has(selectedId)
      ? selectedId
      : (nodes.find((node) => node.type === "root")?.id ?? nodes[0].id);
  const children = new Map<string, string[]>();
  const undirected = new Map<string, string[]>();
  for (const edge of edges) {
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    undirected.set(edge.from, [...(undirected.get(edge.from) ?? []), edge.to]);
    undirected.set(edge.to, [...(undirected.get(edge.to) ?? []), edge.from]);
  }
  const levels: GraphNode[][] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.id)) continue;
    const node = nodeById.get(item.id);
    if (!node) continue;
    visited.add(item.id);
    levels[item.depth] = [...(levels[item.depth] ?? []), node];
    const nextIds = children.get(item.id)?.length ? children.get(item.id)! : (undirected.get(item.id) ?? []);
    for (const next of nextIds) {
      if (!visited.has(next) && nodeById.has(next)) queue.push({ id: next, depth: item.depth + 1 });
    }
  }
  const unvisited = nodes.filter((node) => !visited.has(node.id));
  if (unvisited.length > 0) levels.push(unvisited);
  return levels.filter((level) => level.length > 0);
}

function compareTreeNodes(a: GraphNode, b: GraphNode): number {
  const typeOrder: Record<GraphNode["type"], number> = {
    root: 0,
    cluster: 1,
    source: 2,
    section: 3,
    event: 4,
    decision: 4,
    fact: 5,
    failure: 6,
  };
  const rootOrder: Record<string, number> = {
    "root:neurakeep": 0,
    "root:sources": 1,
    "root:sections": 2,
    "root:decisions": 3,
    "root:facts": 4,
    "root:failures": 5,
  };
  return (
    (rootOrder[a.id] ?? typeOrder[a.type] ?? 99) - (rootOrder[b.id] ?? typeOrder[b.type] ?? 99) ||
    a.label.localeCompare(b.label)
  );
}

function graphModeIds(
  graph: GraphPayload,
  mode: string,
  selectedId: string,
  focusIds: Set<string> | null,
): Set<string> | null {
  if (mode === "focused") {
    if (focusIds) return focusIds;
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    graph.edges.forEach((edge) => {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    });
    return ids;
  }
  if (mode === "all") return null;
  const ids = new Set<string>();
  const addNeighbors = () =>
    graph.edges.forEach((edge) => {
      if (ids.has(edge.from)) ids.add(edge.to);
      if (ids.has(edge.to)) ids.add(edge.from);
    });
  if (mode === "source")
    graph.nodes
      .filter((node) => node.type === "root" || node.type === "source" || node.id === selectedId)
      .forEach((node) => ids.add(node.id));
  if (mode === "failures") graph.nodes.filter((node) => node.type === "failure").forEach((node) => ids.add(node.id));
  if (mode === "decisions")
    graph.nodes
      .filter((node) => node.type === "event" && /decision|decided|direction/i.test(node.label))
      .forEach((node) => ids.add(node.id));
  addNeighbors();
  return ids;
}

function mergeGraphPayload(current: GraphPayload, incoming: GraphPayload): GraphPayload {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const node of current.nodes) nodes.set(node.id, node);
  for (const node of incoming.nodes) nodes.set(node.id, node);
  for (const edge of current.edges) edges.set(`${edge.from}->${edge.to}:${edge.type}`, edge);
  for (const edge of incoming.edges) edges.set(`${edge.from}->${edge.to}:${edge.type}`, edge);
  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    hiddenNeighbors: { ...(current.hiddenNeighbors ?? {}), ...(incoming.hiddenNeighbors ?? {}) },
    state: { ...(current.state ?? {}), mode: "all", collapsedBranches: current.state?.collapsedBranches ?? [] },
    meta: {
      ...(incoming.meta ??
        current.meta ?? {
          totalNodes: nodes.size,
          totalEdges: edges.size,
          visibleNodes: nodes.size,
          visibleEdges: edges.size,
          focusId: null,
          depth: 1,
          limit: nodes.size,
          truncated: false,
        }),
      visibleNodes: nodes.size,
      visibleEdges: edges.size,
    },
  };
}

function branchHiddenIds(graph: GraphPayload, roots: string[]): Set<string> {
  const hidden = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const distances = graphRootDistances(graph, adjacency);
  for (const root of roots) {
    const rootDistance = distances.get(root) ?? 0;
    const queue = (adjacency.get(root) ?? [])
      .filter((id) => (distances.get(id) ?? Number.MAX_SAFE_INTEGER) > rootDistance)
      .map((id) => ({ id, parent: root }));
    const visited = new Set<string>([root]);
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      const node = graph.nodes.find((candidate) => candidate.id === item.id);
      if (!node || node.type === "root") continue;
      hidden.add(item.id);
      const distance = distances.get(item.id) ?? Number.MAX_SAFE_INTEGER;
      for (const next of adjacency.get(item.id) ?? []) {
        if (next === item.parent) continue;
        if ((distances.get(next) ?? Number.MAX_SAFE_INTEGER) >= distance) {
          queue.push({ id: next, parent: item.id });
        }
      }
    }
  }
  return hidden;
}

function hiddenNeighborCounts(graph: GraphPayload, visibleIds: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, count] of Object.entries(graph.hiddenNeighbors ?? {})) {
    if (visibleIds.has(id) && count > 0) counts.set(id, count);
  }
  for (const edge of graph.edges) {
    if (visibleIds.has(edge.from) && !visibleIds.has(edge.to)) counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    if (visibleIds.has(edge.to) && !visibleIds.has(edge.from)) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  }
  return counts;
}

function graphBreadcrumb(graph: GraphPayload, selectedId: string): GraphNode[] {
  if (!selectedId) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(selectedId)) return [];
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const parent = new Map<string, string | null>([["root:neurakeep", null]]);
  const queue = ["root:neurakeep"];
  while (queue.length > 0 && !parent.has(selectedId)) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, id);
      queue.push(next);
    }
  }
  if (!parent.has(selectedId)) return [nodeById.get(selectedId)!];
  const path: GraphNode[] = [];
  let cursor: string | null = selectedId;
  while (cursor) {
    const node = nodeById.get(cursor);
    if (node) path.unshift(node);
    cursor = parent.get(cursor) ?? null;
  }
  return path.slice(0, 5);
}

function graphRootDistances(graph: GraphPayload, adjacency: Map<string, string[]>): Map<string, number> {
  const distances = new Map<string, number>();
  const queue = ["root:neurakeep"];
  distances.set("root:neurakeep", 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const distance = distances.get(id) ?? 0;
    for (const next of adjacency.get(id) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  for (const node of graph.nodes) {
    if (!distances.has(node.id)) distances.set(node.id, Number.MAX_SAFE_INTEGER);
  }
  return distances;
}

function togglePin(
  id: string,
  graph: GraphPayload,
  setGraph: React.Dispatch<React.SetStateAction<GraphPayload>>,
  save: (state: GraphState) => Promise<void>,
  toast: (message: string) => void,
): void {
  const pinned = new Set(graph.state.pinned ?? []);
  if (pinned.has(id)) pinned.delete(id);
  else pinned.add(id);
  const state = { ...graph.state, pinned: Array.from(pinned) };
  setGraph((current) => ({ ...current, state }));
  void save(state).then(() => toast(pinned.has(id) ? "Node pinned" : "Node unpinned"));
}

function toggleCollapse(
  id: string,
  graph: GraphPayload,
  setGraph: React.Dispatch<React.SetStateAction<GraphPayload>>,
  save: (state: GraphState) => Promise<void>,
  toast: (message: string) => void,
): void {
  const collapsed = new Set(graph.state.collapsed ?? []);
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  const state = { ...graph.state, collapsed: Array.from(collapsed) };
  setGraph((current) => ({ ...current, state }));
  void save(state).then(() => toast(collapsed.has(id) ? "Node collapsed" : "Node expanded"));
}

function selectedMap(diff: ProposalDiff, value: boolean): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  (["events", "facts", "failures"] as Array<keyof ProposalDiff>).forEach((kind) =>
    diff[kind].forEach((_, index) => {
      map[`${kind}:${index}`] = value;
    }),
  );
  return map;
}

function cleanSelected(
  diff: ProposalDiff,
  warnings: Array<{ itemType: string; itemId: string }>,
): Record<string, boolean> {
  const map = selectedMap(diff, true);
  const blocked = new Set(warnings.map((warning) => warning.itemId));
  (["events", "facts", "failures"] as Array<keyof ProposalDiff>).forEach((kind) =>
    diff[kind].forEach((item, index) => {
      if (blocked.has(item.id ?? "")) map[`${kind}:${index}`] = false;
    }),
  );
  return map;
}

function filterDiff(diff: ProposalDiff, selected: Record<string, boolean>): ProposalDiff {
  return {
    events: diff.events.filter((_, index) => selected[`events:${index}`]),
    facts: diff.facts.filter((_, index) => selected[`facts:${index}`]),
    failures: diff.failures.filter((_, index) => selected[`failures:${index}`]),
  };
}

function countItems(diff: ProposalDiff): number {
  return diff.events.length + diff.facts.length + diff.failures.length;
}

function toggleInSet(set: Set<string>, value: string, checked: boolean): string[] {
  const next = new Set(set);
  if (checked) next.add(value);
  else next.delete(value);
  return Array.from(next);
}

function recordTitle(record: MemoryRecord | undefined, fallback: string): string {
  return record?.title ?? record?.heading ?? record?.summary ?? record?.subject ?? record?.attempted ?? fallback;
}

function recordText(record: MemoryRecord): string {
  if (record.recordType === "source" && Array.isArray(record.sections)) {
    return record.sections
      .map((section) => `${section.heading ? `# ${section.heading}\n\n` : ""}${section.body ?? ""}`)
      .join("\n\n---\n\n");
  }
  if (record.recordType === "section") return record.body ?? "";
  if (record.recordType === "fact") return [record.subject, record.predicate, record.object].filter(Boolean).join(" ");
  if (record.recordType === "failure")
    return `Attempted: ${record.attempted ?? ""}\nFailed because: ${record.failed_because ?? ""}\nDo not repeat: ${record.do_not_repeat ?? ""}`;
  return record.summary ?? JSON.stringify(record, null, 2);
}

function plainWarning(message: string): string {
  return message
    .replace(/generic_api_key/gi, "possible placeholder or exposed API key")
    .replace(/prompt[_ -]?injection/gi, "possible prompt injection")
    .replace(/secret/gi, "sensitive secret")
    .replace(/blocked/gi, "blocked until reviewed");
}

function parseArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function textToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function copyText(value: string, toast: (message: string, type?: Toast["type"]) => void): void {
  navigator.clipboard
    ?.writeText(value)
    .then(() => toast("Copied"))
    .catch(() => toast("Copy failed", "error"));
}

function readGraphViews(): GraphSavedView[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("neurakeep_graph_views") ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is GraphSavedView =>
          Boolean((item as GraphSavedView).name && (item as GraphSavedView).view),
        )
      : [];
  } catch {
    return [];
  }
}

function routeLabel(value: RouteName): string {
  if (value === "proposals") return "Props";
  if (value === "connect") return "MCP";
  if (value === "activity") return "Audit";
  if (value === "universe") return "Universe";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function routeFromHash(): RouteName {
  const route = window.location.hash.replace(/^#/, "");
  if (route === "props") return "proposals";
  if (window.location.pathname === "/app/universe") return "universe";
  return ["graph", "universe", "search", "inbox", "proposals", "connect", "activity", "quality", "settings"].includes(
    route,
  )
    ? (route as RouteName)
    : "graph";
}

interface OAuthBrowserRequest {
  clientName: string;
  parameters: Record<string, string>;
}

function oauthRequestFromLocation(): OAuthBrowserRequest | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("oauth") !== "1") return null;
  const names = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "state",
    "resource",
  ];
  const parameters: Record<string, string> = {};
  for (const name of names) {
    const value = params.get(name);
    if (value) parameters[name] = value;
  }
  if (!parameters.client_id || !parameters.redirect_uri || !parameters.code_challenge || !parameters.resource)
    return null;
  return { clientName: params.get("client_name")?.trim().slice(0, 80) || "MCP client", parameters };
}

interface SearchResult {
  id: string;
  heading?: string;
  sourceTitle?: string;
  score?: number;
  snippet?: string;
  relatedFailures?: Array<{ id: string; doNotRepeat: string }>;
}

interface RetrievalGuidance {
  confidence: string;
  resultCount: number;
  citationCount: number;
  relatedFailureCount: number;
  doNotRepeat: string[];
  recommendedNextStep: string;
}

type MemoryRecord = Record<string, any>;

interface GraphSavedView {
  name: string;
  view: { x: number; y: number; scale: number };
  selectedId: string;
  state: GraphState;
}

interface SearchFilters {
  dateFrom: string;
  dateTo: string;
  project: string;
  sensitivity: string;
  sourceOrigin: string;
  memoryType: string;
  failuresOnly: boolean;
}

createRoot(document.getElementById("root")!).render(<App />);
