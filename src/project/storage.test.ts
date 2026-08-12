import { describe, expect, it } from 'vitest';
import { templates } from '../config/appConfig';
import { createProjectFromTemplate } from './projectFactory';
import { clearProject, loadProject, parseProjectFile, saveProject, serializeProjectFile } from './storage';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('project storage', () => {
  it('saves, loads and clears schema version 1 project', () => {
    const storage = new MemoryStorage();
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    saveProject(project, storage);
    expect(loadProject(storage)?.id).toBe(project.id);
    clearProject(storage);
    expect(loadProject(storage)).toBeNull();
  });

  it('round-trips a project through the .vilray file format', () => {
    const project = createProjectFromTemplate(templates[0], [1700, 2000]);
    const restored = parseProjectFile(serializeProjectFile(project));

    expect(restored).toEqual(project);
    expect(parseProjectFile('{"format":"other"}')).toBeNull();
  });
});
