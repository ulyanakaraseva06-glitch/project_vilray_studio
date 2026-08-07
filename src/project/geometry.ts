import type { FinishZone, LayoutSettings, PointMm, ProjectSettings, Room, RoomArea, RoomTemplate, Surface } from '../types/project';

export const MIN_SIDE_MM = 1;
export const MAX_SIDE_MM = 15000;
export const MIN_ROOM_HEIGHT_MM = 1800;
export const MAX_ROOM_HEIGHT_MM = 4500;
const MIN_ROOM_AREA_SQ_MM = 10_000;
const MIN_INTERIOR_ANGLE_DEG = 10;

export function createContourFromTemplate(template: RoomTemplate, size: [number, number] | undefined): PointMm[] {
  const [width, depth] = size ?? template.sizes[0] ?? [1700, 2000];

  if (template.id === 'l-shape') {
    const notchWidth = Math.round(width * 0.38);
    const notchDepth = Math.round(depth * 0.42);
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: depth },
      { x: notchWidth, y: depth },
      { x: notchWidth, y: notchDepth },
      { x: 0, y: notchDepth },
    ];
  }

  if (template.id === 'projection') {
    const projectionWidth = Math.round(width * 0.28);
    const projectionDepth = Math.round(depth * 0.25);
    const centerLeft = Math.round(width * 0.5 - projectionWidth / 2);
    const centerRight = centerLeft + projectionWidth;
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: depth },
      { x: centerRight, y: depth },
      { x: centerRight, y: depth + projectionDepth },
      { x: centerLeft, y: depth + projectionDepth },
      { x: centerLeft, y: depth },
      { x: 0, y: depth },
    ];
  }

  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
}

export function validateRoomHeight(heightMm: number): number {
  return clampInteger(heightMm, MIN_ROOM_HEIGHT_MM, MAX_ROOM_HEIGHT_MM);
}

export function validateContour(contour: PointMm[]): { ok: boolean; message?: string } {
  if (contour.length < 3 || contour.length > 12) {
    return { ok: false, message: 'Контур должен содержать от 3 до 12 стен.' };
  }

  for (let i = 0; i < contour.length; i += 1) {
    const current = contour[i];
    const next = contour[(i + 1) % contour.length];
    const length = segmentLength(current, next);

    if (length < MIN_SIDE_MM || length > MAX_SIDE_MM) return { ok: false, message: 'Сторона вне допустимого диапазона.' };
  }

  if (hasSelfIntersections(contour)) return { ok: false, message: 'Линии помещения не могут пересекаться.' };
  if (polygonArea(contour) < MIN_ROOM_AREA_SQ_MM) return { ok: false, message: 'Контур помещения имеет слишком маленькую площадь.' };

  for (let index = 0; index < contour.length; index += 1) {
    const previous = contour[(index - 1 + contour.length) % contour.length];
    const current = contour[index];
    const next = contour[(index + 1) % contour.length];
    if (interiorAngleDeg(previous, current, next) < MIN_INTERIOR_ANGLE_DEG) return { ok: false, message: 'Угол помещения слишком острый.' };
  }

  return { ok: true };
}

export function updateSegmentLength(contour: PointMm[], segmentIndex: number, nextLengthMm: number): PointMm[] {
  const length = clampInteger(nextLengthMm, MIN_SIDE_MM, MAX_SIDE_MM);
  const current = contour[segmentIndex];
  const next = contour[(segmentIndex + 1) % contour.length];
  const dx = next.x - current.x;
  const dy = next.y - current.y;

  if (dx === 0 && dy === 0) return contour;

  const updated = contour.map((point) => ({ ...point }));
  const currentLength = Math.hypot(dx, dy);
  const directionX = dx / currentLength;
  const directionY = dy / currentLength;
  const newNext = {
    x: current.x + directionX * length,
    y: current.y + directionY * length,
  };
  const delta = { x: newNext.x - next.x, y: newNext.y - next.y };

  // Preserve the familiar rectangular resize behavior for orthogonal contours.
  if (dy === 0) {
    for (const point of updated) {
      if (point.x === next.x) point.x += delta.x;
    }
  } else if (dx === 0) {
    for (const point of updated) {
      if (point.y === next.y) point.y += delta.y;
    }
  } else {
    updated[(segmentIndex + 1) % updated.length] = newNext;
  }

  const normalized = normalizeContour(updated);
  return validateContour(normalized).ok ? normalized : contour;
}

