/**
 * Apply a 3x3 homography (row-major as a 3x3 array) to a point [x, y].
 */
export function applyHomography(
  h: number[][],
  x: number,
  y: number,
): [number, number] {
  const wx = h[0][0] * x + h[0][1] * y + h[0][2];
  const wy = h[1][0] * x + h[1][1] * y + h[1][2];
  const w = h[2][0] * x + h[2][1] * y + h[2][2];
  return [wx / w, wy / w];
}
