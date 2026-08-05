export const WALLS_BASE_Y = 410;
export const FLOOR_TO_WALLS_GAP_PX = 72;

export function calculateWallsStartY(floorBottomY: number, baseY = WALLS_BASE_Y, gapPx = FLOOR_TO_WALLS_GAP_PX): number {
  return Math.max(baseY, Math.ceil(floorBottomY + gapPx));
}
