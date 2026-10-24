import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ControlsContainer,
  FullScreenControl,
  SigmaContainer,
  ZoomControl,
  useRegisterEvents,
  useSigma,
} from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import { loadGraphNeighbors, loadGraphOverview, locateGraphNodes, saveGraphState } from "../api.js";
import type { GraphNode, GraphState } from "../types.js";
import { GraphModel, type GraphNodeAttributes } from "./GraphModel.js";
import { forceAtlasSettings, runNoverlapInWorker, seedClusters, settleLayout } from "./layout.js";
import { applySelectionRing, graphNodeAppearance } from "./programs.js";
import "@react-sigma/core/lib/style.css";
import "./graph.css";

const sigmaOptions = {
  styles: {
    stage: { background: "#0b1013" },
  },
  settings: {
    enableNodeDrag: true,
    renderLabels: true,
    labelDensity: 0.75,
    labelGridCellSize: 140,
    labelRenderedSizeThreshold: 5.5,
    labelSize: 12,
    labelWeight: "500",
    itemSizesReference: "screen" as const,
    zoomToSizeRatioFunction: () => 1,
    stagePadding: 96,
  },
  nodeReducer: (
    _key: string,
    data: Record<string, unknown>,
    attributes: GraphNodeAttributes,
    nodeState: { isHovered: boolean; isHighlighted: boolean },
  ) => ({
    ...data,
    ...graphNodeAppearance(attributes, nodeState),
  }),
  edgeReducer: (_key: string, data: Record<string, unknown>) => ({
    ...data,
    color: "#647681",
    opacity: 0.5,
    size: 0.8,
  }),
};

export interface SigmaGraphViewProps {
  state?: GraphState;
  openRecord: (id: string) => Promise<void>;
  toast: (message: string, type?: "ok" | "error") => void;
  initialFocusId?: string;
  readOnly?: boolean;
}

