import React, { useEffect, useMemo, useRef, useState } from "react";
import { Graph as CosmosGraph } from "@cosmos.gl/graph";
import { apiClient, locateGraphNodes } from "../api.js";
import type { GraphNode } from "../types.js";
import { anchorForKey } from "./layout.js";
import "./graph.css";

interface EncodedArray {
  type: "Uint8Array" | "Uint32Array" | "Float32Array";
  length: number;
  data: string;
}

interface UniversePayload {
  encoding: "base64-le";
  pointCount: number;
  totalPointCount: number;
  ids: string[];
  links: EncodedArray;
  pointTypes: EncodedArray;
  pointClusters: EncodedArray;
  typeLabels: string[];
  clusterLabels: string[];
  positions: EncodedArray | null;
  sampled: boolean;
  note: string | null;
}

const UNIVERSE_POINT_CAP = 12_000;

export default function UniverseView({
  openRecord,
  toast,
  readOnly = false,
}: {
  openRecord: (id: string) => Promise<void>;
  toast: (message: string, type?: "ok" | "error") => void;
  readOnly?: boolean;
}): React.ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const cosmos = useRef<CosmosGraph | null>(null);
  const ids = useRef<string[]>([]);
  const [clusterBy, setClusterBy] = useState("type");
  const [payload, setPayload] = useState<UniversePayload | null>(null);
  const [hover, setHover] = useState<GraphNode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const selectionStart = useRef<[number, number] | null>(null);
  const supported = useMemo(() => supportsUniverse(), []);

  useEffect(() => {
    if (!supported || !container.current) return;
    let cancelled = false;
    setLoading(true);
    apiClient
      .api<UniversePayload>(
        `/api/graph/universe?clusterBy=${encodeURIComponent(clusterBy)}&cap=${UNIVERSE_POINT_CAP}`,
      )
      .then(async (data) => {
        if (cancelled || !container.current) return;
        setPayload(data);
        ids.current = data.ids;
        const graph = new CosmosGraph(container.current, {
          backgroundColor: "#111315",
          pointDefaultColor: "#6bd78f",
          pointDefaultSize: 3,
          linkDefaultColor: "#43505b",
          linkOpacity: 0.28,
          renderHoveredPointRing: true,
          simulationCluster: 0.18,
          simulationCollision: 0.15,
          onPointMouseOver: (index: number) => {
            const id = ids.current[index];
            if (!id) return;
            void apiClient
              .api<{ nodes: GraphNode[] }>(`/api/graph/locate?id=${encodeURIComponent(id)}`)
              .then((result) => setHover(result.nodes[0] ?? null));
          },
          onPointMouseOut: () => setHover(null),
          onPointClick: (index: number) => setSelected(ids.current[index] ?? null),
          onSimulationEnd: () => {
            if (readOnly || data.sampled) return;
            void graph
              .getPointPositionsAsync()
              .then((positions) =>
                apiClient.api("/api/graph/universe/positions", {
                  method: "POST",
                  body: JSON.stringify({ pointCount: data.pointCount, positions: encodeArray(positions) }),
                }),
              )
              .catch((error: Error) => {
                if (!cancelled) toast(`Universe positions were not saved: ${error.message}`, "error");
              });
          },
        });
        cosmos.current = graph;
        graph.setLinks(Float32Array.from(decodeArray(data.links) as Uint32Array));
        const clusters = decodeArray(data.pointClusters) as Uint8Array;
        graph.setPointClusters(Array.from(clusters));
        graph.setClusterPositions(clusterPositions(data.clusterLabels));
        graph.setPointColors(pointColors(decodeArray(data.pointTypes) as Uint8Array, data.typeLabels));
        if (data.positions) graph.setPointPositions(decodeArray(data.positions) as Float32Array, true);
        graph.render();
        await graph.ready;
      })
      .catch((error: Error) => toast(error.message, "error"))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
      cosmos.current?.destroy();
      cosmos.current = null;
    };
  }, [clusterBy, readOnly, supported, toast]);

  const runSearch = async (): Promise<void> => {
    const result = await locateGraphNodes(query, 100);
    const index = new Map(ids.current.map((id, pointIndex) => [id, pointIndex]));
    const highlighted = result.nodes
      .map((node) => index.get(node.id))
      .filter((value): value is number => value !== undefined);
    cosmos.current?.setConfigPartial({ highlightedPointIndices: highlighted, outlinedPointIndices: highlighted });
    setReview(result.nodes.map((node) => node.id));
  };

  const openWorkingGraph = (id: string): void => {
    localStorage.setItem("neurakeep_graph_focus", id);
    window.location.hash = "graph";
  };

  if (!supported) {
    return (
      <section className="graphFallback" data-testid="universe-fallback">
        <h2>Universe needs desktop WebGL 2</h2>
        <p>This GPU view is unavailable on iOS or this browser.</p>
        <button
          onClick={() => {
            window.location.hash = "graph";
          }}
        >
          Back to working graph
        </button>
      </section>
    );
  }

  return (
    <section className="universeView" data-testid="universe-view">
      <header className="sigmaToolbar">
        <label>
          Cluster by{" "}
          <select value={clusterBy} onChange={(event) => setClusterBy(event.target.value)}>
            <option value="type">Type</option>
            <option value="space">Space</option>
            <option value="trust">Trust</option>
            <option value="sensitivity">Sensitivity</option>
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Highlight search hits" />
          <button>Highlight</button>
        </form>
        <span>
          {payload
            ? `${payload.pointCount.toLocaleString()} points · ${(payload.links.length / 2).toLocaleString()} links`
            : loading
              ? "Loading…"
              : ""}
        </span>
      </header>
      {payload?.sampled && <div className="universeBanner">{payload.note}</div>}
      <p className="srOnly" id="universe-instructions">
        Search results are available in the review list. Hold Shift and drag across the canvas to review a region.
      </p>
      <div
        className="universeCanvas"
        ref={container}
        role="region"
        tabIndex={0}
        aria-label="Memory universe graph"
        aria-describedby="universe-instructions"
        onPointerDown={(event) => {
          if (event.shiftKey) selectionStart.current = [event.nativeEvent.offsetX, event.nativeEvent.offsetY];
        }}
        onPointerUp={(event) => {
          if (!selectionStart.current || !cosmos.current) return;
          const end: [number, number] = [event.nativeEvent.offsetX, event.nativeEvent.offsetY];
          const found = cosmos.current.findPointsInRect([selectionStart.current, end]);
          setReview(found.map((index) => ids.current[index]).filter(Boolean));
          selectionStart.current = null;
        }}
      />
      {hover && (
        <div className="universeTooltip">
          <b>{hover.label}</b>
          <span>{hover.type}</span>
        </div>
      )}
      {selected && (
        <aside className="universePanel">
          <h3>{selected}</h3>
          <button onClick={() => openWorkingGraph(selected)}>Open in working graph</button>
          <button onClick={() => void openRecord(selected)}>Open record</button>
        </aside>
      )}
      {review.length > 0 && (
        <aside className="universePanel review">
          <h3>Review these {review.length}</h3>
          <button onClick={() => setReview([])}>Clear</button>
          <ol>
            {review.slice(0, 200).map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ol>
        </aside>
      )}
    </section>
  );
}

function decodeArray(encoded: EncodedArray): Uint8Array | Uint32Array | Float32Array {
  const binary = atob(encoded.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encoded.type === "Uint32Array") return new Uint32Array(bytes.buffer);
  if (encoded.type === "Float32Array") return new Float32Array(bytes.buffer);
  return bytes;
}

function encodeArray(value: Float32Array): EncodedArray {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return { type: "Float32Array", length: value.length, data: btoa(binary) };
}

function clusterPositions(labels: string[]): Array<number | undefined> {
  return labels.flatMap((label) => {
    const anchor = anchorForKey(label);
    return [anchor.x, anchor.y];
  });
}

function pointColors(types: Uint8Array, labels: string[]): Float32Array {
  const palette: Record<string, number[]> = {
    source: [0.3, 0.64, 1, 1],
    section: [0.42, 0.84, 0.56, 1],
    fact: [0.91, 0.86, 0.47, 1],
    event: [0.96, 0.78, 0.29, 1],
    failure: [1, 0.42, 0.42, 1],
    decision: [0.9, 0.66, 0.24, 1],
  };
  return Float32Array.from(Array.from(types).flatMap((type) => palette[labels[type] ?? "section"] ?? palette.section));
}

function supportsUniverse(): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return false;
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}
