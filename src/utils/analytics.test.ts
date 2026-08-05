import { describe, expect, it } from 'vitest';
import { sanitizeAnalyticsPayload } from './analytics';

describe('analytics payload sanitizer', () => {
  it('keeps only allowed public parameters', () => {
    expect(
      sanitizeAnalyticsPayload({
        templateId: 'rectangle',
        surfaceType: 'floor',
        roomDimensions: '2000x3000',
        email: 'client@example.com',
        unknown: 'value',
      }),
    ).toEqual({
      templateId: 'rectangle',
      surfaceType: 'floor',
    });
  });
});
