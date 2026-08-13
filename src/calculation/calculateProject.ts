import { generatePolygonLayout, generateRectLayout } from '../layout/layoutEngine';
import type { LayoutEdgeCuts } from '../layout/layoutEngine';
import { getBoundingBox } from '../project/geometry';
import { getRoomObjectWallProjection } from '../project/projectFactory';
import type { FinishZone, Surface, TileMaterial, TileProject } from '../types/project';

export interface ZoneCalculation {
  areaM2: number;
  boxes: number | null;
  criticalPieces: number;
  cutPieces: number;
  edgeCuts: LayoutEdgeCuts;
  edgeOffsets: LayoutEdgeCuts;
  fullPieces: number;
  materialId: string;
  minCutMm: number | null;
  purchasePieces: number;
  reservePieces: number;
  surfaceId: string;
  surfaceName: string;
  totalPieces: number;
  truncated: boolean;
  warnings: string[];
  zoneId: string;
  zoneName: string;
}

export interface MaterialCalculation {
  areaM2: number;
  boxes: number | null;
  material: TileMaterial;
  purchasePieces: number;
  reservePieces: number;
  totalPieces: number;
  zones: ZoneCalculation[];
}

export interface ProjectCalculation {
  criticalPieces: number;
  cutPieces: number;
  fullPieces: number;
  materials: MaterialCalculation[];
  totalBoxes: number | null;
  totalAreaM2: number;
  totalPurchasePieces: number;
  warnings: string[];
  zones: ZoneCalculation[];
}

export function calculateProject(project: TileProject): ProjectCalculation {
  const rawZones = project.surfaces.flatMap((surface) =>
    surface.zones.flatMap((zone) => {
      const material = project.materials.find((item) => item.id === zone.materialId) ?? project.materials[0];
      if (!material) return [];
      const layout = calculateZoneLayout(project, zone, surface, material);
      const totalPieces = layout.fullCount + layout.cutCount + layout.criticalCount;
      const reservePercent = material.reservePercent ?? project.settings.reservePercent;
      const reservePieces = Math.ceil(totalPieces * (reservePercent / 100));
      const purchasePieces = totalPieces + reservePieces;
      return {
        areaM2: roundM2(layout.usedAreaMm2 / 1_000_000),
        boxes: calculateBoxes(material, purchasePieces, layout.usedAreaMm2),
        criticalPieces: layout.criticalCount,
        cutPieces: layout.cutCount,
        edgeCuts: layout.edgeCuts,
        edgeOffsets: layout.edgeOffsets,
        fullPieces: layout.fullCount,
        materialId: material.id,
        minCutMm: layout.minCutMm,
        purchasePieces,
        reservePieces,
        surfaceId: surface.id,
        surfaceName: surface.name,
        totalPieces,
        truncated: layout.truncated,
        warnings: getZoneWarnings(layout.truncated, material, zone),
        zoneId: zone.id,
        zoneName: zone.name,
      };
    }),
  );
  const zones = rawZones.map((zone) => {
    const surface = project.surfaces.find((item) => item.id === zone.surfaceId);
    if (!surface || surface.zones[0]?.id !== zone.zoneId) return zone;
    const replacementAreaM2 = sum(rawZones.filter((candidate) => candidate.surfaceId === zone.surfaceId && candidate.zoneId !== zone.zoneId).map((candidate) => candidate.areaM2));
    if (!replacementAreaM2 || !zone.areaM2) return zone;
    const areaM2 = roundM2(Math.max(0, zone.areaM2 - replacementAreaM2));
    const ratio = Math.max(0, Math.min(1, areaM2 / zone.areaM2));
    const fullPieces = Math.round(zone.fullPieces * ratio);
    const cutPieces = Math.round(zone.cutPieces * ratio);
    const criticalPieces = Math.round(zone.criticalPieces * ratio);
    const totalPieces = fullPieces + cutPieces + criticalPieces;
    const reservePieces = Math.round(zone.reservePieces * ratio);
    const purchasePieces = totalPieces + reservePieces;
    const material = project.materials.find((item) => item.id === zone.materialId);
    return {
      ...zone,
      areaM2,
      boxes: material ? calculateBoxes(material, purchasePieces, areaM2 * 1_000_000) : zone.boxes,
      criticalPieces,
      cutPieces,
      fullPieces,
      purchasePieces,
      reservePieces,
      totalPieces,
    };
  });

  const materials = project.materials.flatMap((material) => {
    const materialZones = zones.filter((zone) => zone.materialId === material.id);
    if (!materialZones.length) return [];
    return {
      areaM2: roundM2(sum(materialZones.map((zone) => zone.areaM2))),
      boxes: calculateMaterialBoxes(material, materialZones),
      material,
      purchasePieces: sum(materialZones.map((zone) => zone.purchasePieces)),
      reservePieces: sum(materialZones.map((zone) => zone.reservePieces)),
      totalPieces: sum(materialZones.map((zone) => zone.totalPieces)),
      zones: materialZones,
    };
  });

  return {
    criticalPieces: sum(zones.map((zone) => zone.criticalPieces)),
    cutPieces: sum(zones.map((zone) => zone.cutPieces)),
    fullPieces: sum(zones.map((zone) => zone.fullPieces)),
    materials,
    totalBoxes: sumNullable(materials.map((material) => material.boxes)),
    totalAreaM2: roundM2(sum(zones.map((zone) => zone.areaM2))),
    totalPurchasePieces: sum(zones.map((zone) => zone.purchasePieces)),
    warnings: zones.flatMap((zone) => zone.warnings),
    zones,
  };
}

