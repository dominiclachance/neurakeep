import type Sigma from "sigma";
import type { GraphNodeAttributes } from "./GraphModel.js";

interface GraphNodeVisualState {
  isHovered: boolean;
  isHighlighted: boolean;
}

interface GraphNodeAppearance {
  labelColor: string;
  labelSize: number;
  labelFont: string;
  labelBackgroundColor: string;
  labelBackgroundPadding: number;
  backdropVisibility: "visible" | "hidden";
  backdropArea: "node";
  backdropColor: string;
  backdropPadding: number;
  backdropBorderColor: string;
  backdropBorderWidth: number;
  backdropShadowColor: string;
  backdropShadowBlur: number;
}

const glyphs: Record<string, string> = {
  root: "◆",
  cluster: "◉",
  source: "▣",
  section: "§",
  fact: "●",
  event: "◇",
  decision: "◇",
  failure: "!",
};

/** Sigma v4 renders the selection ring with its highlighted-node backdrop primitive. */
export function applySelectionRing(sigma: Sigma, previous: string | null, selected: string | null): void {
  if (previous && sigma.getGraph().hasNode(previous)) sigma.setNodeState(previous, { isHighlighted: false });
  if (selected && sigma.getGraph().hasNode(selected)) sigma.setNodeState(selected, { isHighlighted: true });
}

/** Dark-stage node treatment: crisp by default, category halo only for hubs and interaction states. */
export function graphNodeAppearance(
  attributes: GraphNodeAttributes,
  state: GraphNodeVisualState,
): GraphNodeAppearance {
  const categoryColor = attributes.color || "#73c7ae";
  const structuralHub = attributes.type === "root" || attributes.type === "cluster";
  const emphasized = state.isHovered || state.isHighlighted || structuralHub;

  return {
    labelColor: "#e6edf3",
    labelSize: state.isHovered || state.isHighlighted ? 13 : 12,
    labelFont: "Geist, 'Segoe UI', sans-serif",
    labelBackgroundColor: "rgba(11, 16, 19, 0.82)",
    labelBackgroundPadding: 2,
    backdropVisibility: emphasized ? "visible" : "hidden",
    backdropArea: "node",
    backdropColor: "rgba(11, 16, 19, 0.76)",
    backdropPadding: state.isHighlighted ? 5 : state.isHovered ? 4 : 3,
    backdropBorderColor: state.isHighlighted ? "#f5f7fa" : categoryColor,
    backdropBorderWidth: state.isHighlighted ? 2 : state.isHovered ? 1 : structuralHub ? 0.75 : 0,
    backdropShadowColor: emphasized ? categoryColor : "transparent",
    backdropShadowBlur: state.isHighlighted ? 16 : state.isHovered ? 12 : structuralHub ? 8 : 0,
  };
}

/** Label-layer equivalent of the old canvas hook: glyph plus the progressive +N badge. */
export function decoratedLabel(attributes: GraphNodeAttributes): string {
  const badge = Number(attributes.remaining ?? 0) > 0 ? `  +${attributes.remaining}` : "";
  return `${glyphs[attributes.type] ?? "•"} ${attributes.rawLabel}${badge}`;
}
