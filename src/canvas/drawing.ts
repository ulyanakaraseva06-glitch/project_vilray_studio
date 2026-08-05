import type { PointMm } from '../types/project';

export const CUSTOM_DRAW_GRID_MM = 250;
export const CUSTOM_DRAW_MIN_POINTS = 4;
export const CUSTOM_DRAW_MAX_POINTS = 12;

export function snapMm(value: number, step = CUSTOM_DRAW_GRID_MM): number {
  return Math.round(value / step) * step;
}

export function snapPoint(point: PointMm, step = CUSTOM_DRAW_GRID_MM): PointMm {
  return { x: snapMm(point.x, step), y: snapMm(point.y, step) };
}

export function constrainOrthogonalPoint(points: PointMm[], nextPoint: PointMm): PointMm {
  const snapped = snapPoint(nextPoint);
  const previous = points[points.length - 1];
  if (!previous) return snapped;

  const deltaX = Math.abs(snapped.x - previous.x);
  const deltaY = Math.abs(snapped.y - previous.y);
  return deltaX >= deltaY ? { x: snapped.x, y: previous.y } : { x: previous.x, y: snapped.y };
}

export function canCloseContour(points: PointMm[]): boolean {
  return points.length >= CUSTOM_DRAW_MIN_POINTS;
}

export function buildClosedOrthogonalContour(points: PointMm[]): PointMm[] | null {
  if (!canCloseContour(points)) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!last) return null;

  if (first.x === last.x || first.y === last.y) return normalizeDraftContour(points);

  return normalizeDraftContour([...points, { x: first.x, y: last.y }]);
}

function normalizeDraftContour(points: PointMm[]): PointMm[] {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return points.map((point) => ({ x: point.x - minX, y: point.y - minY }));
}
