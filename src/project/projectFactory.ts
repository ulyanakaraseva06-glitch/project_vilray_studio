import { serviceConfig, templates, tileSizePresets } from '../config/appConfig';
import type { FinishZone, Opening, Partition, PointMm, ProjectSettings, RectZone, Room, RoomArea, RoomObject, RoomTemplate, Surface, TileMaterial, TileProject, TileSizePreset } from '../types/project';
import { createContourFromTemplate, createSurfacesFromRoom, getBoundingBox, moveWall, normalizeRoomModel, segmentLength, updateSegmentLength, validateRoomHeight } from './geometry';

const PRIMARY_MATERIAL_ID = 'material-primary';
const DEFAULT_TILE_PRESET_ID = '600x1200';
const MIN_ZONE_SIZE_MM = 100;
const DEFAULT_ADJACENT_ROOM_WIDTH_MM = 1600;
const DEFAULT_ADJACENT_ROOM_DEPTH_MM = 2000;
const DEFAULT_DOOR_WIDTH_MM = 800;
const DEFAULT_DOOR_HEIGHT_MM = 2100;
const DEFAULT_PASSAGE_WIDTH_MM = 900;
const DEFAULT_WINDOW_SIZE_MM = 1000;
const MIN_OPENING_SIZE_MM = 300;
const MIN_OBJECT_SIZE_MM = 1;

export function createProjectFromTemplate(template: RoomTemplate, size?: [number, number], previous?: TileProject): TileProject {
  const now = new Date().toISOString();
  const contour = createContourFromTemplate(template, size);
  const heightMm = validateRoomHeight(template.heightMm || serviceConfig.defaults.roomHeightMm);
  const settings = previous?.settings ?? createDefaultSettings();
  const materials = normalizeMaterials(previous?.materials?.length ? previous.materials : [createMaterialFromPreset(getDefaultTilePreset(), settings)], settings);
  const primaryMaterial = materials[0] ?? createMaterialFromPreset(getDefaultTilePreset(), settings);

  return {
    schemaVersion: 1,
    id: previous?.id ?? createId(),
    name: previous?.name ?? 'Новый проект',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    room: normalizeRoomModel({
      templateId: template.id === 'custom' ? null : template.id,
      heightMm,
      contour,
    }),
    surfaces: mergeSurfaceAssignments(createSurfacesFromRoom(normalizeRoomModel({ templateId: template.id === 'custom' ? null : template.id, heightMm, contour }), primaryMaterial.id, settings), previous?.surfaces, materials, primaryMaterial.id),
    objects: [],
    materials,
    settings,
  };
}

export function updateRoomHeight(project: TileProject, heightMm: number): TileProject {
  const areaId = ensureProjectDefaults(project).room.areas?.[0]?.id ?? 'room-1';
  return updateRoomAreaHeight(project, areaId, heightMm);
}

export function updateRoomAreaHeight(project: TileProject, areaId: string, heightMm: number): TileProject {
  const nextHeight = validateRoomHeight(heightMm);
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const areaIndex = normalized.room.areas?.findIndex((area) => area.id === areaId) ?? -1;
  if (areaIndex < 0) return normalized;
  const surfaceIds = new Set(normalized.surfaces.filter((surface) => surface.sourceRef?.startsWith(`wall:${areaId}:`)).map((surface) => surface.id));
  const room = normalizeRoomModel({
    ...normalized.room,
    heightMm: areaIndex === 0 ? nextHeight : normalized.room.heightMm,
    areas: normalized.room.areas?.map((area) => area.id === areaId ? { ...area, heightMm: nextHeight } : area),
    openings: normalized.room.openings?.map((opening) => {
      if (!surfaceIds.has(opening.surfaceId)) return opening;
      if (opening.kind === 'passage') return { ...opening, yMm: 0, heightMm: nextHeight };
      if (opening.kind === 'door') {
        const openingHeight = Math.min(opening.heightMm, nextHeight);
        return { ...opening, yMm: nextHeight - openingHeight, heightMm: openingHeight };
      }
      const openingHeight = Math.min(opening.heightMm, nextHeight);
      return { ...opening, yMm: Math.max(0, Math.min(opening.yMm, nextHeight - openingHeight)), heightMm: openingHeight };
    }),
    partitions: normalized.room.partitions?.map((partition) => (partition.areaId ?? 'room-1') === areaId ? { ...partition, heightMm: nextHeight } : partition),
  });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
}

export function updateRoomContour(project: TileProject, contour: TileProject['room']['contour'], shapeLocked?: boolean): TileProject {
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({
    ...normalized.room,
    contour,
    areas: (normalized.room.areas ?? []).map((area, index) => (index === 0 ? { ...area, contour, shapeLocked: shapeLocked ?? area.shapeLocked } : area)),
  });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
}

export function updateRoomSegmentLength(project: TileProject, segmentIndex: number, lengthMm: number): TileProject {
  return updateRoomContour(project, updateSegmentLength(project.room.contour, segmentIndex, lengthMm));
}

export function updateRoomAreaSegmentLength(project: TileProject, areaId: string, segmentIndex: number, lengthMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const areas = room.areas ?? [];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  if (areaIndex < 0) return normalized;
  return updateRoomAreaContour(normalized, areaIndex, updateSegmentLength(areas[areaIndex].contour, segmentIndex, lengthMm));
}

export function moveRoomAreaWall(project: TileProject, areaId: string, segmentIndex: number, deltaMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const areas = room.areas ?? [];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  if (areaIndex < 0) return normalized;
  return updateRoomAreaContour(normalized, areaIndex, moveWall(areas[areaIndex].contour, segmentIndex, deltaMm));
}

function updateRoomAreaContour(project: TileProject, areaIndex: number, contour: TileProject['room']['contour']): TileProject {
  const materialId = getPrimaryMaterial(project)?.id ?? null;
  const areas = project.room.areas ?? [];
  const room = normalizeRoomModel({
    ...project.room,
    contour: areaIndex === 0 ? contour : project.room.contour,
    areas: areas.map((area, index) => index === areaIndex ? { ...area, contour } : area),
  });
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, project, materialId),
  };
}

export function updatePrimaryTileMaterial(project: TileProject, tile: TileSizePreset): TileProject {
  if (!tile.widthMm || !tile.heightMm) return ensureProjectDefaults(project);
  const normalized = ensureProjectDefaults(project);
  const material = createMaterialFromPreset(tile, normalized.settings, getPrimaryMaterial(normalized)?.id ?? PRIMARY_MATERIAL_ID);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    materials: [material],
    surfaces: createSurfacesFromRoom(normalized.room, material.id, normalized.settings),
  };
}

export function updatePrimaryCustomTileMaterial(project: TileProject, widthMm: number, heightMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const material = createMaterialFromSize(widthMm, heightMm, normalized.settings, getPrimaryMaterial(normalized)?.id ?? PRIMARY_MATERIAL_ID);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    materials: [material],
    surfaces: createSurfacesFromRoom(normalized.room, material.id, normalized.settings),
  };
}

export function updateSurfaceTileMaterial(project: TileProject, surfaceId: string, tile: TileSizePreset): TileProject {
  if (!tile.widthMm || !tile.heightMm) return ensureProjectDefaults(project);
  const normalized = ensureProjectDefaults(project);
  const material = findMatchingMaterial(normalized.materials, tile.widthMm, tile.heightMm, tile.id) ?? createMaterialFromPreset(tile, normalized.settings, getAvailableMaterialId(normalized.materials, `material-${tile.id}`));
  return assignMaterialToSurface(normalized, surfaceId, material);
}

export function updateSurfaceCustomTileMaterial(project: TileProject, surfaceId: string, widthMm: number, heightMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const material =
    findMatchingMaterial(normalized.materials, widthMm, heightMm) ??
    createMaterialFromSize(widthMm, heightMm, normalized.settings, getAvailableMaterialId(normalized.materials, `material-custom-${Math.round(widthMm)}x${Math.round(heightMm)}`));
  return assignMaterialToSurface(normalized, surfaceId, material);
}

export function updateZoneTileMaterial(project: TileProject, surfaceId: string, zoneId: string, tile: TileSizePreset): TileProject {
  if (!tile.widthMm || !tile.heightMm) return ensureProjectDefaults(project);
  const normalized = ensureProjectDefaults(project);
  const material = findMatchingMaterial(normalized.materials, tile.widthMm, tile.heightMm, tile.id) ?? createMaterialFromPreset(tile, normalized.settings, getAvailableMaterialId(normalized.materials, `material-${tile.id}`));
  return assignMaterialToZone(normalized, surfaceId, zoneId, material);
}

