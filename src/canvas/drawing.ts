import type { PointMm } from '../types/project';

export const CUSTOM_DRAW_GRID_MM = 1;
export const CUSTOM_DRAW_MIN_POINTS = 3;
export const CUSTOM_DRAW_MAX_POINTS = 12;
export const CUSTOM_DRAW_MIN_SIDE_MM = 250;
export const CUSTOM_DRAW_CLOSE_SNAP_MM = 250;

const ROUND_LENGTH_MM = 10;
const ROUND_LENGTH_MAGNET_MM = 4;
const START_AXIS_MAGNET_MM = 125;

export function snapMm(value: number, step = CUSTOM_DRAW_GRID_MM): number {
  return Math.round(value / step) * step;
}

export function snapPoint(point: PointMm, step = CUSTOM_DRAW_GRID_MM): PointMm {
  return { x: snapMm(point.x, step), y: snapMm(point.y, step) };
}

export function constrainFreePoint(nextPoint: PointMm, points: PointMm[] = []): PointMm {
  const snapped = snapPoint(nextPoint);
  const closingPoint = getClosingSnapPoint(points, snapped);
  if (closingPoint) return closingPoint;
  const previous = points[points.length - 1];
  return previous ? magnetizeSegmentLength(previous, snapped) : snapped;
}

export function constrainOrthogonalPoint(points: PointMm[], nextPoint: PointMm): PointMm {
  const snapped = snapPoint(nextPoint);
  const closingPoint = getClosingSnapPoint(points, snapped);
  if (closingPoint) return closingPoint;
  const previous = points[points.length - 1];
  if (!previous) return snapped;
  const deltaX = Math.abs(snapped.x - previous.x);
  const deltaY = Math.abs(snapped.y - previous.y);
  let constrained = deltaX >= deltaY ? { x: snapped.x, y: previous.y } : { x: previous.x, y: snapped.y };
  const first = points[0];
  let alignedWithStart = false;
  if (points.length >= CUSTOM_DRAW_MIN_POINTS) {
    if (constrained.y === previous.y && Math.abs(constrained.x - first.x) <= START_AXIS_MAGNET_MM) {
      constrained = { x: first.x, y: constrained.y };
      alignedWithStart = true;
    }
    if (constrained.x === previous.x && Math.abs(constrained.y - first.y) <= START_AXIS_MAGNET_MM) {
      constrained = { x: constrained.x, y: first.y };
      alignedWithStart = true;
    }
  }
  return alignedWithStart ? constrained : magnetizeSegmentLength(previous, constrained);
}

export function constrainOrthogonalResizePoint(start: PointMm, end: PointMm, pointer: PointMm): PointMm {
  const snapped = snapPoint(pointer);
  return start.y === end.y ? { x: snapped.x, y: start.y } : { x: start.x, y: snapped.y };
}

function getClosingSnapPoint(points: PointMm[], nextPoint: PointMm): PointMm | null {
  if (points.length < CUSTOM_DRAW_MIN_POINTS) return null;
  return distance(points[0], nextPoint) <= CUSTOM_DRAW_CLOSE_SNAP_MM ? points[0] : null;
}

function magnetizeSegmentLength(previous: PointMm, nextPoint: PointMm): PointMm {
  const dx = nextPoint.x - previous.x;
  const dy = nextPoint.y - previous.y;
  const length = Math.hypot(dx, dy);
  if (!length) return nextPoint;
  const roundedLength = Math.round(length / ROUND_LENGTH_MM) * ROUND_LENGTH_MM;
  if (Math.abs(length - roundedLength) > ROUND_LENGTH_MAGNET_MM) return nextPoint;
  const ratio = roundedLength / length;
  return {
    x: Math.round(previous.x + dx * ratio),
    y: Math.round(previous.y + dy * ratio),
  };
}

export function canCloseContour(points: PointMm[]): boolean {
  return points.length >= CUSTOM_DRAW_MIN_POINTS;
}

export function isExplicitlyClosedContour(points: PointMm[]): boolean {
  return points.length > CUSTOM_DRAW_MIN_POINTS && samePoint(points[0], points[points.length - 1]);
}

export function validateDraftPoint(points: PointMm[], nextPoint: PointMm): string | null {
  const previous = points[points.length - 1];
  if (!previous) return null;
  if (distance(previous, nextPoint) < CUSTOM_DRAW_MIN_SIDE_MM) return `Стена должна быть не короче ${CUSTOM_DRAW_MIN_SIDE_MM} мм.`;
  const closesContour = points.length >= CUSTOM_DRAW_MIN_POINTS && samePoint(points[0], nextPoint);
  if (closesContour) {
    for (let index = 1; index < points.length - 2; index += 1) {
      if (segmentsIntersect(points[index], points[index + 1], previous, nextPoint)) return 'Линии помещения не могут пересекаться.';
    }
    return null;
  }
  if (points.some((point) => samePoint(point, nextPoint))) return 'Точки помещения не должны совпадать.';

  for (let index = 0; index < points.length - 2; index += 1) {
    if (segmentsIntersect(points[index], points[index + 1], previous, nextPoint)) return 'Линии помещения не могут пересекаться.';
  }
  return null;
}

export function buildClosedContour(points: PointMm[]): PointMm[] | null {
  const openPoints = removeRepeatedClosingPoint(points);
  if (!canCloseContour(openPoints)) return null;
  const first = openPoints[0];
  const last = openPoints[openPoints.length - 1];
  if (!last) return null;
  if (distance(last, first) < CUSTOM_DRAW_MIN_SIDE_MM) return null;
  for (let index = 1; index < openPoints.length - 2; index += 1) {
    if (segmentsIntersect(openPoints[index], openPoints[index + 1], last, first)) return null;
  }
  return normalizeDraftContour(openPoints);
}

export function buildClosedOrthogonalContour(points: PointMm[]): PointMm[] | null {
  const openPoints = removeRepeatedClosingPoint(points);
  if (!canCloseContour(openPoints)) return null;
  const first = openPoints[0];
  const last = openPoints[openPoints.length - 1];
  if (!last) return null;
  const closed = first.x === last.x || first.y === last.y ? openPoints : [...openPoints, { x: first.x, y: last.y }];
  if (closed.some((point, index) => distance(point, closed[(index + 1) % closed.length]) < CUSTOM_DRAW_MIN_SIDE_MM)) return null;
  return normalizeDraftContour(closed);
}

function removeRepeatedClosingPoint(points: PointMm[]): PointMm[] {
  return points.length > 1 && samePoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
}

function distance(a: PointMm, b: PointMm): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function samePoint(a: PointMm, b: PointMm): boolean {
  return a.x === b.x && a.y === b.y;
}

function segmentsIntersect(a: PointMm, b: PointMm, c: PointMm, d: PointMm): boolean {
  const cross = (p: PointMm, q: PointMm, r: PointMm) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b)) || (Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB));
}

function onSegment(a: PointMm, b: PointMm, point: PointMm): boolean {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

function normalizeDraftContour(points: PointMm[]): PointMm[] {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return points.map((point) => ({ x: point.x - minX, y: point.y - minY }));
}
