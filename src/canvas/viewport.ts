export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.65;
export const MAX_ZOOM = 2.2;

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(zoom.toFixed(2))));
}

export function panViewport(viewport: CanvasViewport, dx: number, dy: number): CanvasViewport {
  return {
    ...viewport,
    x: Math.round(viewport.x + dx),
    y: Math.round(viewport.y + dy),
  };
}

export function resetViewport(): CanvasViewport {
  return { x: 0, y: 0, zoom: 1 };
}
