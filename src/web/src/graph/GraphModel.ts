import { MultiGraph } from "graphology";
import type { Attributes } from "graphology-types";
import type { GraphEdge, GraphNode, GraphState } from "../types.js";
import { decoratedLabel } from "./programs.js";

export interface OverviewCluster {
  id: string;
  key: string;
  label: string;
  kind: string;
  count: number;
  sampleIds: string[];
}

export interface GraphOverview {
  root: GraphNode & { count?: number };
  clusters: OverviewCluster[];
  hubs: Array<GraphNode & { degree?: number }>;
  edges: GraphEdge[];
  generatedAt: string;
}

export interface NeighborPage {
  nodes: Array<GraphNode & { degree?: number; remaining?: number }>;
  edges: GraphEdge[];
  nextCursor: string | null;
  remaining: number;
  total: number;
}

export interface GraphNodeAttributes extends Attributes {
  label: string;
  type: GraphNode["type"] | "cluster";
  x: number;
  y: number;
  size: number;
  color: string;
  space?: string;
  trustLevel?: string;
  sensitivity?: string;
  count?: number;
  remaining?: number;
  fixed?: boolean;
  overview?: boolean;
  clusterSeeded?: boolean;
}

const kindColors: Record<string, string> = {
  root: "#b983ff",
  cluster: "#9a7fd1",
  source: "#4da3ff",
  section: "#6bd78f",
  fact: "#e7dc79",
  event: "#f4c84a",
  decision: "#e5a93d",
  failure: "#ff6b6b",
};

export class GraphModel {
  readonly graph = new MultiGraph<GraphNodeAttributes, Attributes>({ allowSelfLoops: false });
  readonly softCap: number;
  clusterBy: "type" | "space" | "trust" | "sensitivity" = "type";
  private readonly overviewIds = new Set<string>();
  private readonly branchNodes = new Map<string, Set<string>>();
  private readonly branchOrder: string[] = [];

  constructor(softCap = 5_000) {
    this.softCap = Math.max(100, softCap);
  }

  mergeOverview(overview: GraphOverview): void {
    this.graph.clear();
    this.overviewIds.clear();
    this.branchNodes.clear();
    this.branchOrder.splice(0);
    this.mergeNode(overview.root, true);
    for (const cluster of overview.clusters) {
      if (this.graph.order >= this.softCap) break;
      this.mergeNode({ ...cluster, type: "cluster", remaining: cluster.count }, true);
    }
    for (const hub of overview.hubs) {
      if (this.graph.order >= this.softCap) break;
      this.mergeNode(hub, true);
    }
    for (const edge of overview.edges) this.mergeEdge(edge);
  }

  expand(parentId: string, page: NeighborPage): void {
    let incoming = page.nodes.filter((node) => !this.graph.hasNode(node.id)).length;
    while (this.graph.order + incoming > this.softCap) {
      const oldest = this.branchOrder.find((branch) => branch !== parentId);
      if (!oldest) break;
      this.collapse(oldest);
      incoming = page.nodes.filter((node) => !this.graph.hasNode(node.id)).length;
    }
    const owned = this.branchNodes.get(parentId) ?? new Set<string>();
    let available = Math.max(0, this.softCap - this.graph.order);
    let omitted = 0;
    for (const node of page.nodes) {
      if (!this.graph.hasNode(node.id)) {
        if (available === 0) {
          omitted += 1;
          continue;
        }
        available -= 1;
      }
      this.mergeNode(node, false);
      if (!this.overviewIds.has(node.id)) owned.add(node.id);
    }
    for (const edge of page.edges) this.mergeEdge(edge);
    this.branchNodes.set(parentId, owned);
    const existingIndex = this.branchOrder.indexOf(parentId);
    if (existingIndex >= 0) this.branchOrder.splice(existingIndex, 1);
    this.branchOrder.push(parentId);
    if (this.graph.hasNode(parentId)) {
      this.graph.mergeNodeAttributes(parentId, { remaining: page.remaining + omitted });
      const attributes = this.graph.getNodeAttributes(parentId);
      this.graph.setNodeAttribute(parentId, "label", decoratedLabel(attributes));
    }
    this.evictOldestBranches(parentId);
  }

  collapse(parentId: string): string[] {
    const collapsed = new Set<string>();
    this.collapseBranch(parentId, collapsed);
    return [...collapsed];
  }

  private collapseBranch(parentId: string, collapsed: Set<string>): void {
    const owned = this.branchNodes.get(parentId);
    if (!owned) return;
    collapsed.add(parentId);
    this.branchNodes.delete(parentId);
    const index = this.branchOrder.indexOf(parentId);
    if (index >= 0) this.branchOrder.splice(index, 1);
    for (const id of owned) {
      if (id !== parentId && this.branchNodes.has(id)) this.collapseBranch(id, collapsed);
    }
    for (const id of owned) {
      if (!this.overviewIds.has(id) && !this.isOwnedElsewhere(id, parentId) && this.graph.hasNode(id))
        this.graph.dropNode(id);
    }
    if (this.graph.hasNode(parentId)) {
      this.graph.mergeNodeAttributes(parentId, { remaining: undefined });
      const attributes = this.graph.getNodeAttributes(parentId);
      this.graph.setNodeAttribute(parentId, "label", decoratedLabel(attributes));
    }
  }

