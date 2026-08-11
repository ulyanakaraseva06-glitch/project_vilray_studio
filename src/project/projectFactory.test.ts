import { describe, expect, it } from 'vitest';
import { templates } from '../config/appConfig';
import {
  addAdjacentRoom,
  addRoomFromTemplate,
  addRoomFromContour,
  addFloorZone,
  addOpening,
  addOpeningDetailed,
  addPartition,
  addRoomObject,
  addWallZone,
  createProjectFromTemplate,
  connectRoomOpenings,
  deleteOpening,
  deletePartition,
  deleteRoomObject,
  deleteZone,
  ensureProjectDefaults,
  getSurfaceMaterial,
  getOpeningConnectionCandidates,
  getZoneMaterial,
  moveRoomArea,
  moveRoomAreaChecked,
  moveRoomAreaWall,
  moveOpening,
  movePartition,
  moveRoomObject,
  resizeOpening,
  resetOpening,
  resetPartition,
  resetRoomObject,
  renameRoomArea,
  updatePrimaryCustomTileMaterial,
  updatePrimaryTileMaterial,
  updateRoomHeight,
  updateRoomAreaHeight,
  updateRoomAreaSegmentLength,
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

  it('adds a chosen room to the right and moves it without allowing overlap', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const added = addRoomFromTemplate(project, templates[1], templates[1].sizes[0]);
    const firstBox = added.room.areas![0].contour;
    const secondBefore = added.room.areas![1].contour;
    const moved = moveRoomArea(added, 'room-2', -400, 0);
    expect(Math.min(...moved.room.areas![1].contour.map((point) => point.x))).toBe(Math.max(...firstBox.map((point) => point.x)));
    const rejected = moveRoomArea(moved, 'room-2', -100, 0);
    expect(rejected.room.areas![1].contour).toEqual(moved.room.areas![1].contour);
    expect(secondBefore).not.toEqual(moved.room.areas![1].contour);
  });

  it('marks a manually drawn room as shape-locked but keeps template rooms editable', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const custom = addRoomFromContour(project, [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 900 }, { x: 0, y: 900 }]);
    const templated = addRoomFromTemplate(project, templates[0], [1200, 900]);

    expect(custom.room.areas?.[1].shapeLocked).toBe(true);
    expect(templated.room.areas?.[1].shapeLocked).toBe(false);
  });

  it('moves the primary room and rejects overlap with another room', () => {
    const project = addRoomFromTemplate(createProjectFromTemplate(templates[0], [1700, 2000]), templates[0], [1200, 1200]);
    const moved = moveRoomAreaChecked(project, 'room-1', 200, 300);
    const rejected = moveRoomAreaChecked(moved.project, 'room-1', 1900, -300);

    expect(moved.error).toBeUndefined();
    expect(moved.project.room.areas?.[0].contour[0]).toEqual({ x: 200, y: 300 });
    expect(rejected.error).toContain('накладывать');
    expect(rejected.project.room.areas?.[0].contour).toEqual(moved.project.room.areas?.[0].contour);
  });

  it('numbers openings and joins two rooms through matching free doors', () => {
    const project = addRoomFromTemplate(createProjectFromTemplate(templates[0], [1700, 2000]), templates[0], [1200, 1600]);
    const first = addOpeningDetailed(project, 'surface-wall-2', 'door');
    const second = addOpeningDetailed(first.project, 'surface-wall-room-2-4', 'door');
    const candidates = getOpeningConnectionCandidates(second.project, second.opening!.id);
    const connected = connectRoomOpenings(second.project, second.opening!.id, first.opening!.id);
    const firstRight = Math.max(...connected.project.room.areas![0].contour.map((point) => point.x));
    const secondLeft = Math.min(...connected.project.room.areas![1].contour.map((point) => point.x));

    expect(first.opening).toMatchObject({ kind: 'door', number: 1, name: 'Дверь 1' });
    expect(second.opening).toMatchObject({ kind: 'door', number: 2, name: 'Дверь 2' });
    expect(candidates).toHaveLength(1);
    expect(connected.error).toBeUndefined();
    expect(secondLeft).toBe(firstRight);
    expect(connected.project.room.openings?.find((opening) => opening.id === first.opening!.id)?.connectedOpeningId).toBe(second.opening!.id);
  });

  it('moves the connected room when its door is shifted and keeps the paired door fixed', () => {
    const project = addRoomFromTemplate(createProjectFromTemplate(templates[0], [1700, 2000]), templates[0], [1200, 1600]);
    const first = addOpeningDetailed(project, 'surface-wall-2', 'door');
    const second = addOpeningDetailed(first.project, 'surface-wall-room-2-4', 'door');
    const connected = connectRoomOpenings(second.project, second.opening!.id, first.opening!.id).project;
    const firstContour = connected.room.areas![0].contour;
    const secondContour = connected.room.areas![1].contour;
    const fixedOpening = connected.room.openings!.find((opening) => opening.id === first.opening!.id)!;
    const movingOpening = connected.room.openings!.find((opening) => opening.id === second.opening!.id)!;
    const moved = moveOpening(connected, movingOpening.id, movingOpening.xMm + 150);
    const movedFixedOpening = moved.room.openings!.find((opening) => opening.id === fixedOpening.id)!;
    const movedSourceOpening = moved.room.openings!.find((opening) => opening.id === movingOpening.id)!;

    const getCenter = (openingId: string) => {
      const opening = moved.room.openings!.find((item) => item.id === openingId)!;
      const source = moved.surfaces.find((surface) => surface.id === opening.surfaceId)!.sourceRef!.split(':');
      const area = moved.room.areas!.find((item) => item.id === source[1])!;
      const index = Number(source[2]) - 1;
      const start = area.contour[index];
      const end = area.contour[(index + 1) % area.contour.length];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const offset = opening.xMm + opening.widthMm / 2;
      return { x: Math.round(start.x + (end.x - start.x) / length * offset), y: Math.round(start.y + (end.y - start.y) / length * offset) };
    };

    expect(moved.room.areas![0].contour).toEqual(firstContour);
    expect(moved.room.areas![1].contour).not.toEqual(secondContour);
    expect(movedFixedOpening.xMm).toBe(fixedOpening.xMm);
    expect(movedSourceOpening.xMm).toBe(movingOpening.xMm + 150);
    expect(getCenter(movedFixedOpening.id)).toEqual(getCenter(movedSourceOpening.id));
  });

  it('keeps a separate wall height for each room', () => {
    const project = addRoomFromTemplate(createProjectFromTemplate(templates[0], [1700, 2000]), templates[0], [1200, 1600]);
    const updated = updateRoomAreaHeight(project, 'room-2', 3200);

    expect(updated.room.areas?.[0].heightMm).toBe(project.room.heightMm);
    expect(updated.room.areas?.[1].heightMm).toBe(3200);
    expect(updated.surfaces.filter((surface) => surface.sourceRef?.startsWith('wall:room-2:')).every((surface) => surface.heightMm === 3200)).toBe(true);
  });

  it('edits walls of the second room without changing the first room', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const added = addRoomFromTemplate(project, templates[0], [1600, 1900]);
    const firstContour = added.room.areas![0].contour;
    const resized = updateRoomAreaSegmentLength(added, 'room-2', 0, 2100);
    const dragged = moveRoomAreaWall(resized, 'room-2', 1, 100);

    expect(resized.room.areas![0].contour).toEqual(firstContour);
    expect(resized.surfaces.find((surface) => surface.id === 'surface-wall-room-2-1')?.widthMm).toBe(2100);
    expect(dragged.room.areas![0].contour).toEqual(firstContour);
    expect(dragged.room.areas![1].contour).not.toEqual(resized.room.areas![1].contour);
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

  it('moves, resets and deletes an opening on its selected wall', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const withDoor = addOpening(project, 'surface-wall-1', 'door');
    const door = withDoor.room.openings![0];
    const moved = moveOpening(withDoor, door.id, 50);
    const reset = resetOpening(moved, door.id);
    const deleted = deleteOpening(reset, door.id);

    expect(moved.room.openings![0].xMm).toBe(50);
    expect(reset.room.openings![0].xMm).toBe(door.initialXmm);
    expect(deleted.room.openings).toHaveLength(0);
    expect(deleted.surfaces.find((surface) => surface.id === 'surface-wall-1')?.openings).toHaveLength(0);
  });

  it('moves, resizes, resets and deletes a window on its selected wall', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const withWindow = addOpening(project, 'surface-wall-1', 'window');
    const window = withWindow.room.openings![0];
    const moved = moveOpening(withWindow, window.id, 120, 540);
    const resized = resizeOpening(moved, window.id, { xMm: 180, yMm: 420, widthMm: 900, heightMm: 700 });
    const reset = resetOpening(resized, window.id);
    const deleted = deleteOpening(reset, window.id);

    expect(window).toMatchObject({ kind: 'window', widthMm: 1000, heightMm: 1000 });
    expect(moved.room.openings![0]).toMatchObject({ xMm: 120, yMm: 540 });
    expect(resized.room.openings![0]).toMatchObject({ xMm: 180, yMm: 420, widthMm: 900, heightMm: 700 });
    expect(reset.room.openings![0]).toMatchObject({ xMm: window.initialXmm, yMm: window.initialYmm, widthMm: 900, heightMm: 700 });
    expect(deleted.room.openings).toHaveLength(0);
  });

  it('resizes a passage only horizontally and keeps a door on the floor', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const withPassage = addOpening(project, 'surface-wall-1', 'passage');
    const passage = withPassage.room.openings![0];
    const resizedPassage = resizeOpening(withPassage, passage.id, { xMm: 100, yMm: 600, widthMm: 1100, heightMm: 800 });
    const withDoor = addOpening(project, 'surface-wall-1', 'door');
    const door = withDoor.room.openings![0];
    const resizedDoor = resizeOpening(withDoor, door.id, { xMm: 140, yMm: 200, widthMm: 950, heightMm: 1800 });

    expect(resizedPassage.room.openings![0]).toMatchObject({ xMm: 100, yMm: 0, widthMm: 1100, heightMm: project.room.heightMm });
    expect(resizedDoor.room.openings![0]).toMatchObject({ xMm: 140, widthMm: 950, heightMm: 1800, yMm: project.room.heightMm - 1800 });
  });

  it('creates two wall faces for a partition and supports move, reset and delete', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const withPartition = addPartition(project, { x: 0, y: 500 }, { x: 900, y: 500 }, 'room-1');
    const partition = withPartition.room.partitions![0];
    const moved = movePartition(withPartition, partition.id, { x: 0, y: 650 }, { x: 900, y: 650 });
    const reset = resetPartition(moved, partition.id);
    const deleted = deletePartition(reset, partition.id);

    expect(partition).toMatchObject({ areaId: 'room-1', start: { x: 0, y: 500 }, end: { x: 900, y: 500 } });
    expect(withPartition.surfaces.filter((surface) => surface.sourceRef?.startsWith(`partition:${partition.id}`))).toHaveLength(2);
    expect(moved.room.partitions![0]).toMatchObject({ start: { x: 0, y: 650 }, end: { x: 900, y: 650 } });
    expect(reset.room.partitions![0]).toMatchObject({ start: { x: 0, y: 500 }, end: { x: 900, y: 500 } });
    expect(deleted.room.partitions).toHaveLength(0);
    expect(deleted.surfaces.some((surface) => surface.sourceRef?.startsWith(`partition:${partition.id}`))).toBe(false);
  });

  it('preserves material assignments when a second room is added', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const assigned = updateSurfaceTileMaterial(project, 'surface-wall-2', { id: '600x600', label: '60Г—60', widthMm: 600, heightMm: 600 });
    const updated = addAdjacentRoom(assigned);

    expect(getSurfaceMaterial(updated, 'surface-wall-2')).toMatchObject({ presetId: '600x600' });
  });

  it('adds, constrains, resets and deletes a room object', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const added = addRoomObject(project, { areaId: 'room-1', excludeTile: true, heightMm: 850, lengthMm: 800, name: 'Тумба', widthMm: 500 });
    const object = added.object!;
    const moved = moveRoomObject(added.project, object.id, 1200, 1700);
    const reset = resetRoomObject(moved.project, object.id);
    const deleted = deleteRoomObject(reset, object.id);

    expect(added.error).toBeUndefined();
    expect(object).toMatchObject({ areaId: 'room-1', excludeTile: true, name: 'Тумба', lengthMm: 800, widthMm: 500, heightMm: 850 });
    expect(moved.object!.xMm + moved.object!.lengthMm).toBeLessThanOrEqual(1700);
    expect(moved.object!.yMm + moved.object!.widthMm).toBeLessThanOrEqual(2000);
    expect(reset.objects[0]).toMatchObject({ xMm: object.initialXmm, yMm: object.initialYmm });
    expect(deleted.objects).toHaveLength(0);
  });

  it('keeps room objects from overlapping during creation and movement', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const first = addRoomObject(project, { areaId: 'room-1', excludeTile: false, heightMm: 850, lengthMm: 800, name: 'Первый', widthMm: 500 });
    const second = addRoomObject(first.project, { areaId: 'room-1', excludeTile: false, heightMm: 850, lengthMm: 800, name: 'Второй', widthMm: 500 });
    const moved = moveRoomObject(second.project, second.object!.id, first.object!.xMm, first.object!.yMm);
    const firstObject = moved.project.objects.find((object) => object.id === first.object!.id)!;
    const secondObject = moved.project.objects.find((object) => object.id === second.object!.id)!;
    const overlap = firstObject.xMm < secondObject.xMm + secondObject.lengthMm
      && firstObject.xMm + firstObject.lengthMm > secondObject.xMm
      && firstObject.yMm < secondObject.yMm + secondObject.widthMm
      && firstObject.yMm + firstObject.widthMm > secondObject.yMm;

    expect(second.error).toBeUndefined();
    expect(second.object).not.toMatchObject({ xMm: first.object!.xMm, yMm: first.object!.yMm });
    expect(overlap).toBe(false);
  });

  it('rejects invalid object dimensions and renames a room', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const invalid = addRoomObject(project, { areaId: 'room-1', excludeTile: false, heightMm: 850, lengthMm: -10, name: 'Раковина', widthMm: 500 });
    const oversized = addRoomObject(project, { areaId: 'room-1', excludeTile: false, heightMm: 600, lengthMm: 4000, name: 'Ванна', widthMm: 700 });
    const renamed = renameRoomArea(project, 'room-1', 'Главная ванная');

    expect(invalid.error).toContain('положительными');
    expect(oversized.error).toContain('не помещается');
    expect(renamed.room.areas![0].name).toBe('Главная ванная');
  });
});