export function moveWall(contour: PointMm[], segmentIndex: number, deltaMm: number): PointMm[] {
  const current = contour[segmentIndex];
  const next = contour[(segmentIndex + 1) % contour.length];
  const dx = next.x - current.x;
  const dy = next.y - current.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return contour;
  const normalX = dx === 0 ? 1 : dy === 0 ? 0 : -dy / length;
  const normalY = dy === 0 ? 1 : dx === 0 ? 0 : dx / length;
  const updated = contour.map((point) => ({ ...point }));

  updated[segmentIndex] = {
    x: Math.round(updated[segmentIndex].x + normalX * deltaMm),
    y: Math.round(updated[segmentIndex].y + normalY * deltaMm),
  };
  updated[(segmentIndex + 1) % updated.length] = {
    x: Math.round(updated[(segmentIndex + 1) % updated.length].x + normalX * deltaMm),
    y: Math.round(updated[(segmentIndex + 1) % updated.length].y + normalY * deltaMm),
  };

  const normalized = normalizeContour(updated);
  return validateContour(normalized).ok ? normalized : contour;
}

export function normalizeRoomAreas(room: Room): RoomArea[] {
  const areas = room.areas?.length ? room.areas : [{ id: 'room-1', name: 'Помещение 1', contour: room.contour }];
  return areas.map((area, index) => ({
    id: area.id || `room-${index + 1}`,
    name: area.name || `Помещение ${index + 1}`,
    contour: area.contour?.length ? area.contour : room.contour,
  }));
}

export function normalizeRoomModel(room: Room): Room {
  const areas = normalizeRoomAreas(room);
  return {
    ...room,
    contour: areas[0]?.contour ?? room.contour,
    areas,
    openings: room.openings ?? [],
    partitions: room.partitions ?? [],
  };
}

export function createSurfaces(contour: PointMm[], roomHeightMm: number, materialId?: string | null, settings?: ProjectSettings): Surface[] {
  return createSurfacesFromRoom({ templateId: null, heightMm: roomHeightMm, contour }, materialId, settings);
}

export function createSurfacesFromRoom(roomInput: Room, materialId?: string | null, settings?: ProjectSettings): Surface[] {
  const room = normalizeRoomModel(roomInput);
  const areaSurfaces = room.areas!.flatMap((area, areaIndex) => createAreaSurfaces(area, areaIndex, room, materialId, settings));
  const partitionSurfaces = (room.partitions ?? []).flatMap((partition, partitionIndex) => {
    const widthMm = segmentLength(partition.start, partition.end);
    const heightMm = partition.heightMm || room.heightMm;
    return (['a', 'b'] as const).map((side) => {
      const id = `surface-partition-${partitionIndex + 1}-${side}`;
      return createWallSurface({
        heightMm,
        id,
        materialId,
        name: `${partition.name || `Перегородка ${partitionIndex + 1}`} ${side === 'a' ? 'A' : 'B'}`,
        openings: room.openings?.filter((opening) => opening.surfaceId === id) ?? [],
        settings,
        sourceRef: `partition:${partition.id}:${side}`,
        widthMm,
      });
    });
  });

  return [...areaSurfaces, ...partitionSurfaces];
}

