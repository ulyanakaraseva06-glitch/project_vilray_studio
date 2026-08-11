import { describe, expect, it } from 'vitest';
import { templates } from '../config/appConfig';
import { addFloorZone, addOpening, addPartition, addRoomObject, addWallZone, createProjectFromTemplate, updateZoneTileMaterial } from '../project/projectFactory';
import { calculateProject } from './calculateProject';

describe('calculateProject', () => {
  it('groups pieces by material and includes floor zones', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const zoned = addFloorZone(project, 'rect');
    const zone = zoned.surfaces.find((surface) => surface.id === 'surface-floor')!.zones[1]!;
    const updated = updateZoneTileMaterial(zoned, 'surface-floor', zone.id, { id: '600x600', label: '60×60', widthMm: 600, heightMm: 600 });

    const result = calculateProject(updated);

    expect(result.zones.length).toBeGreaterThan(updated.surfaces.length);
    expect(result.materials.some((item) => item.material.presetId === '600x600')).toBe(true);
    expect(result.totalPurchasePieces).toBeGreaterThan(result.fullPieces);
    expect(result.totalAreaM2).toBeGreaterThan(0);
  });

  it('includes wall zones and package box estimates', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const zoned = addWallZone(project, 'surface-wall-1', 'vertical-band');
    const zone = zoned.surfaces.find((surface) => surface.id === 'surface-wall-1')!.zones[1]!;
    const updated = updateZoneTileMaterial(zoned, 'surface-wall-1', zone.id, { id: '600x600', label: '60Г-60', widthMm: 600, heightMm: 600 });
    const materialId = updated.surfaces.find((surface) => surface.id === 'surface-wall-1')!.zones[1]!.materialId!;
    const withBoxes = {
      ...updated,
      materials: updated.materials.map((material) => (material.id === materialId ? { ...material, piecesPerBox: 4 } : material)),
    };

    const result = calculateProject(withBoxes);
    const wallZone = result.zones.find((item) => item.zoneId === zone.id);
    const material = result.materials.find((item) => item.material.id === materialId);

    expect(wallZone?.surfaceId).toBe('surface-wall-1');
    expect(wallZone?.edgeCuts).toHaveProperty('left');
    expect(material?.boxes).toBeGreaterThan(0);
    expect(result.totalBoxes).toBeGreaterThan(0);
  });

  it('subtracts door openings from wall calculation', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const baseline = calculateProject(project);
    const withDoor = calculateProject(addOpening(project, 'surface-wall-1', 'door'));

    expect(withDoor.totalAreaM2).toBeLessThan(baseline.totalAreaM2);
  });

  it('subtracts a window and counts both faces of a partition', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const baseline = calculateProject(project);
    const withWindow = calculateProject(addOpening(project, 'surface-wall-1', 'window'));
    const partitionedProject = addPartition(project, { x: 0, y: 500 }, { x: 1000, y: 500 }, 'room-1');
    const withPartition = calculateProject(partitionedProject);

    expect(withWindow.totalAreaM2).toBeLessThan(baseline.totalAreaM2);
    expect(withPartition.totalAreaM2).toBeGreaterThan(baseline.totalAreaM2);
    expect(withPartition.zones.filter((zone) => zone.surfaceId.startsWith('surface-partition-'))).toHaveLength(2);
  });

  it('subtracts an object only when tile is disabled behind it', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const baseline = calculateProject(project);
    const tiledObject = addRoomObject(project, { areaId: 'room-1', excludeTile: false, heightMm: 850, lengthMm: 800, name: 'Шкаф', widthMm: 500 }).project;
    const untiledObject = addRoomObject(project, { areaId: 'room-1', excludeTile: true, heightMm: 850, lengthMm: 800, name: 'Шкаф', widthMm: 500 }).project;

    expect(calculateProject(tiledObject).totalAreaM2).toBe(baseline.totalAreaM2);
    expect(calculateProject(untiledObject).totalAreaM2).toBeLessThan(baseline.totalAreaM2);
  });
});