export function updateZoneCustomTileMaterial(project: TileProject, surfaceId: string, zoneId: string, widthMm: number, heightMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const material =
    findMatchingMaterial(normalized.materials, widthMm, heightMm) ??
    createMaterialFromSize(widthMm, heightMm, normalized.settings, getAvailableMaterialId(normalized.materials, `material-custom-${Math.round(widthMm)}x${Math.round(heightMm)}`));
  return assignMaterialToZone(normalized, surfaceId, zoneId, material);
}

export function updateSurfaceLayoutOrigin(project: TileProject, surfaceId: string, originMode: TileProject['surfaces'][number]['zones'][number]['layout']['originMode']): TileProject {
  const normalized = ensureProjectDefaults(project);
  const zoneId = normalized.surfaces.find((surface) => surface.id === surfaceId)?.zones[0]?.id;
  return zoneId ? updateZoneLayoutOrigin(normalized, surfaceId, zoneId, originMode) : normalized;
}

export function updateZoneLayoutOrigin(project: TileProject, surfaceId: string, zoneId: string, originMode: TileProject['surfaces'][number]['zones'][number]['layout']['originMode']): TileProject {
  const normalized = ensureProjectDefaults(project);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) => (zone.id === zoneId ? { ...zone, layout: { ...zone.layout, originMode, originXmm: 0, originYmm: 0 } } : zone)),
      };
    }),
  };
}

export function updateZoneLayoutPattern(project: TileProject, surfaceId: string, zoneId: string, pattern: TileProject['surfaces'][number]['zones'][number]['layout']['pattern']): TileProject {
  const normalized = ensureProjectDefaults(project);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) =>
          zone.id === zoneId
            ? {
                ...zone,
                layout: {
                  ...zone.layout,
                  angleDeg: pattern === 'diagonal' ? 45 : 0,
                  pattern,
                },
              }
            : zone,
        ),
      };
    }),
  };
}

export function updateSurfaceLayoutOffset(project: TileProject, surfaceId: string, originXmm: number, originYmm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const zoneId = normalized.surfaces.find((surface) => surface.id === surfaceId)?.zones[0]?.id;
  return zoneId ? updateZoneLayoutOffset(normalized, surfaceId, zoneId, originXmm, originYmm) : normalized;
}

export function updateZoneLayoutOffset(project: TileProject, surfaceId: string, zoneId: string, originXmm: number, originYmm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) =>
          zone.id === zoneId
            ? {
                ...zone,
                layout: {
                  ...zone.layout,
                  originMode: 'manual',
                  originXmm: clampLayoutOffset(originXmm),
                  originYmm: clampLayoutOffset(originYmm),
                },
              }
            : zone,
        ),
      };
    }),
  };
}

export type ZonePresetKind = 'rect' | 'shower' | 'horizontal-band' | 'vertical-band';

export function addFloorZone(project: TileProject, kind: ZonePresetKind): TileProject {
  const normalized = ensureProjectDefaults(project);
  const floor = normalized.surfaces.find((surface) => surface.id === 'surface-floor');
  if (!floor) return normalized;
  const baseZone = floor.zones[0];
  const zone = createFloorZone(floor, baseZone?.materialId ?? getPrimaryMaterial(normalized)?.id ?? null, normalized.settings, kind);

  return appendZone(normalized, floor.id, zone);
}

export function addWallZone(project: TileProject, surfaceId: string, kind: Exclude<ZonePresetKind, 'shower'>): TileProject {
  const normalized = ensureProjectDefaults(project);
  const wall = normalized.surfaces.find((surface) => surface.id === surfaceId && surface.type === 'wall');
  if (!wall) return normalized;
  const baseZone = wall.zones[0];
  const zone = createFloorZone(wall, baseZone?.materialId ?? getPrimaryMaterial(normalized)?.id ?? null, normalized.settings, kind);

  return appendZone(normalized, wall.id, zone);
}

export function updateZoneShape(project: TileProject, surfaceId: string, zoneId: string, patch: Partial<RectZone>): TileProject {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  if (!surface) return normalized;
  const zoneIndex = surface.zones.findIndex((zone) => zone.id === zoneId);
  if (zoneIndex <= 0) return normalized;
  const zone = surface.zones[zoneIndex];
  if (zone.shape.type !== 'rect') return normalized;
  const nextShape = clampRectZone({ ...zone.shape, ...patch, type: 'rect' }, surface);

  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((surface) =>
      surface.id === surfaceId
        ? {
            ...surface,
            zones: surface.zones.map((item) => (item.id === zoneId ? { ...item, shape: nextShape } : item)),
          }
        : surface,
    ),
  };
}

export function deleteZone(project: TileProject, surfaceId: string, zoneId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      const zoneIndex = surface.zones.findIndex((zone) => zone.id === zoneId);
      if (zoneIndex <= 0) return surface;
      return { ...surface, zones: surface.zones.filter((zone) => zone.id !== zoneId) };
    }),
  };
}

export function addAdjacentRoom(project: TileProject): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const areas = room.areas ?? [];
  const baseBox = getBoundingBox(areas[0]?.contour ?? room.contour);
  const width = Math.min(DEFAULT_ADJACENT_ROOM_WIDTH_MM, Math.max(1200, baseBox.width));
  const depth = Math.min(DEFAULT_ADJACENT_ROOM_DEPTH_MM, Math.max(1400, baseBox.height));
  const x = baseBox.maxX;
  const y = baseBox.minY;
  const areaIndex = areas.length + 1;
  const areaId = `room-${areaIndex}`;
  const area = {
    id: areaId,
    name: `Помещение ${areaIndex}`,
    heightMm: room.heightMm,
    contour: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + depth },
      { x, y: y + depth },
    ],
  };
  const nextRoom = normalizeRoomModel({
    ...room,
    areas: [...areas, area],
  });
  const baseWallId = findRightWallId(areas[0]?.contour ?? room.contour, 'surface-wall');
  const newRoomLeftWallId = `surface-wall-${areaId}-4`;
  const openings = [
    ...(nextRoom.openings ?? []),
    createCenteredOpening(baseWallId, 'passage', segmentLength((areas[0]?.contour ?? room.contour)[1], (areas[0]?.contour ?? room.contour)[2]), room.heightMm),
    createCenteredOpening(newRoomLeftWallId, 'passage', depth, room.heightMm),
  ];
  const roomWithOpenings = normalizeRoomModel({ ...nextRoom, openings });

  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: roomWithOpenings,
    surfaces: createSurfacesWithAssignments(roomWithOpenings, normalized, materialId),
  };
}

export function addRoomFromTemplate(project: TileProject, template: RoomTemplate, size?: [number, number]): TileProject {
  return addRoomFromContour(project, createContourFromTemplate(template, size), false);
}

export function addRoomFromContour(project: TileProject, contour: TileProject['room']['contour'], shapeLocked = true): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const areas = room.areas ?? [];
  const localBox = getBoundingBox(contour);
  const rightEdge = Math.max(...areas.map((area) => getBoundingBox(area.contour).maxX));
  const baseTop = getBoundingBox(areas[0]?.contour ?? room.contour).minY;
  const areaIndex = areas.length + 1;
  const areaId = `room-${areaIndex}`;
  const offsetX = rightEdge + 500 - localBox.minX;
  const offsetY = baseTop - localBox.minY;
  const area = {
    id: areaId,
    name: `Помещение ${areaIndex}`,
    heightMm: room.heightMm,
    shapeLocked,
    contour: contour.map((point) => ({ x: Math.round(point.x + offsetX), y: Math.round(point.y + offsetY) })),
  };
  const nextRoom = normalizeRoomModel({ ...room, areas: [...areas, area] });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: nextRoom,
    surfaces: createSurfacesWithAssignments(nextRoom, normalized, materialId),
  };
}

export interface RoomActionResult {
  error?: string;
  project: TileProject;
}

export function moveRoomArea(project: TileProject, areaId: string, deltaXmm: number, deltaYmm: number): TileProject {
  return moveRoomAreaChecked(project, areaId, deltaXmm, deltaYmm).project;
}

