import type { LayoutSettings, PointMm, RectZone } from '../types/project';

export type LayoutPieceKind = 'full' | 'cut' | 'critical';

export interface LayoutTilePiece {
  col: number;
  heightMm: number;
  id: string;
  kind: LayoutPieceKind;
  polygon?: PointMm[];
  row: number;
  widthMm: number;
  xMm: number;
  yMm: number;
}

export interface LayoutEdgeCuts {
  bottom: number | null;
  left: number | null;
  right: number | null;
  top: number | null;
}

export type LayoutEdgeOffsets = LayoutEdgeCuts;

export interface RectLayoutInput {
  blockedRects?: RectZone[];
  heightMm: number;
  layout: LayoutSettings;
  maxPieces?: number;
  tileHeightMm: number;
  tileWidthMm: number;
  widthMm: number;
}

export interface PolygonLayoutInput {
  blockedRects?: RectZone[];
  layout: LayoutSettings;
  maxPieces?: number;
  points: PointMm[];
  tileHeightMm: number;
  tileWidthMm: number;
}

export interface RectLayoutResult {
  criticalCount: number;
  cutCount: number;
  edgeCuts: LayoutEdgeCuts;
  edgeOffsets: LayoutEdgeOffsets;
  fullCount: number;
  minCutMm: number | null;
  pieces: LayoutTilePiece[];
  truncated: boolean;
}

const DEFAULT_MAX_PIECES = 1200;
const EPSILON_MM = 0.5;

export function generateRectLayout(input: RectLayoutInput): RectLayoutResult {
  const surfaceWidth = Math.max(0, input.widthMm);
  const surfaceHeight = Math.max(0, input.heightMm);
  const tile = getOrientedTile(input.tileWidthMm, input.tileHeightMm, input.layout.rotation, input.layout.pattern === 'diagonal');
  const grout = Math.max(0, input.layout.groutMm);
  const stepX = tile.widthMm + grout;
  const stepY = tile.heightMm + grout;
  const maxPieces = input.maxPieces ?? DEFAULT_MAX_PIECES;
  const origin = resolveOrigin(input.layout, surfaceWidth, surfaceHeight, tile.widthMm, tile.heightMm, stepX, stepY);
  const pieces: LayoutTilePiece[] = [];

  if (surfaceWidth <= 0 || surfaceHeight <= 0 || tile.widthMm <= 0 || tile.heightMm <= 0 || stepX <= 0 || stepY <= 0) {
    return summarizePieces(pieces, false);
  }

  const startY = normalizeStart(origin.yMm, stepY);
  let truncated = false;
  let row = 0;

  for (let tileY = startY; tileY < surfaceHeight; tileY += stepY, row += 1) {
    const rowOffset = getPatternRowOffset(input.layout.pattern, row, stepX);
    const startX = normalizeStart(origin.xMm + rowOffset, stepX);
    let col = 0;

    for (let tileX = startX; tileX < surfaceWidth; tileX += stepX, col += 1) {
      const visible = intersectTile(tileX, tileY, tile.widthMm, tile.heightMm, surfaceWidth, surfaceHeight);
      if (!visible) continue;

      const visibleParts = subtractBlockedRects(visible, input.blockedRects ?? []);
      for (const [partIndex, part] of visibleParts.entries()) {
        pieces.push({
          col,
          heightMm: part.heightMm,
          id: `r${row}-c${col}${visibleParts.length > 1 ? `-p${partIndex}` : ''}`,
          kind: classifyPiece(part.widthMm, part.heightMm, tile.widthMm, tile.heightMm, input.layout.criticalCutMm),
          row,
          widthMm: part.widthMm,
          xMm: part.xMm,
          yMm: part.yMm,
        });
      }

      if (pieces.length >= maxPieces) {
        truncated = true;
        return summarizePieces(pieces, truncated);
      }
    }
  }

  return summarizePieces(pieces, truncated);
}

