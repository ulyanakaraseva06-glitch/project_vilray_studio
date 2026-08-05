import { describe, expect, it } from 'vitest';
import { templates } from '../config/appConfig';
import {
  addAdjacentRoom,
  addFloorZone,
  addOpening,
  addPartition,
  addWallZone,
  createProjectFromTemplate,
  deleteZone,
  ensureProjectDefaults,
  getSurfaceMaterial,
  getZoneMaterial,
  updatePrimaryCustomTileMaterial,
  updatePrimaryTileMaterial,
  updateRoomHeight,
  updateSurfaceLayoutOffset,
  updateSurfaceLayoutOrigin,
  updateSurfaceTileMaterial,
  updateZoneLayoutOffset,
  updateZoneLayoutPattern,
  updateZoneShape,
  updateZoneTileMaterial,
} from './projectFactory';

describe('project factory', () => {
  it('creates schema version 1 project from template', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    expect(project.schemaVersion).toBe(1);
    expect(project.room.templateId).toBe('rectangle');
    expect(project.surfaces).toHaveLength(5);
    expect(project.settings.reservePercent).toBe(10);
    expect(project.materials[0]).toMatchObject({ presetId: '600x1200', widthMm: 600, heightMm: 1200 });
    expect(project.surfaces.every((surface) => surface.zones[0]?.materialId === project.materials[0].id)).toBe(true);
  });

  it('regenerates wall surfaces after height changes', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updateRoomHeight(project, 3000);
    expect(updated.room.heightMm).toBe(3000);
    expect(updated.surfaces.filter((surface) => surface.type === 'wall').every((surface) => surface.heightMm === 3000)).toBe(true);
    expect(updated.surfaces.every((surface) => surface.zones[0]?.materialId === project.materials[0].id)).toBe(true);
  });

  it('updates the primary tile material from a preset', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updatePrimaryTileMaterial(project, { id: '600x600', label: '60×60', widthMm: 600, heightMm: 600 });
    expect(updated.materials[0]).toMatchObject({ presetId: '600x600', widthMm: 600, heightMm: 600 });
    expect(updated.surfaces.every((surface) => surface.zones[0]?.materialId === updated.materials[0].id)).toBe(true);
  });

  it('stores custom tile size in millimeters', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updatePrimaryCustomTileMaterial(project, 750, 1500);
    expect(updated.materials[0]).toMatchObject({ widthMm: 750, heightMm: 1500, label: '75×150' });
    expect(updated.materials[0].presetId).toBeUndefined();
  });

  it('hydrates old projects that do not have materials and zones yet', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const oldProject = { ...project, materials: [], surfaces: project.surfaces.map((surface) => ({ ...surface, zones: [] })) };
    const hydrated = ensureProjectDefaults(oldProject);
    expect(hydrated.materials).toHaveLength(1);
    expect(hydrated.surfaces.every((surface) => surface.zones.length === 1)).toBe(true);
  });

  it('assigns a tile material to one wall without changing the others', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSurfaceTileMaterial(project, 'surface-wall-2', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });

    expect(getSurfaceMaterial(updated, 'surface-wall-2')).toMatchObject({ presetId: '600x600' });
    expect(getSurfaceMaterial(updated, 'surface-wall-1')).toMatchObject({ presetId: '600x1200' });
  });

  it('preserves wall tile assignments after height changes', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const assigned = updateSurfaceTileMaterial(project, 'surface-wall-2', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });
    const resized = updateRoomHeight(assigned, 3000);

    expect(getSurfaceMaterial(resized, 'surface-wall-2')).toMatchObject({ presetId: '600x600' });
    expect(resized.surfaces.find((surface) => surface.id === 'surface-wall-2')?.heightMm).toBe(3000);
  });

  it('assigns a tile material to the floor surface', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSurfaceTileMaterial(project, 'surface-floor', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });

    expect(getSurfaceMaterial(updated, 'surface-floor')).toMatchObject({ presetId: '600x600' });
    expect(getSurfaceMaterial(updated, 'surface-wall-1')).toMatchObject({ presetId: '600x1200' });
  });

  it('preserves materials and matching surface assignments after changing room template', () => {
    const rectangle = templates.find((template) => template.id === 'rectangle') ?? templates[0];
    const square = templates.find((template) => template.id === 'square') ?? templates[0];
    const project = createProjectFromTemplate(rectangle, [1700, 2000]);
    const assigned = updateSurfaceTileMaterial(project, 'surface-wall-2', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });
    const changed = createProjectFromTemplate(square, [1800, 1800], assigned);

    expect(changed.materials.some((material) => material.presetId === '600x600')).toBe(true);
    expect(getSurfaceMaterial(changed, 'surface-wall-2')).toMatchObject({ presetId: '600x600' });
    expect(getSurfaceMaterial(changed, 'surface-floor')).toMatchObject({ presetId: '600x1200' });
  });

  it('updates layout origin mode for one surface', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSurfaceLayoutOrigin(project, 'surface-floor', 'tile-center');

    expect(updated.surfaces.find((surface) => surface.id === 'surface-floor')?.zones[0]?.layout.originMode).toBe('tile-center');
    expect(updated.surfaces.find((surface) => surface.id === 'surface-wall-1')?.zones[0]?.layout.originMode).not.toBe('tile-center');
  });

  it('combines a selected start point with a layout pattern', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const floor = project.surfaces.find((surface) => surface.id === 'surface-floor')!;
    const zoneId = floor.zones[0]!.id;
    const withOrigin = updateSurfaceLayoutOrigin(project, floor.id, 'corner-br');
    const withPattern = updateZoneLayoutPattern(withOrigin, floor.id, zoneId, 'half-offset');
    const layout = withPattern.surfaces.find((surface) => surface.id === floor.id)!.zones[0]!.layout;

    expect(layout).toMatchObject({ originMode: 'corner-br', pattern: 'half-offset' });
  });

  it('stores manual layout offset for one surface', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSurfaceLayoutOffset(project, 'surface-floor', 20, -10);
    const layout = updated.surfaces.find((surface) => surface.id === 'surface-floor')?.zones[0]?.layout;

    expect(layout).toMatchObject({ originMode: 'manual', originXmm: 20, originYmm: -10 });
  });

  it('adds a floor zone and assigns a separate material to it', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const zoned = addFloorZone(project, 'rect');
    const floor = zoned.surfaces.find((surface) => surface.id === 'surface-floor');
    const zone = floor?.zones[1];
    expect(zone?.shape.type).toBe('rect');

    const updated = updateZoneTileMaterial(zoned, 'surface-floor', zone!.id, { id: '600x600', label: '60×60', widthMm: 600, heightMm: 600 });

    expect(getZoneMaterial(updated, 'surface-floor', zone!.id)).toMatchObject({ presetId: '600x600' });
    expect(getSurfaceMaterial(updated, 'surface-floor')).toMatchObject({ presetId: '600x1200' });
  });

  it('stores manual layout offset for one zone', () => {
    const project = addFloorZone(createProjectFromTemplate(templates[0], [1700, 2000]), 'shower');
    const zone = project.surfaces.find((surface) => surface.id === 'surface-floor')!.zones[1]!;
    const updated = updateZoneLayoutOffset(project, 'surface-floor', zone.id, 40, 30);
    const layout = updated.surfaces.find((surface) => surface.id === 'surface-floor')?.zones[1]?.layout;

    expect(layout).toMatchObject({ originMode: 'manual', originXmm: 40, originYmm: 30 });
    expect(updated.surfaces.find((surface) => surface.id === 'surface-floor')?.zones[0]?.layout.originMode).toBe('corner-tl');
  });

  it('adds wall zones and preserves them when room height changes', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const zoned = addWallZone(project, 'surface-wall-1', 'horizontal-band');
    const wall = zoned.surfaces.find((surface) => surface.id === 'surface-wall-1');

    expect(wall?.zones).toHaveLength(2);
    expect(wall?.zones[1]?.shape.type).toBe('rect');

    const resized = updateRoomHeight(zoned, 3000);
    expect(resized.surfaces.find((surface) => surface.id === 'surface-wall-1')?.zones).toHaveLength(2);
  });

  it('updates and clamps editable zone geometry', () => {
    const project = addFloorZone(createProjectFromTemplate(templates[0], [1700, 2000]), 'rect');
    const zone = project.surfaces.find((surface) => surface.id === 'surface-floor')!.zones[1]!;
    const updated = updateZoneShape(project, 'surface-floor', zone.id, { heightMm: 20, widthMm: 99999, xMm: 99999, yMm: -200 });
    const shape = updated.surfaces.find((surface) => surface.id === 'surface-floor')!.zones[1]!.shape;

    expect(shape).toMatchObject({ heightMm: 100, widthMm: 1700, xMm: 0, yMm: 0 });
  });

  it('does not delete base zones but deletes extra zones', () => {
    const project = addFloorZone(createProjectFromTemplate(templates[0], [1700, 2000]), 'rect');
    const floor = project.surfaces.find((surface) => surface.id === 'surface-floor')!;
    const baseDelete = deleteZone(project, 'surface-floor', floor.zones[0]!.id);
    const extraDelete = deleteZone(project, 'surface-floor', floor.zones[1]!.id);

    expect(baseDelete.surfaces.find((surface) => surface.id === 'surface-floor')?.zones).toHaveLength(2);
    expect(extraDelete.surfaces.find((surface) => surface.id === 'surface-floor')?.zones).toHaveLength(1);
  });

  it('hydrates old projects with a first room area', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const oldProject = { ...project, room: { templateId: project.room.templateId, heightMm: project.room.heightMm, contour: project.room.contour } };

    const hydrated = ensureProjectDefaults(oldProject);

    expect(hydrated.room.areas).toHaveLength(1);
    expect(hydrated.surfaces.find((surface) => surface.id === 'surface-floor')?.sourceRef).toBe('floor:room-1');
  });

  it('adds a second room with stable floor and wall surface ids', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const updated = addAdjacentRoom(project);

    expect(updated.room.areas).toHaveLength(2);
    expect(updated.surfaces.some((surface) => surface.id === 'surface-floor-room-2')).toBe(true);
    expect(updated.surfaces.some((surface) => surface.id === 'surface-wall-room-2-1')).toBe(true);
    expect(updated.room.openings?.some((opening) => opening.kind === 'passage')).toBe(true);
  });

  it('adds doors and partitions as project geometry', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const withDoor = addOpening(project, 'surface-wall-1', 'door');
    const withPartition = addPartition(withDoor);

    expect(withDoor.room.openings?.[0]).toMatchObject({ kind: 'door', surfaceId: 'surface-wall-1', widthMm: 800 });
    expect(withPartition.room.partitions).toHaveLength(1);
    expect(withPartition.surfaces.some((surface) => surface.id === 'surface-partition-1-a')).toBe(true);
    expect(withPartition.surfaces.some((surface) => surface.id === 'surface-partition-1-b')).toBe(true);
  });

  it('preserves material assignments when a second room is added', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const assigned = updateSurfaceTileMaterial(project, 'surface-wall-2', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });
    const updated = addAdjacentRoom(assigned);

    expect(getSurfaceMaterial(updated, 'surface-wall-2')).toMatchObject({ presetId: '600x600' });
  });
});