function createAreaSurfaces(area: RoomArea, areaIndex: number, room: Room, materialId?: string | null, settings?: ProjectSettings): Surface[] {
  const box = getBoundingBox(area.contour);
  const floorId = areaIndex === 0 ? 'surface-floor' : `surface-floor-${area.id}`;
  const floor: Surface = {
    id: floorId,
    type: 'floor',
    name: areaIndex === 0 ? 'Пол' : `Пол ${areaIndex + 1}`,
    widthMm: box.width,
    heightMm: box.height,
    sourceRef: `floor:${area.id}`,
    openings: [],
    zones: [createBaseZone(floorId, { type: 'polygon', points: area.contour }, materialId, settings)],
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    status: 'ready',
  };

  const walls = area.contour.map((point, index) => {
    const next = area.contour[(index + 1) % area.contour.length];
    const wallId = areaIndex === 0 ? `surface-wall-${index + 1}` : `surface-wall-${area.id}-${index + 1}`;
    return createWallSurface({
      heightMm: room.heightMm,
      id: wallId,
      materialId,
      name: areaIndex === 0 ? `Стена ${index + 1}` : `Стена ${areaIndex + 1}.${index + 1}`,
      openings: room.openings?.filter((opening) => opening.surfaceId === wallId) ?? [],
      settings,
      sourceRef: `wall:${area.id}:${index + 1}`,
      widthMm: segmentLength(point, next),
    });
  });

  return [floor, ...walls];
}

function createWallSurface({
  heightMm,
  id,
  materialId,
  name,
  openings,
  settings,
  sourceRef,
  widthMm,
}: {
  heightMm: number;
  id: string;
  materialId?: string | null;
  name: string;
  openings: Surface['openings'];
  settings?: ProjectSettings;
  sourceRef: string;
  widthMm: number;
}): Surface {
  return {
    id,
    type: 'wall',
    name,
    widthMm,
    heightMm,
    sourceRef,
    openings,
    zones: [createBaseZone(id, { type: 'rect', xMm: 0, yMm: 0, widthMm, heightMm }, materialId, settings)],
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    status: 'empty',
  };
}

export function getBoundingBox(points: PointMm[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function segmentLength(a: PointMm, b: PointMm): number {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

export function polygonArea(points: PointMm[]): number {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

export function hasSelfIntersections(points: PointMm[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

function interiorAngleDeg(previous: PointMm, current: PointMm, next: PointMm): number {
  const ax = previous.x - current.x;
  const ay = previous.y - current.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (!lengths) return 0;
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths));
  return Math.acos(cosine) * 180 / Math.PI;
}

function segmentsIntersect(a: PointMm, b: PointMm, c: PointMm, d: PointMm): boolean {
  const cross = (p: PointMm, q: PointMm, r: PointMm) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC === 0 && onSegment(a, b, c)) return true;
  if (abD === 0 && onSegment(a, b, d)) return true;
  if (cdA === 0 && onSegment(c, d, a)) return true;
  if (cdB === 0 && onSegment(c, d, b)) return true;
  return Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
}

function onSegment(a: PointMm, b: PointMm, point: PointMm): boolean {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeContour(contour: PointMm[]): PointMm[] {
  const box = getBoundingBox(contour);
  return contour.map((point) => ({
    x: point.x - box.minX,
    y: point.y - box.minY,
  }));
}

function createBaseZone(surfaceId: string, shape: FinishZone['shape'], materialId?: string | null, settings?: ProjectSettings): FinishZone {
  return {
    id: `${surfaceId}-base-zone`,
    name: 'Базовая зона',
    shape,
    materialId: materialId ?? null,
    layout: createDefaultLayout(settings),
    manualEdits: [],
  };
}

function createDefaultLayout(settings?: ProjectSettings): LayoutSettings {
  return {
    pattern: 'straight',
    rotation: 0,
    angleDeg: 0,
    groutMm: settings?.groutMm ?? 2,
    originXmm: 0,
    originYmm: 0,
    originMode: 'corner-tl',
    criticalCutMm: settings?.criticalCutMm ?? 80,
  };
}
