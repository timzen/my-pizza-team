/**
 * WorkflowGraph — SVG-based directed graph visualization for a workflow.
 *
 * Renders states as rounded rectangles in a left-to-right layered layout,
 * connected by curved arrows showing transitions. Edges are color-coded
 * by permission type (any=green, teammate=blue, lead=amber).
 *
 * Layout algorithm:
 * 1. Find the initial state (first in states[] or initialState)
 * 2. BFS from initial state to assign layer (column) numbers
 * 3. Orphan states (unreachable) placed in an extra rightmost column
 * 4. Nodes positioned in columns with even vertical spacing
 * 5. Edges drawn as cubic bezier curves with arrowhead markers
 */

import { useMemo } from "react";

export interface WorkflowConfig {
  states: string[];
  transitions: Record<string, Record<string, string>>;
  initialState?: string;
  doneState?: string;
  categories?: string[];
  instructions?: Record<string, string>;
}

interface Props {
  workflow: WorkflowConfig;
}

/** Permission → color mapping */
const PERM_COLORS: Record<string, string> = {
  any: "#22c55e",       // green-500
  teammate: "#3b82f6",  // blue-500
  lead: "#f59e0b",      // amber-500
};

/** Node dimensions */
const NODE_WIDTH = 130;
const NODE_HEIGHT = 40;
const COL_GAP = 180;
const ROW_GAP = 80;
const PADDING_X = 60;
const PADDING_Y = 50;

interface NodePosition {
  state: string;
  x: number;
  y: number;
  col: number;
  row: number;
}

interface Edge {
  from: string;
  to: string;
  permission: string;
}

/**
 * Assign layers via BFS from the initial state.
 * Returns a map of state → layer (column index).
 */
function assignLayers(
  states: string[],
  transitions: Record<string, Record<string, string>>,
  initialState: string
): Map<string, number> {
  const layers = new Map<string, number>();
  const queue: string[] = [initialState];
  layers.set(initialState, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layers.get(current)!;
    const targets = transitions[current];
    if (!targets) continue;

    for (const target of Object.keys(targets)) {
      if (!layers.has(target)) {
        layers.set(target, currentLayer + 1);
        queue.push(target);
      }
    }
  }

  // Place unreachable states in an extra column at the end
  const maxLayer = layers.size > 0 ? Math.max(...layers.values()) : 0;
  for (const state of states) {
    if (!layers.has(state)) {
      layers.set(state, maxLayer + 1);
    }
  }

  return layers;
}

/**
 * Compute node positions based on layer assignments.
 * Nodes in the same column are spaced vertically.
 */
function computePositions(
  states: string[],
  layers: Map<string, number>
): NodePosition[] {
  // Group states by column
  const columns = new Map<number, string[]>();
  for (const state of states) {
    const col = layers.get(state) ?? 0;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col)!.push(state);
  }

  const positions: NodePosition[] = [];
  for (const [col, colStates] of columns) {
    for (let row = 0; row < colStates.length; row++) {
      const state = colStates[row];
      positions.push({
        state,
        col,
        row,
        x: PADDING_X + col * COL_GAP,
        y: PADDING_Y + row * ROW_GAP,
      });
    }
  }

  return positions;
}

/**
 * Generate a cubic bezier path between two nodes.
 * Handles self-loops and back-edges with curved arcs.
 */
function edgePath(
  fromPos: NodePosition,
  toPos: NodePosition,
  edgeIndex: number,
  totalEdgesBetween: number
): string {
  const fromX = fromPos.x + NODE_WIDTH;
  const fromY = fromPos.y + NODE_HEIGHT / 2;
  const toX = toPos.x;
  const toY = toPos.y + NODE_HEIGHT / 2;

  // Self-loop
  if (fromPos.state === toPos.state) {
    const cx = fromPos.x + NODE_WIDTH / 2;
    const topY = fromPos.y - 30;
    return `M ${fromPos.x + NODE_WIDTH * 0.7} ${fromPos.y} C ${cx + 20} ${topY - 20}, ${cx - 20} ${topY - 20}, ${fromPos.x + NODE_WIDTH * 0.3} ${fromPos.y}`;
  }

  // Back-edge (target is in an earlier or same column)
  if (toPos.col <= fromPos.col) {
    const offset = (edgeIndex - (totalEdgesBetween - 1) / 2) * 15;
    const midY = Math.min(fromY, toY) - 50 + offset;
    return `M ${fromX} ${fromY} C ${fromX + 40} ${midY}, ${toX - 40} ${midY}, ${toX} ${toY}`;
  }

  // Forward edge — cubic bezier with control points offset horizontally
  const offset = totalEdgesBetween > 1 ? (edgeIndex - (totalEdgesBetween - 1) / 2) * 12 : 0;
  const cx1 = fromX + COL_GAP * 0.35;
  const cy1 = fromY + offset;
  const cx2 = toX - COL_GAP * 0.35;
  const cy2 = toY + offset;

  return `M ${fromX} ${fromY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${toX} ${toY}`;
}

