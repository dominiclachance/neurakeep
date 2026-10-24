import { describe, expect, it } from "vitest";
import { GraphModel, type GraphOverview, type NeighborPage } from "../src/web/src/graph/GraphModel.js";

function overview(): GraphOverview {
  return {
    root: { id: "root:neurakeep", label: "NeuraKeep", type: "root" },
    clusters: [{ id: "cluster:type:source", key: "source", label: "Sources", kind: "type", count: 2, sampleIds: [] }],
    hubs: [],
    edges: [{ from: "root:neurakeep", to: "cluster:type:source", type: "root" }],
    generatedAt: new Date(0).toISOString(),
  };
}

function page(nodes: NeighborPage["nodes"], edges: NeighborPage["edges"] = []): NeighborPage {
  return { nodes, edges, nextCursor: null, remaining: 0, total: nodes.length };
}

describe("GraphModel", () => {
  it("recursively collapses descendants and reports every cursor owner to clear", () => {
    const model = new GraphModel();
    model.mergeOverview(overview());
    model.expand(
      "cluster:type:source",
      page(
        [
          { id: "source:one", label: "One", type: "source" },
          { id: "source:two", label: "Two", type: "source" },
        ],
        [
          { from: "cluster:type:source", to: "source:one", type: "cluster" },
          { from: "cluster:type:source", to: "source:two", type: "cluster" },
        ],
      ),
    );
    model.expand(
      "source:one",
      page(
        [{ id: "section:one", label: "Section", type: "section" }],
        [{ from: "source:one", to: "section:one", type: "contains" }],
      ),
    );

    expect(new Set(model.collapse("cluster:type:source"))).toEqual(
      new Set(["cluster:type:source", "source:one"]),
    );
    expect(model.graph.nodes().sort()).toEqual(["cluster:type:source", "root:neurakeep"]);
    expect(model.expandedBranches()).toEqual([]);
  });

  it("preserves overview nodes shared with expanded branches", () => {
    const model = new GraphModel();
    const initial = overview();
    initial.hubs.push({ id: "source:hub", label: "Hub", type: "source", degree: 5 });
    initial.edges.push({ from: "cluster:type:source", to: "source:hub", type: "cluster" });
    model.mergeOverview(initial);
    model.expand(
      "cluster:type:source",
      page([{ id: "source:hub", label: "Hub", type: "source", degree: 5 }]),
    );

    model.collapse("cluster:type:source");

    expect(model.graph.hasNode("source:hub")).toBe(true);
  });
});
