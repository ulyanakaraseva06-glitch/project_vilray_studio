import { serviceConfig, templates, tileSizePresets } from '../config/appConfig';
import type { FinishZone, Opening, Partition, PointMm, ProjectSettings, RectZone, Room, RoomArea, RoomObject, RoomTemplate, Surface, TileMaterial, TileProject, TileSizePreset } from '../types/project';
import { createContourFromTemplate, createSurfacesFromRoom, getBoundingBox, isSegmentWithinContour, moveSquareWall, moveWall, normalizeRoomModel, resizeSquareContour, segmentLength, segmentsIntersect, updateSegmentLength, validateContour, validateRoomHeight } from './geometry';

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

type OpeningRect = Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>;

export function openingRectsOverlap(a: OpeningRect, b: OpeningRect): boolean {
  return a.xMm < b.xMm + b.widthMm && a.xMm + a.widthMm > b.xMm
    && a.yMm < b.yMm + b.heightMm && a.yMm + a.heightMm > b.yMm;
}

function getOpeningsOnSurface(project: TileProject, surfaceId: string, ignoreId?: string): Opening[] {
  return (project.room.openings ?? []).filter((item) => item.surfaceId === surfaceId && item.id !== ignoreId);
}

function openingFitsOnSurface(surface: Pick<Surface, 'widthMm' | 'heightMm'>, opening: OpeningRect, others: Opening[]): boolean {
  if (opening.xMm < 0 || opening.yMm < 0) return false;
  if (opening.xMm + opening.widthMm > surface.widthMm) return false;
  if (opening.yMm + opening.heightMm > surface.heightMm) return false;
  return !others.some((other) => openingRectsOverlap(opening, other));
}

function clampOpeningCoord(value: number, max: number): number {
  return Math.max(0, Math.min(Math.round(value), Math.max(0, max)));
}