/**
 * Compute the midpoint of a cubic bezier for label placement.
 */
function bezierMidpoint(
  fromPos: NodePosition,
  toPos: NodePosition,
  edgeIndex: number,
  totalEdgesBetween: number
): { x: number; y: number } {
  const fromX = fromPos.x + NODE_WIDTH;
  const fromY = fromPos.y + NODE_HEIGHT / 2;
  const toX = toPos.x;
  const toY = toPos.y + NODE_HEIGHT / 2;

  if (fromPos.state === toPos.state) {
    return { x: fromPos.x + NODE_WIDTH / 2, y: fromPos.y - 40 };
  }

  if (toPos.col <= fromPos.col) {
    const offset = (edgeIndex - (totalEdgesBetween - 1) / 2) * 15;
    const midY = Math.min(fromY, toY) - 50 + offset;
    return { x: (fromX + toX) / 2, y: midY - 10 };
  }

  const offset = totalEdgesBetween > 1 ? (edgeIndex - (totalEdgesBetween - 1) / 2) * 12 : 0;
  return { x: (fromX + toX) / 2, y: (fromY + toY) / 2 + offset - 10 };
}

export function WorkflowGraph({ workflow }: Props) {
  const { positions, edges, svgWidth, svgHeight } = useMemo(() => {
    const initialState = workflow.initialState || workflow.states[0] || "todo";
    const layers = assignLayers(workflow.states, workflow.transitions, initialState);
    const positions = computePositions(workflow.states, layers);

    // Collect edges
    const edges: Edge[] = [];
    for (const [from, targets] of Object.entries(workflow.transitions)) {
      for (const [to, permission] of Object.entries(targets)) {
        if (workflow.states.includes(from) && workflow.states.includes(to)) {
          edges.push({ from, to, permission });
        }
      }
    }

    // Compute SVG dimensions
    const maxCol = Math.max(...positions.map((p) => p.col), 0);
    const maxRow = Math.max(
      ...Array.from(new Set(positions.map((p) => p.col))).map(
        (col) => positions.filter((p) => p.col === col).length - 1
      ),
      0
    );
    const svgWidth = PADDING_X * 2 + maxCol * COL_GAP + NODE_WIDTH;
    const svgHeight = PADDING_Y * 2 + maxRow * ROW_GAP + NODE_HEIGHT;

    return { positions, edges, svgWidth, svgHeight };
  }, [workflow]);

  // Count edges between same pair for offset calculation
  const edgeCounts = new Map<string, number>();
  const edgeIndexMap = new Map<string, number>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const pairKey = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    edgeCounts.set(pairKey, (edgeCounts.get(pairKey) || 0) + 1);
    edgeIndexMap.set(key, (edgeIndexMap.get(key) || 0));
  }

  // Recount for proper indexing
  const pairIndexCounter = new Map<string, number>();

  const posMap = new Map(positions.map((p) => [p.state, p]));

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border bg-card">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width={Math.max(svgWidth, 400)}
        height={Math.max(svgHeight, 200)}
        className="min-w-full"
      >
        {/* Arrowhead markers for each permission color */}
        <defs>
          {Object.entries(PERM_COLORS).map(([perm, color]) => (
            <marker
              key={perm}
              id={`arrow-${perm}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* Edges */}
        {edges.map((edge) => {
          const fromPos = posMap.get(edge.from);
          const toPos = posMap.get(edge.to);
          if (!fromPos || !toPos) return null;

          const pairKey = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
          const totalBetween = edgeCounts.get(pairKey) || 1;
          const idx = pairIndexCounter.get(pairKey) || 0;
          pairIndexCounter.set(pairKey, idx + 1);

          const color = PERM_COLORS[edge.permission] || "#888";
          const path = edgePath(fromPos, toPos, idx, totalBetween);
          const labelPos = bezierMidpoint(fromPos, toPos, idx, totalBetween);

          return (
            <g key={`${edge.from}-${edge.to}-${edge.permission}`}>
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={2}
                markerEnd={`url(#arrow-${edge.permission})`}
              />
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                fontSize={10}
                fill={color}
                fontWeight={500}
              >
                {edge.permission}
              </text>
            </g>
          );
        })}

        {/* Nodes */}
        {positions.map((pos) => {
          const isInitial = pos.state === (workflow.initialState || workflow.states[0]);
          const isDone = pos.state === (workflow.doneState || workflow.states[workflow.states.length - 1]);

          return (
            <g key={pos.state}>
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                ry={8}
                fill={isInitial ? "#dcfce7" : isDone ? "#dbeafe" : "#f4f4f5"}
                stroke={isInitial ? "#16a34a" : isDone ? "#2563eb" : "#a1a1aa"}
                strokeWidth={isInitial || isDone ? 2 : 1.5}
              />
              <text
                x={pos.x + NODE_WIDTH / 2}
                y={pos.y + NODE_HEIGHT / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={500}
                fill="#18181b"
              >
                {pos.state}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
