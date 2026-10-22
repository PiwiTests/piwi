/** A box in viewport pixels. */
export interface LabelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rows a label moves at most, down and up, to find a free place. */
const MAX_SHIFT = 6;
/** Pixels between two labels stacked one above the other. */
const LABEL_GAP = 1;
/** The cells `placeLabels` files the placed labels in, so a new one is compared with its neighbours only. */
const CELL_WIDTH = 120;
const CELL_HEIGHT = 32;

/**
 * Where each label goes, so that no two overlap: above its element's top left corner (on the element when there is no
 * room above it), else shifted one row at a time, down then up, up to `MAX_SHIFT` rows, to the first place no label
 * placed before it takes, inside the viewport. Labels are placed in their order, so the first ones keep their place;
 * null for a label that finds none.
 */
export function placeLabels(
  labels: Array<{ anchor: LabelBox; width: number; height: number }>,
  viewport: { width: number; height: number },
): Array<{ left: number; top: number } | null> {
  const cells = new Map<string, LabelBox[]>();
  const cellsOf = (box: LabelBox): string[] => {
    const keys: string[] = [];
    for (let x = Math.floor(box.left / CELL_WIDTH); x <= Math.floor((box.left + box.width) / CELL_WIDTH); x++) {
      for (let y = Math.floor(box.top / CELL_HEIGHT); y <= Math.floor((box.top + box.height) / CELL_HEIGHT); y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  };
  const apart = (a: LabelBox, b: LabelBox): boolean =>
    a.left >= b.left + b.width || b.left >= a.left + a.width || a.top >= b.top + b.height || b.top >= a.top + a.height;
  const free = (box: LabelBox): boolean =>
    cellsOf(box).every((key) => (cells.get(key) ?? []).every((o) => apart(box, o)));

  return labels.map(({ anchor, width, height }) => {
    const left = Math.max(0, Math.min(anchor.left, viewport.width - width));
    const base = anchor.top >= height ? anchor.top - height : Math.max(0, anchor.top);
    const step = height + LABEL_GAP;
    const tops = [base];
    for (let shift = 1; shift <= MAX_SHIFT; shift++) tops.push(base + shift * step, base - shift * step);
    for (const top of tops) {
      if (top < 0 || top + height > viewport.height) continue;
      const box = { left, top, width, height };
      if (!free(box)) continue;
      for (const key of cellsOf(box)) {
        const cell = cells.get(key);
        if (cell) cell.push(box);
        else cells.set(key, [box]);
      }
      return { left, top };
    }
    return null;
  });
}