export function generatePolygonLayout(input: PolygonLayoutInput): RectLayoutResult {
  const box = getBoundingBox(input.points);
  const normalizedPolygon = input.points.map((point) => ({ x: point.x - box.minX, y: point.y - box.minY }));
  const cells = decomposeOrthogonalPolygon(input.points, box);
  const rectResult = generateRectLayout({
    blockedRects: input.blockedRects,
    heightMm: box.height,
    layout: input.layout,
    maxPieces: input.maxPieces,
    tileHeightMm: input.tileHeightMm,
    tileWidthMm: input.tileWidthMm,
    widthMm: box.width,
  });
  const pieces: LayoutTilePiece[] = [];

  if (isConvexPolygon(normalizedPolygon)) {
    for (const piece of rectResult.pieces) {
      const clippedPolygon = clipPolygonByConvexPolygon(rectToPolygon(piece), normalizedPolygon);
      if (clippedPolygon.length < 3 || polygonArea(clippedPolygon) <= EPSILON_MM) continue;
      const clippedBox = getBoundingBox(clippedPolygon);
      pieces.push({
        ...piece,
        heightMm: clippedBox.height,
        kind: classifyPiece(clippedBox.width, clippedBox.height, piece.widthMm, piece.heightMm, input.layout.criticalCutMm),
        polygon: clippedPolygon,
        widthMm: clippedBox.width,
        xMm: clippedBox.minX,
        yMm: clippedBox.minY,
      });
    }
    return summarizePieces(pieces, rectResult.truncated);
  }

  for (const piece of rectResult.pieces) {
    for (const cell of cells) {
      const clipped = intersectRects(
        { heightMm: piece.heightMm, widthMm: piece.widthMm, xMm: piece.xMm, yMm: piece.yMm },
        cell,
      );
      if (!clipped) continue;
      pieces.push({
        ...piece,
        heightMm: clipped.heightMm,
        id: `${piece.id}-${cell.id}`,
        kind: classifyPiece(clipped.widthMm, clipped.heightMm, piece.widthMm, piece.heightMm, input.layout.criticalCutMm),
        polygon: rectToPolygon(clipped),
        widthMm: clipped.widthMm,
        xMm: clipped.xMm,
        yMm: clipped.yMm,
      });
    }
  }

  return summarizePieces(pieces, rectResult.truncated);
}

function isConvexPolygon(points: PointMm[]): boolean {
  if (points.length < 3) return false;
  let direction = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= EPSILON_MM) continue;
    const nextDirection = Math.sign(cross);
    if (direction && nextDirection !== direction) return false;
    direction = nextDirection;
  }
  return direction !== 0;
}

function clipPolygonByConvexPolygon(subject: PointMm[], clip: PointMm[]): PointMm[] {
  let output = subject;
  const orientation = Math.sign(signedPolygonArea(clip)) || 1;
  for (let index = 0; index < clip.length; index += 1) {
    const edgeStart = clip[index];
    const edgeEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      const currentInside = isInsideClipEdge(current, edgeStart, edgeEnd, orientation);
      const previousInside = isInsideClipEdge(previous, edgeStart, edgeEnd, orientation);
      if (currentInside) {
        if (!previousInside) output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
      }
      previous = current;
    }
  }
  return output;
}

function isInsideClipEdge(point: PointMm, edgeStart: PointMm, edgeEnd: PointMm, orientation: number): boolean {
  const cross = (edgeEnd.x - edgeStart.x) * (point.y - edgeStart.y) - (edgeEnd.y - edgeStart.y) * (point.x - edgeStart.x);
  return orientation * cross >= -EPSILON_MM;
}

function lineIntersection(start: PointMm, end: PointMm, edgeStart: PointMm, edgeEnd: PointMm): PointMm {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const edgeDx = edgeEnd.x - edgeStart.x;
  const edgeDy = edgeEnd.y - edgeStart.y;
  const denominator = dx * edgeDy - dy * edgeDx;
  if (Math.abs(denominator) <= EPSILON_MM) return end;
  const t = ((edgeStart.x - start.x) * edgeDy - (edgeStart.y - start.y) * edgeDx) / denominator;
  return { x: start.x + t * dx, y: start.y + t * dy };
}

