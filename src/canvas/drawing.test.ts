import { describe, expect, it } from 'vitest';
import { buildClosedContour, buildClosedOrthogonalContour, canCloseContour, constrainFreePoint, constrainOrthogonalPoint, constrainOrthogonalResizePoint, isExplicitlyClosedContour, snapMm, validateDraftPoint } from './drawing';

describe('custom room drawing', () => {
  it('keeps millimeter precision while drawing', () => {
    expect(snapMm(124.4)).toBe(124);
    expect(snapMm(126.6)).toBe(127);
    expect(snapMm(620)).toBe(620);
  });

  it('keeps diagonal points while snapping them to the grid', () => {
    expect(constrainFreePoint({ x: 900.4, y: 300.7 })).toEqual({ x: 900, y: 301 });
  });

  it('keeps straight angles in the default drawing mode', () => {
    expect(constrainOrthogonalPoint([{ x: 0, y: 0 }], { x: 900, y: 300 })).toEqual({ x: 900, y: 0 });
    expect(buildClosedOrthogonalContour([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 750 }])).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 750 },
      { x: 0, y: 750 },
    ]);
  });

  it('gently snaps a segment to a whole centimeter', () => {
    expect(constrainOrthogonalPoint([{ x: 0, y: 0 }], { x: 1003, y: 200 })).toEqual({ x: 1000, y: 0 });
    expect(constrainFreePoint({ x: 1003, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: 1000, y: 0 });
    expect(constrainFreePoint({ x: 1005, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: 1005, y: 0 });
  });

  it('snaps back to the first point before applying an orthogonal constraint', () => {
    const points = [{ x: 100, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 1100 }];
    expect(constrainOrthogonalPoint(points, { x: 170, y: 140 })).toEqual({ x: 100, y: 100 });
    expect(constrainFreePoint({ x: 170, y: 140 }, points)).toEqual({ x: 100, y: 100 });
  });

  it('holds an orthogonal wall opposite the first point', () => {
    const points = [{ x: 100, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 900 }];
    expect(constrainOrthogonalPoint(points, { x: 180, y: 920 })).toEqual({ x: 100, y: 900 });
  });

  it('keeps an ordinary wall on its original orthogonal axis while resizing', () => {
    expect(constrainOrthogonalResizePoint({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1403, y: 700 })).toEqual({ x: 1403, y: 0 });
    expect(constrainOrthogonalResizePoint({ x: 0, y: 0 }, { x: 0, y: 1000 }, { x: 700, y: 403 })).toEqual({ x: 0, y: 403 });
    expect(constrainOrthogonalResizePoint({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: -403, y: 700 })).toEqual({ x: -403, y: 0 });
  });

  it('requires at least three points before closing', () => {
    expect(canCloseContour([{ x: 0, y: 0 }, { x: 1000, y: 0 }])).toBe(false);
    expect(canCloseContour([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 1000 }])).toBe(true);
  });

  it('marks the contour ready only after the last point matches the first', () => {
    const open = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }];
    expect(isExplicitlyClosedContour(open)).toBe(false);
    expect(isExplicitlyClosedContour([...open, { x: 0, y: 0 }])).toBe(true);
  });

  it('closes and normalizes a diagonal contour without adding a point', () => {
    const contour = buildClosedContour([
      { x: 250, y: 250 },
      { x: 1250, y: 250 },
      { x: 1000, y: 1000 },
      { x: 500, y: 1250 },
    ]);

    expect(contour).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 750, y: 750 },
      { x: 250, y: 1000 },
    ]);
  });

  it('rejects a new segment that crosses an existing wall', () => {
    const points = [{ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }];
    expect(validateDraftPoint(points, { x: 1000, y: 0 })).toBe('Линии помещения не могут пересекаться.');
  });

  it('allows the last point to match the first point and closes the contour', () => {
    const points = [{ x: 100, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 1100 }];
    expect(validateDraftPoint(points, { x: 100, y: 100 })).toBeNull();
    expect(buildClosedContour([...points, { x: 100, y: 100 }])).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
    ]);
  });
});
