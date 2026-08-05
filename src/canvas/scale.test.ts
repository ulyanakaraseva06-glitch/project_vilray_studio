import { describe, expect, it } from 'vitest';
import { canvasToMm, gridPxForMm, MAJOR_GRID_PX, MM_PER_MAJOR_GRID, mmToCanvas } from './scale';

describe('canvas scale', () => {
  it('maps one major grid cell to 1000 mm', () => {
    expect(MM_PER_MAJOR_GRID).toBe(1000);
    expect(gridPxForMm(1000)).toBe(MAJOR_GRID_PX);
  });

  it('converts millimeters and canvas units consistently', () => {
    expect(mmToCanvas(2000)).toBe(160);
    expect(canvasToMm(160)).toBe(2000);
  });
});
