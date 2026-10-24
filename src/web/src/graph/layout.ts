import type { GraphModel } from "./GraphModel.js";
import type { GraphState } from "../types.js";

interface ForceAtlasParameters {
  iterations: number;
  settings: {
    barnesHutOptimize: boolean;
    barnesHutTheta: number;
    scalingRatio: number;
    gravity: number;
    slowDown: number;
    adjustSizes: boolean;
  };
}

export const anchorMap: Record<string, { x: number; y: number }> = {
  source: { x: -80, y: -25 },
  section: { x: -20, y: 55 },
  fact: { x: 55, y: 45 },
  event: { x: 75, y: -15 },
  decision: { x: 75, y: -15 },
  failure: { x: 15, y: -75 },
  root: { x: 0, y: 0 },
  cluster: { x: 0, y: 0 },
};

export function seedClusters(model: GraphModel): void {
  model.graph.forEachNode((id, attributes) => {
    if (attributes.fixed || attributes.clusterSeeded) return;
    const key =
      model.clusterBy === "type"
        ? attributes.type
        : model.clusterBy === "space"
          ? (attributes.space ?? "unknown")
          : model.clusterBy === "trust"
            ? (attributes.trustLevel ?? "unknown")
            : (attributes.sensitivity ?? "unknown");
    const anchor = anchorForKey(key);
    const jitter = hashAnchor(id);
    model.graph.mergeNodeAttributes(id, {
      x: anchor.x + jitter.x * 0.12,
      y: anchor.y + jitter.y * 0.12,
      clusterSeeded: true,
    });
  });
}

export function anchorForKey(key: string): { x: number; y: number } {
  return anchorMap[key] ?? hashAnchor(key);
}

export function forceAtlasSettings(state: GraphState): ForceAtlasParameters {
  const physics = state.physics ?? {
    repulsion: 280,
    linkDistance: 85,
    clusterStrength: 0.12,
    collisionRadius: 26,
    iterations: 160,
  };
  return {
    iterations: Math.max(1, Math.min(1_000, physics.iterations)),
    settings: {
      barnesHutOptimize: true,
      barnesHutTheta: 0.6,
      scalingRatio: Math.max(0.1, physics.repulsion / 100),
      gravity: Math.max(0.01, physics.clusterStrength * 10),
      slowDown: Math.max(1, physics.linkDistance / 15),
      adjustSizes: true,
    },
  };
}

export function settleLayout(model: GraphModel, state: GraphState, reducedMotion: boolean): void {
  seedClusters(model);
  void state;
  void reducedMotion;
}

export function runNoverlapInWorker(
  model: GraphModel,
  state: GraphState,
  reducedMotion: boolean,
): Promise<Array<[string, { x: number; y: number }]>> {
  if (model.graph.order < 2) return Promise.resolve([]);
  const nodes = model.graph.mapNodes((id, attributes) => ({
    id,
    x: attributes.x,
    y: attributes.y,
    size: attributes.size,
    fixed: Boolean(attributes.fixed),
  }));
  const worker = new Worker(new URL("./layoutNoverlapWorker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ positions: Array<[string, { x: number; y: number }]> }>) => {
      worker.terminate();
      resolve(event.data.positions);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Noverlap worker failed"));
    };
    worker.postMessage({
      nodes,
      maxIterations: reducedMotion ? 40 : 120,
      margin: Math.max(2, (state.physics?.collisionRadius ?? 26) / 5),
    });
  });
}

function hashAnchor(value: string): { x: number; y: number } {
  let hash = 0;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 0x45d9f3b);
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  return { x: Math.cos(angle) * 90, y: Math.sin(angle) * 90 };
}
