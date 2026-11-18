// The layout of the panes of a window: a tree of splits. A leaf is a pane (its
// id); a split lays its children side by side ("row") or one above the other
// ("column"), each with its share of the room. Pure functions: the DOM side is
// in ui/panes.ts.

export type Split = { dir: "row" | "column"; children: Layout[]; sizes: number[] };
export type Layout = { pane: number } | Split;

/** Where a pane goes, next to another one. */
export type Side = "left" | "right" | "top" | "bottom";

/** Where something dragged over a pane would land: next to it, or in it. */
export type Zone = Side | "center";

export const MAX_PANES = 6;

const isPane = (n: Layout): n is { pane: number } => "pane" in n;

/** The panes, from the top left to the bottom right. */
export function panesInOrder(node: Layout): number[] {
  return isPane(node) ? [node.pane] : node.children.flatMap(panesInOrder);
}

/** A new pane `id` next to pane `target`. A split in the same direction takes it in, beside its neighbor. */
export function splitLayout(root: Layout, target: number, side: Side, id: number): Layout {
  const dir = side === "left" || side === "right" ? "row" : "column";
  const after = side === "right" || side === "bottom";
  const leaf = { pane: id };
  const visit = (node: Layout): Layout => {
    if (isPane(node)) {
      if (node.pane !== target) return node;
      return { dir, children: after ? [node, leaf] : [leaf, node], sizes: [1, 1] };
    }
    const i = node.children.findIndex((c) => isPane(c) && c.pane === target);
    if (i >= 0 && node.dir === dir) {
      // The pane gives half of its room to the new one.
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = sizes[i] / 2;
      sizes[i] = half;
      children.splice(after ? i + 1 : i, 0, leaf);
      sizes.splice(after ? i + 1 : i, 0, half);
      return { dir: node.dir, children, sizes };
    }
    return { dir: node.dir, children: node.children.map(visit), sizes: [...node.sizes] };
  };
  return visit(root);
}

/** The layout without pane `id`: its room goes to its neighbors; a split left with one child is replaced by it. */
export function removeFromLayout(root: Layout, id: number): Layout | null {
  const visit = (node: Layout): Layout | null => {
    if (isPane(node)) return node.pane === id ? null : node;
    const children: Layout[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const kept = visit(c);
      if (!kept) return;
      // A split of the same direction inside: its children join this one.
      if (!isPane(kept) && kept.dir === node.dir) {
        const total = kept.sizes.reduce((a, b) => a + b, 0) || 1;
        kept.children.forEach((k, j) => {
          children.push(k);
          sizes.push((node.sizes[i] * kept.sizes[j]) / total);
        });
      } else {
        children.push(kept);
        sizes.push(node.sizes[i]);
      }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { dir: node.dir, children, sizes };
  };
  return visit(root);
}

/** The panes next to which pane `id` sits in a direction (the one in the middle of that side first). */
export function neighborPane(root: Layout, id: number, side: Side): number | null {
  const dir = side === "left" || side === "right" ? "row" : "column";
  const step = side === "right" || side === "bottom" ? 1 : -1;
  // From the pane up to the root: the first split of that direction where it can move.
  const path: { node: Split; index: number }[] = [];
  const find = (node: Layout): boolean => {
    if (isPane(node)) return node.pane === id;
    for (let i = 0; i < node.children.length; i++) {
      path.push({ node, index: i });
      if (find(node.children[i])) return true;
      path.pop();
    }
    return false;
  };
  if (!find(root)) return null;
  for (let k = path.length - 1; k >= 0; k--) {
    const { node, index } = path[k];
    if (node.dir !== dir) continue;
    const next = node.children[index + step];
    if (!next) continue;
    const panes = panesInOrder(next);
    return step > 0 ? panes[0] : panes[panes.length - 1];
  }
  return null;
}

/** The zone of a pane under the pointer: near an edge, a split on that side; in the middle, the pane itself. */
export function zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, edge = 0.3): Zone {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const sides: [Side, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
  sides.sort((a, b) => a[1] - b[1]);
  return sides[0][1] < edge ? sides[0][0] : "center";
}

/** A layout read back from a session: checked, with only the panes that exist (null when unusable). */
export function sanitizeLayout(raw: unknown, count: number): Layout | null {
  const seen = new Set<number>();
  const visit = (n: unknown, depth: number): Layout | null => {
    if (!n || typeof n !== "object" || depth > 8) return null;
    const o = n as Record<string, unknown>;
    if (typeof o.pane === "number") {
      const p = o.pane;
      if (!Number.isInteger(p) || p < 0 || p >= count || seen.has(p)) return null;
      seen.add(p);
      return { pane: p };
    }
    if ((o.dir !== "row" && o.dir !== "column") || !Array.isArray(o.children)) return null;
    const sizes = Array.isArray(o.sizes) ? o.sizes : [];
    const children: Layout[] = [];
    const kept: number[] = [];
    o.children.slice(0, MAX_PANES).forEach((c, i) => {
      const k = visit(c, depth + 1);
      if (!k) return;
      children.push(k);
      const s = sizes[i];
      kept.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1);
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { dir: o.dir, children, sizes: kept };
  };
  const layout = visit(raw, 0);
  return layout && seen.size === count ? layout : null;
}

/** The layout with other ids for its panes (session: index ↔ id). */
export function mapLayout(node: Layout, fn: (pane: number) => number): Layout {
  return isPane(node) ? { pane: fn(node.pane) } : { dir: node.dir, children: node.children.map((c) => mapLayout(c, fn)), sizes: [...node.sizes] };
}