export function moveRoomAreaChecked(project: TileProject, areaId: string, deltaXmm: number, deltaYmm: number): RoomActionResult {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const areas = room.areas ?? [];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  if (areaIndex < 0) return { project: normalized };
  const movingAreaIds = getConnectedAreaIds(normalized, areaId);
  const movingAreas = areas.filter((area) => movingAreaIds.has(area.id));
  const stationaryAreas = areas.filter((area) => !movingAreaIds.has(area.id));
  let appliedX = Math.round(deltaXmm);
  let appliedY = Math.round(deltaYmm);
  let movedBox = getBoundingBox(movingAreas.flatMap((area) => area.contour.map((point) => ({ x: point.x + appliedX, y: point.y + appliedY }))));
  const snapDistanceMm = 180;
  let snapX = 0;
  let snapY = 0;
  for (const area of stationaryAreas) {
    const box = getBoundingBox(area.contour);
    const xCandidates = [box.maxX - movedBox.minX, box.minX - movedBox.maxX].filter((value) => Math.abs(value) <= snapDistanceMm);
    const yCandidates = [box.maxY - movedBox.minY, box.minY - movedBox.maxY].filter((value) => Math.abs(value) <= snapDistanceMm);
    const nextX = xCandidates.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    const nextY = yCandidates.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    if (nextX !== undefined && (!snapX || Math.abs(nextX) < Math.abs(snapX))) snapX = nextX;
    if (nextY !== undefined && (!snapY || Math.abs(nextY) < Math.abs(snapY))) snapY = nextY;
  }
  if (snapX || snapY) {
    appliedX += snapX;
    appliedY += snapY;
    movedBox = { ...movedBox, minX: movedBox.minX + snapX, maxX: movedBox.maxX + snapX, minY: movedBox.minY + snapY, maxY: movedBox.maxY + snapY };
  }
  const movedAreas = movingAreas.map((area) => ({ ...area, contour: translateContour(area.contour, appliedX, appliedY) }));
  const overlaps = movedAreas.some((movedArea) => stationaryAreas.some((stationary) => polygonsOverlapInterior(movedArea.contour, stationary.contour)));
  if (overlaps) return { error: 'Помещения нельзя накладывать друг на друга. Отодвиньте помещение или соедините его через свободную дверь либо проход.', project: normalized };
  const previewAreas = areas.map((area) => movedAreas.find((moved) => moved.id === area.id) ?? area);
  const previewProject = { ...normalized, room: { ...room, contour: previewAreas[0]?.contour ?? room.contour, areas: previewAreas } };
  if (hasWindowOnAreaIntersection(previewProject)) {
    return { error: 'Окно нельзя размещать на линии соединения помещений. Отодвиньте помещение или перенесите окно на другую стену.', project: normalized };
  }
  if (hasOpeningTouchingMultipleAreas(previewProject)) {
    return { error: 'Дверь или проход не могут выходить сразу в несколько помещений. Измените расположение общей схемы.', project: normalized };
  }
  const nextRoom = normalizeRoomModel({
    ...room,
    contour: movingAreaIds.has(areas[0]?.id ?? '') ? translateContour(room.contour, appliedX, appliedY) : room.contour,
    areas: areas.map((area) => movingAreaIds.has(area.id) ? { ...area, contour: translateContour(area.contour, appliedX, appliedY) } : area),
    partitions: room.partitions?.map((partition) => movingAreaIds.has(partition.areaId ?? areas[0]?.id ?? 'room-1') ? { ...partition, start: translatePoint(partition.start, appliedX, appliedY), end: translatePoint(partition.end, appliedX, appliedY) } : partition),
  });
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  return { project: {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: nextRoom,
    objects: normalized.objects.map((object) => movingAreaIds.has(object.areaId) ? {
      ...object,
      initialXmm: object.initialXmm + appliedX,
      initialYmm: object.initialYmm + appliedY,
      xMm: object.xMm + appliedX,
      yMm: object.yMm + appliedY,
    } : object),
    surfaces: createSurfacesWithAssignments(nextRoom, normalized, materialId),
  } };
}

export interface OpeningConnectionCandidate {
  areaId: string;
  areaName: string;
  kind: 'door' | 'passage';
  label: string;
  openingId: string;
}

export function getOpeningConnectionCandidates(project: TileProject, openingId: string): OpeningConnectionCandidate[] {
  const normalized = ensureProjectDefaults(project);
  const source = normalized.room.openings?.find((opening) => opening.id === openingId);
  if (!source || source.kind === 'window' || source.connectedOpeningId) return [];
  const sourceAreaId = getOpeningAreaId(normalized, source);
  if (!sourceAreaId) return [];
  const sourceComponent = getConnectedAreaIds(normalized, sourceAreaId);
  return (normalized.room.openings ?? [])
    .filter((opening): opening is Opening & { kind: 'door' | 'passage' } => opening.kind === source.kind && opening.id !== source.id && !opening.connectedOpeningId)
    .map((opening) => ({ opening, areaId: getOpeningAreaId(normalized, opening) }))
    .filter((item): item is { opening: Opening & { kind: 'door' | 'passage' }; areaId: string } => Boolean(item.areaId) && !sourceComponent.has(item.areaId!))
    .map(({ opening, areaId }) => {
      const area = normalized.room.areas?.find((item) => item.id === areaId);
      return {
        areaId,
        areaName: area?.name ?? 'Помещение',
        kind: opening.kind,
        label: getOpeningLabel(opening),
        openingId: opening.id,
      };
    });
}

export function connectRoomOpenings(project: TileProject, sourceOpeningId: string, targetOpeningId: string): RoomActionResult {
  const normalized = ensureProjectDefaults(project);
  const source = normalized.room.openings?.find((opening) => opening.id === sourceOpeningId);
  const target = normalized.room.openings?.find((opening) => opening.id === targetOpeningId);
  if (!source || !target || source.kind === 'window' || target.kind === 'window') {
    return { error: 'Для соединения выберите две двери или два прохода.', project: normalized };
  }
  if (source.kind !== target.kind) {
    return { error: 'Дверь можно соединить только с дверью, а проход — только с проходом.', project: normalized };
  }
  if (source.connectedOpeningId || target.connectedOpeningId) {
    return { error: 'Один из выбранных проёмов уже занят. Выберите свободную дверь или свободный проход.', project: normalized };
  }
  const sourceAnchor = getOpeningAnchor(normalized, source);
  const targetAnchor = getOpeningAnchor(normalized, target);
  if (!sourceAnchor || !targetAnchor || sourceAnchor.areaId === targetAnchor.areaId) {
    return { error: 'Проёмы должны находиться в разных помещениях.', project: normalized };
  }
  const sourceComponent = getConnectedAreaIds(normalized, sourceAnchor.areaId);
  if (sourceComponent.has(targetAnchor.areaId)) {
    return { error: 'Эти помещения уже входят в одну схему.', project: normalized };
  }
  const connectorSurfaceIds = new Set([source.surfaceId, target.surfaceId]);
  if ((normalized.room.openings ?? []).some((opening) => opening.kind === 'window' && connectorSurfaceIds.has(opening.surfaceId))) {
    return { error: 'На стене соединения находится окно. Перенесите окно на другую стену или выберите другой проём.', project: normalized };
  }

  const angle = Math.atan2(-targetAnchor.normal.y, -targetAnchor.normal.x) - Math.atan2(sourceAnchor.normal.y, sourceAnchor.normal.x);
  const rotatedSourceCenter = rotatePoint(sourceAnchor.center, sourceAnchor.center, angle);
  const offsetX = targetAnchor.center.x - rotatedSourceCenter.x;
  const offsetY = targetAnchor.center.y - rotatedSourceCenter.y;
  const transform = (point: PointMm) => translatePoint(rotatePoint(point, sourceAnchor.center, angle), offsetX, offsetY);
  const areas = normalized.room.areas ?? [];
  const transformedAreas = areas.map((area) => sourceComponent.has(area.id) ? { ...area, contour: area.contour.map(transform) } : area);
  const movingAreas = transformedAreas.filter((area) => sourceComponent.has(area.id));
  const stationaryAreas = transformedAreas.filter((area) => !sourceComponent.has(area.id));
  if (movingAreas.some((moving) => stationaryAreas.some((stationary) => polygonsOverlapInterior(moving.contour, stationary.contour)))) {
    return { error: 'После соединения помещения накладываются друг на друга. Выберите другой проём или измените расположение помещений.', project: normalized };
  }

  const transformedSourceCenter = transform(sourceAnchor.center);
  const touchesAnotherRoom = stationaryAreas.some((area) => area.id !== targetAnchor.areaId && isPointOnContourBoundary(transformedSourceCenter, area.contour, 5));
  if (touchesAnotherRoom) {
    return { error: 'Эта дверь будет выходить сразу в несколько помещений. Выберите другой свободный проём.', project: normalized };
  }
  const previewProject = { ...normalized, room: { ...normalized.room, contour: transformedAreas[0]?.contour ?? normalized.room.contour, areas: transformedAreas } };
  if (hasWindowOnAreaIntersection(previewProject)) {
    return { error: 'После соединения окно окажется на стыке помещений. Перенесите окно или выберите другой проём.', project: normalized };
  }
  if (hasOpeningTouchingMultipleAreas(previewProject)) {
    return { error: 'После соединения одна из дверей будет выходить сразу в несколько помещений. Выберите другой проём.', project: normalized };
  }

  const openings = (normalized.room.openings ?? []).map((opening) => {
    if (opening.id === source.id) return { ...opening, connectedOpeningId: target.id };
    if (opening.id === target.id) return { ...opening, connectedOpeningId: source.id };
    return opening;
  });
  const nextRoom = normalizeRoomModel({
    ...normalized.room,
    contour: sourceComponent.has(areas[0]?.id ?? '') ? transformedAreas[0].contour : normalized.room.contour,
    areas: transformedAreas,
    openings,
    partitions: normalized.room.partitions?.map((partition) => sourceComponent.has(partition.areaId ?? areas[0]?.id ?? 'room-1') ? { ...partition, start: transform(partition.start), end: transform(partition.end) } : partition),
  });
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  return {
    project: {
      ...normalized,
      updatedAt: new Date().toISOString(),
      room: nextRoom,
      surfaces: createSurfacesWithAssignments(nextRoom, normalized, materialId),
    },
  };
}

