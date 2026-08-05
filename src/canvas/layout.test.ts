import { describe, expect, it } from 'vitest';
import { calculateWallsStartY, FLOOR_TO_WALLS_GAP_PX, WALLS_BASE_Y } from './layout';

describe('canvas layout', () => {
  it('keeps walls at the base position for compact rooms', () => {
    expect(calculateWallsStartY(260)).toBe(WALLS_BASE_Y);
  });

  it('pushes wall frames below a resized floor plan', () => {
    const floorBottomY = 560;
    expect(calculateWallsStartY(floorBottomY)).toBe(floorBottomY + FLOOR_TO_WALLS_GAP_PX);
  });
});