function resolveOpeningPosition(
  surface: Pick<Surface, 'widthMm' | 'heightMm'>,
  opening: OpeningRect,
  others: Opening[],
  requestedX: number,
  requestedY: number,
): { xMm: number; yMm: number } {
  const maxX = Math.max(0, surface.widthMm - opening.widthMm);
  const maxY = Math.max(0, surface.heightMm - opening.heightMm);
  let x = clampOpeningCoord(requestedX, maxX);
  let y = clampOpeningCoord(requestedY, maxY);
  const fits = (testX: number, testY: number) => openingFitsOnSurface(surface, { ...opening, xMm: testX, yMm: testY }, others);
  if (fits(x, y)) return { xMm: x, yMm: y };

  const candidates: Array<{ xMm: number; yMm: number; dist: number }> = [{
    xMm: opening.xMm,
    yMm: opening.yMm,
    dist: Math.hypot(opening.xMm - requestedX, opening.yMm - requestedY),
  }];
  for (const other of others) {
    const snapPositions = [
      { xMm: other.xMm + other.widthMm, yMm: y },
      { xMm: other.xMm - opening.widthMm, yMm: y },
      { xMm: x, yMm: other.yMm + other.heightMm },
      { xMm: x, yMm: other.yMm - opening.heightMm },
      { xMm: other.xMm + other.widthMm, yMm: other.yMm },
      { xMm: other.xMm - opening.widthMm, yMm: other.yMm },
    ];
    for (const pos of snapPositions) {
      const sx = clampOpeningCoord(pos.xMm, maxX);
      const sy = clampOpeningCoord(pos.yMm, maxY);
      candidates.push({ xMm: sx, yMm: sy, dist: Math.hypot(sx - requestedX, sy - requestedY) });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const candidate of candidates) {
    if (fits(candidate.xMm, candidate.yMm)) return { xMm: candidate.xMm, yMm: candidate.yMm };
  }

  for (let iter = 0; iter < others.length + 2; iter++) {
    let adjusted = false;
    for (const other of others) {
      if (!openingRectsOverlap({ ...opening, xMm: x, yMm: y }, other)) continue;
      adjusted = true;
      const options = [
        { xMm: other.xMm + other.widthMm, yMm: y },
        { xMm: other.xMm - opening.widthMm, yMm: y },
        { xMm: x, yMm: other.yMm + other.heightMm },
        { xMm: x, yMm: other.yMm - opening.heightMm },
      ]
        .map((pos) => ({
          xMm: clampOpeningCoord(pos.xMm, maxX),
          yMm: clampOpeningCoord(pos.yMm, maxY),
          dist: Math.hypot(clampOpeningCoord(pos.xMm, maxX) - requestedX, clampOpeningCoord(pos.yMm, maxY) - requestedY),
        }))
        .sort((a, b) => a.dist - b.dist);
      for (const option of options) {
        if (fits(option.xMm, option.yMm)) {
          x = option.xMm;
          y = option.yMm;
          break;
        }
      }
    }
    if (fits(x, y)) return { xMm: x, yMm: y };
    if (!adjusted) break;
  }

  return { xMm: opening.xMm, yMm: opening.yMm };
}

function findOpeningPosition(surface: Pick<Surface, 'widthMm' | 'heightMm'>, template: OpeningRect, others: Opening[]): { xMm: number; yMm: number } | null {
  const centerX = Math.max(0, Math.round((surface.widthMm - template.widthMm) / 2));
  const candidates: Array<{ xMm: number; yMm: number }> = [
    { xMm: centerX, yMm: template.yMm },
    { xMm: 0, yMm: template.yMm },
    { xMm: surface.widthMm - template.widthMm, yMm: template.yMm },
  ];
  for (const other of others) {
    candidates.push(
      { xMm: other.xMm + other.widthMm, yMm: template.yMm },
      { xMm: other.xMm - template.widthMm, yMm: template.yMm },
      { xMm: other.xMm, yMm: other.yMm + other.heightMm },
      { xMm: other.xMm, yMm: other.yMm - template.heightMm },
      { xMm: other.xMm + other.widthMm, yMm: other.yMm },
      { xMm: other.xMm - template.widthMm, yMm: other.yMm },
    );
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const xMm = clampOpeningCoord(candidate.xMm, surface.widthMm - template.widthMm);
    const yMm = clampOpeningCoord(candidate.yMm, surface.heightMm - template.heightMm);
    const key = `${xMm}:${yMm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (openingFitsOnSurface(surface, { ...template, xMm, yMm }, others)) return { xMm, yMm };
  }
  for (let xMm = 0; xMm <= surface.widthMm - template.widthMm; xMm++) {
    const yValues = template.heightMm >= surface.heightMm ? [template.yMm] : Array.from({ length: surface.heightMm - template.heightMm + 1 }, (_, index) => index);
    for (const yMm of yValues) {
      if (openingFitsOnSurface(surface, { ...template, xMm, yMm }, others)) return { xMm, yMm };
    }
  }
  return null;
}

export function constrainOpeningPosition(
  surface: Pick<Surface, 'widthMm' | 'heightMm'>,
  opening: OpeningRect,
  others: Opening[],
  xMm: number,
  yMm: number,
): { xMm: number; yMm: number } {
  return resolveOpeningPosition(surface, opening, others, xMm, yMm);
}
const MIN_OBJECT_SIZE_MM = 1;
const OBJECT_BOUNDARY_TOLERANCE_MM = 1.5;
const WALL_OBJECT_TOUCH_TOLERANCE_MM = 40;

export type RoomObjectFootprint = {
  lengthMm: number;
  rotationDeg?: number;
  widthMm: number;
  xMm: number;
  yMm: number;
};

export function normalizeObjectRotationDeg(rotationDeg: number): number {
  const normalized = rotationDeg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

/** Corners of the object's plan footprint, rotated around its center. */
export function getRoomObjectCorners(footprint: RoomObjectFootprint): PointMm[] {
  const angle = (normalizeObjectRotationDeg(footprint.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = footprint.xMm + footprint.lengthMm / 2;
  const centerY = footprint.yMm + footprint.widthMm / 2;
  const halfLength = footprint.lengthMm / 2;
  const halfWidth = footprint.widthMm / 2;
  return [
    { x: -halfLength, y: -halfWidth },
    { x: halfLength, y: -halfWidth },
    { x: halfLength, y: halfWidth },
    { x: -halfLength, y: halfWidth },
  ].map((point) => ({
    x: centerX + point.x * cos - point.y * sin,
    y: centerY + point.x * sin + point.y * cos,
  }));
}

export function createProjectFromTemplate(template: RoomTemplate, size?: [number, number], previous?: TileProject, carryOverAssignments = true, carryOverExtraZones = carryOverAssignments): TileProject {
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
    // A fresh additional room reuses the same "area index 0" surface ids as any
    // brand-new single-room draft (surface-floor, surface-wall-1, ...), which
    // collide with the primary room's ids. Merging assignments in that case
    // would incorrectly drag the primary room's extra zones into the new room,
    // so callers adding another room (not replacing the primary one) opt out.
    surfaces: mergeSurfaceAssignments(createSurfacesFromRoom(normalizeRoomModel({ templateId: template.id === 'custom' ? null : template.id, heightMm, contour }), primaryMaterial.id, settings), carryOverAssignments ? previous?.surfaces : undefined, materials, primaryMaterial.id, carryOverExtraZones),
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

export function updateRoomContour(project: TileProject, contour: TileProject['room']['contour'], shapeLocked?: boolean, carryOverExtraZones = true): TileProject {
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
    surfaces: createSurfacesWithAssignments(room, normalized, materialId, carryOverExtraZones),
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
  if (areaIndex < 0 || areas[areaIndex].shapeLocked) return normalized;
  const originalBox = getBoundingBox(areas[areaIndex].contour);
  const resized = areas[areaIndex].templateId === 'square'
    ? resizeSquareContour(areas[areaIndex].contour, lengthMm)
    : updateSegmentLength(areas[areaIndex].contour, segmentIndex, lengthMm);
  const resizedBox = getBoundingBox(resized);
  const contour = resized.map((point) => ({ x: point.x + originalBox.minX - resizedBox.minX, y: point.y + originalBox.minY - resizedBox.minY }));
  if (areas.some((area, index) => index !== areaIndex && polygonsOverlapInterior(contour, area.contour))) return normalized;
  return updateRoomAreaContour(normalized, areaIndex, contour);
}

export function confirmRoomAreaDimensions(project: TileProject, areaId: string, lengthsMm: number[]): { error?: string; project: TileProject } {
  const normalized = ensureProjectDefaults(project);
  const areas = normalized.room.areas ?? [];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  if (areaIndex < 0 || areas[areaIndex].shapeLocked) return { project: normalized };
  if (lengthsMm.length !== areas[areaIndex].contour.length || lengthsMm.some((length) => !Number.isFinite(length) || length < 250)) {
    return { error: 'Укажите корректную длину каждой стены — не меньше 250 мм.', project: normalized };
  }
  let contour = areas[areaIndex].contour;
  lengthsMm.forEach((length, index) => { contour = updateSegmentLength(contour, index, length); });
  const validation = validateContour(contour);
  if (!validation.ok) return { error: validation.message ?? 'Такие размеры не образуют корректное помещение.', project: normalized };
  const actualLengths = contour.map((point, index) => Math.round(Math.hypot(contour[(index + 1) % contour.length].x - point.x, contour[(index + 1) % contour.length].y - point.y)));
  if (actualLengths.some((length, index) => Math.abs(length - Math.round(lengthsMm[index])) > 1)) {
    return { error: 'Указанные длины не замыкают выбранную форму. Проверьте размеры противоположных и соседних стен.', project: normalized };
  }
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({
    ...normalized.room,
    contour: areaIndex === 0 ? contour : normalized.room.contour,
    areas: areas.map((area, index) => index === areaIndex ? { ...area, contour, shapeLocked: true } : area),
  });
  return { project: { ...normalized, updatedAt: new Date().toISOString(), room, surfaces: createSurfacesWithAssignments(room, normalized, materialId) } };
}

export function moveRoomAreaWall(project: TileProject, areaId: string, segmentIndex: number, deltaMm: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const areas = room.areas ?? [];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  if (areaIndex < 0 || areas[areaIndex].shapeLocked) return normalized;
  const contour = previewRoomAreaWall(areas[areaIndex], segmentIndex, deltaMm);
  if (areas.some((area, index) => index !== areaIndex && polygonsOverlapInterior(contour, area.contour))) return normalized;
  return updateRoomAreaContour(normalized, areaIndex, contour);
}

export function previewRoomAreaWall(area: RoomArea, segmentIndex: number, deltaMm: number): PointMm[] {
  const originalBox = getBoundingBox(area.contour);
  const movedContour = area.templateId === 'square'
    ? moveSquareWall(area.contour, segmentIndex, deltaMm)
    : moveWall(area.contour, segmentIndex, deltaMm);
  const movedBox = getBoundingBox(movedContour);
  return movedContour.map((point) => ({
    x: point.x + originalBox.minX - movedBox.minX,
    y: point.y + originalBox.minY - movedBox.minY,
  }));
}

function updateRoomAreaContour(project: TileProject, areaIndex: number, contour: TileProject['room']['contour']): TileProject {
  const materialId = getPrimaryMaterial(project)?.id ?? null;
  const areas = project.room.areas ?? [];
  const areaId = areas[areaIndex]?.id;
  if (!areaId || !areAreaPartitionsValid(project.room, areaId, contour)) return project;
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

export function updateZoneTileColor(project: TileProject, surfaceId: string, zoneId: string, color: string, customName?: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  const zone = surface?.zones.find((item) => item.id === zoneId);
  const source = zone?.materialId ? normalized.materials.find((item) => item.id === zone.materialId) : getPrimaryMaterial(normalized);
  if (!surface || !zone || !source || !/^#[0-9a-f]{6}$/i.test(color)) return normalized;
  const normalizedColor = color.toUpperCase();
  const normalizedName = customName?.trim().slice(0, 60) || `Цвет ${normalizedColor}`;
  const reusable = normalized.materials.find((item) =>
    item.widthMm === source.widthMm
    && item.heightMm === source.heightMm
    && item.swatch.type === 'color'
    && item.swatch.value.toUpperCase() === normalizedColor
    && item.name === normalizedName,
  );
  const materialId = reusable?.id ?? `material-color-${Date.now()}-${normalized.materials.length + 1}`;
  const material: TileMaterial = reusable ?? { ...source, id: materialId, name: normalizedName, swatch: { type: 'color', value: normalizedColor } };
  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    materials: upsertMaterial(normalized.materials, material),
    surfaces: normalized.surfaces.map((item) => item.id === surfaceId ? { ...item, zones: item.zones.map((candidate) => candidate.id === zoneId ? { ...candidate, materialId } : candidate) } : item),
  };
}

/** Renames every material that currently uses this swatch color. */
export function renameTileMaterialsByColor(project: TileProject, color: string, name: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const normalizedColor = color.toUpperCase();
  const nextName = name.trim().slice(0, 60);
  if (!/^#[0-9a-f]{6}$/i.test(color) || !nextName) return normalized;
  let changed = false;
  const materials = normalized.materials.map((material) => {
    if (material.swatch.type !== 'color' || material.swatch.value.toUpperCase() !== normalizedColor) return material;
    if (material.name === nextName) return material;
    changed = true;
    return { ...material, name: nextName };
  });
  if (!changed) return normalized;
  return { ...normalized, updatedAt: new Date().toISOString(), materials };
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
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    surfaces: project.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) =>
          zone.id === zoneId
            ? {
                ...zone,
                layout: {
                  ...zone.layout,
                  angleDeg: pattern === 'diagonal' || pattern === 'herringbone' ? 45 : 0,
                  pattern,
                  stagger: zone.layout.stagger ?? getLegacyLayoutStagger(zone.layout.pattern),
                },
              }
            : zone,
        ),
      };
    }),
  };
}

function getLegacyLayoutStagger(pattern: TileProject['surfaces'][number]['zones'][number]['layout']['pattern']) {
  if (pattern === 'half-offset') return 'half' as const;
  if (pattern === 'third-offset') return 'third' as const;
  if (pattern === 'quarter-offset') return 'quarter' as const;
  return 'none' as const;
}

export function updateZoneLayoutStagger(
  project: TileProject,
  surfaceId: string,
  zoneId: string,
  stagger: NonNullable<TileProject['surfaces'][number]['zones'][number]['layout']['stagger']>,
): TileProject {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    surfaces: project.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) =>
          zone.id === zoneId
            ? { ...zone, layout: { ...zone.layout, stagger } }
            : zone,
        ),
      };
    }),
  };
}

export function updateZoneLayoutGrout(project: TileProject, surfaceId: string, zoneId: string, groutMm: number): TileProject {
  const nextGroutMm = clampGroutMm(groutMm);
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    settings: { ...project.settings, groutMm: nextGroutMm },
    surfaces: project.surfaces.map((surface) => {
      if (surface.id !== surfaceId) return surface;
      return {
        ...surface,
        zones: surface.zones.map((zone) =>
          zone.id === zoneId
            ? { ...zone, layout: { ...zone.layout, groutMm: nextGroutMm } }
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

export function updateZoneLayoutTurn(project: TileProject, surfaceId: string, zoneId: string, turnDeg: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const nextTurnDeg = Number.isFinite(turnDeg) ? turnDeg : 0;
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
                  turnDeg: nextTurnDeg,
                },
              }
            : zone,
        ),
      };
    }),
  };
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

export type ZonePresetKind = 'rect' | 'horizontal-band' | 'vertical-band';

export function addFloorZone(project: TileProject, kind: ZonePresetKind, surfaceId = 'surface-floor'): TileProject {
  const normalized = ensureProjectDefaults(project);
  const floor = normalized.surfaces.find((surface) => surface.id === surfaceId && surface.type === 'floor');
  if (!floor) return normalized;
  const baseZone = floor.zones[0];
  const zone = createFloorZone(floor, baseZone?.materialId ?? getPrimaryMaterial(normalized)?.id ?? null, normalized.settings, kind);

  return appendZone(normalized, floor.id, zone);
}

export function addWallZone(project: TileProject, surfaceId: string, kind: ZonePresetKind): TileProject {
  const normalized = ensureProjectDefaults(project);
  const wall = normalized.surfaces.find((surface) => surface.id === surfaceId && surface.type === 'wall');
  if (!wall) return normalized;
  const baseZone = wall.zones[0];
  const zone = createFloorZone(wall, baseZone?.materialId ?? getPrimaryMaterial(normalized)?.id ?? null, normalized.settings, kind);

  return appendZone(normalized, wall.id, zone);
}

export function addManualZone(project: TileProject, surfaceId: string, points: PointMm[]): { project: TileProject; zone: FinishZone | null } {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  if (!surface || points.length < 3) return { project: normalized, zone: null };
  const baseZone = surface.zones[0];
  const seed = createFloorZone(surface, baseZone?.materialId ?? getPrimaryMaterial(normalized)?.id ?? null, normalized.settings, 'rect');
  const shape = { type: 'polygon' as const, points: points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })) };
  const zone: FinishZone = {
    ...seed,
    id: `${surface.id}-manual-zone-${Date.now()}`,
    locked: true,
    name: `Ручная зона ${surface.zones.length}`,
    relatedSurfaceIds: surface.type === 'floor'
      ? normalized.surfaces.filter((item) => item.type === 'wall' && item.sourceRef?.startsWith(`wall:${surface.sourceRef?.split(':')[1]}:`)).map((item) => item.id)
      : undefined,
    shape,
  };
  return { project: appendZone(normalized, surface.id, zone), zone };
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

export function updateZonePolygonPoints(project: TileProject, surfaceId: string, zoneId: string, points: PointMm[]): TileProject {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  const zoneIndex = surface?.zones.findIndex((zone) => zone.id === zoneId) ?? -1;
  if (!surface || zoneIndex <= 0 || points.length < 3) return normalized;
  const zone = surface.zones[zoneIndex];
  if (zone.shape.type !== 'polygon') return normalized;
  const nextPoints = points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));

  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((item) =>
      item.id === surfaceId
        ? {
            ...item,
            zones: item.zones.map((candidate) => (candidate.id === zoneId ? { ...candidate, shape: { type: 'polygon', points: nextPoints } } : candidate)),
          }
        : item,
    ),
  };
}

export function updateZoneName(project: TileProject, surfaceId: string, zoneId: string, name: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId);
  const zoneIndex = surface?.zones.findIndex((zone) => zone.id === zoneId) ?? -1;
  if (!surface || zoneIndex <= 0) return normalized;
  const nextName = name.replace(/[\r\n\t]/g, ' ').slice(0, 60);

  return {
    ...normalized,
    updatedAt: new Date().toISOString(),
    surfaces: normalized.surfaces.map((item) =>
      item.id === surfaceId
        ? {
            ...item,
            zones: item.zones.map((zone) => (zone.id === zoneId ? { ...zone, name: nextName } : zone)),
          }
        : item,
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
  return addRoomFromContour(project, createContourFromTemplate(template, size), false, template.id);
}

export function addRoomFromContour(project: TileProject, contour: TileProject['room']['contour'], shapeLocked = true, templateId: string | null = null): TileProject {
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
    templateId,
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

export function deleteRoomArea(project: TileProject, areaId: string): RoomActionResult {
  const normalized = ensureProjectDefaults(project);
  const areas = normalized.room.areas ?? [];
  if (!areas.some((area) => area.id === areaId)) return { project: normalized };
  if (areas.length <= 1) {
    return { error: 'Нельзя удалить единственное помещение. Сначала добавьте другое помещение или сбросьте проект.', project: normalized };
  }

  const deletedOpeningIds = new Set(
    (normalized.room.openings ?? [])
      .filter((opening) => getOpeningAreaId(normalized, opening) === areaId)
      .map((opening) => opening.id),
  );
  const remainingAreas = areas.filter((area) => area.id !== areaId);
  const nextPrimaryArea = remainingAreas[0];
  const openings = (normalized.room.openings ?? [])
    .filter((opening) => !deletedOpeningIds.has(opening.id))
    .map((opening) => {
      const openingAreaId = getOpeningAreaId(normalized, opening);
      const sourceParts = normalized.surfaces.find((surface) => surface.id === opening.surfaceId)?.sourceRef?.split(':') ?? [];
      const nextSurfaceId = openingAreaId === nextPrimaryArea.id && sourceParts[0] === 'wall'
        ? `surface-wall-${sourceParts[2]}`
        : opening.surfaceId;
      return {
        ...opening,
        connectedOpeningId: opening.connectedOpeningId && deletedOpeningIds.has(opening.connectedOpeningId) ? undefined : opening.connectedOpeningId,
        surfaceId: nextSurfaceId,
      };
    });
  const room = normalizeRoomModel({
    ...normalized.room,
    templateId: nextPrimaryArea.templateId ?? null,
    contour: nextPrimaryArea.contour,
    heightMm: nextPrimaryArea.heightMm ?? normalized.room.heightMm,
    areas: remainingAreas,
    openings,
    partitions: normalized.room.partitions?.filter((partition) => (partition.areaId ?? areas[0].id) !== areaId),
  });
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  return {
    project: {
      ...normalized,
      updatedAt: new Date().toISOString(),
      room,
      objects: normalized.objects.filter((object) => object.areaId !== areaId),
      surfaces: createSurfacesWithAssignments(room, normalized, materialId),
    },
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
    surfaces: translateFloorZonePolygons(createSurfacesWithAssignments(nextRoom, normalized, materialId), movingAreaIds, appliedX, appliedY),
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
  const connectedProject = {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room: nextRoom,
    surfaces: transformFloorZonePolygons(createSurfacesWithAssignments(nextRoom, normalized, materialId), sourceComponent, transform),
  };
  return {
    project: keepProjectInsidePlanCanvas(connectedProject),
  };
}

export function addOpening(project: TileProject, surfaceId: string, kind: Opening['kind'], dimensions?: { widthMm: number; heightMm?: number }): TileProject {
  return addOpeningDetailed(project, surfaceId, kind, dimensions).project;
}

export function addOpeningDetailed(project: TileProject, surfaceId: string, kind: Opening['kind'], dimensions?: { widthMm: number; heightMm?: number }): { opening: Opening | null; project: TileProject } {
  const normalized = ensureProjectDefaults(project);
  const surface = normalized.surfaces.find((item) => item.id === surfaceId && item.type === 'wall');
  if (!surface) return { opening: null, project: normalized };
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const areaId = getSurfaceAreaId(surface) ?? normalized.room.areas?.[0]?.id ?? 'room-1';
  const areaHeight = normalized.room.areas?.find((area) => area.id === areaId)?.heightMm ?? normalized.room.heightMm;
  const number = kind === 'window' ? undefined : Math.max(0, ...(normalized.room.openings ?? []).filter((item) => item.kind === kind).map((item) => item.number ?? 0)) + 1;
  const opening = createCenteredOpening(surface.id, kind, surface.widthMm, areaHeight, number, dimensions);
  const others = getOpeningsOnSurface(normalized, surface.id);
  const position = findOpeningPosition(surface, opening, others);
  if (!position) return { opening: null, project: normalized };
  const placedOpening = { ...opening, xMm: position.xMm, yMm: position.yMm, initialXmm: position.xMm, initialYmm: position.yMm };
  const room = normalizeRoomModel({
    ...normalized.room,
    openings: [...(normalized.room.openings ?? []), placedOpening],
  });
  const nextProject = {
    ...normalized,
    updatedAt: new Date().toISOString(),
    room,
    surfaces: createSurfacesWithAssignments(room, normalized, materialId),
  };
  return { opening: placedOpening, project: nextProject };
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
  const others = getOpeningsOnSurface(normalized, opening.surfaceId, openingId);
  const resolved = resolveOpeningPosition(surface, opening, others, nextXmm, nextYmm);
  const movedOpening = { ...opening, xMm: resolved.xMm, yMm: resolved.yMm };
  if (!openingFitsOnSurface(surface, movedOpening, others)) return normalized;
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
  return keepProjectInsidePlanCanvas({
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
    surfaces: translateFloorZonePolygons(createSurfacesWithAssignments(nextRoom, normalized, materialId), movingAreaIds, deltaXmm, deltaYmm),
  });
}

export function resizeOpening(project: TileProject, openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>): TileProject {
  const normalized = ensureProjectDefaults(project);
  const opening = normalized.room.openings?.find((item) => item.id === openingId);
  const surface = opening ? normalized.surfaces.find((item) => item.id === opening.surfaceId && item.type === 'wall') : null;
  if (!opening || !surface) return normalized;
  const minWidthMm = Math.min(MIN_OPENING_SIZE_MM, surface.widthMm);
  const xMm = Math.max(0, Math.min(Math.round(patch.xMm), Math.max(0, surface.widthMm - minWidthMm)));
  const widthMm = Math.max(minWidthMm, Math.min(Math.round(patch.widthMm), surface.widthMm - xMm));
  const others = getOpeningsOnSurface(normalized, opening.surfaceId, openingId);
  let resizedOpening: Opening;
  if (opening.kind === 'passage') {
    resizedOpening = { ...opening, xMm, yMm: 0, widthMm, heightMm: surface.heightMm };
  } else {
    const minHeightMm = Math.min(MIN_OPENING_SIZE_MM, surface.heightMm);
    const heightMm = Math.max(minHeightMm, Math.min(Math.round(patch.heightMm), surface.heightMm));
    if (opening.kind === 'door') {
      resizedOpening = { ...opening, xMm, yMm: surface.heightMm - heightMm, widthMm, heightMm };
    } else {
      const yMm = Math.max(0, Math.min(Math.round(patch.yMm), Math.max(0, surface.heightMm - minHeightMm)));
      const windowHeightMm = Math.max(minHeightMm, Math.min(heightMm, surface.heightMm - yMm));
      resizedOpening = { ...opening, xMm, yMm, widthMm, heightMm: windowHeightMm };
    }
  }
  if (!openingFitsOnSurface(surface, resizedOpening, others)) return normalized;
  return updateOpening(normalized, openingId, () => resizedOpening);
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

export function addPartition(project: TileProject, start?: PointMm, end?: PointMm, areaId?: string, wallIndex?: number): TileProject {
  const normalized = ensureProjectDefaults(project);
  const room = normalizeRoomModel(normalized.room);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const area = room.areas?.find((item) => item.id === areaId) ?? room.areas?.[0];
  const box = getBoundingBox(area?.contour ?? room.contour);
  const partitionIndex = (room.partitions?.length ?? 0) + 1;
  const x = Math.round(box.minX + box.width / 2);
  const partitionStart = start ?? { x, y: box.minY };
  const partitionEnd = end ?? { x, y: box.maxY };
  if (!area || !isPartitionGeometryValid(room, area.id, partitionStart, partitionEnd)) return normalized;
  const partition: Partition = {
    areaId: area?.id ?? 'room-1',
    id: `partition-${partitionIndex}`,
    initialEnd: { ...partitionEnd },
    initialStart: { ...partitionStart },
    name: `Перегородка ${partitionIndex}`,
    start: partitionStart,
    end: partitionEnd,
    wallIndex: wallIndex ?? findContourSegmentIndex(area?.contour ?? room.contour, partitionStart),
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
  if (!partition?.areaId || !isPartitionGeometryValid(normalized.room, partition.areaId, start, end, partitionId)) return normalized;
  return updatePartition(normalized, partitionId, (item) => ({ ...item, start: { x: Math.round(start.x), y: Math.round(start.y) }, end: { x: Math.round(end.x), y: Math.round(end.y) } }));
}

export function resetPartition(project: TileProject, partitionId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const partition = normalized.room.partitions?.find((item) => item.id === partitionId);
  if (!partition) return normalized;
  return movePartition(
    normalized,
    partitionId,
    partition.initialStart ? { ...partition.initialStart } : partition.start,
    partition.initialEnd ? { ...partition.initialEnd } : partition.end,
  );
}

export function deletePartition(project: TileProject, partitionId: string): TileProject {
  const normalized = ensureProjectDefaults(project);
  const materialId = getPrimaryMaterial(normalized)?.id ?? null;
  const room = normalizeRoomModel({ ...normalized.room, partitions: (normalized.room.partitions ?? []).filter((item) => item.id !== partitionId) });
  return { ...normalized, updatedAt: new Date().toISOString(), room, surfaces: createSurfacesWithAssignments(room, normalized, materialId) };
}

export interface ObjectActionResult {
  conflictIds?: string[];
  error?: string;
  object?: RoomObject;
  project: TileProject;
}

export const OBJECT_STACK_CONFLICT_HINT = 'Поверх красных объектов не получится поставить новый объект: недостаточно места.';

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
  excludeFloorTile?: boolean;
  excludeTile?: boolean;
  excludeWallTile?: boolean;
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
  const position = findObjectPlacement(
    area.contour,
    nextLength,
    nextWidth,
    normalized.objects.filter((object) => object.areaId === input.areaId),
    (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? area.id) === area.id),
  );
  if (!position) return { error: 'Объект с такими размерами не помещается в выбранном помещении.', project: normalized };
  const roomHeightMm = area.heightMm ?? normalized.room.heightMm;
  const stack = resolveRoomObjectStacking(
    { xMm: position.x, yMm: position.y, lengthMm: nextLength, widthMm: nextWidth, heightMm: nextHeight },
    roomHeightMm,
    normalized.objects.filter((object) => object.areaId === input.areaId),
    0,
  );
  if (stack.conflictIds.length) {
    return { conflictIds: stack.conflictIds, error: OBJECT_STACK_CONFLICT_HINT, project: normalized };
  }
  const objectIndex = normalized.objects.length + 1;
  const object: RoomObject = {
    areaId: input.areaId,
    elevationMm: stack.elevationMm,
    excludeTile: (input.excludeFloorTile ?? input.excludeTile ?? false) && (input.excludeWallTile ?? input.excludeTile ?? false),
    excludeFloorTile: input.excludeFloorTile ?? input.excludeTile ?? false,
    excludeWallTile: input.excludeWallTile ?? input.excludeTile ?? false,
    heightMm: nextHeight,
    id: `room-object-${Date.now()}-${objectIndex}`,
    initialElevationMm: stack.elevationMm,
    initialXmm: position.x,
    initialYmm: position.y,
    lengthMm: nextLength,
    name: nextName,
    rotationDeg: 0,
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
    (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? targetArea.id) === targetArea.id),
    current.rotationDeg ?? 0,
  );
  if (canKeepPosition && targetArea) {
    const stack = resolveRoomObjectStacking(
      {
        xMm: current.xMm,
        yMm: current.yMm,
        lengthMm: result.object.lengthMm,
        widthMm: result.object.widthMm,
        heightMm: result.object.heightMm,
        rotationDeg: current.rotationDeg ?? 0,
      },
      targetArea.heightMm ?? normalized.room.heightMm,
      withoutCurrent.objects.filter((item) => item.areaId === targetArea.id),
      current.elevationMm,
    );
    if (stack.conflictIds.length) {
      return { conflictIds: stack.conflictIds, error: OBJECT_STACK_CONFLICT_HINT, project: normalized };
    }
    const updated: RoomObject = {
      ...result.object,
      elevationMm: stack.elevationMm,
      id: current.id,
      initialElevationMm: stack.elevationMm,
      initialXmm: current.xMm,
      initialYmm: current.yMm,
      rotationDeg: current.rotationDeg ?? 0,
      xMm: current.xMm,
      yMm: current.yMm,
    };
    return {
      object: updated,
      project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((object) => object.id === objectId ? updated : object) },
    };
  }
  const updated: RoomObject = {
    ...result.object,
    id: current.id,
    rotationDeg: current.rotationDeg ?? 0,
  };
  return {
    object: updated,
    project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((object) => object.id === objectId ? updated : object) },
  };
}

export function moveRoomObject(project: TileProject, objectId: string, xMm: number, yMm: number, preferredAreaId?: string): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const object = normalized.objects.find((item) => item.id === objectId);
  if (!object) return { project: normalized };
  const requested = { x: Math.round(xMm), y: Math.round(yMm) };

  const tryArea = (area: RoomArea): ObjectActionResult | null => {
    const roomHeightMm = area.heightMm ?? normalized.room.heightMm;
    const partitions = (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? area.id) === area.id);
    if (object.heightMm > roomHeightMm) return null;
    if (!isRoomObjectPlacementValid(area.contour, requested.x, requested.y, object.lengthMm, object.widthMm, partitions, object.rotationDeg ?? 0)) return null;
    const others = normalized.objects.filter((item) => item.areaId === area.id && item.id !== object.id);
    const stack = resolveRoomObjectStacking(
      {
        xMm: requested.x,
        yMm: requested.y,
        lengthMm: object.lengthMm,
        widthMm: object.widthMm,
        heightMm: object.heightMm,
        rotationDeg: object.rotationDeg ?? 0,
      },
      roomHeightMm,
      others,
      object.elevationMm,
    );
    if (stack.conflictIds.length) {
      return {
        conflictIds: stack.conflictIds,
        error: OBJECT_STACK_CONFLICT_HINT,
        object,
        project: normalized,
      };
    }
    const moved = {
      ...object,
      areaId: area.id,
      elevationMm: stack.elevationMm,
      xMm: requested.x,
      yMm: requested.y,
    };
    return {
      object: moved,
      project: { ...normalized, updatedAt: new Date().toISOString(), objects: normalized.objects.map((item) => item.id === objectId ? moved : item) },
    };
  };

  const preferredArea = preferredAreaId
    ? normalized.room.areas?.find((item) => item.id === preferredAreaId)
    : null;
  if (preferredArea) {
    const preferredResult = tryArea(preferredArea);
    if (preferredResult) return preferredResult;
  }

  const area = normalized.room.areas?.find((item) => item.id === object.areaId);
  if (!area) return { project: normalized };
  const areaPartitions = (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? area.id) === area.id);
  const staysInCurrentArea = isRoomObjectPlacementValid(area.contour, requested.x, requested.y, object.lengthMm, object.widthMm, areaPartitions, object.rotationDeg ?? 0);
  if (staysInCurrentArea) {
    const currentResult = tryArea(area);
    if (currentResult) return currentResult;
  }

  const targetArea = normalized.room.areas?.find((candidate) => {
    if (candidate.id === object.areaId) return false;
    if (object.heightMm > (candidate.heightMm ?? normalized.room.heightMm)) return false;
    const partitions = (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? candidate.id) === candidate.id);
    return isRoomObjectPlacementValid(candidate.contour, requested.x, requested.y, object.lengthMm, object.widthMm, partitions, object.rotationDeg ?? 0);
  });
  if (targetArea) {
    const targetResult = tryArea(targetArea);
    if (targetResult) return targetResult;
  }

  const position = slideRoomObjectPosition(area.contour, object, requested.x, requested.y, { x: object.xMm, y: object.yMm }, areaPartitions);
  const others = normalized.objects.filter((item) => item.areaId === area.id && item.id !== object.id);
  const stack = resolveRoomObjectStacking(
    {
      xMm: position.x,
      yMm: position.y,
      lengthMm: object.lengthMm,
      widthMm: object.widthMm,
      heightMm: object.heightMm,
      rotationDeg: object.rotationDeg ?? 0,
    },
    area.heightMm ?? normalized.room.heightMm,
    others,
    object.elevationMm,
  );
  if (stack.conflictIds.length) {
    return {
      conflictIds: stack.conflictIds,
      error: OBJECT_STACK_CONFLICT_HINT,
      object,
      project: normalized,
    };
  }
  const moved = {
    ...object,
    areaId: area.id,
    elevationMm: stack.elevationMm,
    xMm: position.x,
    yMm: position.y,
  };
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

export function rotateRoomObject(project: TileProject, objectId: string, rotationDeg: number): ObjectActionResult {
  const normalized = ensureProjectDefaults(project);
  const object = normalized.objects.find((item) => item.id === objectId);
  if (!object) return { project: normalized };
  const area = normalized.room.areas?.find((item) => item.id === object.areaId);
  if (!area) return { project: normalized };
  const nextRotation = normalizeObjectRotationDeg(rotationDeg);
  const partitions = (normalized.room.partitions ?? []).filter((partition) => (partition.areaId ?? area.id) === area.id);
  let fitted = { x: object.xMm, y: object.yMm };
  if (!isRoomObjectPlacementValid(area.contour, fitted.x, fitted.y, object.lengthMm, object.widthMm, partitions, nextRotation)) {
    fitted = slideRoomObjectPosition(area.contour, { ...object, rotationDeg: nextRotation }, object.xMm, object.yMm, { x: object.xMm, y: object.yMm }, partitions);
  }
  if (!isRoomObjectPlacementValid(area.contour, fitted.x, fitted.y, object.lengthMm, object.widthMm, partitions, nextRotation)) {
    fitted = findRotatedObjectPlacement(area.contour, object.lengthMm, object.widthMm, nextRotation, partitions, fitted)
      ?? findRotatedObjectPlacement(area.contour, object.lengthMm, object.widthMm, nextRotation, partitions)
      ?? fitted;
  }
  const others = normalized.objects.filter((item) => item.areaId === area.id && item.id !== object.id);
  const stack = resolveRoomObjectStacking(
    {
      xMm: fitted.x,
      yMm: fitted.y,
      lengthMm: object.lengthMm,
      widthMm: object.widthMm,
      heightMm: object.heightMm,
      rotationDeg: nextRotation,
    },
    area.heightMm ?? normalized.room.heightMm,
    others,
    object.elevationMm,
  );
  const rotated = {
    ...object,
    elevationMm: stack.conflictIds.length ? object.elevationMm : stack.elevationMm,
    rotationDeg: nextRotation,
    xMm: fitted.x,
    yMm: fitted.y,
  };
  return {
    ...(stack.conflictIds.length ? { conflictIds: stack.conflictIds, error: OBJECT_STACK_CONFLICT_HINT } : {}),
    object: rotated,
    project: {
      ...normalized,
      updatedAt: new Date().toISOString(),
      objects: normalized.objects.map((item) => (item.id === objectId ? rotated : item)),
    },
  };
}

export function constrainRoomObjectPosition(
  contour: PointMm[],
  object: Pick<RoomObject, 'areaId' | 'id' | 'lengthMm' | 'rotationDeg' | 'widthMm' | 'xMm' | 'yMm'>,
  xMm: number,
  yMm: number,
  partitions: Partition[] = [],
): PointMm {
  const target = { x: Math.round(xMm), y: Math.round(yMm) };
  const rotationDeg = object.rotationDeg ?? 0;
  if (isRoomObjectPlacementValid(contour, target.x, target.y, object.lengthMm, object.widthMm, partitions, rotationDeg)) return target;
  let low = 0;
  let high = 1;
  let best = { x: object.xMm, y: object.yMm };
  for (let index = 0; index < 18; index += 1) {
    const ratio = (low + high) / 2;
    const candidate = {
      x: Math.round(object.xMm + (target.x - object.xMm) * ratio),
      y: Math.round(object.yMm + (target.y - object.yMm) * ratio),
    };
    if (isRoomObjectPlacementValid(contour, candidate.x, candidate.y, object.lengthMm, object.widthMm, partitions, rotationDeg)) {
      best = candidate;
      low = ratio;
    } else high = ratio;
  }
  return best;
}

/**
 * Fits an object's whole footprint inside one room's contour.
 *
 * Prefers axis-aligned sliding from a known-good anchor toward the request so
 * the object can sit flush against walls without jumping to a distant probe.
 * Footprint overlap with other furniture is allowed — vertical stacking is
 * resolved separately by resolveRoomObjectStacking.
 */
export function clampRoomObjectToContour(
  contour: PointMm[],
  object: Pick<RoomObject, 'lengthMm' | 'rotationDeg' | 'widthMm' | 'xMm' | 'yMm'>,
  xMm: number,
  yMm: number,
  partitions: Partition[] = [],
): PointMm {
  const rotationDeg = object.rotationDeg ?? 0;
  const anchor = isRoomObjectPlacementValid(contour, object.xMm, object.yMm, object.lengthMm, object.widthMm, partitions, rotationDeg)
    ? { x: object.xMm, y: object.yMm }
    : findObjectPlacement(contour, object.lengthMm, object.widthMm, [], partitions) ?? { x: object.xMm, y: object.yMm };
  return slideRoomObjectPosition(contour, object, xMm, yMm, anchor, partitions);
}

/**
 * Keeps furniture inside one room while dragging: try the requested point, then
 * slide on one axis at a time from the last valid spot, then walk back along the
 * drag ray. Never teleports to a far ring candidate. Partitions act like walls —
 * the object may stand along them, but not on top of them.
 */
export function slideRoomObjectPosition(
  contour: PointMm[],
  object: Pick<RoomObject, 'lengthMm' | 'rotationDeg' | 'widthMm'>,
  xMm: number,
  yMm: number,
  anchor: PointMm,
  partitions: Partition[] = [],
): PointMm {
  const box = getBoundingBox(contour);
  const rotationDeg = object.rotationDeg ?? 0;
  const prototype = getBoundingBox(getRoomObjectCorners({
    xMm: 0,
    yMm: 0,
    lengthMm: object.lengthMm,
    widthMm: object.widthMm,
    rotationDeg,
  }));
  const bound = (point: PointMm): PointMm => ({
    x: Math.round(Math.min(Math.max(point.x, box.minX - prototype.minX), box.maxX - prototype.maxX)),
    y: Math.round(Math.min(Math.max(point.y, box.minY - prototype.minY), box.maxY - prototype.maxY)),
  });
  const requested = bound({ x: xMm, y: yMm });
  const stableAnchor = bound(anchor);
  const candidates = [
    requested,
    bound({ x: requested.x, y: stableAnchor.y }),
    bound({ x: stableAnchor.x, y: requested.y }),
    stableAnchor,
  ];
  for (const candidate of candidates) {
    if (isRoomObjectPlacementValid(contour, candidate.x, candidate.y, object.lengthMm, object.widthMm, partitions, rotationDeg)) return candidate;
  }
  return constrainRoomObjectPosition(
    contour,
    { ...object, areaId: '', id: '', rotationDeg, xMm: stableAnchor.x, yMm: stableAnchor.y },
    requested.x,
    requested.y,
    partitions,
  );
}

export function footprintsOverlap(
  first: RoomObjectFootprint,
  second: RoomObjectFootprint,
): boolean {
  const firstRotation = first.rotationDeg ?? 0;
  const secondRotation = second.rotationDeg ?? 0;
  if (!firstRotation && !secondRotation) {
    return rectanglesOverlap(
      { xMm: first.xMm, yMm: first.yMm, widthMm: first.lengthMm, heightMm: first.widthMm },
      { xMm: second.xMm, yMm: second.yMm, widthMm: second.lengthMm, heightMm: second.widthMm },
    );
  }
  return polygonsOverlap(getRoomObjectCorners(first), getRoomObjectCorners(second));
}

/** True when the object's floor footprint covers any part of a partition body. */
export function footprintsIntersectPartition(
  footprint: RoomObjectFootprint,
  partition: Pick<Partition, 'end' | 'start' | 'thicknessMm'>,
): boolean {
  const half = Math.max(1, partition.thicknessMm / 2);
  const dx = partition.end.x - partition.start.x;
  const dy = partition.end.y - partition.start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return false;
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  const partitionPolygon = [
    { x: partition.start.x + nx, y: partition.start.y + ny },
    { x: partition.start.x - nx, y: partition.start.y - ny },
    { x: partition.end.x - nx, y: partition.end.y - ny },
    { x: partition.end.x + nx, y: partition.end.y + ny },
  ];
  return polygonsOverlap(getRoomObjectCorners(footprint), partitionPolygon);
}

export function footprintsIntersectPartitions(
  footprint: RoomObjectFootprint,
  partitions: Array<Pick<Partition, 'end' | 'start' | 'thicknessMm'>>,
): boolean {
  return partitions.some((partition) => footprintsIntersectPartition(footprint, partition));
}

function polygonsOverlap(first: PointMm[], second: PointMm[]): boolean {
  for (let index = 0; index < first.length; index += 1) {
    const start = first[index];
    const end = first[(index + 1) % first.length];
    for (let otherIndex = 0; otherIndex < second.length; otherIndex += 1) {
      if (segmentsProperlyIntersect(start, end, second[otherIndex], second[(otherIndex + 1) % second.length])) return true;
    }
  }
  return first.some((point) => isPointStrictlyInsidePolygon(point, second) || isPointOnContourBoundary(point, second, 0.5))
    || second.some((point) => isPointStrictlyInsidePolygon(point, first) || isPointOnContourBoundary(point, first, 0.5));
}

/**
 * When footprints overlap on the plan, place the moving object in free vertical
 * space above (preferred) or below the others — like a wall cabinet over a
 * base unit. Returns conflictIds when no slot fits under the ceiling.
 */
export function resolveRoomObjectStacking(
  footprint: { heightMm: number; lengthMm: number; rotationDeg?: number; widthMm: number; xMm: number; yMm: number },
  roomHeightMm: number,
  others: RoomObject[],
  currentElevationMm = 0,
): { conflictIds: string[]; elevationMm: number } {
  const overlapping = others.filter((item) => footprintsOverlap(footprint, item));
  return resolveVerticalStacking(
    footprint.heightMm,
    roomHeightMm,
    overlapping.map((item) => ({ id: item.id, bottom: item.elevationMm, top: item.elevationMm + item.heightMm })),
    currentElevationMm,
  );
}

/**
 * Same stacking rules for a wall elevation: objects whose horizontal spans
 * overlap on the wall must sit fully above or below each other.
 */
export function resolveWallObjectStacking(
  heightMm: number,
  wallHeightMm: number,
  offsetMm: number,
  widthMm: number,
  currentElevationMm: number,
  others: Array<{ elevationMm: number; heightMm: number; id: string; offsetMm: number; widthMm: number }>,
): { conflictIds: string[]; elevationMm: number } {
  const overlapping = others.filter((item) => offsetMm < item.offsetMm + item.widthMm && offsetMm + widthMm > item.offsetMm);
  return resolveVerticalStacking(
    heightMm,
    wallHeightMm,
    overlapping.map((item) => ({ id: item.id, bottom: item.elevationMm, top: item.elevationMm + item.heightMm })),
    currentElevationMm,
  );
}

function resolveVerticalStacking(
  heightMm: number,
  roomHeightMm: number,
  bandsInput: Array<{ bottom: number; id: string; top: number }>,
  currentElevationMm = 0,
): { conflictIds: string[]; elevationMm: number } {
  const maxElevation = Math.max(0, roomHeightMm - heightMm);
  const desired = Math.max(0, Math.min(Math.round(currentElevationMm), maxElevation));
  if (!bandsInput.length) {
    return {
      conflictIds: [],
      elevationMm: desired,
    };
  }

  const bands = [...bandsInput].sort((first, second) => first.bottom - second.bottom || first.top - second.top);
  const fits = (elevationMm: number) => (
    elevationMm >= 0
    && elevationMm + heightMm <= roomHeightMm + 0.5
    && bands.every((band) => elevationMm + heightMm <= band.bottom + 0.5 || elevationMm >= band.top - 0.5)
  );

  // Keep the user's requested height when it already clears overlapping objects.
  // Otherwise wall drag could only snap to discrete "on top / under" slots.
  if (fits(desired)) return { conflictIds: [], elevationMm: desired };

  const highestTop = Math.max(...bands.map((band) => band.top));
  const lowestBottom = Math.min(...bands.map((band) => band.bottom));
  const candidates: number[] = [highestTop];
  if (lowestBottom >= heightMm) candidates.push(lowestBottom - heightMm);
  for (let index = 0; index < bands.length - 1; index += 1) {
    const gapBottom = bands[index].top;
    if (bands[index + 1].bottom - gapBottom >= heightMm) candidates.push(gapBottom);
  }
  if (bands.every((band) => band.bottom >= heightMm)) candidates.push(0);

  const valid = candidates
    .map((candidate) => Math.round(candidate))
    .filter((elevationMm, index, list) => list.indexOf(elevationMm) === index && fits(elevationMm))
    .sort((first, second) => Math.abs(first - desired) - Math.abs(second - desired));
  if (valid.length) return { conflictIds: [], elevationMm: valid[0] };

  return {
    conflictIds: bands.map((band) => band.id),
    elevationMm: desired,
  };
}

export function isRoomObjectPlacementValid(
  contour: PointMm[],
  xMm: number,
  yMm: number,
  lengthMm: number,
  depthMm: number,
  partitions: Partition[] = [],
  rotationDeg = 0,
): boolean {
  if (lengthMm <= 0 || depthMm <= 0) return false;
  const corners = getRoomObjectCorners({ xMm, yMm, lengthMm, widthMm: depthMm, rotationDeg });
  if (!corners.every((point) => isPointStrictlyInsidePolygon(point, contour) || isPointOnContourBoundary(point, contour, OBJECT_BOUNDARY_TOLERANCE_MM))) return false;
  if (corners.some((start, index) => contour.some((wallStart, wallIndex) => segmentsProperlyIntersect(start, corners[(index + 1) % corners.length], wallStart, contour[(wallIndex + 1) % contour.length])))) return false;
  return !footprintsIntersectPartitions({ xMm, yMm, lengthMm, widthMm: depthMm, rotationDeg }, partitions);
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

function findObjectPlacement(
  contour: PointMm[],
  lengthMm: number,
  depthMm: number,
  obstacles: RoomObject[] = [],
  partitions: Partition[] = [],
): PointMm | null {
  const box = getBoundingBox(contour);
  const preferred = { x: Math.round(box.minX + (box.width - lengthMm) / 2), y: Math.round(box.minY + (box.height - depthMm) / 2) };
  const isFree = (x: number, y: number) => (
    isRoomObjectPlacementValid(contour, x, y, lengthMm, depthMm, partitions)
    && !obstacles.some((object) => footprintsOverlap(
      { xMm: x, yMm: y, lengthMm, widthMm: depthMm },
      object,
    ))
  );
  if (isFree(preferred.x, preferred.y)) return preferred;
  const step = Math.max(25, Math.min(100, Math.round(Math.min(lengthMm, depthMm) / 4)));
  for (let y = box.minY; y <= box.maxY - depthMm; y += step) {
    for (let x = box.minX; x <= box.maxX - lengthMm; x += step) {
      if (isFree(x, y)) return { x, y };
    }
  }
  // Last resort: allow stacking on an occupied spot if the contour and partitions fit.
  if (isRoomObjectPlacementValid(contour, preferred.x, preferred.y, lengthMm, depthMm, partitions)) return preferred;
  for (let y = box.minY; y <= box.maxY - depthMm; y += step) {
    for (let x = box.minX; x <= box.maxX - lengthMm; x += step) {
      if (isRoomObjectPlacementValid(contour, x, y, lengthMm, depthMm, partitions)) return { x, y };
    }
  }
  return null;
}

function findRotatedObjectPlacement(
  contour: PointMm[],
  lengthMm: number,
  widthMm: number,
  rotationDeg: number,
  partitions: Partition[] = [],
  preferred?: PointMm,
): PointMm | null {
  const box = getBoundingBox(contour);
  const prototype = getBoundingBox(getRoomObjectCorners({ xMm: 0, yMm: 0, lengthMm, widthMm, rotationDeg }));
  const minX = Math.round(box.minX - prototype.minX);
  const maxX = Math.round(box.maxX - prototype.maxX);
  const minY = Math.round(box.minY - prototype.minY);
  const maxY = Math.round(box.maxY - prototype.maxY);
  const isValid = (point: PointMm) => isRoomObjectPlacementValid(contour, point.x, point.y, lengthMm, widthMm, partitions, rotationDeg);
  if (preferred && isValid(preferred)) return preferred;
  const center = preferred ?? {
    x: Math.round((minX + maxX) / 2),
    y: Math.round((minY + maxY) / 2),
  };
  if (isValid(center)) return center;
  const step = Math.max(20, Math.min(80, Math.round(Math.min(lengthMm, widthMm) / 5)));
  for (let radius = step; radius <= Math.max(box.width, box.height); radius += step) {
    for (let angle = 0; angle < 360; angle += 30) {
      const radians = (angle * Math.PI) / 180;
      const candidate = {
        x: Math.round(center.x + Math.cos(radians) * radius),
        y: Math.round(center.y + Math.sin(radians) * radius),
      };
      if (candidate.x < minX || candidate.x > maxX || candidate.y < minY || candidate.y > maxY) continue;
      if (isValid(candidate)) return candidate;
    }
  }
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (isValid({ x, y })) return { x, y };
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
  const corners = getRoomObjectCorners(object);
  const offsets: number[] = [];
  const considerPoint = (point: PointMm) => {
    const offset = (point.x - start.x) * direction.x + (point.y - start.y) * direction.y;
    const closest = {
      x: start.x + direction.x * offset,
      y: start.y + direction.y * offset,
    };
    const distance = Math.hypot(point.x - closest.x, point.y - closest.y);
    if (distance > WALL_OBJECT_TOUCH_TOLERANCE_MM) return;
    if (offset < -WALL_OBJECT_TOUCH_TOLERANCE_MM || offset > length + WALL_OBJECT_TOUCH_TOLERANCE_MM) return;
    offsets.push(Math.max(0, Math.min(length, offset)));
  };
  for (let index = 0; index < corners.length; index += 1) {
    const edgeStart = corners[index];
    const edgeEnd = corners[(index + 1) % corners.length];
    considerPoint(edgeStart);
    const edgeLength = Math.hypot(edgeEnd.x - edgeStart.x, edgeEnd.y - edgeStart.y);
    const samples = Math.max(2, Math.ceil(edgeLength / 40));
    for (let sample = 1; sample < samples; sample += 1) {
      const ratio = sample / samples;
      considerPoint({
        x: edgeStart.x + (edgeEnd.x - edgeStart.x) * ratio,
        y: edgeStart.y + (edgeEnd.y - edgeStart.y) * ratio,
      });
    }
    if (segmentsIntersect(edgeStart, edgeEnd, start, end)) {
      // Intersection point projection is covered by dense edge samples near the wall.
      considerPoint(edgeStart);
      considerPoint(edgeEnd);
    }
  }
  if (!offsets.length) return null;
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  const widthMm = Math.max(1, Math.round(max - min));
  return { offsetMm: Math.round(min), widthMm };
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
  const position = constrainRoomObjectPosition(
    area.contour,
    object,
    object.xMm + direction.x * delta,
    object.yMm + direction.y * delta,
    (normalized.room.partitions ?? []).filter((item) => (item.areaId ?? area.id) === area.id),
  );
  const siblings = normalized.objects.flatMap((item) => {
    if (item.id === objectId) return [];
    const siblingProjection = getRoomObjectWallProjection(normalized, surfaceId, item);
    if (!siblingProjection) return [];
    return [{
      elevationMm: item.elevationMm,
      heightMm: item.heightMm,
      id: item.id,
      offsetMm: siblingProjection.offsetMm,
      widthMm: siblingProjection.widthMm,
    }];
  });
  const stack = resolveWallObjectStacking(
    object.heightMm,
    surface.heightMm,
    nextOffset,
    projection.widthMm,
    Math.round(elevationMm),
    siblings,
  );
  if (stack.conflictIds.length) {
    return {
      conflictIds: stack.conflictIds,
      error: OBJECT_STACK_CONFLICT_HINT,
      object,
      project: normalized,
    };
  }
  const moved: RoomObject = {
    ...object,
    elevationMm: stack.elevationMm,
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

function isPartitionGeometryValid(room: Room, areaId: string, start: PointMm, end: PointMm, partitionId?: string): boolean {
  const area = room.areas?.find((item) => item.id === areaId);
  if (!area || segmentLength(start, end) < 250 || !isSegmentWithinContour(area.contour, start, end)) return false;
  return !(room.partitions ?? []).some((partition) => partition.id !== partitionId && segmentsIntersect(start, end, partition.start, partition.end));
}

function areAreaPartitionsValid(room: Room, areaId: string, contour: PointMm[]): boolean {
  return (room.partitions ?? [])
    .filter((partition) => partition.areaId === areaId)
    .every((partition) => isSegmentWithinContour(contour, partition.start, partition.end));
}

export function ensureProjectDefaults(project: TileProject): TileProject {
  const settings = project.settings ?? createDefaultSettings();
  const material = getPrimaryMaterial(project) ?? createMaterialFromPreset(getDefaultTilePreset(), settings);
  const materials = normalizeMaterials(project.materials?.length ? project.materials : [material], settings);
  const primaryMaterial = materials[0] ?? material;
  const room = normalizeRoomModel(project.room);
  const areas = room.areas ?? [];
  const partitions = (room.partitions ?? []).map((partition) => {
    const area = areas.find((item) => item.id === partition.areaId) ?? areas[0];
    return {
      ...partition,
      wallIndex: partition.wallIndex ?? findContourSegmentIndex(area?.contour ?? room.contour, partition.start),
    };
  });
  const hydratedRoom = partitions === room.partitions ? room : normalizeRoomModel({ ...room, partitions });
  return {
    ...project,
    objects: (project.objects ?? []).map((object) => {
      const legacy = object as RoomObject & { depthMm?: number; kind?: 'bathtub' | 'vanity' | 'sink' };
      const legacyNames = { bathtub: 'Ванна', vanity: 'Тумба', sink: 'Раковина' };
      return {
        ...object,
        elevationMm: object.elevationMm ?? 0,
        excludeTile: object.excludeTile ?? ((object.excludeFloorTile ?? false) && (object.excludeWallTile ?? false)),
        excludeFloorTile: object.excludeFloorTile ?? object.excludeTile ?? false,
        excludeWallTile: object.excludeWallTile ?? object.excludeTile ?? false,
        initialElevationMm: object.initialElevationMm ?? 0,
        name: object.name || (legacy.kind ? legacyNames[legacy.kind] : 'Объект'),
        rotationDeg: normalizeObjectRotationDeg(object.rotationDeg ?? 0),
        widthMm: object.widthMm ?? legacy.depthMm ?? 500,
      };
    }),
    room: hydratedRoom,
    settings,
    materials,
    surfaces: mergeSurfaceAssignments(createSurfacesFromRoom(hydratedRoom, primaryMaterial.id, settings), project.surfaces, materials, primaryMaterial.id),
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

function createSurfacesWithAssignments(room: Room, previous: TileProject, fallbackMaterialId: string | null, carryOverExtraZones = true): Surface[] {
  return mergeSurfaceAssignments(createSurfacesFromRoom(room, fallbackMaterialId, previous.settings), previous.surfaces, previous.materials, fallbackMaterialId, carryOverExtraZones);
}

function mergeSurfaceAssignments(nextSurfaces: Surface[], previousSurfaces: Surface[] = [], materials: TileMaterial[], fallbackMaterialId: string | null, carryOverExtraZones = true): Surface[] {
  const materialIds = new Set(materials.map((material) => material.id));
  return nextSurfaces.map((surface) => {
    const previous = previousSurfaces.find((item) => item.id === surface.id) ?? previousSurfaces.find((item) => item.sourceRef && item.sourceRef === surface.sourceRef);
    const previousMaterialId = previous?.zones[0]?.materialId;
    const previousBaseZone = previous?.zones[0];
    const materialId = previousMaterialId && materialIds.has(previousMaterialId) ? previousMaterialId : fallbackMaterialId;
    const extraZones =
      carryOverExtraZones && previous?.type === surface.type
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

export function getConnectedAreaIds(project: TileProject, startAreaId: string): Set<string> {
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

// Manually drawn floor zones store their polygon in absolute room coordinates
// (unlike rect zones and wall zones, which are local to their surface), so
// they must be repositioned explicitly whenever the room/area they belong to
// moves or rotates. Otherwise the zone is left behind at its old position.
function transformFloorZonePolygons(surfaces: Surface[], areaIds: Set<string>, transform: (point: PointMm) => PointMm): Surface[] {
  return surfaces.map((surface) => {
    if (surface.type !== 'floor') return surface;
    const areaId = surface.sourceRef?.split(':')[1];
    if (!areaId || !areaIds.has(areaId)) return surface;
    return {
      ...surface,
      zones: surface.zones.map((zone, index) =>
        index > 0 && zone.shape.type === 'polygon'
          ? { ...zone, shape: { type: 'polygon', points: zone.shape.points.map(transform) } }
          : zone,
      ),
    };
  });
}

function translateFloorZonePolygons(surfaces: Surface[], areaIds: Set<string>, deltaXmm: number, deltaYmm: number): Surface[] {
  if (!deltaXmm && !deltaYmm) return surfaces;
  return transformFloorZonePolygons(surfaces, areaIds, (point) => translatePoint(point, deltaXmm, deltaYmm));
}

function keepProjectInsidePlanCanvas(project: TileProject): TileProject {
  const areas = project.room.areas ?? [];
  if (!areas.length) return project;
  const bounds = getBoundingBox(areas.flatMap((area) => area.contour));
  const deltaXmm = bounds.minX < 0 ? Math.ceil(-bounds.minX) : 0;
  const deltaYmm = bounds.minY < 0 ? Math.ceil(-bounds.minY) : 0;
  if (!deltaXmm && !deltaYmm) return project;

  const room = normalizeRoomModel({
    ...project.room,
    contour: translateContour(project.room.contour, deltaXmm, deltaYmm),
    areas: areas.map((area) => ({ ...area, contour: translateContour(area.contour, deltaXmm, deltaYmm) })),
    partitions: project.room.partitions?.map((partition) => ({
      ...partition,
      start: translatePoint(partition.start, deltaXmm, deltaYmm),
      end: translatePoint(partition.end, deltaXmm, deltaYmm),
    })),
  });
  const materialId = getPrimaryMaterial(project)?.id ?? null;
  return {
    ...project,
    room,
    objects: project.objects.map((object) => ({
      ...object,
      initialXmm: object.initialXmm + deltaXmm,
      initialYmm: object.initialYmm + deltaYmm,
      xMm: object.xMm + deltaXmm,
      yMm: object.yMm + deltaYmm,
    })),
    surfaces: translateFloorZonePolygons(createSurfacesWithAssignments(room, project, materialId), new Set(areas.map((area) => area.id)), deltaXmm, deltaYmm),
  };
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

export function isPointStrictlyInsidePolygon(point: PointMm, polygon: PointMm[]): boolean {
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

export function isPointOnContourBoundary(point: PointMm, contour: PointMm[], toleranceMm: number): boolean {
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

function createCenteredOpening(surfaceId: string, kind: Opening['kind'], surfaceWidthMm: number, roomHeightMm: number, number?: number, dimensions?: { widthMm: number; heightMm?: number }): Opening {
  const defaultWidth = kind === 'door' ? DEFAULT_DOOR_WIDTH_MM : kind === 'window' ? DEFAULT_WINDOW_SIZE_MM : DEFAULT_PASSAGE_WIDTH_MM;
  const requestedWidth = dimensions?.widthMm ?? defaultWidth;
  const widthMm = Math.max(Math.min(MIN_OPENING_SIZE_MM, surfaceWidthMm), Math.min(Math.round(requestedWidth), surfaceWidthMm));
  const defaultHeight = kind === 'door' ? DEFAULT_DOOR_HEIGHT_MM : kind === 'window' ? DEFAULT_WINDOW_SIZE_MM : roomHeightMm;
  const requestedHeight = dimensions?.heightMm ?? defaultHeight;
  const heightMm = kind === 'passage' ? roomHeightMm : Math.max(Math.min(MIN_OPENING_SIZE_MM, roomHeightMm), Math.min(Math.round(requestedHeight), roomHeightMm));
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
    widthMm,
    heightMm,
  };
}

function findContourSegmentIndex(contour: PointMm[], point: PointMm): number {
  const toleranceMm = 3;
  return contour.findIndex((start, index) => {
    const end = contour[(index + 1) % contour.length];
    const length = segmentLength(start, end);
    if (!length) return false;
    return Math.abs(segmentLength(start, point) + segmentLength(point, end) - length) <= toleranceMm;
  });
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

function createFloorZone(surface: Surface, materialId: string | null, settings: ProjectSettings, kind: ZonePresetKind) {
  const width = Math.max(1, surface.widthMm);
  const height = Math.max(1, surface.heightMm);
  const shortSide = Math.min(width, height);
  const band = Math.max(250, Math.round(shortSide * 0.22));
  const rectWidth = Math.max(300, Math.round(width * 0.42));
  const rectHeight = Math.max(300, Math.round(height * 0.34));
  const shapeByKind = {
    rect: {
      type: 'rect' as const,
      xMm: Math.round((width - rectWidth) / 2),
      yMm: Math.round((height - rectHeight) / 2),
      widthMm: Math.min(width, rectWidth),
      heightMm: Math.min(height, rectHeight),
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
      stagger: 'none' as const,
      rotation: 0 as const,
      angleDeg: 0 as const,
      turnDeg: 0,
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

function clampGroutMm(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.min(50, Math.round(value * 10) / 10));
}

function clampLayoutOffset(value: number): number {
  return Math.max(-15000, Math.min(15000, Math.round(value)));
}

function formatTileLabel(widthMm: number, heightMm: number): string {
  return `${Math.round(widthMm / 10)}×${Math.round(heightMm / 10)}`;
}