export function addOpening(project: TileProject, surfaceId: string, kind: Opening['kind']): TileProject {
  return addOpeningDetailed(project, surfaceId, kind).project;
}

export function addOpeningDetailed(project: TileProject, surfaceId: string, kind: Opening['kind']): { opening: Opening | null; project: TileProject } {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId && item.type === 'wall');
  if (!surface) return { opening: null, project: normalized };
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const areaId = getSurfaceAreaId(surface) ?? normalized.room.areas?.[0]?.id ?? 'room-1';
  const areaHeight = normalized.room.areas?.find((area) => area.id === areaId)?.heightMm ?? normalized.room.heightMm;
  const number = kind === 'window' ? undefined : Math.max(0, ...(normalized.room.openings ?? []).filter((item) => item.kind === kind).map((item) => item.number ?? 0)) + 1;
  const opening = createCenteredOpening(surface.id, kind, surface.widthMm, areaHeight, number);
  const room = normalizeRoomModel({
    ...normalized.room,
    openings: [...(normalized.room.openings ?? []), opening],
  });
  const nextProject = {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
  return { opening, project: nextProject };
}

export function moveOpening(project: TileProject, openingId: string, xMm: number, yMm?: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const opening = normalized.room.openings?.find((item) => item.id === openingId);
  const surface = opening ? normalized.surfaces.find((item) => item.id === opening.surfaceId && item.type === 'wall') : null;
  if (!opening || !surface) return normalized;
  const nextXmm = Math.max(0, Math.min(Math.round(xMm), Math.max(0, surface.widthMm - opening.widthMm)));
  const nextYmm = opening.kind === 'window' && yMm !== undefined
    ? Math.max(0, Math.min(Math.round(yMm), Math.max(0, surface.heightMm - opening.heightMm)))
    : opening.yMm;
  const movedOpening = { ...opening, xMm: nextXmm, yMm: nextYmm };
  if (!opening.connectedOpeningId || opening.kind === 'window') {
    return updateOpening(normalized, openingId, () => movedOpening);
  }

  const linkedOpening = normalized.room.openings?.find((item) => item.id === opening.connectedOpeningId);
  const movingAreaId = getOpeningAreaId(normalized, opening);
  const linkedAreaId = linkedOpening ? getOpeningAreaId(normalized, linkedOpening) : null;
  if (!linkedOpening || !movingAreaId || !linkedAreaId || movingAreaId === linkedAreaId) {
    return updateOpening(normalized, openingId, () => movedOpening);
  }

  const nextOpenings = (normalized.room.openings ?? []).map((item) => item.id === openingId ? movedOpening : item);
  const projectWithMovedOpening = { ...normalized, room: { ...normalized.room, openings: nextOpenings } };
  const movingAnchor = getOpeningAnchor(projectWithMovedOpening, movedOpening);
  const fixedAnchor = getOpeningAnchor(projectWithMovedOpening, linkedOpening);
  if (!movingAnchor || !fixedAnchor) return normalized;

  const deltaXmm = Math.round(fixedAnchor.center.x - movingAnchor.center.x);
  const deltaYmm = Math.round(fixedAnchor.center.y - movingAnchor.center.y);
  const movingAreaIds = getConnectedAreaIdsWithoutOpenings(normalized, movingAreaId, new Set([opening.id, linkedOpening.id]));
  const areas = normalized.room.areas ?? [];
  const movedAreas = areas.map((area) => movingAreaIds.has(area.id)
    ? { ...area, contour: translateContour(area.contour, deltaXmm, deltaYmm) }
    : area);
  const movingAreas = movedAreas.filter((area) => movingAreaIds.has(area.id));
  const stationaryAreas = movedAreas.filter((area) => !movingAreaIds.has(area.id));
  if (movingAreas.some((moving) => stationaryAreas.some((stationary) => polygonsOverlapInterior(moving.contour, stationary.contour)))) return normalized;

  const nextRoom = normalizeRoomModel({
    ...normalized.room,
    contour: movingAreaIds.has(areas[0]?.id ?? '') ? translateContour(normalized.room.contour, deltaXmm, deltaYmm) : normalized.room.contour,
    areas: movedAreas,
    openings: nextOpenings,
    partitions: normalized.room.partitions?.map((partition) => movingAreaIds.has(partition.areaId ?? areas[0]?.id ?? 'room-1')
      ? { ...partition, start: translatePoint(partition.start, deltaXmm, deltaYmm), end: translatePoint(partition.end, deltaXmm, deltaYmm) }
      : partition),
  });
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: nextRoom,
    objects: normalized.objects.map((object) => movingAreaIds.has(object.areaId) ? {
      ...object,
      initialXmm: object.initialXmm + deltaXmm,
      initialYmm: object.initialYmm + deltaYmm,
      xMm: object.xMm + deltaXmm,
      yMm: object.yMm + deltaYmm,
    } : object),
    surfaces: createSurfacesWithAssignments(nextRoom, normalized, materialId),
  };
}

export function resizeOpening(project: TileProject, openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>): TileProject {
  const normalized = ensureProjectDefaults(project);
  const opening = normalized.room.openings?.find((item) => item.id === openingId);
  const surface = opening ? normalized.surfaces.find((item) => item.id === opening.surfaceId && item.type === 'wall') : null;
  if (!opening || !surface) return normalized;
  const minWidthMm = Math.min(MIN_OPENING_SIZE_MM, surface.widthMm);
  const xMm = Math.max(0, Math.min(Math.round(patch.xMm), Math.max(0, surface.widthMm - minWidthMm)));
  const widthMm = Math.max(minWidthMm, Math.min(Math.round(patch.widthMm), surface.widthMm - xMm));
  if (opening.kind === 'passage') {
    return updateOpening(normalized, openingId, (item) => ({ ...item, xMm, yMm: 0, widthMm, heightMm: surface.heightMm }));
  }
  const minHeightMm = Math.min(MIN_OPENING_SIZE_MM, surface.heightMm);
  const heightMm = Math.max(minHeightMm, Math.min(Math.round(patch.heightMm), surface.heightMm));
  if (opening.kind === 'door') {
    return updateOpening(normalized, openingId, (item) => ({ ...item, xMm, yMm: surface.heightMm - heightMm, widthMm, heightMm }));
  }
  const yMm = Math.max(0, Math.min(Math.round(patch.yMm), Math.max(0, surface.heightMm - minHeightMm)));
  const windowHeightMm = Math.max(minHeightMm, Math.min(heightMm, surface.heightMm - yMm));
  return updateOpening(normalized, openingId, (item) => ({ ...item, xMm, yMm, widthMm, heightMm: windowHeightMm }));
}

export function resetOpening(project: TileProject, openingId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const opening = normalized.room.openings?.find((item) => item.id === openingId);
  const surface = opening ? normalized.surfaces.find((item) => item.id === opening.surfaceId && item.type === 'wall') : null;
  if (!opening || !surface) return normalized;
  const centeredXmm = Math.max(0, Math.round((surface.widthMm - opening.widthMm) / 2));
  const initialXmm = Math.max(0, Math.min(opening.initialXmm ?? centeredXmm, Math.max(0, surface.widthMm - opening.widthMm)));
  const centeredYmm = Math.max(0, Math.round((surface.heightMm - opening.heightMm) / 2));
  const initialYmm = opening.kind === 'window'
    ? Math.max(0, Math.min(opening.initialYmm ?? centeredYmm, Math.max(0, surface.heightMm - opening.heightMm)))
    : opening.yMm;
  return moveOpening(normalized, openingId, initialXmm, initialYmm);
}

export function deleteOpening(project: TileProject, openingId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  if (!normalized.room.openings?.some((item) => item.id === openingId)) return normalized;
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({
    ...normalized.room,
    openings: normalized.room.openings.filter((item) => item.id !== openingId).map((item) => item.connectedOpeningId === openingId ? { ...item, connectedOpeningId: undefined } : item),
  });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
}

