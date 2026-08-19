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

    const halfMillimetre = generateRectLayout({
      heightMm: 600,
      layout: { ...layout, groutMm: 0.5 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1201,
    });
    expect(halfMillimetre.pieces.map((piece) => piece.xMm)).toEqual([0, 600.5]);
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

  it('supports brick, third, quarter, deck, diagonal and herringbone layout patterns', () => {
    const brick = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, pattern: 'brick' },
      tileHeightMm: 1200,
      tileWidthMm: 600,
      widthMm: 2400,
    });
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
    const straightWithThirdStagger = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, pattern: 'straight', stagger: 'third' },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1200,
    });
    const deck = generateRectLayout({
      heightMm: 2400,
      layout: { ...layout, groutMm: 0, pattern: 'wood-random' },
      tileHeightMm: 1200,
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
    const herringbone = generateRectLayout({
      heightMm: 1800,
      layout: { ...layout, groutMm: 0, pattern: 'herringbone' },
      tileHeightMm: 200,
      tileWidthMm: 600,
      widthMm: 1800,
    });

    expect(brick.pieces.some((piece) => piece.row === 0 && piece.widthMm === 1200 && piece.heightMm === 600)).toBe(true);
    expect(brick.pieces.some((piece) => piece.row === 1 && piece.widthMm === 600 && piece.heightMm === 600)).toBe(true);
    expect(third.pieces.some((piece) => piece.row === 1 && piece.widthMm === 200)).toBe(true);
    expect(quarter.pieces.some((piece) => piece.row === 1 && piece.widthMm === 150)).toBe(true);
    expect(straightWithThirdStagger.pieces.some((piece) => piece.row === 1 && piece.widthMm === 200)).toBe(true);
    expect(deck.pieces.some((piece) => piece.col === 0 && piece.widthMm === 600 && piece.heightMm === 1200)).toBe(true);
    expect(deck.pieces.some((piece) => piece.col === 1 && piece.yMm === 0 && piece.heightMm !== 1200)).toBe(true);
    expect(diagonal.pieces.some((piece) => piece.polygon?.some((point, index, points) => point.x !== points[(index + 1) % points.length].x && point.y !== points[(index + 1) % points.length].y))).toBe(true);
    expect(diagonal.cutCount + diagonal.criticalCount).toBeGreaterThan(0);
    expect(herringbone.pieces.some((piece) => piece.id.includes('-horizontal'))).toBe(true);
    expect(herringbone.pieces.some((piece) => piece.id.includes('-vertical'))).toBe(true);
    expect(herringbone.fullCount).toBeGreaterThan(0);
  });

  it('applies deck stagger=half as stepY/2 between neighboring columns', () => {
    const tileHeightMm = 1200;
    const tileWidthMm = 600;
    const stepY = tileHeightMm;
    const deckHalf = generateRectLayout({
      heightMm: 2400,
      layout: { ...layout, groutMm: 0, pattern: 'wood-random', stagger: 'half' },
      tileHeightMm,
      tileWidthMm,
      widthMm: 1200,
    });

    const col0Full = deckHalf.pieces
      .filter((p) => p.col === 0 && p.heightMm === tileHeightMm)
      .sort((a, b) => a.yMm - b.yMm)[0];
    const col1Full = deckHalf.pieces
      .filter((p) => p.col === 1 && p.heightMm === tileHeightMm)
      .sort((a, b) => a.yMm - b.yMm)[0];

    expect(col0Full?.yMm).toBe(0);
    expect(col1Full?.yMm).toBe(stepY / 2);
  });

  it('applies herringbone stagger using normalized row phase', () => {
    const base = generateRectLayout({
      heightMm: 1500,
      layout: { ...layout, groutMm: 2, pattern: 'herringbone', stagger: 'none' },
      tileHeightMm: 600,
      tileWidthMm: 200,
      widthMm: 1500,
    });
    const third = generateRectLayout({
      heightMm: 1500,
      layout: { ...layout, groutMm: 2, pattern: 'herringbone', stagger: 'third' },
      tileHeightMm: 600,
      tileWidthMm: 200,
      widthMm: 1500,
    });

    const baseSignature = base.pieces.slice(0, 25).map((piece) => `${Math.round(piece.xMm)}:${Math.round(piece.yMm)}`).join('|');
    const thirdSignature = third.pieces.slice(0, 25).map((piece) => `${Math.round(piece.xMm)}:${Math.round(piece.yMm)}`).join('|');
    expect(thirdSignature).not.toBe(baseSignature);
  });

  it('keeps herringbone stagger deterministic for all offset modes', () => {
    const run = (stagger: LayoutSettings['stagger']) => generateRectLayout({
      heightMm: 1500,
      layout: { ...layout, groutMm: 2, pattern: 'herringbone', stagger },
      tileHeightMm: 600,
      tileWidthMm: 200,
      widthMm: 1500,
    });

    const noneA = run('none');
    const noneB = run('none');
    const half = run('half');
    const third = run('third');
    const quarter = run('quarter');

    const signature = (result: ReturnType<typeof generateRectLayout>) =>
      result.pieces.slice(0, 40).map((piece) => `${Math.round(piece.xMm)}:${Math.round(piece.yMm)}`).join('|');

    expect(signature(noneA)).toBe(signature(noneB));
    expect(signature(half)).not.toBe(signature(noneA));
    expect(signature(third)).not.toBe(signature(noneA));
    expect(signature(quarter)).not.toBe(signature(noneA));
  });

  it('keeps herringbone area coverage stable across stagger modes', () => {
    const make = (stagger: LayoutSettings['stagger']) => generateRectLayout({
      heightMm: 3200,
      layout: { ...layout, groutMm: 2, pattern: 'herringbone', stagger },
      tileHeightMm: 600,
      tileWidthMm: 200,
      widthMm: 3200,
    });
    const none = make('none');
    const half = make('half');
    const third = make('third');
    const quarter = make('quarter');

    const area = (result: ReturnType<typeof generateRectLayout>) =>
      result.pieces.reduce((sum, piece) => sum + (piece.areaMm2 ?? piece.widthMm * piece.heightMm), 0);

    const baseArea = area(none);
    const withinFivePercent = (value: number) => Math.abs(value - baseArea) / baseArea < 0.05;

    expect(withinFivePercent(area(half))).toBe(true);
    expect(withinFivePercent(area(third))).toBe(true);
    expect(withinFivePercent(area(quarter))).toBe(true);
  });

  it('returns non-zero edge offsets for herringbone cuts', () => {
    const result = generateRectLayout({
      heightMm: 1500,
      layout: { ...layout, groutMm: 2, pattern: 'herringbone', stagger: 'half' },
      tileHeightMm: 600,
      tileWidthMm: 200,
      widthMm: 1500,
    });
    expect(result.edgeOffsets.top).not.toBeNull();
    expect(result.edgeOffsets.right).not.toBeNull();
    expect(result.edgeOffsets.bottom).not.toBeNull();
    expect(result.edgeOffsets.left).not.toBeNull();
  });

  it('rotates the layout around the surface center and clips tiles to the surface', () => {
    const turned = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, turnDeg: 25 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1800,
    });
    const untilted = generateRectLayout({
      heightMm: 1200,
      layout: { ...layout, groutMm: 0, turnDeg: 0 },
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 1800,
    });

    expect(turned.pieces.length).toBeGreaterThan(0);
    expect(turned.pieces.some((piece) => (piece.polygon?.length ?? 0) >= 3)).toBe(true);
    expect(turned.pieces.every((piece) => {
      const polygon = piece.polygon ?? [
        { x: piece.xMm, y: piece.yMm },
        { x: piece.xMm + piece.widthMm, y: piece.yMm },
        { x: piece.xMm + piece.widthMm, y: piece.yMm + piece.heightMm },
        { x: piece.xMm, y: piece.yMm + piece.heightMm },
      ];
      return polygon.every((point) => point.x >= -0.6 && point.x <= 1800.6 && point.y >= -0.6 && point.y <= 1200.6);
    })).toBe(true);
    expect(untilted.pieces.every((piece) => !piece.polygon?.length)).toBe(true);
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

  it('reuses an unchanged layout result from the bounded cache', () => {
    const input = {
      heightMm: 2700,
      layout,
      tileHeightMm: 600,
      tileWidthMm: 600,
      widthMm: 2000,
    };

    expect(generateRectLayout(input)).toBe(generateRectLayout({ ...input, layout: { ...layout } }));
  });
});
