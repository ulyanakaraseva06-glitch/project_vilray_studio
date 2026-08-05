import { describe, expect, it } from 'vitest';
import { buildClosedOrthogonalContour, canCloseContour, constrainOrthogonalPoint, snapMm } from './drawing';

describe('custom room drawing', () => {
  it('snaps millimeters to the drawing grid', () => {
    expect(snapMm(124)).toBe(0);
    expect(snapMm(126)).toBe(250);
    expect(snapMm(620)).toBe(500);
  });

  it('constrains new points to orthogonal segments', () => {
    expect(constrainOrthogonalPoint([{ x: 0, y: 0 }], { x: 900, y: 300 })).toEqual({ x: 1000, y: 0 });
    expect(constrainOrthogonalPoint([{ x: 0, y: 0 }], { x: 300, y: 900 })).toEqual({ x: 0, y: 1000 });
  });

  it('requires at least four points before closing', () => {
    expect(canCloseContour([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }])).toBe(false);
    expect(canCloseContour([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }])).toBe(true);
  });

  it('adds one orthogonal closing point when needed', () => {
    const contour = buildClosedOrthogonalContour([
      { x: 250, y: 250 },
      { x: 1250, y: 250 },
      { x: 1250, y: 1000 },
      { x: 500, y: 1000 },
    ]);

    expect(contour).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 750 },
      { x: 250, y: 750 },
      { x: 0, y: 750 },
    ]);
  });
});