function updateOpening(project: TileProject, openingId: string, update: (opening: Opening) => Opening): TileProject {
  const materialId = getPrimaryMaterial(project)?.id ?? null;
  const room = normalizeRoomModel({
    ...project.room,
    openings: (project.room.openings ?? []).map((opening) => opening.id === openingId ? update(opening) : opening),
  });
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, project, materialId),
  };
}

export function addPartition(project: TileProject, start?: PointMm, end?: PointMm, areaId?: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const area = room.areas?.find((item) => item.id === areaId) ?? room.areas?.[0];
  const box = getBoundingBox(area?.contour ?? room.contour);
  const partitionIndex = (room.partitions?.length ?? 0) + 1;
  const x = Math.round(box.minX + box.width / 2);
  const partitionStart = start ?? { x, y: box.minY };
  const partitionEnd = end ?? { x, y: box.maxY };
  const partition: Partition = {
    areaId: area?.id ?? 'room-1',
    id: `partition-${partitionIndex}`,
    initialEnd: { ...partitionEnd },
    initialStart: { ...partitionStart },
    name: `Перегородка ${partitionIndex}`,
    start: partitionStart,
    end: partitionEnd,
    thicknessMm: 100,
    heightMm: room.heightMm,
  };
  const nextRoom = normalizeRoomModel({ ...room, partitions: [...(room.partitions ?? []), partition] });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: nextRoom,
    surfaces: createSurfacesWithAssignments(nextRoom, normalized, materialId),
  };
}

export function movePartition(project: TileProject, partitionId: string, start: PointMm, end: PointMm): TileProject {
  const normalized = ensureProjectDefaults(project);
  const partition = normalized.room.partitions?.find((item) => item.id === partitionId);
  if (!partition || (start.x !== end.x && start.y !== end.y) || segmentLength(start, end) < 250) return normalized;
  return updatePartition(normalized, partitionId, (item) => ({ ...item, start: { x: Math.round(start.x), y: Math.round(start.y) }, end: { x: Math.round(end.x), y: Math.round(end.y) } }));
}

export function resetPartition(project: TileProject, partitionId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const partition = normalized.room.partitions?.find((item) => item.id === partitionId);
  if (!partition) return normalized;
  return updatePartition(normalized, partitionId, (item) => ({
    ...item,
    start: item.initialStart ? { ...item.initialStart } : item.start,
    end: item.initialEnd ? { ...item.initialEnd } : item.end,
  }));
}

export function deletePartition(project: TileProject, partitionId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({ ...normalized.room, partitions: (normalized.room.partitions ?? []).filter((item) => item.id !== partitionId) });
  return { ...normalized, updatedAt: new Date().toISOString(), room, surfaces: createSurfacesWithAssignments(room, normalized, materialId) };
}

export interface ObjectActionResult {
  error?: string;
  object?: RoomObject;
  project: TileProject;
}

export function renameRoomArea(project: TileProject, areaId: string, name: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const nextName = name.trim().slice(0, 60);
  if (!nextName || !normalized.room.areas?.some((area) => area.id === areaId)) return normalized;
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: normalizeRoomModel({
      ...normalized.room,
      areas: normalized.room.areas?.map((area) => area.id === areaId ? { ...area, name: nextName } : area),
    }),
  };
}

export interface RoomObjectInput {
  areaId: string;
  excludeTile: boolean;
  heightMm: number;
  lengthMm: number;
  name: string;
  widthMm: number;
}

export function addRoomObject(project: TileProject, input: RoomObjectInput): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const area = normalized.room.areas?.find((item) => item.id === input.areaId);
  if (!area) return { error: 'Выберите помещение для размещения объекта.', project: normalized };
  const nextName = input.name.trim().slice(0, 80);
  const nextLength = Math.round(input.lengthMm);
  const nextWidth = Math.round(input.widthMm);
  const nextHeight = Math.round(input.heightMm);
  if (!nextName) return { error: 'Введите название объекта.', project: normalized };
  if (nextLength < MIN_OBJECT_SIZE_MM || nextWidth < MIN_OBJECT_SIZE_MM || nextHeight < MIN_OBJECT_SIZE_MM) {
    return { error: 'Длина, ширина и высота должны быть положительными числами.', project: normalized };
  }
  if (nextHeight > (area.heightMm ?? normalized.room.heightMm)) {
    return { error: 'Высота объекта не может превышать высоту помещения.', project: normalized };
  }
  const position = findObjectPlacement(area.contour, nextLength, nextWidth, normalized.objects.filter((object) => object.areaId === input.areaId));
  if (!position) return { error: 'Объект с такими размерами не помещается в выбранном помещении.', project: normalized };
  const objectIndex = normalized.objects.length + 1;
  const object: RoomObject = {
    areaId: input.areaId,
    elevationMm: 0,
    excludeTile: input.excludeTile,
    heightMm: nextHeight,
    id: `room-object-${Date.now()}-${objectIndex}`,
    initialElevationMm: 0,
    initialXmm: position.x,
    initialYmm: position.y,
    lengthMm: nextLength,
    name: nextName,
    widthMm: nextWidth,
    xMm: position.x,
    yMm: position.y,
  };
  return {
    object,
    project: { ...normalized, updatedAt: new Date().toISOString(), objects: [...normalized.objects, object] },
  };
}

export function updateRoomObject(project: TileProject, objectId: string, input: RoomObjectInput): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const current = normalized.objects.find((object) => object.id === objectId);
  if (!current) return { project: normalized };
  const withoutCurrent = { ...normalized, objects: normalized.objects.filter((object) => object.id !== objectId) };
  const result = addRoomObject(withoutCurrent, input);
  if (result.error || !result.object) return { ...result, project: normalized };
  const targetArea = normalized.room.areas?.find((area) => area.id === input.areaId);
  const canKeepPosition = input.areaId === current.areaId && targetArea && isRoomObjectPlacementValid(
    targetArea.contour,
    current.xMm,
    current.yMm,
    result.object.lengthMm,
    result.object.widthMm,
  );
  const updated: RoomObject = {
    ...result.object,
    ...(canKeepPosition ? {
      elevationMm: Math.min(current.elevationMm, Math.max(0, (targetArea.heightMm ?? normalized.room.heightMm) - result.object.heightMm)),
      initialElevationMm: Math.min(current.elevationMm, Math.max(0, (targetArea.heightMm ?? normalized.room.heightMm) - result.object.heightMm)),
      initialXmm: current.xMm,
      initialYmm: current.yMm,
      xMm: current.xMm,
      yMm: current.yMm,
    } : {}),
    id: current.id,
  };
  return {
    object: updated,
    project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((object) => object.id === objectId ? updated : object) },
  };
}

export function moveRoomObject(project: TileProject, objectId: string, xMm: number, yMm: number): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const object = normalized.objects.find((item) => item.id === objectId);
  const area = object ? normalized.room.areas?.find((item) => item.id === object.areaId) : null;
  if (!object || !area) return { project: normalized };
  const position = constrainRoomObjectPosition(area.contour, object, Math.round(xMm), Math.round(yMm), normalized.objects);
  const moved = { ...object, xMm: position.x, yMm: position.y };
  return {
    object: moved,
    project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((item) => item.id === objectId ? moved : item) },
  };
}

export function resetRoomObject(project: TileProject, objectId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    objects: normalized.objects.map((object) => object.id === objectId ? { ...object, elevationMm: object.initialElevationMm, xMm: object.initialXmm, yMm: object.initialYmm } : object),
  };
}

export function deleteRoomObject(project: TileProject, objectId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  return { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.filter((object) => object.id !== objectId) };
}

export function constrainRoomObjectPosition(contour: PointMm[], object: Pick<RoomObject, 'areaId' | 'id' | 'lengthMm' | 'widthMm' | 'xMm' | 'yMm'>, xMm: number, yMm: number, objects: RoomObject[] = []): PointMm {
  const target = { x: Math.round(xMm), y: Math.round(yMm) };
  const obstacles = objects.filter((item) => item.areaId === object.areaId && item.id !== object.id);
  if (isRoomObjectPlacementValid(contour, target.x, target.y, object.lengthMm, object.widthMm, obstacles)) return target;
  let low = 0;
  let high = 1;
  let best = { x: object.xMm, y: object.yMm };
  for (let index = 0; index < 18; index += 1) {
    const ratio = (low + high) / 2;
    const candidate = {
      x: Math.round(object.xMm + (target.x - object.xMm) * ratio),
      y: Math.round(object.yMm + (target.y - object.yMm) * ratio),
    };
    if (isRoomObjectPlacementValid(contour, candidate.x, candidate.y, object.lengthMm, object.widthMm, obstacles)) {
      best = candidate;
      low = ratio;
    } else high = ratio;
  }
  return best;
}