export default function GraphView({
  state = {},
  openRecord,
  toast,
  initialFocusId,
  readOnly = false,
}: SigmaGraphViewProps): React.ReactElement {
  const model = useMemo(() => new GraphModel(5_000), []);
  const [clusterBy, setClusterBy] = useState<GraphModel["clusterBy"]>(normalizeClusterBy(state.clusterBy));
  const [version, setVersion] = useState(0);
  const [overviewStatus, setOverviewStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GraphNode[]>([]);
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [physics, setPhysics] = useState(
    state.physics ?? { repulsion: 280, linkDistance: 85, clusterStrength: 0.12, collisionRadius: 26, iterations: 160 },
  );
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const restoredFocus = useRef(false);
  const overviewGeneration = useRef(0);
  const contextRef = useRef<HTMLDivElement | null>(null);
  const locateRef = useRef<HTMLDivElement | null>(null);
  const locateInputRef = useRef<HTMLInputElement | null>(null);
  const matchListId = useId();
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const webgl = useMemo(() => supportsWebGl(), []);
  const effectiveState = useMemo(() => ({ ...state, physics }), [physics, state]);

  const overview = useCallback(async () => {
    const generation = ++overviewGeneration.current;
    setLoading(true);
    try {
      const data = await loadGraphOverview(clusterBy);
      if (generation !== overviewGeneration.current) return;
      setContext(null);
      model.setClusterBy(clusterBy);
      model.mergeOverview(data);
      seedClusters(model);
      model.restore(state);
      model.setClusterBy(clusterBy);
      setCursors({});
      setSelected(null);
      setOverviewStatus(model.contentNodeCount() === 0 ? "empty" : "ready");
      setVersion((value) => value + 1);
    } catch (error) {
      if (generation !== overviewGeneration.current) return;
      setOverviewStatus("error");
      throw error;
    } finally {
      if (generation === overviewGeneration.current) setLoading(false);
    }
  }, [clusterBy, model, state]);

  const expand = useCallback(
    async (id: string, nextPage = false) => {
      setLoading(true);
      try {
        const firstPage = await loadGraphNeighbors(id, {
          cursor: nextPage ? cursors[id] : null,
          limit: 200,
        });
        model.expand(id, firstPage);
        setCursors((current) => ({ ...current, [id]: firstPage.nextCursor }));

        settleLayout(model, effectiveState, reducedMotion);
        model.restore(state);
        model.setClusterBy(clusterBy);
        setVersion((value) => value + 1);
      } finally {
        setLoading(false);
      }
    },
    [clusterBy, cursors, effectiveState, model, reducedMotion, state],
  );

  const collapse = useCallback(
    (id: string) => {
      const collapsed = new Set(model.collapse(id));
      setCursors((current) =>
        Object.fromEntries(Object.entries(current).map(([key, value]) => [key, collapsed.has(key) ? null : value])),
      );
      setVersion((value) => value + 1);
    },
    [model],
  );

  useEffect(() => {
    void overview().catch((error: Error) => toast(error.message, "error"));
    return () => {
      overviewGeneration.current += 1;
    };
  }, [overview, toast]);

  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContext(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [context]);

  const closeMatches = useCallback((restoreFocus = false) => {
    setMatchesOpen(false);
    setActiveMatchIndex(-1);
    if (restoreFocus) window.requestAnimationFrame(() => locateInputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!matchesOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !locateRef.current?.contains(event.target)) closeMatches();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [closeMatches, matchesOpen]);

  useEffect(() => {
    const reload = () => void overview().catch((error: Error) => toast(error.message, "error"));
    window.addEventListener("neurakeep:graph-change", reload);
    return () => window.removeEventListener("neurakeep:graph-change", reload);
  }, [overview, toast]);

  useEffect(() => {
    if (!initialFocusId || !model.graph.hasNode(initialFocusId)) return;
    setSelected(initialFocusId);
  }, [initialFocusId, model, version]);

  useEffect(() => {
    if (restoredFocus.current || version === 0) return;
    const focusId = initialFocusId || localStorage.getItem("neurakeep_graph_focus") || "";
    if (!focusId) return;
    restoredFocus.current = true;
    localStorage.removeItem("neurakeep_graph_focus");
    void locateGraphNodes(focusId, 1)
      .then(async ({ nodes }) => {
        const node = nodes.find((candidate) => candidate.id === focusId) ?? nodes[0];
        if (!node) return;
        model.mergeLocated(node);
        setSelected(node.id);
        await expand(node.id);
      })
      .catch((error: Error) => toast(error.message, "error"));
  }, [expand, initialFocusId, model, toast, version]);

  const search = async (preset = query, toggle = true): Promise<void> => {
    if (!preset.trim()) return;
    if (toggle && matchesOpen && preset.trim() === query.trim()) {
      closeMatches(true);
      return;
    }
    const result = await locateGraphNodes(preset.trim());
    if (preset !== query) setQuery(preset);
    setMatches(result.nodes);
    setMatchesOpen(true);
    setActiveMatchIndex(-1);
  };

  const selectSearchHit = async (node: GraphNode): Promise<void> => {
    if (!model.graph.hasNode(node.id)) {
      model.mergeLocated(node);
      await expand(node.id);
    }
    setSelected(node.id);
    closeMatches(true);
    setVersion((value) => value + 1);
  };

  const save = async (): Promise<void> => {
    await saveGraphState(model.serialize(effectiveState));
    toast("Graph layout saved");
  };

  const runAction = useCallback(
    (action: () => Promise<unknown>): void => {
      void action().catch((error: unknown) =>
        toast(error instanceof Error ? error.message : "Graph action failed", "error"),
      );
    },
    [toast],
  );

  const fallbackNodes = model.graph.nodes().map((id) => {
    const attributes = model.graph.getNodeAttributes(id);
    return {
      id,
      label: attributes.rawLabel,
      type: attributes.type,
      space: attributes.space,
      trustLevel: attributes.trustLevel,
      sensitivity: attributes.sensitivity,
      remaining: attributes.remaining,
    } as GraphNode;
  });

  if (overviewStatus === "loading") {
    return (
      <section className="graphState" data-testid="graph-loading-state" aria-live="polite">
        <div>
          <span className="graphStateKicker">Working graph</span>
          <h2>Loading your memory map</h2>
          <p>Reading the vault overview and preparing the graph.</p>
        </div>
      </section>
    );
  }

  if (overviewStatus === "error") {
    return (
      <section className="graphState graphStateError" data-testid="graph-error-state" role="alert">
        <div>
          <span className="graphStateKicker">Working graph</span>
          <h2>The graph could not be loaded</h2>
          <p>Your vault is unchanged. Retry the overview when the local service is ready.</p>
          <button type="button" onClick={() => void overview().catch((error: Error) => toast(error.message, "error"))}>
            Retry overview
          </button>
        </div>
      </section>
    );
  }

  if (overviewStatus === "empty") {
    return (
      <section className="graphState" data-testid="graph-empty-state">
        <div>
          <span className="graphStateKicker">Your memory graph</span>
          <h2>Nothing to map yet</h2>
          <p>Add a source to turn notes, documents, and agent sessions into a reviewable memory graph.</p>
          <button type="button" onClick={() => { window.location.hash = "inbox"; }}>
            Add your first source
          </button>
        </div>
      </section>
    );
  }

  if (!webgl) {
    return (
      <section className="graphFallback" data-testid="graph-webgl-fallback">
        <h2>Working graph list</h2>
        <p>
          WebGL is unavailable. The accessible list view remains available; use a WebGL-capable browser for the
          interactive graph.
        </p>
        <button onClick={() => runAction(overview)}>Reload overview</button>
        <ul>
          {fallbackNodes.map((node) => (
            <li key={node.id}>
              <button
                onClick={() => {
                  if (node.type === "cluster") runAction(() => expand(node.id, Boolean(cursors[node.id])));
                  else if (node.type !== "root") runAction(() => openRecord(node.id));
                }}
              >
                {node.label}
              </button>
              {model.expandedBranches().includes(node.id) && (
                <button onClick={() => collapse(node.id)}>Collapse</button>
              )}
              {cursors[node.id] && <button onClick={() => runAction(() => expand(node.id, true))}>Load more</button>}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="sigmaGraph" data-testid="sigma-graph">
      <header className="sigmaToolbar">
        <label>
          Cluster by{" "}
          <select value={clusterBy} onChange={(event) => setClusterBy(normalizeClusterBy(event.target.value))}>
            <option value="type">Type</option>
            <option value="space">Space</option>
            <option value="trust">Trust</option>
            <option value="sensitivity">Sensitivity</option>
          </select>
        </label>
        <div className="graphLocate" ref={locateRef}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void search().catch((error: Error) => toast(error.message, "error"));
            }}
          >
            <input
              ref={locateInputRef}
              role="combobox"
              aria-label="Locate graph node"
              aria-controls={matchListId}
              aria-expanded={matchesOpen}
              aria-autocomplete="list"
              aria-activedescendant={
                matchesOpen && activeMatchIndex >= 0 ? `${matchListId}-option-${activeMatchIndex}` : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                closeMatches();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && matchesOpen) {
                  event.preventDefault();
                  closeMatches(true);
                } else if (event.key === "ArrowDown" && matchesOpen && matches.length > 0) {
                  event.preventDefault();
                  setActiveMatchIndex((index) => Math.min(matches.length - 1, index + 1));
                } else if (event.key === "ArrowUp" && matchesOpen && matches.length > 0) {
                  event.preventDefault();
                  setActiveMatchIndex((index) => Math.max(0, index <= 0 ? matches.length - 1 : index - 1));
                } else if (event.key === "Enter" && matchesOpen && activeMatchIndex >= 0) {
                  event.preventDefault();
                  void selectSearchHit(matches[activeMatchIndex]);
                }
              }}
              placeholder="Locate title or id"
            />
            <button type="submit" className="primary">Locate</button>
          </form>
          {matchesOpen && (
            <div className="graphMatches" id={matchListId} role="listbox" aria-label="Graph matches">
              {matches.length === 0 ? (
                <div className="graphMatchesEmpty">No matching nodes</div>
              ) : (
                matches.map((node, index) => (
                  <button
                    id={`${matchListId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeMatchIndex}
                    key={node.id}
                    onPointerMove={() => setActiveMatchIndex(index)}
                    onClick={() => runAction(() => selectSearchHit(node))}
                  >
                    <span>{node.label}</span>
                    <small>{graphMatchContext(node)}</small>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="graphPresets" aria-label="Graph search presets">
          {[
            ["Failures", "do not repeat"],
            ["Decisions", "decision direction chosen"],
            ["Recent", "recent memory"],
          ].map(([label, value]) => (
            <button key={label} type="button" className="secondary" onClick={() => runAction(() => search(value, false))}>
              {label}
            </button>
          ))}
        </div>
        <button className="secondary" onClick={() => runAction(overview)} data-testid="collapse-overview">
          Collapse to overview
        </button>
        <button
          className="secondary"
          disabled={readOnly}
          title={readOnly ? "Layout saving is unavailable while this workspace is read-only." : "Save this graph layout."}
          onClick={() => runAction(save)}
        >
          Save layout
        </button>
        <span data-testid="graph-count">
          {model.graph.order} nodes{loading ? " · loading…" : ""}
        </span>
      </header>
      <nav className="graphBreadcrumbs" aria-label="Expanded graph branches">
        <button onClick={() => runAction(overview)}>Overview</button>
        {model.expandedBranches().map((id) => (
          <React.Fragment key={id}>
            <span>›</span>
            <button onClick={() => setSelected(id)}>
              {model.graph.hasNode(id) ? model.graph.getNodeAttribute(id, "rawLabel") : id}
            </button>
          </React.Fragment>
        ))}
      </nav>
      <details className="graphPhysics">
        <summary>Physics</summary>
        {(
          [
            ["repulsion", "Repulsion", 10, 1_000, 10],
            ["linkDistance", "Link distance", 20, 300, 5],
            ["clusterStrength", "Cluster strength", 0.01, 1, 0.01],
            ["collisionRadius", "Collision radius", 2, 100, 1],
            ["iterations", "Iterations", 10, 1_000, 10],
          ] as const
        ).map(([key, label, min, max, step]) => (
          <label key={key}>
            {label} <output>{physics[key]}</output>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={physics[key]}
              onChange={(event) => setPhysics((current) => ({ ...current, [key]: Number(event.target.value) }))}
            />
          </label>
        ))}
      </details>
      <details className="graphKeyboardList">
        <summary>Keyboard node list</summary>
        <div>
          {model.graph
            .nodes()
            .slice(0, 200)
            .map((id) => {
              const attributes = model.graph.getNodeAttributes(id);
              return (
                <button
                  key={id}
                  data-node-id={id}
                  data-node-kind={attributes.type}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setContext({ id, x: bounds.right, y: bounds.top });
                  }}
                  onClick={() => {
                    setSelected(id);
                    if (attributes.type === "cluster") runAction(() => expand(id, Boolean(cursors[id])));
                    else if (attributes.type !== "root") runAction(() => openRecord(id));
                  }}
                >
                  {attributes.rawLabel}
                </button>
              );
            })}
        </div>
      </details>
      <SigmaContainer
        graph={model.graph}
        style={{ height: "100%", width: "100%" }}
        options={sigmaOptions}
      >
        <SigmaInteractions
          model={model}
          version={version}
          state={effectiveState}
          reducedMotion={reducedMotion}
          selected={selected}
          setSelected={setSelected}
          expand={expand}
          cursors={cursors}
          openRecord={openRecord}
          runAction={runAction}
          setContext={setContext}
          closeMatches={closeMatches}
        />
        <ControlsContainer position="bottom-right">
          <ZoomControl />
          <FullScreenControl />
        </ControlsContainer>
      </SigmaContainer>
      {context && model.graph.hasNode(context.id) && (
        <div
          ref={contextRef}
          className="graphContext"
          style={{ left: context.x, top: context.y }}
          role="menu"
          aria-label="Graph node actions"
        >
          {model.graph.getNodeAttribute(context.id, "type") !== "root" && (
            <button
              role="menuitem"
              onClick={() => {
                runAction(() => expand(context.id, Boolean(cursors[context.id])));
                setContext(null);
              }}
            >
              Expand
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              collapse(context.id);
              setContext(null);
            }}
          >
            Collapse
          </button>
          <button
            role="menuitem"
            onClick={() => {
              if (model.graph.getNodeAttribute(context.id, "fixed")) model.unpin(context.id);
              else model.pin(context.id);
              setVersion((value) => value + 1);
              setContext(null);
            }}
          >
            Pin / unpin
          </button>
          {!(["root", "cluster"] as string[]).includes(model.graph.getNodeAttribute(context.id, "type")) && (
            <button
              role="menuitem"
              onClick={() => {
                runAction(() => openRecord(context.id));
                setContext(null);
              }}
            >
              Open record
            </button>
          )}
        </div>
      )}
      {selected && cursors[selected] && (
        <button className="graphMore" onClick={() => runAction(() => expand(selected, true))} data-testid="graph-more">
          Load +N more
        </button>
      )}
    </section>
  );
}

function SigmaInteractions({
  model,
  version,
  state,
  reducedMotion,
  selected,
  setSelected,
  expand,
  cursors,
  openRecord,
  runAction,
  setContext,
  closeMatches,
}: {
  model: GraphModel;
  version: number;
  state: GraphState;
  reducedMotion: boolean;
  selected: string | null;
  setSelected: (id: string | null) => void;
  expand: (id: string, next?: boolean) => Promise<void>;
  cursors: Record<string, string | null>;
  openRecord: (id: string) => Promise<void>;
  runAction: (action: () => Promise<unknown>) => void;
  setContext: (value: { id: string; x: number; y: number } | null) => void;
  closeMatches: () => void;
}): null {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const previous = useRef<string | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const { start: startPhysics, stop: stopPhysics } = useWorkerLayoutForceAtlas2({
    settings: forceAtlasSettings(state).settings,
  });

  useEffect(() => {
    applySelectionRing(sigma, previous.current, selected);
    previous.current = selected;
  }, [selected, sigma]);

  useEffect(() => {
    if (model.graph.order < 2) return;
    let cancelled = false;
    const pinned = new Map<string, { x: number; y: number }>();
    model.graph.forEachNode((id, attributes) => {
      if (attributes.fixed) pinned.set(id, { x: attributes.x, y: attributes.y });
    });
    if (!reducedMotion) startPhysics();
    const timer = window.setTimeout(
      () => {
        stopPhysics();
        for (const [id, position] of pinned) model.pin(id, position);
        void runNoverlapInWorker(model, state, reducedMotion)
          .then((positions) => {
            if (cancelled) return;
            for (const [id, position] of positions) {
              if (model.graph.hasNode(id) && !model.graph.getNodeAttribute(id, "fixed"))
                model.graph.mergeNodeAttributes(id, position);
            }
            for (const [id, position] of pinned) model.pin(id, position);
            sigma.refresh();
          })
          .catch(() => undefined);
      },
      reducedMotion ? 0 : Math.min(4_000, 600 + model.graph.order),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stopPhysics();
    };
  }, [model, reducedMotion, sigma, startPhysics, state, stopPhysics, version]);

  useEffect(() => {
    const clearLongPress = () => {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    };
    registerEvents({
      clickNode: ({ node }) => {
        setSelected(node);
        const type = model.graph.getNodeAttribute(node, "type");
        if (type === "cluster" || Number(model.graph.getNodeAttribute(node, "remaining") ?? 0) > 0)
          runAction(() => expand(node, Boolean(cursors[node])));
        else if (type !== "root") runAction(() => openRecord(node));
      },
      doubleClickNode: ({ node }) => runAction(() => openRecord(node)),
      rightClickNode: ({ node, event }) => {
        event.preventSigmaDefault();
        const original = event.original as MouseEvent;
        setContext({ id: node, x: original.clientX, y: original.clientY });
      },
      downNode: ({ node, event }) => {
        const original = event.original as PointerEvent;
        if (original.pointerType !== "touch") return;
        clearLongPress();
        longPressTimer.current = window.setTimeout(() => {
          setContext({ id: node, x: original.clientX, y: original.clientY });
          longPressTimer.current = null;
        }, 550);
      },
      upNode: clearLongPress,
      clickStage: () => {
        clearLongPress();
        setSelected(null);
        setContext(null);
        closeMatches();
      },
    });
    return clearLongPress;
  }, [closeMatches, cursors, expand, model, openRecord, registerEvents, runAction, setContext, setSelected]);
  return null;
}

function supportsWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function normalizeClusterBy(value: string | undefined): GraphModel["clusterBy"] {
  return value === "space" || value === "trust" || value === "sensitivity" ? value : "type";
}

function graphMatchContext(node: GraphNode): string {
  const source = node.space?.trim() || node.type;
  const shortId = node.id.length > 22 ? `${node.id.slice(0, 10)}…${node.id.slice(-8)}` : node.id;
  return `${source} · ${shortId}`;
}
