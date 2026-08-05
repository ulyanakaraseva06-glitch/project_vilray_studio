import type { FinishZone, LayoutSettings, PointMm, ProjectSettings, Room, RoomArea, RoomTemplate, Surface } from '../types/project';

export const MIN_SIDE_MM = 1;
export const MAX_SIDE_MM = 15000;
export const MIN_ROOM_HEIGHT_MM = 1800;
export const MAX_ROOM_HEIGHT_MM = 4500;

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
  if (contour.length < 4 || contour.length > 12) {
    return { ok: false, message: 'Контур должен содержать от 4 до 12 стен.' };
  }

  for (let i = 0; i < contour.length; i += 1) {
    const current = contour[i];
    const next = contour[(i + 1) % contour.length];
    const horizontal = current.y === next.y;
    const vertical = current.x === next.x;
    const length = segmentLength(current, next);

    if (!horizontal && !vertical) return { ok: false, message: 'Допустимы только углы 90°.' };
    if (length < MIN_SIDE_MM || length > MAX_SIDE_MM) return { ok: false, message: 'Сторона вне допустимого диапазона.' };
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
  const directionX = dx === 0 ? 0 : Math.sign(dx);
  const directionY = dy === 0 ? 0 : Math.sign(dy);
  const newNext = {
    x: current.x + directionX * length,
    y: current.y + directionY * length,
  };
  const delta = { x: newNext.x - next.x, y: newNext.y - next.y };

  // Changing a side moves the boundary line that contains the segment's next point.
  if (dx !== 0) {
    for (const point of updated) {
      if (point.x === next.x) point.x += delta.x;
    }
  } else {
    for (const point of updated) {
      if (point.y === next.y) point.y += delta.y;
    }
  }

  return normalizeContour(updated);
}

export function moveWall(contour: PointMm[], segmentIndex: number, deltaMm: number): PointMm[] {
  const current = contour[segmentIndex];
  const next = contour[(segmentIndex + 1) % contour.length];
  const horizontal = current.y === next.y;
  const updated = contour.map((point) => ({ ...point }));

  updated[segmentIndex] = {
    x: updated[segmentIndex].x + (horizontal ? 0 : deltaMm),
    y: updated[segmentIndex].y + (horizontal ? deltaMm : 0),
  };
  updated[(segmentIndex + 1) % updated.length] = {
    x: updated[(segmentIndex + 1) % updated.length].x + (horizontal ? 0 : deltaMm),
    y: updated[(segmentIndex + 1) % updated.length].y + (horizontal ? deltaMm : 0),
  };

  return normalizeContour(updated);
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
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
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