export function isRoomObjectPlacementValid(contour: PointMm[], xMm: number, yMm: number, lengthMm: number, depthMm: number, obstacles: RoomObject[] = []): boolean {
  if (lengthMm <= 0 || depthMm <= 0) return false;
  const corners = [
    { x: xMm, y: yMm },
    { x: xMm + lengthMm, y: yMm },
    { x: xMm + lengthMm, y: yMm + depthMm },
    { x: xMm, y: yMm + depthMm },
  ];
  if (!corners.every((point) => isPointStrictlyInsidePolygon(point, contour) || isPointOnContourBoundary(point, contour, 0.5))) return false;
  if (corners.some((start, index) => contour.some((wallStart, wallIndex) => segmentsProperlyIntersect(start, corners[(index + 1) % corners.length], wallStart, contour[(wallIndex + 1) % contour.length])))) return false;
  return !obstacles.some((object) => rectanglesOverlap(
    { xMm, yMm, widthMm: lengthMm, heightMm: depthMm },
    { xMm: object.xMm, yMm: object.yMm, widthMm: object.lengthMm, heightMm: object.widthMm },
  ));
}

function rectanglesOverlap(
  first: { heightMm: number; widthMm: number; xMm: number; yMm: number },
  second: { heightMm: number; widthMm: number; xMm: number; yMm: number },
): boolean {
  return first.xMm < second.xMm + second.widthMm
    && first.xMm + first.widthMm > second.xMm
    && first.yMm < second.yMm + second.heightMm
    && first.yMm + first.heightMm > second.yMm;
}

function findObjectPlacement(contour: PointMm[], lengthMm: number, depthMm: number, obstacles: RoomObject[] = []): PointMm | null {
  const box = getBoundingBox(contour);
  const preferred = { x: Math.round(box.minX + (box.width - lengthMm) / 2), y: Math.round(box.minY + (box.height - depthMm) / 2) };
  if (isRoomObjectPlacementValid(contour, preferred.x, preferred.y, lengthMm, depthMm, obstacles)) return preferred;
  const step = Math.max(25, Math.min(100, Math.round(Math.min(lengthMm, depthMm) / 4)));
  for (let y = box.minY; y <= box.maxY - depthMm; y += step) {
    for (let x = box.minX; x <= box.maxX - lengthMm; x += step) {
      if (isRoomObjectPlacementValid(contour, x, y, lengthMm, depthMm, obstacles)) return { x, y };
    }
  }
  return null;
}

export function getRoomObjectWallProjection(project: TileProject, surfaceId: string, object: RoomObject): { offsetMm: number; widthMm: number } | null {
  const surface = project.surfaces.find((item) => item.id === surfaceId);
  const parts = surface?.sourceRef?.split(':') ?? [];
  if (parts[0] !== 'wall' || parts[1] !== object.areaId) return null;
  const area = project.room.areas?.find((item) => item.id === object.areaId);
  const segmentIndex = Number(parts[2]) - 1;
  const start = area?.contour[segmentIndex];
  const end = area?.contour[(segmentIndex + 1) % (area?.contour.length ?? 1)];
  if (!start || !end) return null;
  const length = segmentLength(start, end);
  if (!length) return null;
  const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const corners = [
    { x: object.xMm, y: object.yMm },
    { x: object.xMm + object.lengthMm, y: object.yMm },
    { x: object.xMm + object.lengthMm, y: object.yMm + object.widthMm },
    { x: object.xMm, y: object.yMm + object.widthMm },
  ];
  const touching = corners.filter((point) => Math.abs((point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x)) / length <= 4);
  if (touching.length < 2) return null;
  const offsets = touching.map((point) => (point.x - start.x) * direction.x + (point.y - start.y) * direction.y);
  const min = Math.max(0, Math.min(...offsets));
  const max = Math.min(length, Math.max(...offsets));
  return max - min >= 1 ? { offsetMm: Math.round(min), widthMm: Math.round(max - min) } : null;
}

export function moveRoomObjectOnWall(project: TileProject, objectId: string, surfaceId: string, offsetMm: number, elevationMm: number): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const object = normalized.objects.find((item) => item.id === objectId);
  const area = object ? normalized.room.areas?.find((item) => item.id === object.areaId) : null;
  const projection = object ? getRoomObjectWallProjection(normalized, surfaceId, object) : null;
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  const parts = surface?.sourceRef?.split(':') ?? [];
  const segmentIndex = Number(parts[2]) - 1;
  const start = area?.contour[segmentIndex];
  const end = area?.contour[(segmentIndex + 1) % (area?.contour.length ?? 1)];
  if (!object || !area || !projection || !surface || !start || !end) return { project: normalized };
  const wallLength = segmentLength(start, end);
  const direction = { x: (end.x - start.x) / wallLength, y: (end.y - start.y) / wallLength };
  const nextOffset = Math.max(0, Math.min(Math.round(offsetMm), wallLength - projection.widthMm));
  const delta = nextOffset - projection.offsetMm;
  const position = constrainRoomObjectPosition(area.contour, object, object.xMm + direction.x * delta, object.yMm + direction.y * delta, normalized.objects);
  const moved: RoomObject = {
    ...object,
    elevationMm: Math.max(0, Math.min(Math.round(elevationMm), surface.heightMm - object.heightMm)),
    xMm: position.x,
    yMm: position.y,
  };
  return { object: moved, project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((item) => item.id === objectId ? moved : item) } };
}

function updatePartition(project: TileProject, partitionId: string, update: (partition: Partition) => Partition): TileProject {
  const materialId = getPrimaryMaterial(project)?.id ?? null;
  const room = normalizeRoomModel({ ...project.room, partitions: (project.room.partitions ?? []).map((partition) => partition.id === partitionId ? update(partition) : partition) });
  return { ...project, updatedAt: new Date().toISOString(), room, surfaces: createSurfacesWithAssignments(room, project, materialId) };
}

export function ensureProjectDefaults(project: TileProject): TileProject {
  const settings = project.settings ?? createDefaultSettings();
  const material = getPrimaryMaterial(project) ?? createMaterialFromPreset(getDefaultTilePreset(), settings);
  const materials = normalizeMaterials(project.materials?.length ? project.materials : [material], settings);
  const primaryMaterial = materials[0] ?? material;
  const room = normalizeRoomModel(project.room);
  return {
    ...project,
    objects: (project.objects ?? []).map((object) => {
      const legacy = object as RoomObject & { depthMm?: number; kind?: 'bathtub' | 'vanity' | 'sink' };
      const legacyNames = { bathtub: 'Ванна', vanity: 'Тумба', sink: 'Раковина' };
      return {
        ...object,
        elevationMm: object.elevationMm ?? 0,
        excludeTile: object.excludeTile ?? false,
        initialElevationMm: object.initialElevationMm ?? 0,
        name: object.name || (legacy.kind ? legacyNames[legacy.kind] : 'Объект'),
        widthMm: object.widthMm ?? legacy.depthMm ?? 500,
      };
    }),
    room,
    settings,
    materials,
    surfaces: mergeSurfaceAssignments(createSurfacesFromRoom(room, primaryMaterial.id, settings), project.surfaces, materials, primaryMaterial.id),
  };
}

export function getInitialProject(): TileProject {
  const rectangle = templates.find((template) => template.id === 'rectangle') ?? templates[0];
  const defaultSize = rectangle.sizes.find(([width, depth]) => width === 1700 && depth === 2000) ?? rectangle.sizes[0];
  return createProjectFromTemplate(rectangle, defaultSize);
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `project-${Date.now()}`;
}

function createDefaultSettings(): ProjectSettings {
  return {
    groutMm: serviceConfig.defaults.groutMm,
    reservePercent: serviceConfig.defaults.reservePercent,
    criticalCutMm: serviceConfig.defaults.criticalCutMm,
  };
}

function getDefaultTilePreset(): TileSizePreset {
  return tileSizePresets.find((preset) => preset.id === DEFAULT_TILE_PRESET_ID) ?? tileSizePresets.find((preset) => preset.widthMm && preset.heightMm)!;
}

function getPrimaryMaterial(project?: TileProject): TileMaterial | null {
  return project?.materials?.[0] ?? null;
}

export function getSurfaceMaterial(project: TileProject, surfaceId: string): TileMaterial | null {
  const surface = project.surfaces.find((item) => item.id === surfaceId);
  const materialId = surface?.zones[0]?.materialId;
  return project.materials.find((material) => material.id === materialId) ?? getPrimaryMaterial(project);
}

