export const MM_PER_MAJOR_GRID = 1000;
export const MAJOR_GRID_PX = 80;
export const MINOR_GRID_MM = 250;

export const PX_PER_MM = MAJOR_GRID_PX / MM_PER_MAJOR_GRID;

export function mmToCanvas(mm: number): number {
  return mm * PX_PER_MM;
}

export function canvasToMm(px: number): number {
  return px / PX_PER_MM;
}

export function gridPxForMm(mm: number): number {
  return mmToCanvas(mm);
}