  setClusterBy(clusterBy: GraphModel["clusterBy"]): void {
    this.clusterBy = clusterBy;
  }

  mergeLocated(node: GraphNode): void {
    this.mergeNode(node, false);
  }

  pin(id: string, position?: { x: number; y: number }): void {
    if (!this.graph.hasNode(id)) return;
    this.graph.mergeNodeAttributes(id, { ...position, fixed: true });
  }

  unpin(id: string): void {
    if (this.graph.hasNode(id)) this.graph.setNodeAttribute(id, "fixed", false);
  }

  serialize(base: GraphState = {}): GraphState {
    const layout: NonNullable<GraphState["layout"]> = {};
    const pinned: string[] = [];
    this.graph.forEachNode((id, attributes) => {
      layout[id] = { x: attributes.x, y: attributes.y, pinned: Boolean(attributes.fixed) };
      if (attributes.fixed) pinned.push(id);
    });
    return { ...base, clusterBy: this.clusterBy, layout, pinned };
  }

  restore(state: GraphState): void {
    this.setClusterBy(normalizeClusterBy(state.clusterBy));
    const pinned = new Set(state.pinned ?? []);
    for (const [id, position] of Object.entries(state.layout ?? {})) {
      if (!this.graph.hasNode(id)) continue;
      this.graph.mergeNodeAttributes(id, {
        x: finite(position.x, this.graph.getNodeAttribute(id, "x")),
        y: finite(position.y, this.graph.getNodeAttribute(id, "y")),
        fixed: Boolean(position.pinned || pinned.has(id)),
      });
    }
  }

  expandedBranches(): string[] {
    return [...this.branchOrder];
  }

  contentNodeCount(): number {
    let count = 0;
    this.graph.forEachNode((_id, attributes) => {
      if (attributes.type !== "root" && attributes.type !== "cluster") count += 1;
    });
    return count;
  }

  private mergeNode(node: GraphNode & Partial<GraphNodeAttributes>, overview: boolean): void {
    const existing = this.graph.hasNode(node.id) ? this.graph.getNodeAttributes(node.id) : undefined;
    const seed = seedPosition(node.id, node.type);
    this.graph.mergeNode(node.id, {
      ...existing,
      label: displayLabel(node.label, node.type, node.remaining),
      rawLabel: node.label,
      type: node.type,
      space: node.space,
      trustLevel: node.trustLevel,
      sensitivity: node.sensitivity,
      count: node.count,
      remaining: node.remaining,
      x: existing?.x ?? node.x ?? seed.x,
      y: existing?.y ?? node.y ?? seed.y,
      size: node.size ?? Math.min(18, 4 + Math.log2(2 + Number(node.count ?? node.degree ?? 0))),
      color: node.color ?? kindColors[node.type] ?? kindColors.section,
      fixed: existing?.fixed ?? node.fixed ?? false,
      overview,
      clusterSeeded: existing?.clusterSeeded ?? false,
    });
    if (overview) this.overviewIds.add(node.id);
  }

  private mergeEdge(edge: GraphEdge): void {
    if (!this.graph.hasNode(edge.from) || !this.graph.hasNode(edge.to)) return;
    const key = `${edge.type}:${edge.from}:${edge.to}`;
    if (!this.graph.hasEdge(key))
      this.graph.addEdgeWithKey(key, edge.from, edge.to, { type: edge.type, color: "#59636d", size: 0.7 });
  }

  private evictOldestBranches(except: string): void {
    while (this.graph.order > this.softCap) {
      const oldest = this.branchOrder.find((branch) => branch !== except);
      if (!oldest) break;
      this.collapse(oldest);
    }
  }

  private isOwnedElsewhere(id: string, branch: string): boolean {
    for (const [owner, nodes] of this.branchNodes) if (owner !== branch && nodes.has(id)) return true;
    return false;
  }
}

function seedPosition(id: string, type: string): { x: number; y: number } {
  let hash = 2166136261;
  for (const char of `${type}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const angle = ((hash >>> 0) % 3600) * (Math.PI / 1800);
  const radius = 20 + ((hash >>> 8) % 800) / 10;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function normalizeClusterBy(value: string | undefined): GraphModel["clusterBy"] {
  return value === "space" || value === "trust" || value === "sensitivity" ? value : "type";
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function displayLabel(label: string, type: string, remaining?: number): string {
  const glyph =
    { root: "◆", cluster: "◉", source: "▣", section: "§", fact: "●", event: "◇", decision: "◇", failure: "!" }[type] ??
    "•";
  return `${glyph} ${label}${Number(remaining ?? 0) > 0 ? `  +${remaining}` : ""}`;
}