export function getZoneMaterial(project: TileProject, surfaceId: string, zoneId: string): TileMaterial | null {
  const surface = project.surfaces.find((item) => item.id === surfaceId);
  const zone = surface?.zones.find((item) => item.id === zoneId);
  return project.materials.find((material) => material.id === zone?.materialId) ?? getPrimaryMaterial(project);
}

function createMaterialFromPreset(tile: TileSizePreset, settings: ProjectSettings, id = PRIMARY_MATERIAL_ID): TileMaterial {
  return createMaterialFromSize(tile.widthMm ?? 600, tile.heightMm ?? 1200, settings, id, tile.id, tile.label);
}

function createMaterialFromSize(widthMm: number, heightMm: number, settings: ProjectSettings, id = PRIMARY_MATERIAL_ID, presetId?: string, label?: string): TileMaterial {
  return {
    id,
    name: label ? `Плитка ${label}` : `Плитка ${formatTileLabel(widthMm, heightMm)}`,
    swatch: { type: 'color', value: '#F2EBF9' },
    widthMm: clampTileSize(widthMm),
    heightMm: clampTileSize(heightMm),
    reservePercent: settings.reservePercent,
    presetId,
    label: label ?? formatTileLabel(widthMm, heightMm),
  };
}

function assignMaterialToSurface(project: TileProject, surfaceId: string, material: TileMaterial): TileProject {
  const materials = upsertMaterial(project.materials, material);
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    materials,
    surfaces: project.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone, index) => (index === 0 ? { ...zone, materialId: material.id } : zone)),
      };
    }),
  };
}

function assignMaterialToZone(project: TileProject, surfaceId: string, zoneId: string, material: TileMaterial): TileProject {
  const materials = upsertMaterial(project.materials, material);
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    materials,
    surfaces: project.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) => (zone.id === zoneId ? { ...zone, materialId: material.id } : zone)),
      };
    }),
  };
}

function createSurfacesWithAssignments(room: Room, previous: TileProject, fallbackMaterialId: string | null): Surface[] {
  return mergeSurfaceAssignments(createSurfacesFromRoom(room, fallbackMaterialId, previous.settings), previous.surfaces, previous.materials, fallbackMaterialId);
}

function mergeSurfaceAssignments(nextSurfaces: Surface[], previousSurfaces: Surface[] = [], materials: TileMaterial[], fallbackMaterialId: string | null): Surface[] {
  const materialIds = new Set(materials.map((material) => material.id));
  return nextSurfaces.map((surface) => {
    const previous = previousSurfaces.find((item) => item.id === surface.id) ?? previousSurfaces.find((item) => item.sourceRef && item.sourceRef === surface.sourceRef);
    const previousMaterialId = previous?.zones[0]?.materialId;
    const previousBaseZone = previous?.zones[0];
    const materialId = previousMaterialId && materialIds.has(previousMaterialId) ? previousMaterialId : fallbackMaterialId;
    const extraZones =
      previous?.type === surface.type
        ? previous.zones.slice(1).map((zone) => ({
            ...zone,
            materialId: zone.materialId && materialIds.has(zone.materialId) ? zone.materialId : materialId,
            shape: zone.shape.type === 'rect' ? clampRectZone(zone.shape, surface) : zone.shape,
          }))
        : [];
    return {
      ...surface,
      zones: [
        ...surface.zones.map((zone, index) =>
          index === 0
            ? {
                ...zone,
                materialId,
                layout: previousBaseZone?.layout ?? zone.layout,
                manualEdits: previousBaseZone?.manualEdits ?? zone.manualEdits,
              }
            : zone,
        ),
        ...extraZones,
      ],
    };
  });
}

function findRightWallId(contour: TileProject['room']['contour'], prefix: string): string {
  const box = getBoundingBox(contour);
  const index = contour.findIndex((point, pointIndex) => {
    const next = contour[(pointIndex + 1) % contour.length];
    return point.x === box.maxX && next.x === box.maxX && point.y !== next.y;
  });
  return `${prefix}-${(index >= 0 ? index : 1) + 1}`;
}

function getSurfaceAreaId(surface: Surface | undefined): string | null {
  const parts = surface?.sourceRef?.split(':') ?? [];
  return parts[0] === 'wall' ? parts[1] ?? null : null;
}

function getOpeningAreaId(project: TileProject, opening: Opening): string | null {
  return getSurfaceAreaId(project.surfaces.find((surface) => surface.id === opening.surfaceId));
}

function getOpeningLabel(opening: Opening): string {
  if (opening.kind === 'window') return 'Окно';
  return `${opening.kind === 'door' ? 'Дверь' : 'Проход'} ${opening.number ?? ''}`.trim();
}

function getConnectedAreaIds(project: TileProject, startAreaId: string): Set<string> {
  const result = new Set<string>([startAreaId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const opening of project.room.openings ?? []) {
      if (!opening.connectedOpeningId) continue;
      const other = project.room.openings?.find((item) => item.id === opening.connectedOpeningId);
      if (!other) continue;
      const firstAreaId = getOpeningAreaId(project, opening);
      const secondAreaId = getOpeningAreaId(project, other);
      if (!firstAreaId || !secondAreaId) continue;
      if (result.has(firstAreaId) && !result.has(secondAreaId)) {
        result.add(secondAreaId);
        changed = true;
      } else if (result.has(secondAreaId) && !result.has(firstAreaId)) {
        result.add(firstAreaId);
        changed = true;
      }
    }
  }
  return result;
}

function getConnectedAreaIdsWithoutOpenings(project: TileProject, startAreaId: string, ignoredOpeningIds: Set<string>): Set<string> {
  const result = new Set<string>([startAreaId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const opening of project.room.openings ?? []) {
      if (!opening.connectedOpeningId || ignoredOpeningIds.has(opening.id) || ignoredOpeningIds.has(opening.connectedOpeningId)) continue;
      const other = project.room.openings?.find((item) => item.id === opening.connectedOpeningId);
      if (!other) continue;
      const firstAreaId = getOpeningAreaId(project, opening);
      const secondAreaId = getOpeningAreaId(project, other);
      if (!firstAreaId || !secondAreaId) continue;
      if (result.has(firstAreaId) && !result.has(secondAreaId)) {
        result.add(secondAreaId);
        changed = true;
      } else if (result.has(secondAreaId) && !result.has(firstAreaId)) {
        result.add(firstAreaId);
        changed = true;
      }
    }
  }
  return result;
}

function getOpeningAnchor(project: TileProject, opening: Opening): { areaId: string; center: PointMm; normal: PointMm } | null {
  const surface = project.surfaces.find((item) => item.id === opening.surfaceId);
  const areaId = getSurfaceAreaId(surface);
  const sourceParts = surface?.sourceRef?.split(':') ?? [];
  const segmentIndex = Number(sourceParts[2]) - 1;
  const area = project.room.areas?.find((item) => item.id === areaId);
  if (!areaId || !area || !Number.isInteger(segmentIndex) || segmentIndex < 0) return null;
  const start = area.contour[segmentIndex];
  const end = area.contour[(segmentIndex + 1) % area.contour.length];
  if (!start || !end) return null;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!length) return null;
  const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const centerOffset = Math.max(0, Math.min(length, opening.xMm + opening.widthMm / 2));
  const signedArea = area.contour.reduce((sum, point, index) => {
    const next = area.contour[(index + 1) % area.contour.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const normal = signedArea >= 0 ? { x: -direction.y, y: direction.x } : { x: direction.y, y: -direction.x };
  return {
    areaId,
    center: { x: start.x + direction.x * centerOffset, y: start.y + direction.y * centerOffset },
    normal,
  };
}

function rotatePoint(point: PointMm, center: PointMm, angle: number): PointMm {
  const x = point.x - center.x;
  const y = point.y - center.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: Math.round(center.x + x * cosine - y * sine), y: Math.round(center.y + x * sine + y * cosine) };
}

function translatePoint(point: PointMm, deltaXmm: number, deltaYmm: number): PointMm {
  return { x: Math.round(point.x + deltaXmm), y: Math.round(point.y + deltaYmm) };
}

function translateContour(contour: PointMm[], deltaXmm: number, deltaYmm: number): PointMm[] {
  return contour.map((point) => translatePoint(point, deltaXmm, deltaYmm));
}

function polygonsOverlapInterior(first: PointMm[], second: PointMm[]): boolean {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstStart = first[firstIndex];
    const firstEnd = first[(firstIndex + 1) % first.length];
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondStart = second[secondIndex];
      const secondEnd = second[(secondIndex + 1) % second.length];
      if (segmentsProperlyIntersect(firstStart, firstEnd, secondStart, secondEnd)) return true;
    }
  }
  return first.some((point) => isPointStrictlyInsidePolygon(point, second)) || second.some((point) => isPointStrictlyInsidePolygon(point, first));
}

