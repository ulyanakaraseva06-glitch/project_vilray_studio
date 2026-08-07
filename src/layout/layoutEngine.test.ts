import { describe, expect, it } from 'vitest';
import type { LayoutSettings } from '../types/project';
import { generatePolygonLayout, generateRectLayout } from './layoutEngine';

const layout: LayoutSettings = {
  criticalCutMm: 80,
  groutMm: 2,
  originMode: 'corner-tl',
  originXmm: 0,
  originYmm: 0,
  pattern: 'straight',
  rotation: 0,
};

describe('layout engine', () => {
  it('generates full and cut pieces for a rectangular wall', () => {
    const result = generateRectLayout({
      heightMm: 2700,
      layout,
      tileHeightMm: 1200,
      tileWidthMm: 600,
      widthMm: 2000,
    });

    expect(result.truncated).toBe(false);
    expect(result.fullCount).toBeGreaterThan(0);
    expect(result.cutCount + result.criticalCount).toBeGreaterThan(0);
    expect(result.pieces.some((piece) => piece.widthMm < 600 || piece.heightMm < 1200)).toBe(true);
  });

  it('clips a tile that is larger than the surface', () => {
    const result = generateRectLayout({
      heightMm: 162,
      layout,
      tileHeightMm: 1200,
      tileWidthMm: 600,
      widthMm: 162,
    });

    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]).toMatchObject({ heightMm: 162, kind: 'cut', widthMm: 162 });
  });

  it('marks narrow pieces as critical cuts', () => {
    const result = generateRectLayout({
      heightMm: 600,
      layout,
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 650,
    });

    expect(result.criticalCount).toBe(1);
    expect(result.pieces.find((piece) => piece.kind === 'critical')).toMatchObject({ widthMm: 48 });
  });

  it('uses grout as spacing between tiles', () => {
    const result = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 10 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1210,
    });

    expect(result.pieces.map((piece) => piece.xMm)).toEqual([0, 610]);
  });

  it('swaps tile sides when rotation is 90 degrees', () => {
    const result = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, rotation: 90 },
      tileHeightMm: 1200,
      tileWidthMm: 600,
      widthMm: 1200,
    });

    expect(result.pieces[0]).toMatchObject({ heightMm: 600, widthMm: 1200 });
  });

  it('clips layout by an orthogonal floor polygon', () => {
    const result = generatePolygonLayout({
      layout: { ...layout, groutMm: 0 },
      points: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 500 },
        { x: 500, y: 500 },
        { x: 500, y: 1000 },
        { x: 0, y: 1000 },
      ],
      tileHeightMm: 500,
      tileWidthMm: 500,
    });

    expect(result.pieces).toHaveLength(3);
    expect(result.pieces.every((piece) => piece.polygon && piece.polygon.length >= 4)).toBe(true);
  });

  it('clips every tile vertex by a diagonal floor edge', () => {
    const result = generatePolygonLayout({
      layout: { ...layout, groutMm: 0 },
      points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }],
      tileHeightMm: 500,
      tileWidthMm: 500,
    });

    expect(result.pieces.length).toBeGreaterThan(0);
    expect(result.pieces.every((piece) => piece.polygon?.every((point) => point.x >= -0.5 && point.y >= -0.5 && point.x + point.y <= 1000.5))).toBe(true);
  });

  it('calculates edge cuts and minimum cut size', () => {
    const result = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 650,
    });

    expect(result.edgeCuts.right).toBe(50);
    expect(result.minCutMm).toBe(50);
  });

  it('supports tile-center and joint-center origins', () => {
    const centeredTile = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0, originMode: 'tile-center' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const centeredJoint = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, originMode: 'joint-center' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });

    expect(centeredTile.edgeCuts.left).toBe(300);
    expect(centeredTile.edgeCuts.right).toBe(300);
    expect(centeredJoint.minCutMm).toBeNull();
  });

  it('supports right and bottom corner origins', () => {
    const topRight = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0, originMode: 'corner-tr' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 650,
    });
    const bottomLeft = generateRectLayout({
      heightMm: 650,
      layout: { ...layout, groutMm: 0, originMode: 'corner-bl' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 600,
    });

    expect(topRight.edgeCuts.left).toBe(50);
    expect(topRight.edgeCuts.right).toBeNull();
    expect(bottomLeft.edgeCuts.top).toBe(50);
    expect(bottomLeft.edgeCuts.bottom).toBeNull();
  });

  it('supports edge-centered origin directions', () => {
    const top = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0, originMode: 'corner-t' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const left = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, originMode: 'corner-l' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 600,
    });

    expect(top.edgeCuts.left).toBe(300);
    expect(top.edgeCuts.right).toBe(300);
    expect(left.edgeCuts.top).toBe(300);
    expect(left.edgeCuts.bottom).toBe(300);
  });

  it('uses manual origin offsets', () => {
    const result = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0, originMode: 'manual', originXmm: 20, originYmm: 0 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 650,
    });

    expect(result.edgeCuts.left).toBe(20);
    expect(result.edgeCuts.right).toBe(30);
  });

  it('reports zero edge offsets when a full tile starts at the edge', () => {
    const result = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });

    expect(result.edgeOffsets.left).toBe(0);
    expect(result.edgeOffsets.right).toBe(0);
  });

  it('supports third, quarter, wood and diagonal layout patterns', () => {
    const third = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, pattern: 'third-offset' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const quarter = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, pattern: 'quarter-offset' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const wood = generateRectLayout({
      heightMm: 1800,
      layout: { ...layout, groutMm: 0, pattern: 'wood-random' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const diagonal = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, pattern: 'diagonal' },
      tileHeightMm: 1200,
      tileWidthMm: 600,
      widthMm: 1200,
    });

    expect(third.pieces.some((piece) => piece.row === 1 && piece.widthMm === 200)).toBe(true);
    expect(quarter.pieces.some((piece) => piece.row === 1 && piece.widthMm === 150)).toBe(true);
    expect(wood.pieces.some((piece) => piece.row === 1 && piece.widthMm > 190 && piece.widthMm < 210)).toBe(true);
    expect(diagonal.cutCount + diagonal.criticalCount).toBeGreaterThan(0);
  });

  it('clips pieces around blocked rectangles such as doors', () => {
    const result = generateRectLayout({
      blockedRects: [{ type: 'rect', xMm: 600, yMm: 600, widthMm: 800, heightMm: 2100 }],
      heightMm: 2700,
      layout: { ...layout, groutMm: 0 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 2000,
    });
    const area = result.pieces.reduce((total, piece) => total + piece.widthMm * piece.heightMm, 0);

    expect(area).toBeLessThan(2000 * 2700);
    expect(result.pieces.every((piece) => !(piece.xMm > 600 && piece.xMm < 1400 && piece.yMm > 600 && piece.yMm < 2700))).toBe(true);
  });
});
