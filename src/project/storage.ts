import type { TileProject } from '../types/project';

const STORAGE_KEY = 'poschitay-plitku.project.v1';

export function saveProject(project: TileProject, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(project));
}

export function loadProject(storage: Storage = localStorage): TileProject | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as TileProject;
    if (parsed.schemaVersion !== 1 || !parsed.room || !Array.isArray(parsed.surfaces)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearProject(storage: Storage = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}
