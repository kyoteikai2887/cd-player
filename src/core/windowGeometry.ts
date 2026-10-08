/** Native adapters convert physical pixels to logical pixels before calling this module. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const valid = (rect: WindowRect) =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.width > 0 &&
  rect.height > 0;

/** Preserve the top-left where possible; growth at the bottom moves the window upward. */
export function fitMiniWindow(
  current: WindowRect,
  size: Pick<WindowRect, "width" | "height">,
  workArea: WindowRect,
): WindowRect {
  if (!valid(current) || !valid(workArea) || !valid({ x: 0, y: 0, ...size }))
    throw new RangeError("Invalid logical window bounds");
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.min(
      Math.max(current.x, workArea.x),
      workArea.x + workArea.width - width,
    ),
    y: Math.min(
      Math.max(current.y, workArea.y),
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}
