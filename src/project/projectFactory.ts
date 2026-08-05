import { serviceConfig, templates, tileSizePresets } from '../config/appConfig';
import type { FinishZone, Opening, Partition, ProjectSettings, RectZone, Room, RoomTemplate, Surface, TileMaterial, TileProject, TileSizePreset } from '../types/project';
import { createContourFromTemplate, createSurfacesFromRoom, getBoundingBox, normalizeRoomModel, segmentLength, updateSegmentLength, validateRoomHeight } from './geometry';

const PRIMARY_MATERIAL_ID = 'material-primary';
const DEFAULT_TILE_PRESET_ID = '600x1200';
const MIN_ZONE_SIZE_MM = 100;
const DEFAULT_ADJACENT_ROOM_WIDTH_MM = 1600;
const DEFAULT_ADJACENT_ROOM_DEPTH_MM = 2000;
const DEFAULT_DOOR_WIDTH_MM = 800;
const DEFAULT_DOOR_HEIGHT_MM = 2100;
const DEFAULT_PASSAGE_WIDTH_MM = 900;

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
  const nextHeight = validateRoomHeight(heightMm);
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({
    ...normalized.room,
    heightMm: nextHeight,
    partitions: normalized.room.partitions?.map((partition) => ({ ...partition, heightMm: nextHeight })),
  });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
}

export function updateRoomContour(project: TileProject, contour: TileProject['room']['contour']): TileProject {
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({
    ...normalized.room,
    contour,
    areas: (normalized.room.areas ?? []).map((area, index) => (index === 0 ? { ...area, contour } : area)),
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

export function addOpening(project: TileProject, surfaceId: string, kind: Opening['kind']): TileProject {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId && item.type === 'wall');
  if (!surface) return normalized;
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const opening = createCenteredOpening(surface.id, kind, surface.widthMm, normalized.room.heightMm);
  const room = normalizeRoomModel({
    ...normalized.room,
    openings: [...(normalized.room.openings ?? []), opening],
  });
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
}

export function addPartition(project: TileProject): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const box = getBoundingBox(room.areas?.[0]?.contour ?? room.contour);
  const partitionIndex = (room.partitions?.length ?? 0) + 1;
  const x = Math.round(box.minX + box.width / 2);
  const partition: Partition = {
    id: `partition-${partitionIndex}`,
    name: `Перегородка ${partitionIndex}`,
    start: { x, y: box.minY },
    end: { x, y: box.maxY },
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

export function ensureProjectDefaults(project: TileProject): TileProject {
  const settings = project.settings ?? createDefaultSettings();
  const material = getPrimaryMaterial(project) ?? createMaterialFromPreset(getDefaultTilePreset(), settings);
  const materials = normalizeMaterials(project.materials?.length ? project.materials : [material], settings);
  const primaryMaterial = materials[0] ?? material;
  const room = normalizeRoomModel(project.room);
  return {
    ...project,
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
      zones: [...surface.zones.map((zone, index) => (index === 0 ? { ...zone, materialId } : zone)), ...extraZones],
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

function createCenteredOpening(surfaceId: string, kind: Opening['kind'], surfaceWidthMm: number, roomHeightMm: number): Opening {
  const widthMm = kind === 'door' ? DEFAULT_DOOR_WIDTH_MM : DEFAULT_PASSAGE_WIDTH_MM;
  const heightMm = kind === 'door' ? Math.min(DEFAULT_DOOR_HEIGHT_MM, roomHeightMm) : roomHeightMm;
  return {
    id: `${surfaceId}-${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    kind,
    name: kind === 'door' ? 'Дверь' : 'Проход',
    surfaceId,
    xMm: Math.max(0, Math.round((surfaceWidthMm - widthMm) / 2)),
    yMm: Math.max(0, roomHeightMm - heightMm),
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
