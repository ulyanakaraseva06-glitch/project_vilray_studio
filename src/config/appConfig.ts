import projectConfig from '../../configs/project-config.example.json';
import roomTemplates from '../../configs/room-templates.json';
import tileSizes from '../../configs/tile-sizes.json';
import type { RoomTemplate, ServiceConfig, TileSizePreset } from '../types/project';

export const serviceConfig = projectConfig as ServiceConfig;
export const templates = roomTemplates as RoomTemplate[];
export const tileSizePresets = tileSizes as TileSizePreset[];

export function getDefaultTemplate(): RoomTemplate {
  return templates[0];
}

export function getVisibleTilePresets(): TileSizePreset[] {
  const priority = ['600x1200', '600x600', '200x1200', '300x600', '200x600'];
  return priority
    .map((id) => tileSizePresets.find((preset) => preset.id === id))
    .filter((preset): preset is TileSizePreset => Boolean(preset));
}
