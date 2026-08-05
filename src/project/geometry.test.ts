import { describe, expect, it } from 'vitest';
import { templates } from '../config/appConfig';
import { createContourFromTemplate, createSurfaces, moveWall, updateSegmentLength, validateContour, validateRoomHeight } from './geometry';

describe('room geometry', () => {
  it('creates a rectangular contour from a template size', () => {
    const template = templates.find((item) => item.id === 'rectangle')!;
    expect(createContourFromTemplate(template, [1700, 2000])).toEqual([
      { x: 0, y: 0 },
      { x: 1700, y: 0 },
      { x: 1700, y: 2000 },
      { x: 0, y: 2000 },
    ]);
  });

  it('creates orthogonal l-shape and projection contours', () => {
    for (const id of ['l-shape', 'projection']) {
      const template = templates.find((item) => item.id === id)!;
      const contour = createContourFromTemplate(template, template.sizes[0]);
      expect(contour.length).toBeGreaterThan(4);
      expect(validateContour(contour).ok).toBe(true);
    }
  });

  it('generates floor and wall surfaces from the contour', () => {
    const contour = createContourFromTemplate(templates[0], [1700, 2000]);
    const surfaces = createSurfaces(contour, 2700, 'material-primary', { groutMm: 2, reservePercent: 10, criticalCutMm: 80 });
    expect(surfaces[0]).toMatchObject({ id: 'surface-floor', type: 'floor', widthMm: 1700, heightMm: 2000 });
    expect(surfaces[0].zones[0]).toMatchObject({ id: 'surface-floor-base-zone', materialId: 'material-primary' });
    expect(surfaces.slice(1).map((surface) => [surface.name, surface.widthMm, surface.heightMm])).toEqual([
      ['Стена 1', 1700, 2700],
      ['Стена 2', 2000, 2700],
      ['Стена 3', 1700, 2700],
      ['Стена 4', 2000, 2700],
    ]);
  });

  it('clamps room height to MVP limits', () => {
    expect(validateRoomHeight(1200)).toBe(1800);
    expect(validateRoomHeight(5000)).toBe(4500);
    expect(validateRoomHeight(2688)).toBe(2688);
  });

  it('updates one side length while keeping an orthogonal contour', () => {
    const contour = createContourFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSegmentLength(contour, 0, 2400);
    expect(updated[1]).toEqual({ x: 2400, y: 0 });
    expect(updated[2]).toEqual({ x: 2400, y: 2000 });
    expect(validateContour(updated).ok).toBe(true);
  });

  it('accepts exact millimeter side lengths without rounding to grid steps', () => {
    const contour = createContourFromTemplate(templates[0], [1700, 2000]);
    const updated = updateSegmentLength(contour, 0, 162);
    expect(updated[1]).toEqual({ x: 162, y: 0 });
    expect(updated[2]).toEqual({ x: 162, y: 2000 });
    expect(validateContour(updated).ok).toBe(true);
  });

  it('moves a wall on its axis and keeps the contour orthogonal', () => {
    const contour = createContourFromTemplate(templates[0], [1700, 2000]);
    const updated = moveWall(contour, 1, 300);
    expect(updated[1].x).toBe(2000);
    expect(updated[2].x).toBe(2000);
    expect(validateContour(updated).ok).toBe(true);
  });
});