function signedPolygonArea(points: PointMm[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function polygonArea(points: PointMm[]): number {
  return Math.abs(signedPolygonArea(points));
}

export function getResolvedOrigin(layout: LayoutSettings, surfaceWidthMm: number, surfaceHeightMm: number, tileWidthMm: number, tileHeightMm: number) {
  const tile = getOrientedTile(tileWidthMm, tileHeightMm, layout.rotation, layout.pattern === 'diagonal');
  const grout = Math.max(0, layout.groutMm);
  return resolveOrigin(layout, surfaceWidthMm, surfaceHeightMm, tile.widthMm, tile.heightMm, tile.widthMm + grout, tile.heightMm + grout);
}

function getOrientedTile(widthMm: number, heightMm: number, rotation: 0 | 90, diagonal = false) {
  const width = Math.max(1, Math.round(widthMm));
  const height = Math.max(1, Math.round(heightMm));
  const oriented = rotation === 90 ? { widthMm: height, heightMm: width } : { widthMm: width, heightMm: height };
  if (!diagonal) return oriented;
  const footprint = Math.max(1, Math.ceil((oriented.widthMm + oriented.heightMm) / Math.SQRT2));
  return { widthMm: footprint, heightMm: footprint };
}

function getPatternRowOffset(pattern: LayoutSettings['pattern'], row: number, stepX: number): number {
  if (pattern === 'half-offset') return row % 2 === 1 ? stepX / 2 : 0;
  if (pattern === 'third-offset') return (row % 3) * (stepX / 3);
  if (pattern === 'quarter-offset') return (row % 4) * (stepX / 4);
  if (pattern === 'wood-random') return [0, 0.34, 0.67, 0.18, 0.5][row % 5] * stepX;
  if (pattern === 'diagonal') return row % 2 === 1 ? stepX / 2 : 0;
  return 0;
}

function resolveOrigin(layout: LayoutSettings, surfaceWidthMm: number, surfaceHeightMm: number, tileWidthMm: number, tileHeightMm: number, stepX: number, stepY: number) {
  if (layout.originMode === 'tile-center') {
    return {
      xMm: (surfaceWidthMm - tileWidthMm) / 2,
      yMm: (surfaceHeightMm - tileHeightMm) / 2,
    };
  }

  if (layout.originMode === 'joint-center') {
    return {
      xMm: surfaceWidthMm / 2 - stepX,
      yMm: surfaceHeightMm / 2 - stepY,
    };
  }

  if (layout.originMode === 'corner-tr') {
    return { xMm: surfaceWidthMm - tileWidthMm, yMm: 0 };
  }

  if (layout.originMode === 'corner-t') {
    return { xMm: (surfaceWidthMm - tileWidthMm) / 2, yMm: 0 };
  }

  if (layout.originMode === 'corner-l') {
    return { xMm: 0, yMm: (surfaceHeightMm - tileHeightMm) / 2 };
  }

  if (layout.originMode === 'corner-r') {
    return { xMm: surfaceWidthMm - tileWidthMm, yMm: (surfaceHeightMm - tileHeightMm) / 2 };
  }

  if (layout.originMode === 'corner-bl') {
    return { xMm: 0, yMm: surfaceHeightMm - tileHeightMm };
  }

  if (layout.originMode === 'corner-b') {
    return { xMm: (surfaceWidthMm - tileWidthMm) / 2, yMm: surfaceHeightMm - tileHeightMm };
  }

  if (layout.originMode === 'corner-br') {
    return { xMm: surfaceWidthMm - tileWidthMm, yMm: surfaceHeightMm - tileHeightMm };
  }

  return {
    xMm: layout.originXmm,
    yMm: layout.originYmm,
  };
}

function normalizeStart(originMm: number, stepMm: number): number {
  if (originMm <= 0) return originMm;
  return originMm - Math.ceil(originMm / stepMm) * stepMm;
}

function intersectTile(xMm: number, yMm: number, widthMm: number, heightMm: number, surfaceWidthMm: number, surfaceHeightMm: number) {
  const x1 = Math.max(0, xMm);
  const y1 = Math.max(0, yMm);
  const x2 = Math.min(surfaceWidthMm, xMm + widthMm);
  const y2 = Math.min(surfaceHeightMm, yMm + heightMm);
  const visibleWidth = x2 - x1;
  const visibleHeight = y2 - y1;
  if (visibleWidth <= EPSILON_MM || visibleHeight <= EPSILON_MM) return null;
  return { heightMm: visibleHeight, widthMm: visibleWidth, xMm: x1, yMm: y1 };
}

function subtractBlockedRects(rect: { heightMm: number; widthMm: number; xMm: number; yMm: number }, blockedRects: RectZone[]) {
  const blockers = blockedRects
    .map((blocker) => intersectRects(rect, blocker))
    .filter((blocker): blocker is { heightMm: number; widthMm: number; xMm: number; yMm: number } => Boolean(blocker));
  if (!blockers.length) return [rect];

  const xs = [rect.xMm, rect.xMm + rect.widthMm];
  const ys = [rect.yMm, rect.yMm + rect.heightMm];
  for (const blocker of blockers) {
    xs.push(blocker.xMm, blocker.xMm + blocker.widthMm);
    ys.push(blocker.yMm, blocker.yMm + blocker.heightMm);
  }

  const sortedX = [...new Set(xs)].sort((a, b) => a - b);
  const sortedY = [...new Set(ys)].sort((a, b) => a - b);
  const parts: Array<{ heightMm: number; widthMm: number; xMm: number; yMm: number }> = [];

  for (let yIndex = 0; yIndex < sortedY.length - 1; yIndex += 1) {
    for (let xIndex = 0; xIndex < sortedX.length - 1; xIndex += 1) {
      const x1 = sortedX[xIndex];
      const x2 = sortedX[xIndex + 1];
      const y1 = sortedY[yIndex];
      const y2 = sortedY[yIndex + 1];
      if (x2 - x1 <= EPSILON_MM || y2 - y1 <= EPSILON_MM) continue;
      const center = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      if (blockers.some((blocker) => center.x > blocker.xMm && center.x < blocker.xMm + blocker.widthMm && center.y > blocker.yMm && center.y < blocker.yMm + blocker.heightMm)) continue;
      parts.push({ heightMm: y2 - y1, widthMm: x2 - x1, xMm: x1, yMm: y1 });
    }
  }

  return parts;
}

function classifyPiece(visibleWidthMm: number, visibleHeightMm: number, tileWidthMm: number, tileHeightMm: number, criticalCutMm: number): LayoutPieceKind {
  const fullWidth = Math.abs(visibleWidthMm - tileWidthMm) <= EPSILON_MM;
  const fullHeight = Math.abs(visibleHeightMm - tileHeightMm) <= EPSILON_MM;
  if (fullWidth && fullHeight) return 'full';

  const critical = Math.max(1, criticalCutMm);
  if (visibleWidthMm < critical || visibleHeightMm < critical) return 'critical';
  return 'cut';
}

function summarizePieces(pieces: LayoutTilePiece[], truncated: boolean): RectLayoutResult {
  const cutPieces = pieces.filter((piece) => piece.kind !== 'full');
  const edgeCuts = calculateEdgeCuts(pieces);
  return {
    criticalCount: pieces.filter((piece) => piece.kind === 'critical').length,
    cutCount: pieces.filter((piece) => piece.kind === 'cut').length,
    edgeCuts,
    edgeOffsets: calculateEdgeOffsets(edgeCuts),
    fullCount: pieces.filter((piece) => piece.kind === 'full').length,
    minCutMm: cutPieces.length ? Math.min(...cutPieces.map((piece) => Math.min(piece.widthMm, piece.heightMm))) : null,
    pieces,
    truncated,
  };
}

function calculateEdgeOffsets(edgeCuts: LayoutEdgeCuts): LayoutEdgeOffsets {
  return {
    bottom: edgeCuts.bottom ?? 0,
    left: edgeCuts.left ?? 0,
    right: edgeCuts.right ?? 0,
    top: edgeCuts.top ?? 0,
  };
}

function calculateEdgeCuts(pieces: LayoutTilePiece[]): LayoutEdgeCuts {
  if (!pieces.length) return { bottom: null, left: null, right: null, top: null };
  const minX = Math.min(...pieces.map((piece) => piece.xMm));
  const minY = Math.min(...pieces.map((piece) => piece.yMm));
  const maxX = Math.max(...pieces.map((piece) => piece.xMm + piece.widthMm));
  const maxY = Math.max(...pieces.map((piece) => piece.yMm + piece.heightMm));
  return {
    bottom: getEdgeCut(pieces.filter((piece) => Math.abs(piece.yMm + piece.heightMm - maxY) <= EPSILON_MM), 'heightMm'),
    left: getEdgeCut(pieces.filter((piece) => Math.abs(piece.xMm - minX) <= EPSILON_MM), 'widthMm'),
    right: getEdgeCut(pieces.filter((piece) => Math.abs(piece.xMm + piece.widthMm - maxX) <= EPSILON_MM), 'widthMm'),
    top: getEdgeCut(pieces.filter((piece) => Math.abs(piece.yMm - minY) <= EPSILON_MM), 'heightMm'),
  };
}

function getEdgeCut(pieces: LayoutTilePiece[], dimension: 'heightMm' | 'widthMm'): number | null {
  const cuts = pieces.filter((piece) => piece.kind !== 'full').map((piece) => piece[dimension]);
  return cuts.length ? Math.round(Math.min(...cuts)) : null;
}

function getBoundingBox(points: PointMm[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { height: maxY - minY, maxX, maxY, minX, minY, width: maxX - minX };
}

function decomposeOrthogonalPolygon(points: PointMm[], box: ReturnType<typeof getBoundingBox>) {
  const xs = [...new Set(points.map((point) => point.x - box.minX))].sort((a, b) => a - b);
  const ys = [...new Set(points.map((point) => point.y - box.minY))].sort((a, b) => a - b);
  const normalized = points.map((point) => ({ x: point.x - box.minX, y: point.y - box.minY }));
  const cells: Array<{ heightMm: number; id: string; widthMm: number; xMm: number; yMm: number }> = [];

  for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
      const x1 = xs[xIndex];
      const x2 = xs[xIndex + 1];
      const y1 = ys[yIndex];
      const y2 = ys[yIndex + 1];
      if (x2 - x1 <= EPSILON_MM || y2 - y1 <= EPSILON_MM) continue;
      if (!pointInPolygon({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, normalized)) continue;
      cells.push({ heightMm: y2 - y1, id: `cell-${xIndex}-${yIndex}`, widthMm: x2 - x1, xMm: x1, yMm: y1 });
    }
  }

  return cells.length ? cells : [{ heightMm: box.height, id: 'cell-full', widthMm: box.width, xMm: 0, yMm: 0 }];
}

function intersectRects(
  a: { heightMm: number; widthMm: number; xMm: number; yMm: number },
  b: { heightMm: number; widthMm: number; xMm: number; yMm: number },
) {
  const x1 = Math.max(a.xMm, b.xMm);
  const y1 = Math.max(a.yMm, b.yMm);
  const x2 = Math.min(a.xMm + a.widthMm, b.xMm + b.widthMm);
  const y2 = Math.min(a.yMm + a.heightMm, b.yMm + b.heightMm);
  if (x2 - x1 <= EPSILON_MM || y2 - y1 <= EPSILON_MM) return null;
  return { heightMm: y2 - y1, widthMm: x2 - x1, xMm: x1, yMm: y1 };
}

function rectToPolygon(rect: { heightMm: number; widthMm: number; xMm: number; yMm: number }): PointMm[] {
  return [
    { x: rect.xMm, y: rect.yMm },
    { x: rect.xMm + rect.widthMm, y: rect.yMm },
    { x: rect.xMm + rect.widthMm, y: rect.yMm + rect.heightMm },
    { x: rect.xMm, y: rect.yMm + rect.heightMm },
  ];
}

function pointInPolygon(point: PointMm, polygon: PointMm[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    const crosses = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