function segmentsProperlyIntersect(a: PointMm, b: PointMm, c: PointMm, d: PointMm): boolean {
  const cross = (p: PointMm, q: PointMm, r: PointMm) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const first = cross(a, b, c);
  const second = cross(a, b, d);
  const third = cross(c, d, a);
  const fourth = cross(c, d, b);
  return first * second < 0 && third * fourth < 0;
}

function isPointStrictlyInsidePolygon(point: PointMm, polygon: PointMm[]): boolean {
  if (isPointOnContourBoundary(point, polygon, 0.5)) return false;
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const crosses = (current.y > point.y) !== (previous.y > point.y) && point.x < (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y || 1) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function isPointOnContourBoundary(point: PointMm, contour: PointMm[], toleranceMm: number): boolean {
  return contour.some((start, index) => distanceToSegment(point, start, contour[(index + 1) % contour.length]) <= toleranceMm);
}

function hasWindowOnAreaIntersection(project: TileProject): boolean {
  return (project.room.openings ?? []).some((opening) => {
    if (opening.kind !== 'window') return false;
    const anchor = getOpeningAnchor(project, opening);
    if (!anchor) return false;
    return (project.room.areas ?? []).some((area) => area.id !== anchor.areaId && isPointOnContourBoundary(anchor.center, area.contour, 5));
  });
}

function hasOpeningTouchingMultipleAreas(project: TileProject): boolean {
  return (project.room.openings ?? []).some((opening) => {
    if (opening.kind === 'window') return false;
    const anchor = getOpeningAnchor(project, opening);
    if (!anchor) return false;
    const touchingAreas = (project.room.areas ?? []).filter((area) => area.id !== anchor.areaId && isPointOnContourBoundary(anchor.center, area.contour, 5));
    return touchingAreas.length > 1;
  });
}

function distanceToSegment(point: PointMm, start: PointMm, end: PointMm): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function createCenteredOpening(surfaceId: string, kind: Opening['kind'], surfaceWidthMm: number, roomHeightMm: number, number?: number): Opening {
  const widthMm = kind === 'door' ? DEFAULT_DOOR_WIDTH_MM : kind === 'window' ? DEFAULT_WINDOW_SIZE_MM : DEFAULT_PASSAGE_WIDTH_MM;
  const heightMm = kind === 'door' ? Math.min(DEFAULT_DOOR_HEIGHT_MM, roomHeightMm) : kind === 'window' ? Math.min(DEFAULT_WINDOW_SIZE_MM, roomHeightMm) : roomHeightMm;
  const xMm = Math.max(0, Math.round((surfaceWidthMm - widthMm) / 2));
  const yMm = kind === 'window' ? Math.max(0, Math.round((roomHeightMm - heightMm) / 2)) : Math.max(0, roomHeightMm - heightMm);
  return {
    id: `${surfaceId}-${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    kind,
    initialXmm: xMm,
    initialYmm: yMm,
    name: kind === 'door' ? `Дверь ${number ?? ''}`.trim() : kind === 'window' ? 'Окно' : `Проход ${number ?? ''}`.trim(),
    number,
    surfaceId,
    xMm,
    yMm,
    widthMm: Math.min(surfaceWidthMm, widthMm),
    heightMm,
  };
}

function appendZone(project: TileProject, surfaceId: string, zone: FinishZone): TileProject {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    surfaces: project.surfaces.map((surface) =>
      surface.id === surfaceId
        ? {
            ...surface,
            zones: [...surface.zones, zone],
          }
        : surface,
    ),
  };
}

function createFloorZone(surface: Surface, materialId: string | null, settings: ProjectSettings, kind: 'rect' | 'shower' | 'horizontal-band' | 'vertical-band') {
  const width = Math.max(1, surface.widthMm);
  const height = Math.max(1, surface.heightMm);
  const shortSide = Math.min(width, height);
  const band = Math.max(250, Math.round(shortSide * 0.22));
  const rectWidth = Math.max(300, Math.round(width * 0.42));
  const rectHeight = Math.max(300, Math.round(height * 0.34));
  const showerWidth = Math.min(width, Math.max(800, Math.round(width * 0.38)));
  const showerHeight = Math.min(height, Math.max(900, Math.round(height * 0.42)));
  const shapeByKind = {
    rect: {
      type: 'rect' as const,
      xMm: Math.round((width - rectWidth) / 2),
      yMm: Math.round((height - rectHeight) / 2),
      widthMm: Math.min(width, rectWidth),
      heightMm: Math.min(height, rectHeight),
    },
    shower: {
      type: 'rect' as const,
      xMm: Math.max(0, width - showerWidth),
      yMm: 0,
      widthMm: showerWidth,
      heightMm: showerHeight,
    },
    'horizontal-band': {
      type: 'rect' as const,
      xMm: 0,
      yMm: Math.round((height - band) / 2),
      widthMm: width,
      heightMm: band,
    },
    'vertical-band': {
      type: 'rect' as const,
      xMm: Math.round((width - band) / 2),
      yMm: 0,
      widthMm: band,
      heightMm: height,
    },
  };
  const nameByKind = {
    rect: 'Зона',
    shower: 'Душевая',
    'horizontal-band': 'Горизонтальная полоса',
    'vertical-band': 'Вертикальная полоса',
  };

  return {
    id: `${surface.id}-zone-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    name: nameByKind[kind],
    shape: clampRectZone(shapeByKind[kind], surface),
    materialId,
    layout: {
      pattern: 'straight' as const,
      rotation: 0 as const,
      angleDeg: 0 as const,
      groutMm: settings.groutMm,
      originXmm: 0,
      originYmm: 0,
      originMode: 'corner-tl' as const,
      criticalCutMm: settings.criticalCutMm,
    },
    manualEdits: [],
  };
}

function clampRectZone(shape: RectZone, surface: Surface): RectZone {
  const maxWidth = Math.max(MIN_ZONE_SIZE_MM, Math.round(surface.widthMm));
  const maxHeight = Math.max(MIN_ZONE_SIZE_MM, Math.round(surface.heightMm));
  const widthMm = Math.max(MIN_ZONE_SIZE_MM, Math.min(maxWidth, Math.round(shape.widthMm)));
  const heightMm = Math.max(MIN_ZONE_SIZE_MM, Math.min(maxHeight, Math.round(shape.heightMm)));
  return {
    type: 'rect',
    xMm: Math.max(0, Math.min(maxWidth - widthMm, Math.round(shape.xMm))),
    yMm: Math.max(0, Math.min(maxHeight - heightMm, Math.round(shape.yMm))),
    widthMm,
    heightMm,
  };
}

function normalizeMaterials(materials: TileMaterial[], settings: ProjectSettings): TileMaterial[] {
  if (!materials.length) return [createMaterialFromPreset(getDefaultTilePreset(), settings)];
  return materials.map((material) => ({
    ...material,
    heightMm: clampTileSize(material.heightMm),
    reservePercent: material.reservePercent ?? settings.reservePercent,
    swatch: material.swatch ?? { type: 'color', value: '#F2EBF9' },
    widthMm: clampTileSize(material.widthMm),
  }));
}

function findMatchingMaterial(materials: TileMaterial[], widthMm: number, heightMm: number, presetId?: string): TileMaterial | null {
  if (presetId) {
    const presetMatch = materials.find((material) => material.presetId === presetId);
    if (presetMatch) return presetMatch;
  }
  const width = clampTileSize(widthMm);
  const height = clampTileSize(heightMm);
  return materials.find((material) => material.widthMm === width && material.heightMm === height && material.presetId === presetId) ?? null;
}

function upsertMaterial(materials: TileMaterial[], material: TileMaterial): TileMaterial[] {
  if (materials.some((item) => item.id === material.id)) {
    return materials.map((item) => (item.id === material.id ? material : item));
  }
  return [...materials, material];
}

function getAvailableMaterialId(materials: TileMaterial[], preferredId: string): string {
  const normalizedId = preferredId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  if (!materials.some((material) => material.id === normalizedId)) return normalizedId;
  let index = 2;
  while (materials.some((material) => material.id === `${normalizedId}-${index}`)) index += 1;
  return `${normalizedId}-${index}`;
}

function clampTileSize(value: number): number {
  return Math.max(50, Math.min(3200, Math.round(value)));
}

function clampLayoutOffset(value: number): number {
  return Math.max(-15000, Math.min(15000, Math.round(value)));
}

function formatTileLabel(widthMm: number, heightMm: number): string {
  return `${Math.round(widthMm / 10)}×${Math.round(heightMm / 10)}`;
}
