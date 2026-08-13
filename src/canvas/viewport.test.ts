import { describe, expect, it } from 'vitest';
import { clampZoom, panViewport, resetViewport } from './viewport';

describe('canvas viewport', () => {
  it('clamps zoom to supported limits', () => {
    expect(clampZoom(0.1)).toBe(0.35);
    expect(clampZoom(3)).toBe(2.2);
    expect(clampZoom(1.234)).toBe(1.23);
  });

  it('pans viewport by rounded deltas', () => {
    expect(panViewport({ x: 10, y: 20, zoom: 1 }, 4.4, -6.7)).toEqual({ x: 14, y: 13, zoom: 1 });
  });

  it('resets viewport to fit state', () => {
    expect(resetViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