function calculateZoneLayout(project: TileProject, zone: FinishZone, surface: Surface, material: TileMaterial) {
  const blockedRects = getBlockedRectsForZone(project, zone, surface);
  const result =
    zone.shape.type === 'polygon'
      ? generatePolygonLayout({
          blockedRects,
          layout: zone.layout,
          points: zone.shape.points,
          tileHeightMm: material.heightMm,
          tileWidthMm: material.widthMm,
        })
      : generateRectLayout({
          blockedRects,
          heightMm: zone.shape.heightMm || surface.heightMm,
          layout: zone.layout,
          tileHeightMm: material.heightMm,
          tileWidthMm: material.widthMm,
          widthMm: zone.shape.widthMm || surface.widthMm,
        });

  return {
    ...result,
    usedAreaMm2: result.pieces.reduce((total, piece) => total + piece.widthMm * piece.heightMm, 0),
  };
}

function getBlockedRectsForZone(project: TileProject, zone: FinishZone, surface: Surface) {
  const blockedRects: Array<{ type: 'rect'; xMm: number; yMm: number; widthMm: number; heightMm: number }> = [];

  if (surface.type === 'wall' && zone.shape.type === 'rect') {
    const shape = zone.shape;
    blockedRects.push(...surface.openings.map((opening) => ({
      type: 'rect' as const,
      xMm: opening.xMm - shape.xMm,
      yMm: opening.yMm - shape.yMm,
      widthMm: opening.widthMm,
      heightMm: opening.heightMm,
    })));
    for (const object of project.objects) {
      if (!object.excludeWallTile) continue;
      const projection = getRoomObjectWallProjection(project, surface.id, object);
      if (!projection) continue;
      blockedRects.push({
        type: 'rect',
        xMm: projection.offsetMm - shape.xMm,
        yMm: surface.heightMm - object.elevationMm - object.heightMm - shape.yMm,
        widthMm: projection.widthMm,
        heightMm: object.heightMm,
      });
    }
  }

  if (surface.type === 'floor') {
    const areaId = surface.sourceRef?.split(':')[1];
    const area = project.room.areas?.find((item) => item.id === areaId);
    if (!area) return blockedRects;
    const areaBox = getBoundingBox(area.contour);
    const zoneOrigin = zone.shape.type === 'polygon'
      ? getBoundingBox(zone.shape.points)
      : { minX: areaBox.minX + zone.shape.xMm, minY: areaBox.minY + zone.shape.yMm };
    for (const object of project.objects) {
      if (!object.excludeFloorTile || object.areaId !== area.id) continue;
      blockedRects.push({
        type: 'rect',
        xMm: object.xMm - zoneOrigin.minX,
        yMm: object.yMm - zoneOrigin.minY,
        widthMm: object.lengthMm,
        heightMm: object.widthMm,
      });
    }
  }

  return blockedRects;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundM2(value: number): number {
  return Math.round(value * 100) / 100;
}

function calculateBoxes(material: TileMaterial, purchasePieces: number, usedAreaMm2: number): number | null {
  if (material.piecesPerBox && material.piecesPerBox > 0) return Math.ceil(purchasePieces / material.piecesPerBox);
  if (material.boxAreaM2 && material.boxAreaM2 > 0) return Math.ceil(usedAreaMm2 / 1_000_000 / material.boxAreaM2);
  return null;
}

function calculateMaterialBoxes(material: TileMaterial, zones: ZoneCalculation[]): number | null {
  if (material.piecesPerBox && material.piecesPerBox > 0) return Math.ceil(sum(zones.map((zone) => zone.purchasePieces)) / material.piecesPerBox);
  if (material.boxAreaM2 && material.boxAreaM2 > 0) return Math.ceil(sum(zones.map((zone) => zone.areaM2)) / material.boxAreaM2);
  return null;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? sum(present) : null;
}

function getZoneWarnings(truncated: boolean, material: TileMaterial, zone: FinishZone): string[] {
  const warnings: string[] = [];
  if (truncated) warnings.push(`${zone.name}: сетка обрезана для скорости отображения.`);
  if (!material.piecesPerBox && !material.boxAreaM2) warnings.push(`${material.label ?? material.name}: не задана упаковка, коробки не считаются.`);
  return warnings;
}
