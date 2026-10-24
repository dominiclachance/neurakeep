import { MultiGraph } from "graphology";
import noverlap from "graphology-layout-noverlap";

const overlap = noverlap as unknown as {
  assign: (graph: MultiGraph, parameters: Record<string, unknown>) => void;
};

interface WorkerNode {
  id: string;
  x: number;
  y: number;
  size: number;
  fixed: boolean;
}

self.onmessage = (event: MessageEvent<{ nodes: WorkerNode[]; maxIterations: number; margin: number }>) => {
  const graph = new MultiGraph({ allowSelfLoops: false });
  const fixed = new Map<string, { x: number; y: number }>();
  for (const node of event.data.nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y, size: node.size });
    if (node.fixed) fixed.set(node.id, { x: node.x, y: node.y });
  }
  overlap.assign(graph, {
    maxIterations: event.data.maxIterations,
    settings: { margin: event.data.margin, ratio: 1.1 },
  });
  const positions = graph.mapNodes((id, attributes) => [id, fixed.get(id) ?? { x: attributes.x, y: attributes.y }]);
  self.postMessage({ positions });
};
