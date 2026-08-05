import { describe, expect, it } from 'vitest';
import { getDefaultTemplate, getVisibleTilePresets, serviceConfig, templates } from './appConfig';

describe('app config', () => {
  it('loads the service identity from JSON config', () => {
    expect(serviceConfig.service.id).toBe('poschitay-plitku');
    expect(serviceConfig.service.appPath).toBe('/app/');
  });

  it('has room templates with at least one selectable size', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(getDefaultTemplate().sizes[0]).toEqual([1500, 1700]);
  });

  it('exposes visible tile presets without the custom placeholder', () => {
    expect(getVisibleTilePresets().every((preset) => preset.id !== 'custom')).toBe(true);
  });

  it('orders visible tile presets for the first screen', () => {
    expect(getVisibleTilePresets().map((preset) => preset.id)).toEqual([
      '600x1200',
      '600x600',
      '200x1200',
      '300x600',
      '200x600',
    ]);
  });
});
