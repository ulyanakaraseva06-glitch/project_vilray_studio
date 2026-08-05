import { describe, expect, it } from 'vitest';
import { formatRoomSize, mmToMetersLabel } from './units';

describe('unit formatters', () => {
  it('formats millimeters for Russian UI labels', () => {
    expect(mmToMetersLabel(1700)).toBe('1,7 м');
    expect(formatRoomSize(1700, 2000)).toBe('1,7 м × 2 м');
  });
});
