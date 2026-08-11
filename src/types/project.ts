export interface PointMm {
  x: number;
  y: number;
}

export type SurfaceType = 'floor' | 'wall' | 'box-front' | 'box-side' | 'custom';
export type SurfaceStatus = 'empty' | 'ready' | 'warning';

export interface RoomTemplate {
  id: string;
  name: string;
  sizes: [number, number][];
  heightMm: number;
}

export interface TileSizePreset {
  id: string;
  widthMm?: number;
  heightMm?: number;
  label: string;
}

export type ZoneShape = RectZone | PolygonZone;

export interface RectZone {
  type: 'rect';
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PolygonZone {
  type: 'polygon';
  points: PointMm[];
}

export type LayoutPattern = 'straight' | 'half-offset' | 'third-offset' | 'quarter-offset' | 'wood-random' | 'diagonal';

export interface LayoutSettings {
  pattern: LayoutPattern;
  rotation: 0 | 90;
  angleDeg?: 0 | 45;
  groutMm: number;
  originXmm: number;
  originYmm: number;
  originMode:
    | 'auto-best'
    | 'tile-center'
    | 'joint-center'
    | 'corner-tl'
    | 'corner-t'
    | 'corner-tr'
    | 'corner-l'
    | 'corner-r'
    | 'corner-bl'
    | 'corner-b'
    | 'corner-br'
    | 'manual';
  criticalCutMm: number;
}

export interface ManualTileEdit {
  tileKey: string;
  offsetXmm: number;
  offsetYmm: number;
  rotationDelta: 0 | 90;
  hidden: boolean;
  note?: string;
}

export interface FinishZone {
  id: string;
  name: string;
  shape: ZoneShape;
  materialId: string | null;
  layout: LayoutSettings;
  manualEdits: ManualTileEdit[];
}

export interface TileMaterial {
  id: string;
  name: string;
  swatch: {
    type: 'color' | 'pattern';
    value: string;
  };
  widthMm: number;
  heightMm: number;
  reservePercent: number;
  presetId?: string;
  label?: string;
  piecesPerBox?: number;
  boxAreaM2?: number;
}

export interface RoomArea {
  id: string;
  name: string;
  contour: PointMm[];
  heightMm?: number;
  shapeLocked?: boolean;
}

export interface Opening {
  connectedOpeningId?: string;
  id: string;
  initialXmm?: number;
  initialYmm?: number;
  kind: 'door' | 'passage' | 'window';
  name: string;
  number?: number;
  surfaceId: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface Partition {
  areaId?: string;
  id: string;
  initialEnd?: PointMm;
  initialStart?: PointMm;
  name: string;
  start: PointMm;
  end: PointMm;
  thicknessMm: number;
  heightMm: number;
}

export interface RoomObject {
  areaId: string;
  excludeTile: boolean;
  heightMm: number;
  id: string;
  initialElevationMm: number;
  initialXmm: number;
  initialYmm: number;
  lengthMm: number;
  name: string;
  elevationMm: number;
  widthMm: number;
  xMm: number;
  yMm: number;
}

export interface Room {
  templateId: string | null;
  heightMm: number;
  contour: PointMm[];
  areas?: RoomArea[];
  openings?: Opening[];
  partitions?: Partition[];
}

export interface SurfaceViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Surface {
  id: string;
  type: SurfaceType;
  name: string;
  widthMm: number;
  heightMm: number;
  sourceRef: string | null;
  openings: Opening[];
  zones: FinishZone[];
  viewport: SurfaceViewport;
  status: SurfaceStatus;
}

export interface ProjectSettings {
  groutMm: number;
  reservePercent: number;
  criticalCutMm: number;
}

export interface TileProject {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  room: Room;
  surfaces: Surface[];
  objects: RoomObject[];
  materials: TileMaterial[];
  settings: ProjectSettings;
}

export interface UiState {
  selectedSurfaceId: string;
  selectedTemplateId: string;
  saveStatus: 'saved' | 'saving';
}

export interface ServiceConfig {
  service: {
    id: string;
    name: string;
    subtitle: string;
    baseUrl: string;
    appPath: string;
    language: string;
    brandOwner: string;
  };
  defaults: {
    roomHeightMm: number;
    groutMm: number;
    reservePercent: number;
    criticalCutMm: number;
    pattern: string;
  };
  analytics: {
    yandexMetrikaId: string;
    enabled: boolean;
  };
  features: Record<string, boolean>;
  links: Record<string, string>;
}
