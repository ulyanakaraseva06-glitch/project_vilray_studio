import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calculator,
  Grid3X3,
  HelpCircle,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import { getVisibleTilePresets, templates } from '../config/appConfig';
import {
  addRoomFromContour,
  addRoomFromTemplate,
  addFloorZone,
  addOpeningDetailed,
  addPartition,
  addRoomObject,
  addWallZone,
  createProjectFromTemplate,
  connectRoomOpenings,
  constrainRoomObjectPosition,
  deleteOpening,
  deletePartition,
  deleteRoomObject,
  deleteZone,
  ensureProjectDefaults,
  getInitialProject,
  getOpeningConnectionCandidates,
  getRoomObjectWallProjection,
  getSurfaceMaterial,
  getZoneMaterial,
  moveRoomAreaChecked,
  moveRoomAreaWall,
  moveOpening,
  movePartition,
  moveRoomObject,
  moveRoomObjectOnWall,
  resizeOpening,
  resetOpening,
  resetPartition,
  renameRoomArea,
  updateRoomObject,
  updatePrimaryCustomTileMaterial,
  updatePrimaryTileMaterial,
  updateRoomContour,
  updateRoomAreaHeight,
  updateRoomAreaSegmentLength,
  updateSurfaceCustomTileMaterial,
  updateSurfaceLayoutOffset,
  updateSurfaceLayoutOrigin,
  updateSurfaceTileMaterial,
  updateZoneCustomTileMaterial,
  updateZoneLayoutOffset,
  updateZoneLayoutOrigin,
  updateZoneLayoutPattern,
  updateZoneShape,
  updateZoneTileMaterial,
  type ZonePresetKind,
  type OpeningConnectionCandidate,
} from '../project/projectFactory';
import { generatePolygonLayout, generateRectLayout, type LayoutEdgeCuts } from '../layout/layoutEngine';
import { calculateProject } from '../calculation/calculateProject';
import { clearProject, loadProject, saveProject } from '../project/storage';
import { getBoundingBox, moveWall, segmentLength, validateContour } from '../project/geometry';
import {
  buildClosedContour,
  buildClosedOrthogonalContour,
  canCloseContour,
  constrainFreePoint,
  constrainOrthogonalPoint,
  constrainOrthogonalResizePoint,
  CUSTOM_DRAW_MAX_POINTS,
  validateDraftPoint,
} from '../canvas/drawing';
import { calculateWallsStartY } from '../canvas/layout';
import { canvasToMm, gridPxForMm, MINOR_GRID_MM, MM_PER_MAJOR_GRID, mmToCanvas, PX_PER_MM } from '../canvas/scale';
import { clampZoom, panViewport, resetViewport, type CanvasViewport } from '../canvas/viewport';
import type { FinishZone, LayoutPattern, Opening, Partition, PointMm, RoomObject, RoomTemplate, TileMaterial, TileProject, TileSizePreset } from '../types/project';

type EditTarget =
  | { type: 'floor-segment'; areaId: string; index: number }
  | { type: 'wall-segment'; areaId: string; index: number; surfaceId: string }
  | { type: 'wall-height'; areaId: string }
  | { type: 'layout-offset'; edge: keyof LayoutEdgeCuts; surfaceId: string; zoneId: string }
  | null;

type CanvasLayers = {
  grid: boolean;
  floor: boolean;
  walls: boolean;
  dimensions: boolean;
};

type DrawingMode = 'idle' | 'custom-room' | 'custom-room-review';
type CustomDrawingMode = 'orthogonal' | 'free';
type PanelTab = 'tile' | 'room' | 'objects' | 'zones';
type TilePanelSection = 'format' | 'laying' | 'origin' | 'movement';
type CustomDrawingTarget = 'primary' | 'additional';

type ConfirmAction = { type: 'reset' } | { type: 'template'; templateId: string } | null;

type InlineEdit = {
  left: number;
  max: number;
  min: number;
  target: Exclude<EditTarget, null>;
  top: number;
  value: number;
};

const tilePresets = getVisibleTilePresets();
const initialCanvasSize = { width: 1120, height: 760 };
const PLAN_OFFSET_X = 170;
const PLAN_OFFSET_Y = 118;

function loadInitialAppState() {
  const savedProject = loadProject();
  return {
    hasRoomEdits: Boolean(savedProject),
    templatePickerOpen: !savedProject,
    project: savedProject ? ensureProjectDefaults(savedProject) : getInitialProject(),
  };
}

export function App() {
  const [initialAppState] = useState(loadInitialAppState);
  const [project, setProject] = useState<TileProject>(initialAppState.project);
  const [selectedTemplateId, setSelectedTemplateId] = useState(project.room.templateId ?? 'custom');
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedWallIndex, setSelectedWallIndex] = useState<number | null>(null);
  const [selectedOpeningId, setSelectedOpeningId] = useState<string | null>(null);
  const [selectedPartitionId, setSelectedPartitionId] = useState<string | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('tile');
  const [layoutDragEnabled, setLayoutDragEnabled] = useState(false);
  const [calculationOpen, setCalculationOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [layers, setLayers] = useState<CanvasLayers>({ grid: true, floor: true, walls: true, dimensions: true });
  const [viewport, setViewport] = useState<CanvasViewport>(resetViewport());
  const [hasRoomEdits, setHasRoomEdits] = useState(initialAppState.hasRoomEdits);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('idle');
  const [customDrawingTarget, setCustomDrawingTarget] = useState<CustomDrawingTarget>('primary');
  const [customDrawingMode, setCustomDrawingMode] = useState<CustomDrawingMode>('orthogonal');
  const [drawingToolArmed, setDrawingToolArmed] = useState(true);
  const [draftContour, setDraftContour] = useState<PointMm[]>([]);
  const [draftWallStart, setDraftWallStart] = useState<PointMm | null>(null);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const [customTileDialogOpen, setCustomTileDialogOpen] = useState(false);
  const [customTileError, setCustomTileError] = useState<string | null>(null);
  const [openTileSection, setOpenTileSection] = useState<TilePanelSection | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(initialAppState.templatePickerOpen);
  const [addRoomPickerOpen, setAddRoomPickerOpen] = useState(false);
  const [partitionDrawingActive, setPartitionDrawingActive] = useState(false);
  const [partitionDraftAreaId, setPartitionDraftAreaId] = useState<string | null>(null);
  const [partitionDraftStart, setPartitionDraftStart] = useState<PointMm | null>(null);
  const [connectionPrompt, setConnectionPrompt] = useState<{ candidates: OpeningConnectionCandidate[]; sourceOpeningId: string } | null>(null);
  const [roomActionMessage, setRoomActionMessage] = useState<string | null>(null);
  const [objectDialogError, setObjectDialogError] = useState<string | null>(null);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [renameRoomAreaId, setRenameRoomAreaId] = useState<string | null>(null);
  const contourStatus = validateContour(project.room.contour);
  const primaryMaterial = project.materials[0];
  const activeSurfaceId = selectedSurfaceId;
  const activeSurface = activeSurfaceId ? project.surfaces.find((surface) => surface.id === activeSurfaceId) : null;
  const activeZone = activeSurface?.zones.find((zone) => zone.id === selectedZoneId) ?? activeSurface?.zones[0] ?? null;
  const activeZoneId = activeZone?.id ?? null;
  const activeTileMaterial = activeSurfaceId && activeZoneId ? getZoneMaterial(project, activeSurfaceId, activeZoneId) : activeSurfaceId ? getSurfaceMaterial(project, activeSurfaceId) : primaryMaterial;
  const calculation = useMemo(() => calculateProject(project), [project]);

  useEffect(() => {
    if (templatePickerOpen) return;
    const timeoutId = window.setTimeout(() => {
      saveProject(project);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [project, templatePickerOpen]);

  useEffect(() => {
    if (!activeSurface || !selectedZoneId) return;
    if (!activeSurface.zones.some((zone) => zone.id === selectedZoneId)) setSelectedZoneId(null);
  }, [activeSurface, selectedZoneId]);

  useEffect(() => {
    if (selectedOpeningId && !project.room.openings?.some((opening) => opening.id === selectedOpeningId)) setSelectedOpeningId(null);
  }, [project.room.openings, selectedOpeningId]);

  useEffect(() => {
    if (selectedObjectId && !project.objects.some((object) => object.id === selectedObjectId)) setSelectedObjectId(null);
  }, [project.objects, selectedObjectId]);

  useEffect(() => {
    if (!roomActionMessage) return;
    const timeoutId = window.setTimeout(() => setRoomActionMessage(null), 5200);
    return () => window.clearTimeout(timeoutId);
  }, [roomActionMessage]);

  function applyTemplate(templateId: string) {
    if (templateId === selectedTemplateId) return;
    if (hasRoomEdits) {
      setConfirmAction({ type: 'template', templateId });
      return;
    }
    applyTemplateNow(templateId);
  }

  function applyTemplateNow(templateId: string) {
    if (templateId === 'custom') {
      setTemplatePickerOpen(false);
      beginCustomDrawing('primary');
      return;
    }
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setSelectedTemplateId(template.id);
    selectSurface('surface-floor');
    setEditTarget(null);
    setViewport(resetViewport());
    setHasRoomEdits(false);
    setTemplatePickerOpen(false);
    setActivePanelTab('tile');
    setProject((current) => createProjectFromTemplate(template, getPreferredTemplateSize(template), current));
  }

  function beginCustomDrawing(target: CustomDrawingTarget) {
    setCustomDrawingTarget(target);
    if (target === 'primary') setSelectedTemplateId('custom');
    selectSurface(null);
    setEditTarget(null);
    setViewport(resetViewport());
    setLayers({ grid: true, floor: true, walls: false, dimensions: true });
    setDraftContour([]);
    setDraftWallStart(null);
    setCustomDrawingMode('orthogonal');
    setDrawingToolArmed(true);
    setDrawingError(null);
    setDrawingMode('custom-room');
    setHasRoomEdits(false);
  }

  function addDraftPoint(point: PointMm) {
    if (!drawingToolArmed) return;
    if (draftContour.length >= CUSTOM_DRAW_MAX_POINTS) return;
    if (!draftWallStart) {
      const previousEnd = draftContour[draftContour.length - 1];
      if (previousEnd) {
        const workingPoints = draftContour;
        const nextPoint = customDrawingMode === 'orthogonal' ? constrainOrthogonalPoint(workingPoints, point) : constrainFreePoint(point, workingPoints);
        const error = validateDraftPoint(workingPoints, nextPoint);
        if (error) {
          setDrawingError(error);
          return;
        }
        setDraftContour((current) => [...current, nextPoint]);
        setDrawingError(null);
        setHasRoomEdits(true);
        return;
      }
      const snappedPoint = constrainFreePoint(point);
      setDraftWallStart(snappedPoint);
      setDrawingError(null);
      return;
    }
    const workingPoints = draftContour.length ? draftContour : [draftWallStart];
    const nextPoint = customDrawingMode === 'orthogonal' ? constrainOrthogonalPoint(workingPoints, point) : constrainFreePoint(point, workingPoints);
    const error = validateDraftPoint(workingPoints, nextPoint);
    if (error) {
      setDrawingError(error);
      return;
    }
    setDraftContour((current) => current.length ? [...current, nextPoint] : [draftWallStart, nextPoint]);
    setDraftWallStart(null);
    setDrawingError(null);
    setHasRoomEdits(true);
  }

  function changeCustomDrawingMode(mode: CustomDrawingMode) {
    if (drawingToolArmed && customDrawingMode === mode) {
      setDrawingToolArmed(false);
      setDraftWallStart(null);
      setDrawingError(null);
      return;
    }
    setCustomDrawingMode(mode);
    setDrawingToolArmed(true);
    setDrawingError(null);
  }

  function moveLastDraftPoint(point: PointMm) {
    if (draftWallStart || draftContour.length < 2) return null;
    const fixedPoints = draftContour.slice(0, -1);
    const wallStart = fixedPoints[fixedPoints.length - 1];
    const currentEnd = draftContour[draftContour.length - 1];
    const nextPoint = customDrawingMode === 'orthogonal'
      ? constrainOrthogonalResizePoint(wallStart, currentEnd, point)
      : constrainFreePoint(point);
    if (customDrawingMode === 'free' && (nextPoint.x === wallStart.x || nextPoint.y === wallStart.y)) {
      setDrawingError('Диагональная стена должна оставаться диагональной.');
      return null;
    }
    const error = validateDraftPoint(fixedPoints, nextPoint);
    if (error) {
      setDrawingError(error);
      return null;
    }
    setDraftContour((current) => [...current.slice(0, -1), nextPoint]);
    setDrawingError(null);
    return nextPoint;
  }

  function undoDraftPoint() {
    if (draftWallStart) {
      setDraftWallStart(null);
      setDrawingError(null);
      return;
    }
    setDraftContour((current) => current.slice(0, -1));
    setDrawingError(null);
  }

  function cancelCustomDrawing() {
    setDraftContour([]);
    setDraftWallStart(null);
    setDrawingToolArmed(true);
    setDrawingError(null);
    setDrawingMode('idle');
    setCustomDrawingTarget('primary');
    setSelectedTemplateId(project.room.templateId ?? 'custom');
  }

  function completeCustomDrawing() {
    const hasDiagonalWall = draftContour.some((point, index) => {
      const next = draftContour[index + 1];
      return next ? point.x !== next.x && point.y !== next.y : false;
    });
    const contour = hasDiagonalWall ? buildClosedContour(draftContour) : buildClosedOrthogonalContour(draftContour);
    if (!contour) {
      setDrawingError('Контур нельзя замкнуть: проверьте длину последней стены и пересечения.');
      return;
    }
    const validation = validateContour(contour);
    if (!validation.ok) {
      setDrawingError(validation.message ?? 'Контур нельзя завершить.');
      return;
    }
    setDraftContour(contour);
    setDraftWallStart(null);
    setDrawingToolArmed(true);
    setDrawingError(null);
    setDrawingMode('custom-room-review');
  }

  function moveDraftReviewPoint(index: number, point: PointMm) {
    const nextContour = draftContour.map((current, pointIndex) => pointIndex === index ? { x: Math.round(point.x), y: Math.round(point.y) } : current);
    const validation = validateContour(nextContour);
    if (!validation.ok) {
      setDrawingError('Точки нельзя переместить так, чтобы стены пересекались или контур стал некорректным.');
      return false;
    }
    setDraftContour(nextContour);
    setDrawingError(null);
    return true;
  }

  function moveDraftReviewWall(index: number, deltaXmm: number, deltaYmm: number) {
    setDraftContour((currentContour) => {
      const point = currentContour[index];
      const next = currentContour[(index + 1) % currentContour.length];
      if (!point || !next) return currentContour;
      const nextContour = moveWall(currentContour, index, point.y === next.y ? deltaYmm : deltaXmm);
      if (!validateContour(nextContour).ok || nextContour === currentContour) return currentContour;
      return nextContour;
    });
    setDrawingError(null);
    return true;
  }

  function saveCustomDrawing() {
    const validation = validateContour(draftContour);
    if (!validation.ok) {
      setDrawingError(validation.message ?? 'Контур нельзя сохранить.');
      return;
    }
    if (customDrawingTarget === 'additional') {
      const nextAreaId = `room-${(project.room.areas?.length ?? 1) + 1}`;
      setProject((current) => addRoomFromContour(current, draftContour, true));
      selectSurface(`surface-floor-${nextAreaId}`);
      setActivePanelTab('room');
    } else {
      setProject((current) => updateRoomContour({ ...current, room: { ...current.room, templateId: null } }, draftContour, true));
      setSelectedTemplateId('custom');
      selectSurface('surface-floor');
    }
    setDraftContour([]);
    setDraftWallStart(null);
    setDrawingError(null);
    setDrawingMode('idle');
    setCustomDrawingTarget('primary');
    setLayers({ grid: true, floor: true, walls: true, dimensions: true });
    setHasRoomEdits(true);
  }

  function changeHeight(areaId: string, value: string) {
    const nextHeight = Number(value);
    if (!Number.isFinite(nextHeight)) return;
    setHasRoomEdits(true);
    setProject((current) => updateRoomAreaHeight(current, areaId, nextHeight));
  }

  function changeSegmentLength(target: Extract<Exclude<EditTarget, null>, { type: 'floor-segment' | 'wall-segment' }>, value: string) {
    const length = Number(value);
    if (!Number.isFinite(length)) return;
    setHasRoomEdits(true);
    setProject((current) => updateRoomAreaSegmentLength(current, target.areaId, target.index, length));
    setEditTarget(null);
  }

  function selectTilePreset(tile: TileSizePreset) {
    setCustomTileDialogOpen(false);
    setCustomTileError(null);
    setHasRoomEdits(true);
    setProject((current) => (activeSurfaceId && activeZoneId ? updateZoneTileMaterial(current, activeSurfaceId, activeZoneId, tile) : activeSurfaceId ? updateSurfaceTileMaterial(current, activeSurfaceId, tile) : updatePrimaryTileMaterial(current, tile)));
    setOpenTileSection(null);
  }

  function submitCustomTile(widthCm: string, heightCm: string) {
    const widthCmNumber = Number(widthCm);
    const heightCmNumber = Number(heightCm);
    const widthMm = widthCmNumber * 10;
    const heightMm = heightCmNumber * 10;
    if (
      !Number.isInteger(widthCmNumber) ||
      !Number.isInteger(heightCmNumber) ||
      widthMm < 50 ||
      heightMm < 50 ||
      widthMm > 3200 ||
      heightMm > 3200
    ) {
      setCustomTileError('Введите ширину и высоту от 5 до 320 см.');
      return;
    }
    setHasRoomEdits(true);
    setProject((current) => (activeSurfaceId && activeZoneId ? updateZoneCustomTileMaterial(current, activeSurfaceId, activeZoneId, widthMm, heightMm) : activeSurfaceId ? updateSurfaceCustomTileMaterial(current, activeSurfaceId, widthMm, heightMm) : updatePrimaryCustomTileMaterial(current, widthMm, heightMm)));
    setCustomTileDialogOpen(false);
    setCustomTileError(null);
    setOpenTileSection(null);
  }

  function dragWall(areaId: string, index: number, deltaMm: number) {
    setHasRoomEdits(true);
    setProject((current) => moveRoomAreaWall(current, areaId, index, deltaMm));
  }

  function selectSurface(surfaceId: string | null) {
    setSelectedSurfaceId(surfaceId);
    setSelectedZoneId(null);
    setSelectedOpeningId(null);
    setSelectedPartitionId(null);
    setSelectedObjectId(null);
    const wallIndex = surfaceId ? project.surfaces.filter((surface) => surface.type === 'wall').findIndex((surface) => surface.id === surfaceId) : -1;
    setSelectedWallIndex(wallIndex >= 0 ? wallIndex : null);
  }

  function selectRoomObject(objectId: string | null) {
    setSelectedObjectId(objectId);
    setSelectedOpeningId(null);
    setSelectedPartitionId(null);
    setSelectedZoneId(null);
    setSelectedWallIndex(null);
    setSelectedSurfaceId(null);
  }

  function selectZone(surfaceId: string, zoneId: string | null) {
    setSelectedSurfaceId(surfaceId);
    setSelectedZoneId(zoneId);
    setSelectedOpeningId(null);
    setSelectedWallIndex(null);
  }

  function selectWall(index: number | null) {
    const walls = project.surfaces.filter((surface) => surface.type === 'wall');
    selectSurface(index === null ? null : walls[index]?.id ?? null);
  }

  function selectOpening(surfaceId: string, openingId: string) {
    selectSurface(surfaceId);
    setSelectedOpeningId(openingId);
  }

  function changeOriginMode(originMode: TileProject['surfaces'][number]['zones'][number]['layout']['originMode']) {
    if (!activeSurfaceId || !activeZoneId) return;
    setHasRoomEdits(true);
    setProject((current) => updateZoneLayoutOrigin(current, activeSurfaceId, activeZoneId, originMode));
  }

  function changeLayoutPattern(pattern: LayoutPattern) {
    if (!activeSurfaceId || !activeZoneId) return;
    setHasRoomEdits(true);
    setProject((current) => updateZoneLayoutPattern(current, activeSurfaceId, activeZoneId, pattern));
  }

  function shiftLayoutOrigin(deltaXmm: number, deltaYmm: number) {
    if (!activeSurfaceId || !activeZone) return;
    const layout = activeZone.layout;
    if (!layout) return;
    setHasRoomEdits(true);
    setProject((current) => updateZoneLayoutOffset(current, activeSurfaceId, activeZone.id, layout.originXmm + deltaXmm, layout.originYmm + deltaYmm));
  }

  function setLayoutOriginOffset(axis: 'x' | 'y', value: string) {
    if (!activeSurfaceId || !activeZone) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const layout = activeZone.layout;
    if (!layout) return;
    setHasRoomEdits(true);
    setProject((current) => updateZoneLayoutOffset(current, activeSurfaceId, activeZone.id, axis === 'x' ? parsed : layout.originXmm, axis === 'y' ? parsed : layout.originYmm));
  }

  function resetLayoutOffset() {
    if (!activeSurfaceId || !activeZoneId) return;
    setHasRoomEdits(true);
    setProject((current) => updateZoneLayoutOrigin(current, activeSurfaceId, activeZoneId, 'corner-tl'));
  }

  function setLayoutEdgeOffset(surfaceId: string, zoneId: string, edge: keyof LayoutEdgeCuts, value: number) {
    const surface = project.surfaces.find((item) => item.id === surfaceId);
    const zone = surface?.zones.find((item) => item.id === zoneId);
    const material = surface && zone ? getZoneMaterial(project, surface.id, zone.id) : null;
    if (!surface || !zone || !material) return;
    const result = getZoneLayoutResult(surface, zone, material);
    const current = result.edgeOffsets[edge] ?? 0;
    const delta = value - current;
    const layout = zone.layout;
    const nextX = edge === 'left' ? layout.originXmm + delta : edge === 'right' ? layout.originXmm - delta : layout.originXmm;
    const nextY = edge === 'top' ? layout.originYmm + delta : edge === 'bottom' ? layout.originYmm - delta : layout.originYmm;
    setHasRoomEdits(true);
    setProject((currentProject) => updateZoneLayoutOffset(currentProject, surfaceId, zoneId, nextX, nextY));
  }

  function addRoom() {
    setAddRoomPickerOpen(true);
  }

  function selectAdditionalRoomTemplate(templateId: string) {
    setAddRoomPickerOpen(false);
    if (templateId === 'custom') {
      beginCustomDrawing('additional');
      return;
    }
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    const nextAreaId = `room-${(project.room.areas?.length ?? 1) + 1}`;
    setHasRoomEdits(true);
    setProject((current) => addRoomFromTemplate(current, template, getPreferredTemplateSize(template)));
    selectSurface(`surface-floor-${nextAreaId}`);
    setActivePanelTab('room');
  }

  function moveAdditionalRoom(areaId: string, deltaXmm: number, deltaYmm: number) {
    setHasRoomEdits(true);
    setProject((current) => {
      const result = moveRoomAreaChecked(current, areaId, deltaXmm, deltaYmm);
      if (result.error) setRoomActionMessage(result.error);
      return result.project;
    });
  }

  function addSurfaceOpening(kind: Opening['kind']) {
    if (!activeSurfaceId) return;
    setHasRoomEdits(true);
    setProject((current) => {
      const added = addOpeningDetailed(current, activeSurfaceId, kind);
      if (!added.opening || added.opening.kind === 'window') return added.project;
      const candidates = getOpeningConnectionCandidates(added.project, added.opening.id);
      if (!candidates.length) return added.project;
      if ((added.project.room.areas?.length ?? 1) === 2 && candidates.length === 1) {
        const connected = connectRoomOpenings(added.project, added.opening.id, candidates[0].openingId);
        setRoomActionMessage(connected.error ?? `${added.opening.name} соединена с ${candidates[0].label}. Помещения объединены в общую схему.`);
        return connected.project;
      }
      setConnectionPrompt({ candidates, sourceOpeningId: added.opening.id });
      return added.project;
    });
  }

  function connectOpeningTo(candidate: OpeningConnectionCandidate) {
    if (!connectionPrompt) return;
    setProject((current) => {
      const result = connectRoomOpenings(current, connectionPrompt.sourceOpeningId, candidate.openingId);
      setRoomActionMessage(result.error ?? `Помещение присоединено через ${candidate.label}.`);
      return result.project;
    });
    setConnectionPrompt(null);
  }

  function moveSurfaceOpening(openingId: string, xMm: number, yMm?: number) {
    setHasRoomEdits(true);
    setProject((current) => moveOpening(current, openingId, xMm, yMm));
  }

  function resizeSurfaceOpening(openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) {
    setHasRoomEdits(true);
    setProject((current) => resizeOpening(current, openingId, patch));
  }

  function resetSurfaceOpening(openingId: string) {
    setHasRoomEdits(true);
    setProject((current) => resetOpening(current, openingId));
  }

  function deleteSurfaceOpening(openingId: string) {
    setHasRoomEdits(true);
    setProject((current) => deleteOpening(current, openingId));
    setSelectedOpeningId(null);
  }

  function createPartition() {
    setPartitionDrawingActive((current) => !current);
    setPartitionDraftStart(null);
    setPartitionDraftAreaId(null);
    setSelectedPartitionId(null);
    setDrawingError(null);
  }

  function addPartitionDraftPoint(point: PointMm) {
    if (!partitionDraftStart) {
      const snapped = findNearestRoomBoundary(project, point, 350);
      if (!snapped) {
        setDrawingError('Начните перегородку на границе пола, рядом с одной из стен.');
        return;
      }
      setPartitionDraftStart(snapped.point);
      setPartitionDraftAreaId(snapped.areaId);
      setDrawingError(null);
      return;
    }
    const area = project.room.areas?.find((item) => item.id === partitionDraftAreaId);
    if (!area) return;
    const end = constrainPartitionEnd(partitionDraftStart, point);
    const crossesPartition = (project.room.partitions ?? []).some((partition) => segmentsCross(partitionDraftStart, end, partition.start, partition.end));
    if (!isPartitionInsideContour(area.contour, partitionDraftStart, end) || crossesPartition) {
      setDrawingError('Перегородка должна идти внутрь помещения и не пересекать стены.');
      return;
    }
    setProject((current) => addPartition(current, partitionDraftStart, end, area.id));
    setHasRoomEdits(true);
    setPartitionDrawingActive(false);
    setPartitionDraftStart(null);
    setPartitionDraftAreaId(null);
    setDrawingError(null);
  }

  function moveSurfacePartition(partitionId: string, deltaXmm: number, deltaYmm: number) {
    const partition = project.room.partitions?.find((item) => item.id === partitionId);
    if (!partition) return;
    const area = project.room.areas?.find((item) => item.id === partition.areaId);
    if (!area) return;
    const wallIndex = findBoundarySegmentIndex(area.contour, partition.start);
    if (wallIndex < 0) return;
    const wallStart = area.contour[wallIndex];
    const wallEnd = area.contour[(wallIndex + 1) % area.contour.length];
    const proposedStart = { x: partition.start.x + deltaXmm, y: partition.start.y + deltaYmm };
    const snappedStart = projectPointToSegment(proposedStart, wallStart, wallEnd);
    const appliedDelta = { x: snappedStart.x - partition.start.x, y: snappedStart.y - partition.start.y };
    const end = { x: partition.end.x + appliedDelta.x, y: partition.end.y + appliedDelta.y };
    const crossesPartition = (project.room.partitions ?? []).some((item) => item.id !== partitionId && segmentsCross(snappedStart, end, item.start, item.end));
    if (!isPartitionInsideContour(area.contour, snappedStart, end) || crossesPartition) return;
    setHasRoomEdits(true);
    setProject((current) => movePartition(current, partitionId, snappedStart, end));
  }

  function resetSurfacePartition(partitionId: string) {
    setHasRoomEdits(true);
    setProject((current) => resetPartition(current, partitionId));
  }

  function deleteSurfacePartition(partitionId: string) {
    setHasRoomEdits(true);
    setProject((current) => deletePartition(current, partitionId));
    setSelectedPartitionId(null);
  }

  function submitRoomObject(input: Parameters<typeof addRoomObject>[1]) {
    const result = editingObjectId ? updateRoomObject(project, editingObjectId, input) : addRoomObject(project, input);
    if (result.error) {
      setObjectDialogError(result.error);
      return false;
    }
    setProject(result.project);
    setSelectedObjectId(result.object?.id ?? null);
    setEditingObjectId(null);
    setObjectDialogError(null);
    setHasRoomEdits(true);
    return true;
  }

  function editSurfaceObject(objectId: string) {
    setEditingObjectId(objectId);
    setSelectedObjectId(objectId);
    setObjectDialogError(null);
    setActivePanelTab('objects');
  }

  function moveSurfaceObjectOnWall(objectId: string, surfaceId: string, offsetMm: number, elevationMm: number) {
    setProject((current) => moveRoomObjectOnWall(current, objectId, surfaceId, offsetMm, elevationMm).project);
    setHasRoomEdits(true);
  }

  function moveSurfaceObject(objectId: string, xMm: number, yMm: number) {
    setProject((current) => moveRoomObject(current, objectId, xMm, yMm).project);
    setHasRoomEdits(true);
  }

  function deleteSurfaceObject(objectId: string) {
    setProject((current) => deleteRoomObject(current, objectId));
    setSelectedObjectId(null);
    setHasRoomEdits(true);
  }

  function changeRoomAreaName(areaId: string, name: string) {
    setProject((current) => renameRoomArea(current, areaId, name));
    setRenameRoomAreaId(null);
    setHasRoomEdits(true);
  }

  function createZone(kind: ZonePresetKind) {
    const targetSurfaceId = activeSurfaceId && project.surfaces.some((surface) => surface.id === activeSurfaceId) ? activeSurfaceId : 'surface-floor';
    const targetSurface = project.surfaces.find((surface) => surface.id === targetSurfaceId);
    if (!targetSurface) return;
    setHasRoomEdits(true);
    setActivePanelTab('zones');
    setProject((current) => {
      const next =
        targetSurface.type === 'wall'
          ? addWallZone(current, targetSurface.id, kind === 'shower' ? 'rect' : kind)
          : addFloorZone(current, kind);
      const surface = next.surfaces.find((item) => item.id === targetSurface.id);
      const zone = surface?.zones[surface.zones.length - 1] ?? null;
      if (zone) {
        setSelectedSurfaceId(targetSurface.id);
        setSelectedZoneId(zone.id);
        setSelectedWallIndex(null);
      }
      return next;
    });
  }

  function changeZoneShape(surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) {
    setHasRoomEdits(true);
    setProject((current) => updateZoneShape(current, surfaceId, zoneId, patch));
  }

  function changeActiveZoneShape(patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) {
    if (!activeSurfaceId || !activeZoneId) return;
    changeZoneShape(activeSurfaceId, activeZoneId, patch);
  }

  function deleteActiveZone() {
    if (!activeSurfaceId || !selectedZoneId) return;
    setHasRoomEdits(true);
    setProject((current) => deleteZone(current, activeSurfaceId, selectedZoneId));
    setSelectedZoneId(null);
  }

  function resetProject() {
    setConfirmAction({ type: 'reset' });
  }

  function resetProjectNow() {
    const nextProject = getInitialProject();
    clearProject();
    setSelectedTemplateId(nextProject.room.templateId ?? 'custom');
    selectSurface('surface-floor');
    setEditTarget(null);
    setLayers({ grid: true, floor: true, walls: true, dimensions: true });
    setViewport(resetViewport());
    setDraftContour([]);
    setDrawingError(null);
    setDrawingMode('idle');
    setCustomTileDialogOpen(false);
    setCustomTileError(null);
    setHasRoomEdits(false);
    setActivePanelTab('tile');
    setTemplatePickerOpen(true);
    setProject(nextProject);
  }

  function confirmPendingAction() {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    if (action.type === 'reset') {
      resetProjectNow();
      return;
    }
    applyTemplateNow(action.templateId);
  }

  const confirmDialog = getConfirmDialogCopy(confirmAction);

  return (
    <div className="app-shell">
      <header className="topbar">
        <AppLogo />
        <div className="topbar-tools" aria-label="Быстрые действия">
          <button type="button" className="icon-button" aria-label="Отменить">
            <Undo2 size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Повторить">
            <Redo2 size={18} />
          </button>
          <button type="button" className={layers.grid ? 'tool-button active' : 'tool-button'} onClick={() => setLayers((current) => ({ ...current, grid: !current.grid }))}>
            <Grid3X3 size={17} />
            Сетка
          </button>
          <button type="button" className="tool-button">
            <HelpCircle size={17} />
            Помощь
          </button>
          <button type="button" className="tool-button danger-lite" onClick={resetProject}>
            <Trash2 size={17} />
            Сброс
          </button>
        </div>
        <div className="topbar-actions">
          <button type="button" className="tool-button">
            <Save size={17} />
            Сохранить
          </button>
          <button type="button" className="primary-button" onClick={() => setCalculationOpen(true)}>
            <Calculator size={17} />
            Расчёт
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="canvas-area" aria-label="Рабочее поле">
          <WorkspaceCanvas
            canCompleteDrawing={!draftWallStart && canCloseContour(draftContour)}
            draftContour={draftContour}
            draftWallStart={draftWallStart}
            drawingError={drawingError}
            drawingMode={drawingMode}
            drawingToolArmed={drawingToolArmed}
            customDrawingMode={customDrawingMode}
            editTarget={editTarget}
            layers={layers}
            partitionDrawingActive={partitionDrawingActive}
            partitionDraftStart={partitionDraftStart}
            onAddPartitionDraftPoint={addPartitionDraftPoint}
            onAddDraftPoint={addDraftPoint}
            onChangeHeight={changeHeight}
            onCancelDrawing={cancelCustomDrawing}
            onCompleteDrawing={completeCustomDrawing}
            onCustomDrawingModeChange={changeCustomDrawingMode}
            onEditSegment={setEditTarget}
            onLayersChange={setLayers}
            layoutDragEnabled={layoutDragEnabled}
            onLayoutDrag={shiftLayoutOrigin}
            onLayoutEdgeOffsetChange={setLayoutEdgeOffset}
            onDeleteOpening={deleteSurfaceOpening}
            onDeletePartition={deleteSurfacePartition}
            onMoveOpening={moveSurfaceOpening}
            onMovePartition={moveSurfacePartition}
            onMoveObject={moveSurfaceObject}
            onMoveObjectOnWall={moveSurfaceObjectOnWall}
            onResizeOpening={resizeSurfaceOpening}
            onMoveWall={dragWall}
            onMoveRoomArea={moveAdditionalRoom}
            onMoveDraftReviewPoint={moveDraftReviewPoint}
            onMoveDraftReviewWall={moveDraftReviewWall}
            onMoveLastDraftPoint={moveLastDraftPoint}
            onSaveDrawing={saveCustomDrawing}
            onSelectSurface={selectSurface}
            onSelectOpening={selectOpening}
            onSelectZone={selectZone}
            onSelectWall={selectWall}
            onSubmitSegment={changeSegmentLength}
            onResetOpening={resetSurfaceOpening}
            onResetPartition={resetSurfacePartition}
            onEditObject={editSurfaceObject}
            onDeleteObject={deleteSurfaceObject}
            onUndoDraftPoint={undoDraftPoint}
            onViewportChange={setViewport}
            onZoneShapeChange={changeZoneShape}
            project={project}
            selectedSurfaceId={selectedSurfaceId}
            selectedOpeningId={selectedOpeningId}
            selectedPartitionId={selectedPartitionId}
            selectedObjectId={selectedObjectId}
            onSelectObject={selectRoomObject}
            onRenameRoomArea={setRenameRoomAreaId}
            onSelectPartition={setSelectedPartitionId}
            selectedZoneId={selectedZoneId}
            selectedWallIndex={selectedWallIndex}
            viewport={viewport}
          />
          {roomActionMessage ? <div className="room-action-message" role="status">{roomActionMessage}</div> : null}
        </section>

        <aside className="side-panel" aria-label="Панель текущего шага">
          <div className="panel-tabs">
            <button type="button" className={activePanelTab === 'tile' ? 'active' : ''} onClick={() => setActivePanelTab('tile')}>Плитка</button>
            <button type="button" className={activePanelTab === 'room' ? 'active' : ''} onClick={() => setActivePanelTab('room')}>Помещение</button>
            <button type="button" className={activePanelTab === 'objects' ? 'active' : ''} onClick={() => setActivePanelTab('objects')}>Объекты</button>
            <button type="button" className={activePanelTab === 'zones' ? 'active' : ''} onClick={() => setActivePanelTab('zones')}>Зоны</button>
          </div>

          {activePanelTab === 'tile' ? (
            <>
              <section className="panel-module tile-format-module">
                <h1 className="panel-module-title">Формат плитки</h1>
                <details
                  className="panel-card panel-section tile-format-select"
                  open={openTileSection === 'format'}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setOpenTileSection((current) => open ? 'format' : current === 'format' ? null : current);
                  }}
                >
                  <summary className={activeTileMaterial ? 'tile-format-summary active' : 'tile-format-summary'}>
                    <strong>{activeTileMaterial?.label ?? 'Выберите формат'}</strong>
                  </summary>
                  <div className="tile-card-grid">
                    {tilePresets.map((tile) => (
                      <TilePresetCard
                        active={activeTileMaterial?.presetId === tile.id}
                        tile={tile}
                        key={tile.id}
                        onSelect={() => selectTilePreset(tile)}
                      />
                    ))}
                    <button
                      type="button"
                      className={activeTileMaterial && !activeTileMaterial.presetId ? 'tile-card custom-tile-card active' : 'tile-card custom-tile-card'}
                      onClick={() => {
                        setCustomTileDialogOpen(true);
                        setCustomTileError(null);
                      }}
                    >
                      <span className="tile-card-preview custom-preview">
                        <Plus size={18} />
                      </span>
                      <strong>{activeTileMaterial && !activeTileMaterial.presetId ? activeTileMaterial.label : 'Другой размер'}</strong>
                    </button>
                  </div>
                </details>
              </section>

              <LayoutControl
                layout={activeZone?.layout}
                layoutDragEnabled={layoutDragEnabled}
                material={activeTileMaterial}
                openSection={openTileSection}
                onOpenSectionChange={setOpenTileSection}
                onOriginModeChange={changeOriginMode}
                onOffsetInput={setLayoutOriginOffset}
                onOffsetReset={resetLayoutOffset}
                onOffsetStep={shiftLayoutOrigin}
                onPatternChange={changeLayoutPattern}
                onToggleLayoutDrag={setLayoutDragEnabled}
                surface={activeSurface}
                zone={activeZone}
              />

            </>
          ) : null}

          {activePanelTab === 'room' ? (
            <section className="panel-card panel-section">
              <h1>Форма помещения</h1>
              <TemplateGrid onSelect={applyTemplate} selectedTemplateId={selectedTemplateId} />
              <RoomTools
                activeSurface={activeSurface}
                onAddDoor={() => addSurfaceOpening('door')}
                onAddPassage={() => addSurfaceOpening('passage')}
                onAddPartition={createPartition}
                onAddWindow={() => addSurfaceOpening('window')}
                partitionDrawingActive={partitionDrawingActive}
                onAddRoom={addRoom}
                project={project}
              />
            </section>
          ) : null}

          {activePanelTab === 'objects' ? (
            <ObjectsPanel
              editingObject={project.objects.find((object) => object.id === editingObjectId) ?? null}
              error={objectDialogError}
              onCancelEdit={() => { setEditingObjectId(null); setObjectDialogError(null); }}
              onDelete={deleteSurfaceObject}
              onEdit={editSurfaceObject}
              onSelect={selectRoomObject}
              onSubmit={submitRoomObject}
              project={project}
            />
          ) : null}
          {activePanelTab === 'zones' ? (
            <ZonesPanel
              activeSurface={activeSurface}
              activeZone={activeZone}
              onCreateZone={createZone}
              onDeleteZone={deleteActiveZone}
              onSelectZone={selectZone}
              onZoneShapeChange={changeActiveZoneShape}
              project={project}
              selectedSurfaceId={selectedSurfaceId}
              selectedZoneId={selectedZoneId}
            />
          ) : null}

          {contourStatus.ok ? null : <p className="error-text">{contourStatus.message}</p>}
        </aside>
      </main>

      {confirmDialog ? (
        <ConfirmDialog
          cancelLabel="Отмена"
          confirmLabel={confirmDialog.confirmLabel}
          message={confirmDialog.message}
          title={confirmDialog.title}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirmPendingAction}
        />
      ) : null}

      {connectionPrompt ? (
        <OpeningConnectionDialog
          candidates={connectionPrompt.candidates}
          onCancel={() => setConnectionPrompt(null)}
          onSelect={connectOpeningTo}
        />
      ) : null}

      {customTileDialogOpen ? (
        <CustomTileDialog
          error={customTileError}
          material={activeTileMaterial ?? undefined}
          onCancel={() => {
            setCustomTileDialogOpen(false);
            setCustomTileError(null);
          }}
          onSubmit={submitCustomTile}
        />
      ) : null}

      {renameRoomAreaId ? (
        <RoomNameDialog
          area={project.room.areas?.find((area) => area.id === renameRoomAreaId)}
          onCancel={() => setRenameRoomAreaId(null)}
          onSubmit={changeRoomAreaName}
        />
      ) : null}

      {templatePickerOpen ? (
        <TemplatePickerDialog
          onSelect={applyTemplateNow}
          selectedTemplateId={selectedTemplateId}
        />
      ) : null}

      {addRoomPickerOpen ? (
        <TemplatePickerDialog
          onSelect={selectAdditionalRoomTemplate}
          selectedTemplateId=""
        />
      ) : null}

      {calculationOpen ? <CalculationDialog calculation={calculation} onClose={() => setCalculationOpen(false)} /> : null}
    </div>
  );
}

function AppLogo() {
  return (
    <div className="brand" aria-label="Посчитай плитку">
      <svg className="brand-logo-mark" viewBox="0 0 52 44" aria-hidden="true">
        <rect className="logo-tile logo-tile-a" x="4" y="5" width="12" height="12" rx="3" />
        <rect className="logo-tile logo-tile-b" x="19" y="5" width="12" height="12" rx="3" />
        <rect className="logo-tile logo-tile-c" x="4" y="20" width="12" height="12" rx="3" />
        <rect className="logo-tile logo-tile-d" x="19" y="20" width="12" height="12" rx="3" />
        <path className="logo-ruler" d="M36 9v25h12" />
        <path className="logo-ruler" d="M36 14h4M36 19h6M36 24h4M36 29h6" />
        <path className="logo-ruler-fill" d="M39 31h9v4h-9z" />
      </svg>
      <strong>
        Посчитай
        <span>плитку</span>
      </strong>
    </div>
  );
}

function ConfirmDialog({
  cancelLabel,
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  title,
}: {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <p>{message}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-submit" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function OpeningConnectionDialog({ candidates, onCancel, onSelect }: { candidates: OpeningConnectionCandidate[]; onCancel: () => void; onSelect: (candidate: OpeningConnectionCandidate) => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog opening-connection-dialog" role="dialog" aria-modal="true" aria-labelledby="opening-connection-title">
        <h2 id="opening-connection-title">Соединить помещения</h2>
        <p>Выберите свободный проём, к которому нужно присоединить новое помещение. Мы развернём и совместим помещения автоматически.</p>
        <div className="opening-connection-options">
          {candidates.map((candidate) => (
            <button type="button" key={candidate.openingId} onClick={() => onSelect(candidate)}>
              <strong>{candidate.label}</strong>
              <span>{candidate.areaName}</span>
            </button>
          ))}
        </div>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>Пока не соединять</button>
        </div>
      </section>
    </div>
  );
}

function ObjectsPanel({ editingObject, error, onCancelEdit, onDelete, onEdit, onSelect, onSubmit, project }: {
  editingObject: RoomObject | null;
  error: string | null;
  onCancelEdit: () => void;
  onDelete: (objectId: string) => void;
  onEdit: (objectId: string) => void;
  onSelect: (objectId: string | null) => void;
  onSubmit: (input: Parameters<typeof addRoomObject>[1]) => boolean;
  project: TileProject;
}) {
  const areas = project.room.areas ?? [];
  const [name, setName] = useState('');
  const [areaId, setAreaId] = useState(areas[0]?.id ?? '');
  const [widthMm, setWidthMm] = useState('500');
  const [heightMm, setHeightMm] = useState('850');
  const [lengthMm, setLengthMm] = useState('800');
  const [excludeTile, setExcludeTile] = useState(false);

  useEffect(() => {
    if (editingObject) {
      setName(editingObject.name);
      setAreaId(editingObject.areaId);
      setWidthMm(String(editingObject.widthMm));
      setHeightMm(String(editingObject.heightMm));
      setLengthMm(String(editingObject.lengthMm));
      setExcludeTile(editingObject.excludeTile);
      return;
    }
    if (!areas.some((area) => area.id === areaId)) setAreaId(areas[0]?.id ?? '');
    setName('');
    setWidthMm('500');
    setHeightMm('850');
    setLengthMm('800');
    setExcludeTile(false);
  }, [editingObject?.id]);

  function resetForm() {
    onCancelEdit();
    setName('');
    setWidthMm('500');
    setHeightMm('850');
    setLengthMm('800');
    setExcludeTile(false);
  }

  return (
    <section className="panel-card panel-section objects-panel">
      <h1>Объекты</h1>
      <form
        className="object-editor"
        onSubmit={(event) => {
          event.preventDefault();
          const saved = onSubmit({
            areaId,
            excludeTile,
            heightMm: Number(heightMm),
            lengthMm: Number(lengthMm),
            name,
            widthMm: Number(widthMm),
          });
          if (saved) {
            setName('');
            setWidthMm('500');
            setHeightMm('850');
            setLengthMm('800');
            setExcludeTile(false);
          }
        }}
      >
        <label className="object-editor-wide">
          Название
          <input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, навесной шкаф" required />
        </label>
        <label className="object-editor-wide">
          Помещение
          <select value={areaId} onChange={(event) => setAreaId(event.target.value)} required>
            {areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}
          </select>
        </label>
        <label>Ширина, мм<input type="number" min="1" max="15000" step="1" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} required /></label>
        <label>Высота, мм<input type="number" min="1" max="4500" step="1" value={heightMm} onChange={(event) => setHeightMm(event.target.value)} required /></label>
        <label>Длина, мм<input type="number" min="1" max="15000" step="1" value={lengthMm} onChange={(event) => setLengthMm(event.target.value)} required /></label>
        <label className="object-tile-checkbox">
          <input type="checkbox" checked={excludeTile} onChange={(event) => setExcludeTile(event.target.checked)} />
          <span>За объектом отсутствует плитка</span>
        </label>
        {error ? <p className="error-text object-editor-wide">{error}</p> : null}
        <div className="object-editor-actions object-editor-wide">
          {editingObject ? <button type="button" className="secondary" onClick={resetForm}>Отмена</button> : null}
          <button type="submit">{editingObject ? 'Сохранить изменения' : 'Создать'}</button>
        </div>
      </form>

      <div className="object-room-groups">
        {areas.map((area) => {
          const objects = project.objects.filter((object) => object.areaId === area.id);
          return (
            <details className="object-room-group" key={area.id} open={objects.length > 0}>
              <summary>
                <span>{area.name}</span>
                <small>{objects.length}</small>
              </summary>
              <div className="object-room-list">
                {objects.length ? objects.map((object) => (
                  <article key={object.id} onClick={() => onSelect(object.id)}>
                    <div>
                      <strong>{object.name}</strong>
                      <span>{object.widthMm} × {object.heightMm} × {object.lengthMm} мм</span>
                      {object.excludeTile ? <small>Без плитки</small> : <small>Плитка сохраняется</small>}
                    </div>
                    <div className="object-list-actions">
                      <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(object.id); }}>Изменить</button>
                      <button type="button" className="danger-lite" onClick={(event) => { event.stopPropagation(); onDelete(object.id); }}>Удалить</button>
                    </div>
                  </article>
                )) : <p>В этом помещении пока нет объектов.</p>}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function RoomNameDialog({ area, onCancel, onSubmit }: {
  area: NonNullable<TileProject['room']['areas']>[number] | undefined;
  onCancel: () => void;
  onSubmit: (areaId: string, name: string) => void;
}) {
  const [name, setName] = useState(area?.name ?? '');
  if (!area) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="confirm-dialog room-name-dialog" role="dialog" aria-modal="true" aria-labelledby="room-name-title" onSubmit={(event) => { event.preventDefault(); onSubmit(area.id, name); }}>
        <h2 id="room-name-title">Название помещения</h2>
        <label>
          Введите своё название
          <input autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel}>Отмена</button>
          <button type="submit" disabled={!name.trim()}>Сохранить</button>
        </div>
      </form>
    </div>
  );
}

function CustomTileDialog({
  error,
  material,
  onCancel,
  onSubmit,
}: {
  error: string | null;
  material?: TileMaterial;
  onCancel: () => void;
  onSubmit: (widthCm: string, heightCm: string) => void;
}) {
  const defaultWidth = material ? String(Math.round(material.widthMm / 10)) : '60';
  const defaultHeight = material ? String(Math.round(material.heightMm / 10)) : '120';

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="confirm-dialog custom-tile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-tile-title"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSubmit(String(data.get('widthCm') ?? ''), String(data.get('heightCm') ?? ''));
        }}
      >
        <h2 id="custom-tile-title">Другой размер плитки</h2>
        <p>Введите размер в сантиметрах. В проекте он сохранится в миллиметрах.</p>
        <div className="custom-tile-fields">
          <label>
            Ширина
            <input name="widthCm" type="number" min={5} max={320} step={1} defaultValue={defaultWidth} autoFocus />
          </label>
          <label>
            Высота
            <input name="heightCm" type="number" min={5} max={320} step={1} defaultValue={defaultHeight} />
          </label>
        </div>
        {error ? <em>{error}</em> : null}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            Отмена
          </button>
          <button type="submit" className="confirm-submit">
            Применить
          </button>
        </div>
      </form>
    </div>
  );
}

function getConfirmDialogCopy(action: ConfirmAction) {
  if (!action) return null;
  if (action.type === 'reset') {
    return {
      confirmLabel: 'Сбросить',
      message: 'Текущая схема, размеры и настройки будут удалены из этого браузера.',
      title: 'Сбросить проект?',
    };
  }

  return {
    confirmLabel: 'Сменить форму',
    message: 'Текущие размеры и правки стен будут заменены выбранным шаблоном.',
    title: 'Сменить форму помещения?',
  };
}

interface WorkspaceCanvasProps {
  canCompleteDrawing: boolean;
  customDrawingMode: CustomDrawingMode;
  draftContour: PointMm[];
  draftWallStart: PointMm | null;
  drawingError: string | null;
  drawingMode: DrawingMode;
  drawingToolArmed: boolean;
  editTarget: EditTarget;
  layers: CanvasLayers;
  partitionDrawingActive: boolean;
  partitionDraftStart: PointMm | null;
  onAddPartitionDraftPoint: (point: PointMm) => void;
  layoutDragEnabled: boolean;
  onAddDraftPoint: (point: PointMm) => void;
  onChangeHeight: (areaId: string, value: string) => void;
  onCancelDrawing: () => void;
  onCompleteDrawing: () => void;
  onCustomDrawingModeChange: (mode: CustomDrawingMode) => void;
  onEditSegment: (target: EditTarget) => void;
  onLayersChange: (layers: CanvasLayers) => void;
  onLayoutDrag: (deltaXmm: number, deltaYmm: number) => void;
  onLayoutEdgeOffsetChange: (surfaceId: string, zoneId: string, edge: keyof LayoutEdgeCuts, value: number) => void;
  onDeleteObject: (objectId: string) => void;
  onEditObject: (objectId: string) => void;
  onDeleteOpening: (openingId: string) => void;
  onDeletePartition: (partitionId: string) => void;
  onMoveObject: (objectId: string, xMm: number, yMm: number) => void;
  onMoveObjectOnWall: (objectId: string, surfaceId: string, offsetMm: number, elevationMm: number) => void;
  onMoveOpening: (openingId: string, xMm: number, yMm?: number) => void;
  onMovePartition: (partitionId: string, deltaXmm: number, deltaYmm: number) => void;
  onResizeOpening: (openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) => void;
  onMoveWall: (areaId: string, index: number, deltaMm: number) => void;
  onMoveRoomArea: (areaId: string, deltaXmm: number, deltaYmm: number) => void;
  onMoveDraftReviewPoint: (index: number, point: PointMm) => boolean;
  onMoveDraftReviewWall: (index: number, deltaXmm: number, deltaYmm: number) => boolean;
  onMoveLastDraftPoint: (point: PointMm) => PointMm | null;
  onSaveDrawing: () => void;
  onSelectSurface: (surfaceId: string | null) => void;
  onSelectOpening: (surfaceId: string, openingId: string) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onSelectWall: (index: number | null) => void;
  onSubmitSegment: (target: Extract<Exclude<EditTarget, null>, { type: 'floor-segment' | 'wall-segment' }>, value: string) => void;
  onRenameRoomArea: (areaId: string) => void;
  onResetOpening: (openingId: string) => void;
  onResetPartition: (partitionId: string) => void;
  onSelectObject: (objectId: string | null) => void;
  onSelectPartition: (partitionId: string | null) => void;
  onUndoDraftPoint: () => void;
  onViewportChange: (viewport: CanvasViewport) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedSurfaceId: string | null;
  selectedOpeningId: string | null;
  selectedObjectId: string | null;
  selectedPartitionId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
  viewport: CanvasViewport;
}

function WorkspaceCanvas({
  canCompleteDrawing,
  customDrawingMode,
  draftContour,
  draftWallStart,
  drawingError,
  drawingMode,
  drawingToolArmed,
  editTarget,
  layers,
  partitionDrawingActive,
  partitionDraftStart,
  onAddPartitionDraftPoint,
  layoutDragEnabled,
  onAddDraftPoint,
  onChangeHeight,
  onCancelDrawing,
  onCompleteDrawing,
  onCustomDrawingModeChange,
  onEditSegment,
  onLayersChange,
  onLayoutDrag,
  onLayoutEdgeOffsetChange,
  onDeleteObject,
  onEditObject,
  onDeleteOpening,
  onDeletePartition,
  onMoveObject,
  onMoveOpening,
  onMoveObjectOnWall,
  onMovePartition,
  onResizeOpening,
  onMoveWall,
  onMoveRoomArea,
  onMoveDraftReviewPoint,
  onMoveDraftReviewWall,
  onMoveLastDraftPoint,
  onSaveDrawing,
  onSelectSurface,
  onSelectOpening,
  onSelectZone,
  onSelectWall,
  onSubmitSegment,
  onRenameRoomArea,
  onResetOpening,
  onResetPartition,
  onSelectObject,
  onSelectPartition,
  onUndoDraftPoint,
  onViewportChange,
  onZoneShapeChange,
  project,
  selectedSurfaceId,
  selectedOpeningId,
  selectedObjectId,
  selectedPartitionId,
  selectedZoneId,
  selectedWallIndex,
  viewport,
}: WorkspaceCanvasProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(initialCanvasSize);
  const [editError, setEditError] = useState<string | null>(null);
  const [draftPointer, setDraftPointer] = useState<PointMm | null>(null);
  const [collapsedWallAreaIds, setCollapsedWallAreaIds] = useState<Set<string>>(() => new Set());
  const panRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const layoutDragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const planView = useMemo(() => getPlanView(project.room.contour), [project.room.contour]);
  const wallLayout = useMemo(() => getWallLayout(project, planView, collapsedWallAreaIds), [project, planView, collapsedWallAreaIds]);
  const wallFrames = wallLayout.frames;
  const activeEdit = editTarget ? getInlineEdit(project, editTarget, planView, wallFrames, viewport) : null;

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(300, Math.round(entry.contentRect.width)),
        height: Math.max(260, Math.round(entry.contentRect.height)),
      });
    });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setEditError(null);
  }, [editTarget]);

  function startPan(event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (drawingMode === 'custom-room' && drawingToolArmed) {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      onAddDraftPoint(pointerToDraftPoint(pointer, viewport));
      return;
    }
    if (partitionDrawingActive) {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      onAddPartitionDraftPoint(pointerToDraftPoint(pointer, viewport));
      return;
    }
    if (selectedOpeningId) onSelectSurface(null);
    if (layoutDragEnabled && selectedSurfaceId) {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      layoutDragRef.current = { active: true, x: pointer.x, y: pointer.y };
      return;
    }
    if (event.target.name() !== 'pan-bg') return;
    const pointer = event.target.getStage()?.getPointerPosition();
    if (!pointer) return;
    panRef.current = { active: true, x: pointer.x, y: pointer.y };
  }

  function movePan(event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (drawingMode === 'custom-room' && drawingToolArmed) {
      const previewStart = draftWallStart ?? draftContour[draftContour.length - 1] ?? null;
      if (!previewStart) {
        setDraftPointer(null);
        return;
      }
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      const rawPoint = pointerToPlanPoint(pointer, viewport, planView);
      const workingPoints = draftContour.length ? draftContour : [previewStart];
      setDraftPointer(customDrawingMode === 'orthogonal' ? constrainOrthogonalPoint(workingPoints, rawPoint) : constrainFreePoint(rawPoint, workingPoints));
      return;
    }
    if (partitionDrawingActive) {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      const rawPoint = pointerToPlanPoint(pointer, viewport, planView);
      setDraftPointer(partitionDraftStart ? constrainPartitionEnd(partitionDraftStart, rawPoint) : rawPoint);
      return;
    }
    if (layoutDragRef.current.active) {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      const dx = pointer.x - layoutDragRef.current.x;
      const dy = pointer.y - layoutDragRef.current.y;
      layoutDragRef.current = { active: true, x: pointer.x, y: pointer.y };
      const deltaXmm = Math.round(dx / (PX_PER_MM * viewport.zoom));
      const deltaYmm = Math.round(dy / (PX_PER_MM * viewport.zoom));
      if (deltaXmm || deltaYmm) onLayoutDrag(deltaXmm, deltaYmm);
      return;
    }
    if (!panRef.current.active) return;
    const pointer = event.target.getStage()?.getPointerPosition();
    if (!pointer) return;
    const dx = pointer.x - panRef.current.x;
    const dy = pointer.y - panRef.current.y;
    panRef.current = { active: true, x: pointer.x, y: pointer.y };
    onViewportChange(panViewport(viewport, dx, dy));
  }

  function stopPan() {
    panRef.current.active = false;
    layoutDragRef.current.active = false;
  }

  function commitActiveEdit(value: string) {
    if (!activeEdit) return;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < activeEdit.min || parsed > activeEdit.max) {
      setEditError(`Введите целое число от ${activeEdit.min} до ${activeEdit.max}.`);
      return;
    }

    if (activeEdit.target.type === 'layout-offset') {
      onLayoutEdgeOffsetChange(activeEdit.target.surfaceId, activeEdit.target.zoneId, activeEdit.target.edge, parsed);
    } else if (activeEdit.target.type === 'wall-height') {
      onChangeHeight(activeEdit.target.areaId, String(parsed));
    } else {
      onSubmitSegment(activeEdit.target, String(parsed));
    }
    setEditError(null);
    onEditSegment(null);
  }

  return (
    <div className={(drawingMode === 'custom-room' && draftWallStart) || (partitionDrawingActive && partitionDraftStart) ? 'canvas-card drawing-line-active' : 'canvas-card'} ref={holderRef}>
      <Stage
        width={size.width}
        height={size.height}
        className="konva-stage"
        onMouseDown={startPan}
        onMouseMove={movePan}
        onMouseUp={stopPan}
        onMouseLeave={() => {
          stopPan();
          setDraftPointer(null);
        }}
        onTouchStart={startPan}
        onTouchMove={movePan}
        onTouchEnd={stopPan}
        onWheel={(event) => {
          event.evt.preventDefault();
          onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom + (event.evt.deltaY > 0 ? -0.08 : 0.08)) });
        }}
      >
        <Layer>
          <Rect name="pan-bg" x={0} y={0} width={size.width} height={size.height} fill="#FBFBFC" />
          {layers.grid ? <Grid width={size.width} height={size.height} viewport={viewport} /> : null}
          <Group x={viewport.x} y={viewport.y} scaleX={viewport.zoom} scaleY={viewport.zoom}>
            {drawingMode === 'custom-room' ? <DraftContourLayer canResizeLastPoint={!draftWallStart && draftContour.length >= 2} mode={customDrawingMode} onLastPointMove={onMoveLastDraftPoint} points={draftContour} previewPoint={draftPointer} previewStart={draftWallStart ?? (drawingToolArmed ? draftContour[draftContour.length - 1] ?? null : null)} /> : null}
            {drawingMode === 'custom-room-review' ? <DraftReviewLayer onPointMove={onMoveDraftReviewPoint} onWallMove={onMoveDraftReviewWall} points={draftContour} /> : null}
            {drawingMode === 'idle' && layers.floor ? (
              <FloorLayer
                dimensionsVisible={layers.dimensions}
                onEditSegment={onEditSegment}
                onMoveWall={onMoveWall}
                onMoveRoomArea={onMoveRoomArea}
                onDeleteObject={onDeleteObject}
                onEditObject={onEditObject}
                onMoveObject={onMoveObject}
                onSelectObject={onSelectObject}
                onDeletePartition={onDeletePartition}
                onMovePartition={onMovePartition}
                onResetPartition={onResetPartition}
                onSelectPartition={onSelectPartition}
                onSelectSurface={onSelectSurface}
                onSelectOpening={onSelectOpening}
                onSelectZone={onSelectZone}
                onSelectWall={onSelectWall}
                onEditLayoutOffset={onEditSegment}
                onZoneShapeChange={onZoneShapeChange}
                project={project}
                roomMoveEnabled={!partitionDrawingActive}
                selectedSurfaceId={selectedSurfaceId}
                selectedOpeningId={selectedOpeningId}
                selectedObjectId={selectedObjectId}
                selectedPartitionId={selectedPartitionId}
                selectedZoneId={selectedZoneId}
                selectedWallIndex={selectedWallIndex}
                view={planView}
              />
            ) : null}
            {drawingMode === 'idle' && partitionDrawingActive ? <PartitionDraftLayer end={partitionDraftStart ? draftPointer : null} start={partitionDraftStart} view={planView} /> : null}
            {drawingMode === 'idle' && layers.walls ? (
              <WallsLayer
                dimensionsVisible={layers.dimensions}
                frames={wallFrames}
                sections={wallLayout.sections}
                onChangeHeight={onChangeHeight}
                onEditSegment={onEditSegment}
                onDeleteOpening={onDeleteOpening}
                onMoveOpening={onMoveOpening}
                onResizeOpening={onResizeOpening}
                onSelectWall={onSelectWall}
                onSelectOpening={onSelectOpening}
                onSelectZone={onSelectZone}
                onEditLayoutOffset={onEditSegment}
                onZoneShapeChange={onZoneShapeChange}
                onResetOpening={onResetOpening}
                onRenameArea={onRenameRoomArea}
                onDeleteObject={onDeleteObject}
                onEditObject={onEditObject}
                onMoveObjectOnWall={onMoveObjectOnWall}
                onSelectObject={onSelectObject}
                project={project}
                selectedSurfaceId={selectedSurfaceId}
                selectedOpeningId={selectedOpeningId}
                selectedObjectId={selectedObjectId}
                selectedZoneId={selectedZoneId}
                selectedWallIndex={selectedWallIndex}
                onToggleArea={(areaId) => {
                  setCollapsedWallAreaIds((current) => {
                    const next = new Set(current);
                    if (next.has(areaId)) next.delete(areaId);
                    else next.add(areaId);
                    return next;
                  });
                }}
              />
            ) : null}
          </Group>
        </Layer>
      </Stage>

      <div className="canvas-layer-controls">
        <label>
          <input type="checkbox" checked={layers.floor} onChange={(event) => onLayersChange({ ...layers, floor: event.target.checked })} />
          Пол
        </label>
        <label>
          <input type="checkbox" checked={layers.walls} onChange={(event) => onLayersChange({ ...layers, walls: event.target.checked })} />
          Стены
        </label>
        <label>
          <input type="checkbox" checked={layers.dimensions} onChange={(event) => onLayersChange({ ...layers, dimensions: event.target.checked })} />
          Размеры
        </label>
      </div>

      <div className="canvas-toolbar">
        <button type="button" aria-label="Уменьшить" onClick={() => onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom - 0.15) })}>
          <Minus size={16} />
        </button>
        <span>{Math.round(viewport.zoom * 100)}%</span>
        <button type="button" aria-label="Увеличить" onClick={() => onViewportChange({ ...viewport, zoom: clampZoom(viewport.zoom + 0.15) })}>
          <Plus size={16} />
        </button>
        <button type="button" aria-label="Вписать" onClick={() => onViewportChange(resetViewport())}>
          <Maximize2 size={16} />
        </button>
      </div>

      {drawingMode === 'custom-room' ? (
        <div className="drawing-controls">
          <div className="drawing-mode-options" role="group" aria-label="Инструмент рисования стен">
            <button type="button" className={drawingToolArmed && customDrawingMode === 'orthogonal' ? 'active' : ''} onClick={() => onCustomDrawingModeChange('orthogonal')}>Нарисовать стену</button>
            <button type="button" className={drawingToolArmed && customDrawingMode === 'free' ? 'active' : ''} onClick={() => onCustomDrawingModeChange('free')}>Стена под углом</button>
          </div>
          <button type="button" className="drawing-complete" onClick={onCompleteDrawing} disabled={!canCompleteDrawing}>
            Завершить построение
          </button>
          <button type="button" onClick={onUndoDraftPoint} disabled={draftContour.length === 0 && !draftWallStart}>
            Отменить действие
          </button>
          <button type="button" onClick={onCancelDrawing}>
            Сброс всего
          </button>
          <span>{!drawingToolArmed && draftContour.length ? 'Режим перемещения: двигайте весь чертёж мышью' : draftContour.length ? `${draftContour.length} точ.` : 'Кликните, чтобы поставить начало стены'}</span>
          {drawingError ? <em>{drawingError}</em> : null}
        </div>
      ) : null}

      {drawingMode === 'custom-room-review' ? (
        <div className="drawing-controls drawing-review-controls">
          <strong>Проверить помещение</strong>
          <span>У прямоугольной формы тяните стены, у формы с углами — отдельные точки</span>
          {drawingError ? <em>{drawingError}</em> : null}
          <button type="button" className="drawing-complete" onClick={onSaveDrawing}>Сохранить</button>
          <button type="button" onClick={onCancelDrawing}>Отмена</button>
        </div>
      ) : null}

      {activeEdit ? (
        <form
          className="inline-dimension-editor"
          style={{ left: activeEdit.left, top: activeEdit.top }}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const value = String(data.get('value') ?? activeEdit.value);
            commitActiveEdit(value);
          }}
        >
          <input
            name="value"
            type="number"
            min={activeEdit.min}
            max={activeEdit.max}
            step={1}
            defaultValue={activeEdit.value}
            autoFocus
            onBlur={(event) => commitActiveEdit(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitActiveEdit(event.currentTarget.value);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditError(null);
                onEditSegment(null);
              }
            }}
          />
          {editError ? <em>{editError}</em> : null}
        </form>
      ) : null}
    </div>
  );
}

function Grid({ width, height, viewport }: { width: number; height: number; viewport: CanvasViewport }) {
  const minorStep = Math.max(8, gridPxForMm(MINOR_GRID_MM) * viewport.zoom);
  const majorEvery = MM_PER_MAJOR_GRID / MINOR_GRID_MM;
  const verticalStart = ((viewport.x % minorStep) + minorStep) % minorStep;
  const horizontalStart = ((viewport.y % minorStep) + minorStep) % minorStep;
  const lines = [];
  let verticalIndex = Math.round((verticalStart - viewport.x) / minorStep);
  for (let x = verticalStart; x <= width; x += minorStep, verticalIndex += 1) {
    const major = verticalIndex % majorEvery === 0;
    lines.push(<Line key={`x-${Math.round(x)}`} points={[x, 0, x, height]} stroke={major ? '#D7D7E0' : '#ECECF1'} strokeWidth={major ? 1.25 : 1} />);
  }

  let horizontalIndex = Math.round((horizontalStart - viewport.y) / minorStep);
  for (let y = horizontalStart; y <= height; y += minorStep, horizontalIndex += 1) {
    const major = horizontalIndex % majorEvery === 0;
    lines.push(<Line key={`y-${Math.round(y)}`} points={[0, y, width, y]} stroke={major ? '#D7D7E0' : '#ECECF1'} strokeWidth={major ? 1.25 : 1} />);
  }
  return <>{lines}</>;
}

function DraftContourLayer({ canResizeLastPoint, mode, onLastPointMove, points, previewPoint, previewStart }: { canResizeLastPoint: boolean; mode: CustomDrawingMode; onLastPointMove: (point: PointMm) => PointMm | null; points: PointMm[]; previewPoint: PointMm | null; previewStart: PointMm | null }) {
  const canvasPoints = points.map(pointToCanvasPoint);
  const linePoints = canvasPoints.flatMap((point) => [point.x, point.y]);
  const previousPoint = previewStart;
  const previewCanvasPoint = previewPoint ? pointToCanvasPoint(previewPoint) : null;
  const previewValidationPoints = points.length ? points : previewStart ? [previewStart] : [];
  const previewError = previousPoint && previewPoint ? validateDraftPoint(previewValidationPoints, previewPoint) : null;

  return (
    <Group>
      <Text x={54} y={54} text="Новый контур" fill="#6B6B80" fontSize={18} />
      <Text x={54} y={82} text={mode === 'orthogonal' ? 'Стена: только горизонтально или вертикально.' : 'Диагональ: свободное направление без пересечений.'} fill="#8F8FA3" fontSize={14} />
      {points.length > 1 ? <Line points={linePoints} stroke="#8A6AAE" strokeWidth={5} lineCap="round" lineJoin="round" /> : null}
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1];
        const start = pointToCanvasPoint(point);
        const end = pointToCanvasPoint(next);
        return <DraftLengthLabel key={`length-${index}`} x={(start.x + end.x) / 2} y={getDraftLengthLabelY(start, end)} text={formatDraftLengthMm(point, next)} />;
      })}
      {previousPoint && previewPoint && previewCanvasPoint && (previousPoint.x !== previewPoint.x || previousPoint.y !== previewPoint.y) ? (
        <Group>
          {points.length >= 3 && (previewPoint.x === points[0].x || previewPoint.y === points[0].y) ? (
            <Line
              points={[previewCanvasPoint.x, previewCanvasPoint.y, pointToCanvasPoint(points[0]).x, pointToCanvasPoint(points[0]).y]}
              stroke="#A385C4"
              strokeWidth={1.5}
              dash={[6, 6]}
              opacity={0.7}
            />
          ) : null}
          <Line
            points={[...Object.values(pointToCanvasPoint(previousPoint)), previewCanvasPoint.x, previewCanvasPoint.y]}
            stroke={previewError ? '#C85B72' : '#A385C4'}
            strokeWidth={4}
            dash={[10, 7]}
            lineCap="round"
          />
          <DraftLengthLabel
            error={Boolean(previewError)}
            x={(pointToCanvasPoint(previousPoint).x + previewCanvasPoint.x) / 2}
            y={getDraftLengthLabelY(pointToCanvasPoint(previousPoint), previewCanvasPoint)}
            text={formatDraftLengthMm(previousPoint, previewPoint)}
          />
          <Circle
            x={previewCanvasPoint.x}
            y={previewCanvasPoint.y}
            radius={7}
            fill="#8A6AAE"
            stroke="#FFFFFF"
            strokeWidth={2}
            shadowColor="rgba(111, 79, 147, 0.38)"
            shadowBlur={8}
          />
        </Group>
      ) : null}
      {canvasPoints.map((point, index) => (
        <Circle
          key={`draft-point-${index}`}
          x={point.x}
          y={point.y}
          radius={canResizeLastPoint && index === canvasPoints.length - 1 ? 9 : 7}
          fill="#8A6AAE"
          stroke={canResizeLastPoint && index === canvasPoints.length - 1 ? '#FFFFFF' : undefined}
          strokeWidth={2}
          shadowColor="rgba(111, 79, 147, 0.38)"
          shadowBlur={canResizeLastPoint && index === canvasPoints.length - 1 ? 8 : 0}
          draggable={canResizeLastPoint && index === canvasPoints.length - 1}
          onMouseEnter={(event) => {
            if (!canResizeLastPoint || index !== canvasPoints.length - 1) return;
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = 'grab';
          }}
          onMouseLeave={(event) => {
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = '';
          }}
          onDragMove={(event) => {
            if (!canResizeLastPoint || index !== canvasPoints.length - 1) return;
            const node = event.target;
            const acceptedPoint = onLastPointMove({
              x: canvasToMm(node.x() - PLAN_OFFSET_X),
              y: canvasToMm(node.y() - PLAN_OFFSET_Y),
            });
            node.position(acceptedPoint ? pointToCanvasPoint(acceptedPoint) : point);
          }}
        />
      ))}
      {previewStart && !points.some((point) => point.x === previewStart.x && point.y === previewStart.y) ? (
        <Circle {...pointToCanvasPoint(previewStart)} radius={7} fill="#8A6AAE" />
      ) : null}
    </Group>
  );
}

function DraftReviewLayer({ onPointMove, onWallMove, points }: { onPointMove: (index: number, point: PointMm) => boolean; onWallMove: (index: number, deltaXmm: number, deltaYmm: number) => boolean; points: PointMm[] }) {
  const wallDragOffsets = useRef<Record<number, { x: number; y: number }>>({});
  const canvasPoints = points.map(pointToCanvasPoint);
  const orthogonal = points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    return point.x === next.x || point.y === next.y;
  });
  return (
    <Group>
      <Text x={54} y={54} text="Проверка помещения" fill="#6B6B80" fontSize={18} />
      <Text x={54} y={82} text={orthogonal ? 'Тяните стены. Прямые углы сохраняются.' : 'Тяните нужную точку. Остальные точки остаются на месте.'} fill="#8F8FA3" fontSize={14} />
      <Line points={canvasPoints.flatMap((point) => [point.x, point.y])} closed fill="#F2EBF9" stroke="#8A6AAE" strokeWidth={5} lineJoin="round" />
      {points.map((point, index) => {
        const next = points[(index + 1) % points.length];
        const startCanvas = pointToCanvasPoint(point);
        const endCanvas = pointToCanvasPoint(next);
        const horizontal = point.y === next.y;
        return (
          <Group key={`review-wall-${index}`}>
            <DraftLengthLabel x={(startCanvas.x + endCanvas.x) / 2} y={getDraftLengthLabelY(startCanvas, endCanvas)} text={formatDraftLengthMm(point, next)} />
            <Line
              points={[startCanvas.x, startCanvas.y, endCanvas.x, endCanvas.y]}
              stroke="transparent"
              strokeWidth={24}
              draggable={orthogonal}
              listening={orthogonal}
              onDragStart={() => {
                wallDragOffsets.current[index] = { x: 0, y: 0 };
              }}
              onDragMove={(event) => {
                if (!orthogonal) return;
                const node = event.currentTarget;
                node.position(horizontal ? { x: 0, y: node.y() } : { x: node.x(), y: 0 });
                const previous = wallDragOffsets.current[index] ?? { x: 0, y: 0 };
                const current = { x: node.x(), y: node.y() };
                const deltaXmm = canvasToMm(current.x - previous.x);
                const deltaYmm = canvasToMm(current.y - previous.y);
                if (deltaXmm || deltaYmm) {
                  onWallMove(index, deltaXmm, deltaYmm);
                  wallDragOffsets.current[index] = current;
                }
              }}
              onMouseEnter={(event) => {
                const container = event.target.getStage()?.container();
                if (container) container.style.cursor = orthogonal ? (horizontal ? 'ns-resize' : 'ew-resize') : 'move';
              }}
              onMouseLeave={(event) => {
                const container = event.target.getStage()?.container();
                if (container) container.style.cursor = '';
              }}
              onDragEnd={(event) => {
                const node = event.currentTarget;
                const previous = wallDragOffsets.current[index] ?? { x: 0, y: 0 };
                const deltaXmm = canvasToMm(node.x() - previous.x);
                const deltaYmm = canvasToMm(node.y() - previous.y);
                node.position({ x: 0, y: 0 });
                delete wallDragOffsets.current[index];
                if (deltaXmm || deltaYmm) onWallMove(index, deltaXmm, deltaYmm);
              }}
            />
          </Group>
        );
      })}
      {canvasPoints.map((canvasPoint, index) => (
        <Circle
          key={`review-point-${index}`}
          x={canvasPoint.x}
          y={canvasPoint.y}
          radius={9}
          fill="#8A6AAE"
          stroke="#FFFFFF"
          strokeWidth={2}
          shadowColor="rgba(111, 79, 147, 0.40)"
          shadowBlur={8}
          draggable={!orthogonal}
          listening={!orthogonal}
          onMouseEnter={(event) => {
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = 'grab';
          }}
          onMouseLeave={(event) => {
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = '';
          }}
          onDragMove={(event) => {
            if (orthogonal) return;
            const node = event.currentTarget;
            const accepted = onPointMove(index, {
              x: canvasToMm(node.x() - PLAN_OFFSET_X),
              y: canvasToMm(node.y() - PLAN_OFFSET_Y),
            });
            if (!accepted) node.position(canvasPoint);
          }}
          onDragEnd={(event) => {
            if (orthogonal) return;
            const node = event.currentTarget;
            const accepted = onPointMove(index, {
              x: canvasToMm(node.x() - PLAN_OFFSET_X),
              y: canvasToMm(node.y() - PLAN_OFFSET_Y),
            });
            if (!accepted) node.position(canvasPoint);
          }}
        />
      ))}
    </Group>
  );
}

function PartitionDraftLayer({ end, start, view }: { end: PointMm | null; start: PointMm | null; view: PlanViewTransform }) {
  if (!start) return <Text x={54} y={92} text="Кликните у стены, чтобы начать перегородку" fill="#6F4F93" fontSize={14} />;
  const startCanvas = { x: view.x(start.x), y: view.y(start.y) };
  const endCanvas = end ? { x: view.x(end.x), y: view.y(end.y) } : null;
  return (
    <Group>
      <Circle x={startCanvas.x} y={startCanvas.y} radius={7} fill="#8A6AAE" stroke="#FFFFFF" strokeWidth={2} />
      {end && endCanvas ? (
        <Group>
          <Line points={[startCanvas.x, startCanvas.y, endCanvas.x, endCanvas.y]} stroke="#A385C4" strokeWidth={4} dash={[10, 7]} lineCap="round" />
          <DraftLengthLabel x={(startCanvas.x + endCanvas.x) / 2} y={getDraftLengthLabelY(startCanvas, endCanvas)} text={formatDraftLengthMm(start, end)} />
          <Circle x={endCanvas.x} y={endCanvas.y} radius={7} fill="#8A6AAE" stroke="#FFFFFF" strokeWidth={2} shadowColor="rgba(111, 79, 147, 0.38)" shadowBlur={8} />
        </Group>
      ) : null}
    </Group>
  );
}

function DraftLengthLabel({ error = false, text, x, y }: { error?: boolean; text: string; x: number; y: number }) {
  return (
    <Group x={x} y={y}>
      <Rect x={-54} y={-11} width={108} height={22} fill="#FFFFFF" stroke={error ? '#C85B72' : '#D9D9E2'} strokeWidth={1} cornerRadius={4} shadowColor="rgba(30, 30, 40, 0.10)" shadowBlur={5} />
      <Text x={-52} y={-7} width={104} align="center" text={text} fill={error ? '#A83F57' : '#4D4D59'} fontSize={12} />
    </Group>
  );
}

function getDraftLengthLabelY(start: { y: number }, end: { y: number }): number {
  const middleY = (start.y + end.y) / 2;
  return middleY < 140 ? middleY + 24 : middleY - 22;
}

function formatDraftLengthMm(start: PointMm, end: PointMm) {
  const totalMm = Math.round(Math.hypot(end.x - start.x, end.y - start.y));
  return `${totalMm} мм`;
}

function pointToCanvasPoint(point: PointMm) {
  return { x: PLAN_OFFSET_X + mmToCanvas(point.x), y: PLAN_OFFSET_Y + mmToCanvas(point.y) };
}

interface FloorLayerProps {
  dimensionsVisible: boolean;
  onDeleteObject: (objectId: string) => void;
  onDeletePartition: (partitionId: string) => void;
  onEditObject: (objectId: string) => void;
  onEditSegment: (target: EditTarget) => void;
  onEditLayoutOffset: (target: EditTarget) => void;
  onMoveObject: (objectId: string, xMm: number, yMm: number) => void;
  onMovePartition: (partitionId: string, deltaXmm: number, deltaYmm: number) => void;
  onMoveWall: (areaId: string, index: number, deltaMm: number) => void;
  onMoveRoomArea: (areaId: string, deltaXmm: number, deltaYmm: number) => void;
  onResetPartition: (partitionId: string) => void;
  onSelectObject: (objectId: string | null) => void;
  onSelectOpening: (surfaceId: string, openingId: string) => void;
  onSelectPartition: (partitionId: string | null) => void;
  onSelectSurface: (surfaceId: string | null) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onSelectWall: (index: number | null) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  roomMoveEnabled: boolean;
  selectedObjectId: string | null;
  selectedOpeningId: string | null;
  selectedPartitionId: string | null;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
  view: PlanViewTransform;
}

function FloorLayer({ dimensionsVisible, onDeleteObject, onDeletePartition, onEditObject, onEditSegment, onEditLayoutOffset, onMoveObject, onMovePartition, onMoveRoomArea, onMoveWall, onResetPartition, onSelectObject, onSelectOpening, onSelectPartition, onSelectSurface, onSelectZone, onSelectWall, onZoneShapeChange, project, roomMoveEnabled, selectedObjectId, selectedOpeningId, selectedPartitionId, selectedSurfaceId, selectedZoneId, selectedWallIndex, view }: FloorLayerProps) {
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour, heightMm: project.room.heightMm }];
  const wallSurfaces = project.surfaces.filter((surface) => surface.type === 'wall');

  return (
    <Group>
      <Text x={54} y={54} text="Пол" fill="#6B6B80" fontSize={18} />
      {areas.map((area, areaIndex) => {
        const floorId = areaIndex === 0 ? 'surface-floor' : `surface-floor-${area.id}`;
        const floor = project.surfaces.find((surface) => surface.id === floorId);
        const baseZone = floor?.zones[0];
        const material = baseZone?.materialId ? project.materials.find((item) => item.id === baseZone.materialId) : null;
        const surfaceActive = selectedSurfaceId === floorId;
        const shapeLocked = area.shapeLocked ?? (areaIndex === 0 && project.room.templateId === null);
        const layoutOpacity = selectedSurfaceId && !surfaceActive ? 0.32 : selectedZoneId ? 0.34 : 1;
        const points = area.contour.flatMap((point) => [view.x(point.x), view.y(point.y)]);
        const connectedAreaIds = getConnectedAreaIdsForUi(project, area.id);
        if (!floor || !baseZone || !material) return null;
        return (
          <Group
            key={area.id}
            id={area.id}
            name="room-floor-group"
            draggable={roomMoveEnabled}
            onDragMove={(event) => {
              const node = event.currentTarget;
              node.getParent()?.find('.room-floor-group').forEach((roomNode) => {
                if (roomNode !== node && connectedAreaIds.has(roomNode.id())) roomNode.position(node.position());
              });
            }}
            onDragEnd={(event) => {
              const node = event.currentTarget;
              const deltaXmm = Math.round(node.x() / view.scale);
              const deltaYmm = Math.round(node.y() / view.scale);
              node.getParent()?.find('.room-floor-group').forEach((roomNode) => {
                if (connectedAreaIds.has(roomNode.id())) roomNode.position({ x: 0, y: 0 });
              });
              if (deltaXmm || deltaYmm) onMoveRoomArea(area.id, deltaXmm, deltaYmm);
            }}
          >
            <Line points={points} closed fill={surfaceActive ? '#F2EBF9' : '#FFFFFF'} stroke="#A385C4" strokeWidth={surfaceActive ? 6 : 4} onClick={() => onSelectSurface(floorId)} onTap={() => onSelectSurface(floorId)} />
            <FloorTileLayout
              blockedObjects={project.objects.filter((object) => object.areaId === area.id && object.excludeTile)}
              contour={area.contour}
              layout={baseZone.layout}
              layoutBounds={getSharedFloorLayoutBox(project, area.id)}
              material={material}
              opacity={layoutOpacity}
              view={view}
            />
            {floor.zones.slice(1).map((zone) => {
              const zoneMaterial = zone.materialId ? project.materials.find((item) => item.id === zone.materialId) : null;
              const zoneActive = selectedZoneId === zone.id;
              return zoneMaterial ? (
                <FloorZoneLayer
                  key={zone.id}
                  material={zoneMaterial}
                  onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: floorId, zoneId: zone.id })}
                  onSelect={() => onSelectZone(floorId, zone.id)}
                  onShapeChange={(patch) => onZoneShapeChange(floorId, zone.id, patch)}
                  selected={zoneActive}
                  view={view}
                  zone={zone}
                  opacity={surfaceActive && !zoneActive ? 0.48 : 1}
                />
              ) : null;
            })}
            <Line points={points} closed stroke={surfaceActive ? '#8A6AAE' : '#A385C4'} strokeWidth={surfaceActive ? 6 : 4} onClick={() => onSelectSurface(floorId)} onTap={() => onSelectSurface(floorId)} />
            <FloorOpeningMarkers areaId={area.id} contour={area.contour} onSelectOpening={onSelectOpening} project={project} selectedOpeningId={selectedOpeningId} view={view} />
            {project.objects.filter((object) => object.areaId === area.id).map((object) => (
              <FloorRoomObject
                contour={area.contour}
                key={object.id}
                object={object}
                objects={project.objects}
                onDelete={() => onDeleteObject(object.id)}
                onMove={(xMm, yMm) => onMoveObject(object.id, xMm, yMm)}
                onEdit={() => onEditObject(object.id)}
                onSelect={() => onSelectObject(object.id)}
                selected={selectedObjectId === object.id}
                view={view}
              />
            ))}
            {dimensionsVisible && surfaceActive ? area.contour.map((_, index) => (
              <FloorWallDimensionLabels
                key={`${floorId}-dimension-${index}`}
                areaId={area.id}
                contour={area.contour}
                index={index}
                onEdit={shapeLocked ? undefined : () => onEditSegment({ type: 'floor-segment', areaId: area.id, index })}
                partitions={project.room.partitions ?? []}
                view={view}
              />
            )) : null}
            {surfaceActive && !selectedZoneId ? (
              <FloorEdgeCutLabels
                contour={area.contour}
                layout={baseZone.layout}
                material={material}
                onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: floorId, zoneId: baseZone.id })}
                view={view}
              />
            ) : null}
            {area.contour.map((point, index) => {
              const next = area.contour[(index + 1) % area.contour.length];
              const horizontal = point.y === next.y;
              const wallSurfaceId = areaIndex === 0 ? `surface-wall-${index + 1}` : `surface-wall-${area.id}-${index + 1}`;
              const wallIndex = wallSurfaces.findIndex((wall) => wall.id === wallSurfaceId);
              const selected = selectedSurfaceId === wallSurfaceId;
              return (
                <Line
                  key={`${floorId}-wall-${index}`}
                  points={[view.x(point.x), view.y(point.y), view.x(next.x), view.y(next.y)]}
                  stroke={selected ? '#8A6AAE' : 'transparent'}
                  strokeWidth={selected ? 18 : 28}
                  opacity={selected ? 0.22 : 1}
                  draggable={roomMoveEnabled && !shapeLocked}
                  dragBoundFunc={(pos) => (horizontal ? { x: 0, y: pos.y } : { x: pos.x, y: 0 })}
                  onClick={(event) => { event.cancelBubble = true; if (wallIndex >= 0) onSelectWall(wallIndex); }}
                  onTap={(event) => { event.cancelBubble = true; if (wallIndex >= 0) onSelectWall(wallIndex); }}
                  onDragEnd={(event) => { event.cancelBubble = true; if (roomMoveEnabled && !shapeLocked) handleWallDrag(event, area.id, index, horizontal, view.scale, onMoveWall); }}
                />
              );
            })}
            {surfaceActive ? area.contour.map((point, index) => <Circle key={`${floorId}-point-${index}`} x={view.x(point.x)} y={view.y(point.y)} radius={6} fill="#8A6AAE" />) : null}
            {(project.room.partitions ?? []).filter((partition) => (partition.areaId ?? areas[0].id) === area.id).map((partition) => (
              <FloorPartition
                key={partition.id}
                contour={area.contour}
                onDelete={() => onDeletePartition(partition.id)}
                onMove={(deltaXmm, deltaYmm) => onMovePartition(partition.id, deltaXmm, deltaYmm)}
                onReset={() => onResetPartition(partition.id)}
                onSelect={() => onSelectPartition(partition.id)}
                partition={partition}
                selected={selectedPartitionId === partition.id}
                view={view}
              />
            ))}
          </Group>
        );
      })}
    </Group>
  );
}

function FloorRoomObject({ contour, object, objects, onDelete, onEdit, onMove, onSelect, selected, view }: {
  contour: PointMm[];
  object: RoomObject;
  objects: RoomObject[];
  onDelete: () => void;
  onMove: (xMm: number, yMm: number) => void;
  onEdit: () => void;
  onSelect: () => void;
  selected: boolean;
  view: PlanViewTransform;
}) {
  const x = view.x(object.xMm);
  const y = view.y(object.yMm);
  const width = mmToCanvas(object.lengthMm);
  const height = mmToCanvas(object.widthMm);
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  function constrainDrag(node: Konva.Node) {
    const proposed = {
      x: object.xMm + Math.round(node.x() / view.scale),
      y: object.yMm + Math.round(node.y() / view.scale),
    };
    const constrained = constrainRoomObjectPosition(contour, object, proposed.x, proposed.y, objects);
    node.position({ x: (constrained.x - object.xMm) * view.scale, y: (constrained.y - object.yMm) * view.scale });
    return constrained;
  }

  return (
    <Group
      name="room-object"
      draggable
      onClick={(event) => { event.cancelBubble = true; onSelect(); }}
      onTap={(event) => { event.cancelBubble = true; onSelect(); }}
      onMouseDown={(event) => { event.cancelBubble = true; onSelect(); }}
      onTouchStart={(event) => { event.cancelBubble = true; onSelect(); }}
      onDragMove={(event) => { event.cancelBubble = true; constrainDrag(event.currentTarget); }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.currentTarget;
        const position = constrainDrag(node);
        node.position({ x: 0, y: 0 });
        onMove(position.x, position.y);
      }}
    >
      <Rect x={x} y={y} width={width} height={height} fill={selected ? '#7A5A97' : '#8A6AAE'} opacity={selected ? 0.62 : 0.42} stroke="#60417E" strokeWidth={selected ? 3 : 2} cornerRadius={Math.min(10, width / 5, height / 5)} />
      <Text x={x + 4} y={centerY - 7} width={Math.max(20, width - 8)} align="center" text={object.name} fill="#FFFFFF" fontSize={11} listening={false} />
      {selected ? <DraftLengthLabel x={centerX} y={y - 18} text={`${object.lengthMm} × ${object.widthMm} мм`} /> : null}
      {selected ? (
        <Group x={centerX - 32} y={y + height + 10}>
          <Group onClick={(event) => { event.cancelBubble = true; onEdit(); }} onTap={(event) => { event.cancelBubble = true; onEdit(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#CDB9DF" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Text x={2} y={2} width={24} height={24} align="center" verticalAlign="middle" text="✎" fill="#6F4F93" fontSize={18} />
          </Group>
          <Group x={36} onClick={(event) => { event.cancelBubble = true; onDelete(); }} onTap={(event) => { event.cancelBubble = true; onDelete(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#E1B7C0" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Line points={[9, 9, 19, 9]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Line points={[11, 7, 17, 7]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Rect x={10} y={11} width={8} height={10} stroke="#A83F57" strokeWidth={1.5} cornerRadius={1} />
          </Group>
        </Group>
      ) : null}
    </Group>
  );
}

function DimensionLabel({ x, y, text, onClick }: { x: number; y: number; text: string; onClick?: () => void }) {
  return (
    <Group x={x} y={y} listening={Boolean(onClick)} onClick={onClick} onTap={onClick}>
      <Rect x={-48} y={-13} width={96} height={26} fill="#FFFFFF" stroke="#D9D9E2" strokeWidth={1} cornerRadius={4} shadowColor="rgba(30, 30, 40, 0.12)" shadowBlur={8} />
      <Text x={-46} y={-7} width={92} align="center" text={text} fill="#18181E" fontSize={14} />
    </Group>
  );
}

function FloorWallDimensionLabels({
  areaId,
  contour,
  index,
  onEdit,
  partitions,
  view,
}: {
  areaId: string;
  contour: PointMm[];
  index: number;
  onEdit?: () => void;
  partitions: Partition[];
  view: PlanViewTransform;
}) {
  const start = contour[index];
  const end = contour[(index + 1) % contour.length];
  const attachedPoints = partitions
    .filter((partition) => (partition.areaId ?? 'room-1') === areaId && isPointOnSegment(partition.start, start, end))
    .map((partition) => partition.start)
    .filter((point) => segmentLength(start, point) > 1 && segmentLength(point, end) > 1)
    .sort((first, second) => segmentLength(start, first) - segmentLength(start, second));

  if (!attachedPoints.length) {
    const label = getFloorSegmentDimensionPosition(contour, start, end, view);
    return <DimensionLabel x={label.x} y={label.y} text={`${segmentLength(start, end)} мм`} onClick={onEdit} />;
  }

  const splitPoints = [start, ...attachedPoints, end].filter((point, pointIndex, points) => pointIndex === 0 || segmentLength(points[pointIndex - 1], point) > 1);
  return (
    <Group>
      {splitPoints.slice(0, -1).map((point, partIndex) => {
        const next = splitPoints[partIndex + 1];
        const label = getFloorSegmentDimensionPosition(contour, point, next, view);
        return <DimensionLabel key={`wall-part-${index}-${partIndex}`} x={label.x} y={label.y} text={`${segmentLength(point, next)} мм`} />;
      })}
    </Group>
  );
}

function FloorPartition({ contour, onDelete, onMove, onReset, onSelect, partition, selected, view }: { contour: PointMm[]; onDelete: () => void; onMove: (deltaXmm: number, deltaYmm: number) => void; onReset: () => void; onSelect: () => void; partition: Partition; selected: boolean; view: PlanViewTransform }) {
  const start = { x: view.x(partition.start.x), y: view.y(partition.start.y) };
  const end = { x: view.x(partition.end.x), y: view.y(partition.end.y) };
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const stripeWidth = Math.max(8, partition.thicknessMm * view.scale);
  const vertical = partition.start.x === partition.end.x;
  return (
    <Group
      name="floor-partition"
      draggable
      onClick={(event) => { event.cancelBubble = true; onSelect(); }}
      onTap={(event) => { event.cancelBubble = true; onSelect(); }}
      onMouseDown={(event) => { event.cancelBubble = true; onSelect(); }}
      onTouchStart={(event) => { event.cancelBubble = true; onSelect(); }}
      onDragStart={(event) => { event.cancelBubble = true; onSelect(); }}
      onDragMove={(event) => {
        event.cancelBubble = true;
        const wallIndex = findBoundarySegmentIndex(contour, partition.start);
        if (wallIndex < 0) return;
        const node = event.currentTarget;
        const proposedStart = {
          x: partition.start.x + node.x() / view.scale,
          y: partition.start.y + node.y() / view.scale,
        };
        const projected = projectPointToSegment(proposedStart, contour[wallIndex], contour[(wallIndex + 1) % contour.length]);
        node.position({
          x: (projected.x - partition.start.x) * view.scale,
          y: (projected.y - partition.start.y) * view.scale,
        });
      }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.currentTarget;
        const deltaXmm = Math.round(node.x() / view.scale);
        const deltaYmm = Math.round(node.y() / view.scale);
        node.position({ x: 0, y: 0 });
        onMove(deltaXmm, deltaYmm);
      }}
    >
      <Line points={[start.x, start.y, end.x, end.y]} stroke={selected ? '#563779' : '#6F4F93'} strokeWidth={stripeWidth + (selected ? 4 : 2)} lineCap="butt" />
      <Line points={[start.x, start.y, end.x, end.y]} stroke={selected ? '#B99FD2' : '#CDB9DF'} strokeWidth={Math.max(4, stripeWidth - 2)} lineCap="butt" />
      <Line points={[start.x, start.y, end.x, end.y]} stroke="transparent" strokeWidth={24} />
      <Circle x={center.x} y={center.y} radius={7} fill="#6F4F93" stroke="#FFFFFF" strokeWidth={2} />
      {selected ? <DraftLengthLabel x={center.x} y={center.y - 22} text={formatDraftLengthMm(partition.start, partition.end)} /> : null}
      {selected ? (
        <>
          <Circle x={start.x} y={start.y} radius={5} fill="#6F4F93" />
          <Circle x={end.x} y={end.y} radius={5} fill="#6F4F93" />
        </>
      ) : null}
      {selected ? (
        <Group x={vertical ? center.x + 62 : center.x - 32} y={vertical ? center.y - 14 : center.y + 30}>
          <Group onClick={(event) => { event.cancelBubble = true; onReset(); }} onTap={(event) => { event.cancelBubble = true; onReset(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#CDB9DF" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Text x={2} y={2} width={24} height={24} align="center" verticalAlign="middle" text="↺" fill="#6F4F93" fontSize={20} />
          </Group>
          <Group x={36} onClick={(event) => { event.cancelBubble = true; onDelete(); }} onTap={(event) => { event.cancelBubble = true; onDelete(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#E1B7C0" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Line points={[9, 9, 19, 9]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Line points={[11, 7, 17, 7]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Rect x={10} y={11} width={8} height={10} stroke="#A83F57" strokeWidth={1.5} cornerRadius={1} />
          </Group>
        </Group>
      ) : null}
    </Group>
  );
}

function FloorOpeningMarkers({
  areaId,
  contour,
  onSelectOpening,
  project,
  selectedOpeningId,
  view,
}: {
  areaId: string;
  contour: PointMm[];
  onSelectOpening: (surfaceId: string, openingId: string) => void;
  project: TileProject;
  selectedOpeningId: string | null;
  view: PlanViewTransform;
}) {
  return (
    <Group>
      {contour.flatMap((point, index) => {
        const next = contour[(index + 1) % contour.length];
        const surface = project.surfaces.find((item) => item.type === 'wall' && item.sourceRef === `wall:${areaId}:${index + 1}`);
        if (!surface) return [];
        const wallLength = Math.max(1, segmentLength(point, next));
        const vectorX = (next.x - point.x) / wallLength;
        const vectorY = (next.y - point.y) / wallLength;
        return surface.openings.map((opening) => {
          const startOffset = Math.max(0, Math.min(opening.xMm, Math.max(0, wallLength - opening.widthMm)));
          const endOffset = Math.max(startOffset, Math.min(opening.xMm + opening.widthMm, wallLength));
          const start = { x: point.x + vectorX * startOffset, y: point.y + vectorY * startOffset };
          const end = { x: point.x + vectorX * endOffset, y: point.y + vectorY * endOffset };
          const selected = selectedOpeningId === opening.id;
          const labelX = (view.x(start.x) + view.x(end.x)) / 2;
          const labelY = (view.y(start.y) + view.y(end.y)) / 2;
          return (
            <Group key={`floor-opening-${opening.id}`}>
              <Line
                points={[view.x(start.x), view.y(start.y), view.x(end.x), view.y(end.y)]}
                stroke={selected ? '#563779' : '#765594'}
                strokeWidth={selected ? 14 : 10}
                lineCap="round"
                opacity={selected ? 0.88 : 0.62}
                onClick={(event) => { event.cancelBubble = true; onSelectOpening(surface.id, opening.id); }}
                onTap={(event) => { event.cancelBubble = true; onSelectOpening(surface.id, opening.id); }}
              />
              {opening.kind !== 'window' ? <Text x={labelX - 38} y={labelY - 25} width={76} align="center" text={getOpeningDisplayName(opening)} fill="#563779" fontSize={11} listening={false} /> : null}
            </Group>
          );
        });
      })}
    </Group>
  );
}

function WallsLayer({
  dimensionsVisible,
  frames,
  sections,
  onChangeHeight,
  onDeleteObject,
  onDeleteOpening,
  onEditObject,
  onEditLayoutOffset,
  onEditSegment,
  onMoveOpening,
  onMoveObjectOnWall,
  onRenameArea,
  onResizeOpening,
  onResetOpening,
  onSelectObject,
  onSelectOpening,
  onSelectWall,
  onSelectZone,
  onZoneShapeChange,
  project,
  selectedOpeningId,
  selectedObjectId,
  selectedSurfaceId,
  selectedZoneId,
  selectedWallIndex,
  onToggleArea,
}: {
  dimensionsVisible: boolean;
  frames: WallFrame[];
  sections: WallAreaSection[];
  onChangeHeight: (areaId: string, value: string) => void;
  onDeleteObject: (objectId: string) => void;
  onDeleteOpening: (openingId: string) => void;
  onEditLayoutOffset: (target: EditTarget) => void;
  onEditSegment: (target: EditTarget) => void;
  onMoveOpening: (openingId: string, xMm: number, yMm?: number) => void;
  onMoveObjectOnWall: (objectId: string, surfaceId: string, offsetMm: number, elevationMm: number) => void;
  onRenameArea: (areaId: string) => void;
  onEditObject: (objectId: string) => void;
  onResizeOpening: (openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) => void;
  onResetOpening: (openingId: string) => void;
  onSelectObject: (objectId: string | null) => void;
  onSelectOpening: (surfaceId: string, openingId: string) => void;
  onSelectWall: (index: number | null) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedOpeningId: string | null;
  selectedObjectId: string | null;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
  onToggleArea: (areaId: string) => void;
}) {
  const firstFramesByArea = frames.filter((frame, index) => frames.findIndex((item) => item.areaId === frame.areaId) === index);
  const titleY = sections[0] ? sections[0].headerY - 38 : 372;

  function resizeWallHeightFromPointer(event: Konva.KonvaEventObject<DragEvent>, areaFrame: WallFrame, heightMarkerX: number) {
    event.cancelBubble = true;
    const node = event.currentTarget;
    const pointer = node.getStage()?.getPointerPosition();
    const parent = node.getParent();
    if (!pointer || !parent) return;
    const localPointer = parent.getAbsoluteTransform().copy().invert().point(pointer);
    const nextHeightMm = Math.max(1800, Math.min(4500, Math.round(canvasToMm(localPointer.y - areaFrame.y))));
    node.position({ x: heightMarkerX, y: areaFrame.y + mmToCanvas(nextHeightMm) });
    if (nextHeightMm !== areaFrame.heightMm) onChangeHeight(areaFrame.areaId, String(nextHeightMm));
  }

  return (
    <Group>
      <Text x={54} y={titleY} text="Стены" fill="#6B6B80" fontSize={18} />
      {sections.map((section) => (
        <Group
          key={`wall-section-${section.areaId}`}
          onClick={(event) => { event.cancelBubble = true; onToggleArea(section.areaId); }}
          onTap={(event) => { event.cancelBubble = true; onToggleArea(section.areaId); }}
        >
          <Rect
            x={section.x}
            y={section.headerY}
            width={section.width}
            height={34}
            fill={section.expanded ? '#F2EBF9' : '#F8F5FB'}
            stroke="#CDB9DF"
            strokeWidth={1}
            cornerRadius={8}
            shadowColor="rgba(45, 31, 58, 0.08)"
            shadowBlur={5}
          />
          <Text x={section.x + 14} y={section.headerY + 9} text={section.name} fill="#4E4458" fontSize={14} />
          <Text
            x={section.x + section.width - 68}
            y={section.headerY + 7}
            width={24}
            align="center"
            text="✎"
            fill="#8A6AAE"
            fontSize={17}
            onClick={(event) => { event.cancelBubble = true; onRenameArea(section.areaId); }}
            onTap={(event) => { event.cancelBubble = true; onRenameArea(section.areaId); }}
          />
          <Text x={section.x + section.width - 34} y={section.headerY + 9} width={20} align="center" text={section.expanded ? '▲' : '▼'} fill="#8A6AAE" fontSize={13} />
        </Group>
      ))}
      {frames.map((frame) => {
        const active = selectedSurfaceId === frame.id;
        const layoutOpacity = selectedSurfaceId && !active ? 0.38 : 1;
        const surface = project.surfaces.find((item) => item.id === frame.id);
        const material = surface?.zones[0]?.materialId ? project.materials.find((item) => item.id === surface.zones[0]?.materialId) : null;
        const layout = surface?.zones[0]?.layout;
        return (
          <Group
            key={frame.id}
            onClick={(event) => {
              if (!event.target.findAncestor('.wall-opening')) onSelectWall(frame.index);
            }}
            onTap={(event) => {
              if (!event.target.findAncestor('.wall-opening')) onSelectWall(frame.index);
            }}
          >
            <Rect
              x={frame.x}
              y={frame.y}
              width={frame.width}
              height={frame.height}
              fill={active ? '#F2EBF9' : '#FFFFFF'}
            />
            {material && layout && surface?.zones[0] ? (
              <WallTileLayout
                frame={frame}
                layout={layout}
                material={material}
                onDeleteOpening={onDeleteOpening}
                onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: frame.id, zoneId: surface.zones[0]!.id })}
                onMoveOpening={onMoveOpening}
                onResizeOpening={onResizeOpening}
                onResetOpening={onResetOpening}
                onSelectOpening={(openingId) => onSelectOpening(frame.id, openingId)}
                openings={surface.openings}
                objectBlockers={project.objects.flatMap((object) => {
                  if (!object.excludeTile) return [];
                  const projection = getRoomObjectWallProjection(project, frame.id, object);
                  return projection ? [{ type: 'rect' as const, xMm: projection.offsetMm, yMm: Math.max(0, frame.heightMm - object.elevationMm - object.heightMm), widthMm: projection.widthMm, heightMm: object.heightMm }] : [];
                })}
                opacity={layoutOpacity}
                selectedOpeningId={selectedOpeningId}
                showEdgeCuts={active && !selectedZoneId && !selectedOpeningId}
              />
            ) : null}
            {surface?.zones.slice(1).map((zone) => {
              const zoneMaterial = zone.materialId ? project.materials.find((item) => item.id === zone.materialId) : null;
              if (!zoneMaterial || zone.shape.type !== 'rect') return null;
              return (
                <WallZoneLayer
                  frame={frame}
                  key={zone.id}
                  material={zoneMaterial}
                  onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: frame.id, zoneId: zone.id })}
                  onSelect={() => onSelectZone(frame.id, zone.id)}
                  onShapeChange={(patch) => onZoneShapeChange(frame.id, zone.id, patch)}
                  opacity={active && selectedZoneId !== zone.id ? 0.48 : 1}
                  selected={selectedZoneId === zone.id}
                  zone={zone}
                />
              );
            })}
            {project.objects.flatMap((object) => {
              const projection = getRoomObjectWallProjection(project, frame.id, object);
              if (!projection) return [];
              return [(
                <WallRoomObject
                  key={`wall-object-${frame.id}-${object.id}`}
                  frame={frame}
                  object={object}
                  onDelete={() => onDeleteObject(object.id)}
                  onEdit={() => onEditObject(object.id)}
                  onMove={(offsetMm, elevationMm) => onMoveObjectOnWall(object.id, frame.id, offsetMm, elevationMm)}
                  onSelect={() => onSelectObject(object.id)}
                  projection={projection}
                  selected={selectedObjectId === object.id}
                />
              )];
            })}
            <Rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} stroke={active ? '#8A6AAE' : '#D0D0D8'} strokeWidth={active ? 3 : 1} listening={false} />
            <Text x={frame.x} y={frame.y - 21} width={frame.width} align="center" text={frame.name} fill="#6B6B80" fontSize={13} listening={false} />
            {dimensionsVisible ? (
              <DimensionLabel
                x={frame.x + frame.width / 2}
                y={frame.y + frame.height + 50}
                text={`${frame.widthMm} мм`}
                onClick={() => onEditSegment({ type: 'wall-segment', areaId: frame.areaId, index: frame.segmentIndex, surfaceId: frame.id })}
              />
            ) : null}
          </Group>
        );
      })}
      {dimensionsVisible ? firstFramesByArea.map((areaFrame) => {
        const heightMarkerX = areaFrame.x - 90;
        return (
          <Group key={`height-${areaFrame.areaId}`}>
            <Line points={[heightMarkerX, areaFrame.y, heightMarkerX, areaFrame.y + areaFrame.height]} stroke="#8F8FA3" strokeWidth={1.5} />
            <Line points={[heightMarkerX - 6, areaFrame.y, heightMarkerX + 6, areaFrame.y]} stroke="#8F8FA3" strokeWidth={1.5} />
            <Line points={[heightMarkerX - 6, areaFrame.y + areaFrame.height, heightMarkerX + 6, areaFrame.y + areaFrame.height]} stroke="#8F8FA3" strokeWidth={1.5} />
            <DimensionLabel x={heightMarkerX - 54} y={areaFrame.y + areaFrame.height / 2} text={`${areaFrame.heightMm} мм`} onClick={() => onEditSegment({ type: 'wall-height', areaId: areaFrame.areaId })} />
            <Circle
              x={heightMarkerX}
              y={areaFrame.y + areaFrame.height}
              radius={6}
              fill="#FFFFFF"
              stroke="#6F4F93"
              strokeWidth={2}
              draggable
              onMouseDown={(event) => { event.cancelBubble = true; }}
              onTouchStart={(event) => { event.cancelBubble = true; }}
              onDragStart={(event) => { event.cancelBubble = true; }}
              onDragMove={(event) => resizeWallHeightFromPointer(event, areaFrame, heightMarkerX)}
              onDragEnd={(event) => resizeWallHeightFromPointer(event, areaFrame, heightMarkerX)}
            />
          </Group>
        );
      }) : null}
    </Group>
  );
}

function WallRoomObject({ frame, object, onDelete, onEdit, onMove, onSelect, projection, selected }: {
  frame: WallFrame;
  object: RoomObject;
  onDelete: () => void;
  onEdit: () => void;
  onMove: (offsetMm: number, elevationMm: number) => void;
  onSelect: () => void;
  projection: { offsetMm: number; widthMm: number };
  selected: boolean;
}) {
  const width = Math.max(8, mmToCanvas(projection.widthMm));
  const heightMm = Math.min(object.heightMm, frame.heightMm);
  const height = Math.max(8, mmToCanvas(heightMm));
  const x = frame.x + mmToCanvas(projection.offsetMm);
  const y = frame.y + frame.height - mmToCanvas(object.elevationMm + heightMm);

  function constrainWallDrag(node: Konva.Node) {
    const nextX = Math.max(frame.x, Math.min(node.x(), frame.x + frame.width - width));
    const nextY = Math.max(frame.y, Math.min(node.y(), frame.y + frame.height - height));
    node.position({ x: nextX, y: nextY });
    return { x: nextX, y: nextY };
  }

  return (
    <Group
      name="wall-room-object"
      x={x}
      y={y}
      draggable
      onClick={(event) => { event.cancelBubble = true; onSelect(); }}
      onTap={(event) => { event.cancelBubble = true; onSelect(); }}
      onMouseDown={(event) => { event.cancelBubble = true; onSelect(); }}
      onTouchStart={(event) => { event.cancelBubble = true; onSelect(); }}
      onDragMove={(event) => { event.cancelBubble = true; constrainWallDrag(event.currentTarget); }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const position = constrainWallDrag(event.currentTarget);
        const offsetMm = Math.round(canvasToMm(position.x - frame.x));
        const topMm = Math.round(canvasToMm(position.y - frame.y));
        onMove(offsetMm, Math.max(0, frame.heightMm - topMm - heightMm));
      }}
    >
      <Rect width={width} height={height} fill={selected ? '#765594' : '#8A6AAE'} opacity={selected ? 0.72 : 0.48} stroke="#60417E" strokeWidth={selected ? 3 : 2} cornerRadius={6} />
      <Text x={4} y={Math.max(4, height / 2 - 7)} width={Math.max(20, width - 8)} align="center" text={object.name} fill="#FFFFFF" fontSize={11} listening={false} />
      {selected ? <DraftLengthLabel x={width / 2} y={-18} text={`${projection.widthMm} × ${object.heightMm} мм`} /> : null}
      {selected ? (
        <Group x={width / 2 - 32} y={height + 9}>
          <Group onClick={(event) => { event.cancelBubble = true; onEdit(); }} onTap={(event) => { event.cancelBubble = true; onEdit(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#CDB9DF" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Text x={2} y={2} width={24} height={24} align="center" verticalAlign="middle" text="✎" fill="#6F4F93" fontSize={18} />
          </Group>
          <Group x={36} onClick={(event) => { event.cancelBubble = true; onDelete(); }} onTap={(event) => { event.cancelBubble = true; onDelete(); }}>
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#E1B7C0" cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Line points={[9, 9, 19, 9]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Line points={[11, 7, 17, 7]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Rect x={10} y={11} width={8} height={10} stroke="#A83F57" strokeWidth={1.5} cornerRadius={1} />
          </Group>
        </Group>
      ) : null}
    </Group>
  );
}

function WallTileLayout({
  frame,
  layout,
  material,
  onDeleteOpening,
  onEditOffset,
  onMoveOpening,
  onResizeOpening,
  onResetOpening,
  onSelectOpening,
  objectBlockers,
  openings,
  opacity,
  selectedOpeningId,
  showEdgeCuts,
}: {
  frame: WallFrame;
  layout: SurfaceLayout;
  material: TileMaterial;
  onDeleteOpening: (openingId: string) => void;
  onEditOffset: (edge: keyof LayoutEdgeCuts) => void;
  onMoveOpening: (openingId: string, xMm: number, yMm?: number) => void;
  onResizeOpening: (openingId: string, patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) => void;
  onResetOpening: (openingId: string) => void;
  onSelectOpening: (openingId: string) => void;
  objectBlockers: Array<{ type: 'rect'; xMm: number; yMm: number; widthMm: number; heightMm: number }>;
  openings: Opening[];
  opacity: number;
  selectedOpeningId: string | null;
  showEdgeCuts: boolean;
}) {
  const result = generateRectLayout({
    blockedRects: openings.map((opening) => ({ type: 'rect' as const, xMm: opening.xMm, yMm: opening.yMm, widthMm: opening.widthMm, heightMm: opening.heightMm })),
    heightMm: frame.heightMm,
    layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: frame.widthMm,
  });

  return (
    <Group opacity={opacity}>
      <Group clipX={frame.x} clipY={frame.y} clipWidth={frame.width} clipHeight={frame.height}>
      {result.pieces.map((piece) => (
        <Rect
          key={piece.id}
          x={frame.x + mmToCanvas(piece.xMm)}
          y={frame.y + mmToCanvas(piece.yMm)}
          width={Math.max(1, mmToCanvas(piece.widthMm))}
          height={Math.max(1, mmToCanvas(piece.heightMm))}
          fill={getLayoutPieceFill(piece.kind)}
          stroke={getLayoutPieceStroke(piece.kind)}
          strokeWidth={0.7}
        />
      ))}
      {objectBlockers.map((blocker, index) => (
        <Rect
          key={`object-mask-${index}`}
          x={frame.x + mmToCanvas(blocker.xMm)}
          y={frame.y + mmToCanvas(blocker.yMm)}
          width={mmToCanvas(blocker.widthMm)}
          height={mmToCanvas(blocker.heightMm)}
          fill="#FFFFFF"
          listening={false}
        />
      ))}
      {result.truncated ? <Text x={frame.x + 12} y={frame.y + frame.height - 28} text="Сетка упрощена" fill="#6F4F93" fontSize={13} /> : null}
      </Group>
      {showEdgeCuts ? <EdgeCutLabels edgeCuts={result.edgeOffsets} height={frame.height} onEditOffset={onEditOffset} width={frame.width} x={frame.x} y={frame.y} /> : null}
      {openings.map((opening) => (
        <WallOpening
          key={opening.id}
          frame={frame}
          opening={opening}
          onDelete={() => onDeleteOpening(opening.id)}
          onMove={(xMm, yMm) => onMoveOpening(opening.id, xMm, yMm)}
          onResize={(patch) => onResizeOpening(opening.id, patch)}
          onReset={() => onResetOpening(opening.id)}
          onSelect={() => onSelectOpening(opening.id)}
          selected={selectedOpeningId === opening.id}
        />
      ))}
    </Group>
  );
}

function WallOpening({
  frame,
  onDelete,
  onMove,
  onResize,
  onReset,
  onSelect,
  opening,
  selected,
}: {
  frame: WallFrame;
  onDelete: () => void;
  onMove: (xMm: number, yMm?: number) => void;
  onResize: (patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) => void;
  onReset: () => void;
  onSelect: () => void;
  opening: Opening;
  selected: boolean;
}) {
  const openingWidth = mmToCanvas(opening.widthMm);
  const openingHeight = mmToCanvas(opening.heightMm);
  const openingXmm = Math.max(0, Math.min(opening.xMm, Math.max(0, frame.widthMm - opening.widthMm)));
  const openingYmm = Math.max(0, Math.min(opening.yMm, Math.max(0, frame.heightMm - opening.heightMm)));
  const openingY = frame.y + mmToCanvas(openingYmm);

  return (
    <Group
      name="wall-opening"
      x={frame.x + mmToCanvas(openingXmm)}
      y={openingY}
      draggable
      onDragStart={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onDragMove={(event) => {
        event.cancelBubble = true;
        const node = event.currentTarget;
        node.position({
          x: Math.max(frame.x, Math.min(node.x(), frame.x + frame.width - openingWidth)),
          y: opening.kind === 'window' ? Math.max(frame.y, Math.min(node.y(), frame.y + frame.height - openingHeight)) : openingY,
        });
      }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.currentTarget;
        const x = Math.max(frame.x, Math.min(node.x(), frame.x + frame.width - openingWidth));
        const y = opening.kind === 'window' ? Math.max(frame.y, Math.min(node.y(), frame.y + frame.height - openingHeight)) : openingY;
        node.position({ x, y });
        onMove(canvasToMm(x - frame.x), opening.kind === 'window' ? canvasToMm(y - frame.y) : undefined);
      }}
      onMouseDown={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onTouchStart={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onClick={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onTap={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onMouseEnter={(event) => {
        const stage = event.target.getStage();
        if (stage) stage.container().style.cursor = 'ew-resize';
      }}
      onMouseLeave={(event) => {
        const stage = event.target.getStage();
        if (stage) stage.container().style.cursor = 'default';
      }}
    >
      <Rect
        width={openingWidth}
        height={openingHeight}
        fill={selected ? '#EEE2F8' : '#FFFFFF'}
        stroke={selected ? '#6F4F93' : '#A385C4'}
        strokeWidth={selected ? 3 : 1.5}
        dash={[8, 6]}
      />
      <Text y={8} width={openingWidth} align="center" text={getOpeningDisplayName(opening)} fill="#6F4F93" fontSize={12} listening={false} />
      {selected ? <OpeningResizeHandles height={openingHeight} onResize={onResize} opening={opening} width={openingWidth} /> : null}
      {selected ? (
        <>
          <DimensionLabel x={openingWidth / 2} y={-22} text={`${opening.widthMm} мм`} />
          <DimensionLabel x={openingWidth + 58} y={openingHeight / 2} text={`${opening.heightMm} мм`} />
        <Group x={-70} y={4}>
          <Group
            onClick={(event) => {
              event.cancelBubble = true;
              onReset();
            }}
            onTap={(event) => {
              event.cancelBubble = true;
              onReset();
            }}
          >
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#CDB9DF" strokeWidth={1} cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Text x={2} y={2} width={24} height={24} align="center" verticalAlign="middle" text="↺" fill="#6F4F93" fontSize={20} />
          </Group>
          <Group
            x={36}
            onClick={(event) => {
              event.cancelBubble = true;
              onDelete();
            }}
            onTap={(event) => {
              event.cancelBubble = true;
              onDelete();
            }}
          >
            <Rect width={28} height={28} fill="#FFFFFF" stroke="#E1B7C0" strokeWidth={1} cornerRadius={6} shadowColor="rgba(38, 24, 50, 0.16)" shadowBlur={6} />
            <Line points={[9, 9, 19, 9]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Line points={[11, 7, 17, 7]} stroke="#A83F57" strokeWidth={1.7} lineCap="round" />
            <Rect x={10} y={11} width={8} height={10} stroke="#A83F57" strokeWidth={1.5} cornerRadius={1} />
          </Group>
        </Group>
        </>
      ) : null}
    </Group>
  );
}

type OpeningResizeHandle = 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br';

function getOpeningDisplayName(opening: Opening): string {
  if (opening.kind === 'window') return 'Окно';
  return `${opening.kind === 'door' ? 'Дверь' : 'Проход'} ${opening.number ?? ''}`.trim();
}

function OpeningResizeHandles({ height, onResize, opening, width }: { height: number; onResize: (patch: Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>) => void; opening: Opening; width: number }) {
  const dragSessions = useRef<Record<string, { opening: Opening; pointerX: number; pointerY: number; scaleX: number; scaleY: number }>>({});
  const handles: Array<{ key: OpeningResizeHandle; x: number; y: number }> = opening.kind === 'window'
    ? [
        { key: 'tl', x: 0, y: 0 },
        { key: 'tr', x: width, y: 0 },
        { key: 'bl', x: 0, y: height },
        { key: 'br', x: width, y: height },
      ]
    : opening.kind === 'door'
      ? [{ key: 'tl', x: 0, y: 0 }, { key: 'tr', x: width, y: 0 }]
      : [{ key: 'left', x: 0, y: height / 2 }, { key: 'right', x: width, y: height / 2 }];

  function applyPointer(handle: OpeningResizeHandle, node: Konva.Node) {
    const session = dragSessions.current[handle];
    const pointer = node.getStage()?.getPointerPosition();
    if (!session || !pointer) return;
    const deltaXmm = canvasToMm((pointer.x - session.pointerX) / session.scaleX);
    const deltaYmm = canvasToMm((pointer.y - session.pointerY) / session.scaleY);
    onResize(getOpeningResizePatch(session.opening, handle, deltaXmm, deltaYmm));
  }

  return (
    <Group>
      {handles.map((handle) => (
        <Circle
          key={handle.key}
          x={handle.x}
          y={handle.y}
          radius={7}
          fill="#FFFFFF"
          stroke="#6F4F93"
          strokeWidth={2}
          draggable
          onDragStart={(event) => {
            event.cancelBubble = true;
            const node = event.currentTarget;
            const pointer = node.getStage()?.getPointerPosition();
            if (!pointer) return;
            const scale = node.getAbsoluteScale();
            dragSessions.current[handle.key] = { opening: { ...opening }, pointerX: pointer.x, pointerY: pointer.y, scaleX: scale.x || 1, scaleY: scale.y || 1 };
          }}
          onMouseDown={(event) => { event.cancelBubble = true; }}
          onTouchStart={(event) => { event.cancelBubble = true; }}
          onDragMove={(event) => {
            event.cancelBubble = true;
            applyPointer(handle.key, event.currentTarget);
          }}
          onDragEnd={(event) => {
            event.cancelBubble = true;
            const node = event.currentTarget;
            applyPointer(handle.key, node);
            node.position({ x: handle.x, y: handle.y });
            delete dragSessions.current[handle.key];
          }}
        />
      ))}
    </Group>
  );
}

function getOpeningResizePatch(opening: Opening, handle: OpeningResizeHandle, deltaXmm: number, deltaYmm: number): Pick<Opening, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'> {
  const left = handle === 'left' || handle === 'tl' || handle === 'bl';
  const right = handle === 'right' || handle === 'tr' || handle === 'br';
  const top = handle === 'tl' || handle === 'tr';
  const bottom = handle === 'bl' || handle === 'br';
  if (opening.kind === 'passage') {
    return {
      xMm: left ? opening.xMm + deltaXmm : opening.xMm,
      yMm: opening.yMm,
      widthMm: opening.widthMm + (left ? -deltaXmm : right ? deltaXmm : 0),
      heightMm: opening.heightMm,
    };
  }
  if (opening.kind === 'door') {
    return {
      xMm: left ? opening.xMm + deltaXmm : opening.xMm,
      yMm: opening.yMm + deltaYmm,
      widthMm: opening.widthMm + (left ? -deltaXmm : right ? deltaXmm : 0),
      heightMm: opening.heightMm - deltaYmm,
    };
  }
  return {
    xMm: left ? opening.xMm + deltaXmm : opening.xMm,
    yMm: top ? opening.yMm + deltaYmm : opening.yMm,
    widthMm: opening.widthMm + (left ? -deltaXmm : right ? deltaXmm : 0),
    heightMm: opening.heightMm + (top ? -deltaYmm : bottom ? deltaYmm : 0),
  };
}

function WallZoneLayer({
  frame,
  material,
  onEditOffset,
  onSelect,
  onShapeChange,
  opacity,
  selected,
  zone,
}: {
  frame: WallFrame;
  material: TileMaterial;
  onEditOffset: (edge: keyof LayoutEdgeCuts) => void;
  onSelect: () => void;
  onShapeChange: (patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  opacity: number;
  selected: boolean;
  zone: FinishZone;
}) {
  if (zone.shape.type !== 'rect') return null;
  const shape = zone.shape;
  const result = generateRectLayout({
    heightMm: shape.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: shape.widthMm,
  });
  const x = frame.x + mmToCanvas(shape.xMm);
  const y = frame.y + mmToCanvas(shape.yMm);
  const width = mmToCanvas(shape.widthMm);
  const height = mmToCanvas(shape.heightMm);

  return (
    <Group
      opacity={opacity}
      draggable={selected}
      onClick={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onTap={(event) => {
        event.cancelBubble = true;
        onSelect();
      }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.target;
        onShapeChange({ xMm: shape.xMm + canvasToMm(node.x()), yMm: shape.yMm + canvasToMm(node.y()) });
        node.position({ x: 0, y: 0 });
      }}
    >
      <Group clipX={x} clipY={y} clipWidth={width} clipHeight={height}>
        {result.pieces.map((piece) => (
          <Rect
            key={piece.id}
            x={x + mmToCanvas(piece.xMm)}
            y={y + mmToCanvas(piece.yMm)}
            width={Math.max(1, mmToCanvas(piece.widthMm))}
            height={Math.max(1, mmToCanvas(piece.heightMm))}
            fill={getFloorLayoutPieceFill(piece.kind)}
            stroke={getLayoutPieceStroke(piece.kind)}
            strokeWidth={0.7}
          />
        ))}
      </Group>
      <Rect x={x} y={y} width={width} height={height} fill="rgba(242, 235, 249, 0.16)" stroke={selected ? '#6F4F93' : '#A385C4'} strokeWidth={selected ? 3 : 1.5} dash={selected ? undefined : [8, 6]} />
      <Text x={x + 10} y={y + 10} text={zone.name} fill="#6F4F93" fontSize={13} fontStyle="bold" />
      {selected ? <ZoneResizeHandles height={height} onResize={onShapeChange} shape={shape} width={width} x={x} y={y} /> : null}
      {selected ? <EdgeCutLabels edgeCuts={result.edgeOffsets} height={height} onEditOffset={onEditOffset} width={width} x={x} y={y} /> : null}
    </Group>
  );
}

type SurfaceLayout = TileProject['surfaces'][number]['zones'][number]['layout'];

function FloorTileLayout({ blockedObjects, contour, layout, layoutBounds, material, opacity, view }: { blockedObjects: RoomObject[]; contour: PointMm[]; layout: SurfaceLayout; layoutBounds?: ReturnType<typeof getBoundingBox>; material: TileMaterial; opacity: number; view: PlanViewTransform }) {
  const box = layoutBounds ?? getBoundingBox(contour);
  // Render whole tiles and clip the finished layout by the room contour. The
  // polygon layout engine may split one tile into several calculation pieces
  // for concave rooms; outlining those pieces exposes artificial inner seams.
  const result = generateRectLayout({
    heightMm: box.height,
    layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: box.width,
  });

  return (
    <Group
      opacity={opacity}
      clipFunc={(context) => {
        if (!contour.length) return;
        context.beginPath();
        context.moveTo(view.x(contour[0].x), view.y(contour[0].y));
        for (const point of contour.slice(1)) context.lineTo(view.x(point.x), view.y(point.y));
        context.closePath();
      }}
    >
      {result.pieces.map((piece) =>
        piece.polygon ? (
          <Line
            key={piece.id}
            points={piece.polygon.flatMap((point) => [view.x(point.x + box.minX), view.y(point.y + box.minY)])}
            closed
            fill={getFloorLayoutPieceFill(piece.kind)}
            stroke={getLayoutPieceStroke(piece.kind)}
            strokeWidth={0.7}
          />
        ) : (
          <Rect
            key={piece.id}
            x={view.x(piece.xMm + box.minX)}
            y={view.y(piece.yMm + box.minY)}
            width={Math.max(1, mmToCanvas(piece.widthMm))}
            height={Math.max(1, mmToCanvas(piece.heightMm))}
            fill={getFloorLayoutPieceFill(piece.kind)}
            stroke={getLayoutPieceStroke(piece.kind)}
            strokeWidth={0.7}
          />
        ),
      )}
      {blockedObjects.map((object) => (
        <Rect
          key={`floor-object-mask-${object.id}`}
          x={view.x(object.xMm)}
          y={view.y(object.yMm)}
          width={mmToCanvas(object.lengthMm)}
          height={mmToCanvas(object.widthMm)}
          fill="#FFFFFF"
          listening={false}
        />
      ))}
      {result.truncated ? <Text x={54} y={112} text="Сетка упрощена" fill="#6F4F93" fontSize={13} /> : null}
    </Group>
  );
}

function FloorZoneLayer({
  material,
  onEditOffset,
  onSelect,
  onShapeChange,
  opacity,
  selected,
  view,
  zone,
}: {
  material: TileMaterial;
  onEditOffset: (edge: keyof LayoutEdgeCuts) => void;
  onSelect: () => void;
  onShapeChange: (patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  opacity: number;
  selected: boolean;
  view: PlanViewTransform;
  zone: FinishZone;
}) {
  if (zone.shape.type === 'polygon') {
    return (
      <Group onClick={onSelect} onTap={onSelect}>
        <FloorTileLayout blockedObjects={[]} contour={zone.shape.points} layout={zone.layout} material={material} opacity={opacity} view={view} />
        {selected ? <FloorEdgeCutLabels contour={zone.shape.points} layout={zone.layout} material={material} onEditOffset={onEditOffset} view={view} /> : null}
      </Group>
    );
  }

  const shape = zone.shape;
  const result = generateRectLayout({
    heightMm: shape.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: shape.widthMm,
  });
  const x = view.x(shape.xMm);
  const y = view.y(shape.yMm);
  const width = mmToCanvas(shape.widthMm);
  const height = mmToCanvas(shape.heightMm);

  return (
    <Group
      opacity={opacity}
      draggable={selected}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.target;
        const nextX = shape.xMm + canvasToMm(node.x());
        const nextY = shape.yMm + canvasToMm(node.y());
        node.position({ x: 0, y: 0 });
        onShapeChange({ xMm: nextX, yMm: nextY });
      }}
    >
      <Group clipX={x} clipY={y} clipWidth={width} clipHeight={height}>
        {result.pieces.map((piece) => (
          <Rect
            key={piece.id}
            x={x + mmToCanvas(piece.xMm)}
            y={y + mmToCanvas(piece.yMm)}
            width={Math.max(1, mmToCanvas(piece.widthMm))}
            height={Math.max(1, mmToCanvas(piece.heightMm))}
            fill={getLayoutPieceFill(piece.kind)}
            stroke={getLayoutPieceStroke(piece.kind)}
            strokeWidth={0.7}
          />
        ))}
      </Group>
      <Rect x={x} y={y} width={width} height={height} fill="rgba(242, 235, 249, 0.16)" stroke={selected ? '#6F4F93' : '#A385C4'} strokeWidth={selected ? 3 : 1.5} dash={selected ? undefined : [8, 6]} />
      <Text x={x + 10} y={y + 10} text={zone.name} fill="#6F4F93" fontSize={13} fontStyle="bold" />
      {selected ? <ZoneResizeHandles height={height} onResize={onShapeChange} shape={zone.shape} width={width} x={x} y={y} /> : null}
      {selected ? <EdgeCutLabels edgeCuts={result.edgeOffsets} height={height} onEditOffset={onEditOffset} width={width} x={x} y={y} /> : null}
    </Group>
  );
}

function ZoneResizeHandles({
  height,
  onResize,
  shape,
  width,
  x,
  y,
}: {
  height: number;
  onResize: (patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  shape: Extract<FinishZone['shape'], { type: 'rect' }>;
  width: number;
  x: number;
  y: number;
}) {
  const handles = [
    { cursor: 'nwse-resize', id: 'tl', x, y },
    { cursor: 'nesw-resize', id: 'tr', x: x + width, y },
    { cursor: 'nwse-resize', id: 'br', x: x + width, y: y + height },
    { cursor: 'nesw-resize', id: 'bl', x, y: y + height },
  ];
  return (
    <>
      {handles.map((handle) => (
        <Circle
          key={handle.id}
          x={handle.x}
          y={handle.y}
          radius={6}
          fill="#FFFFFF"
          stroke="#6F4F93"
          strokeWidth={2}
          draggable
          onMouseEnter={(event) => {
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = handle.cursor;
          }}
          onMouseLeave={(event) => {
            const container = event.target.getStage()?.container();
            if (container) container.style.cursor = 'default';
          }}
          onDragEnd={(event) => {
            event.cancelBubble = true;
            const dx = canvasToMm(event.target.x() - handle.x);
            const dy = canvasToMm(event.target.y() - handle.y);
            event.target.position({ x: handle.x, y: handle.y });
            if (handle.id === 'tl') onResize({ heightMm: shape.heightMm - dy, widthMm: shape.widthMm - dx, xMm: shape.xMm + dx, yMm: shape.yMm + dy });
            if (handle.id === 'tr') onResize({ heightMm: shape.heightMm - dy, widthMm: shape.widthMm + dx, yMm: shape.yMm + dy });
            if (handle.id === 'br') onResize({ heightMm: shape.heightMm + dy, widthMm: shape.widthMm + dx });
            if (handle.id === 'bl') onResize({ heightMm: shape.heightMm + dy, widthMm: shape.widthMm - dx, xMm: shape.xMm + dx });
          }}
        />
      ))}
    </>
  );
}

function FloorEdgeCutLabels({ contour, layout, material, onEditOffset, view }: { contour: PointMm[]; layout: SurfaceLayout; material: TileMaterial; onEditOffset: (edge: keyof LayoutEdgeCuts) => void; view: PlanViewTransform }) {
  const box = getBoundingBox(contour);
  const result = generatePolygonLayout({
    layout,
    points: contour,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
  });
  return <EdgeCutLabels edgeCuts={result.edgeOffsets} height={mmToCanvas(box.height)} onEditOffset={onEditOffset} width={mmToCanvas(box.width)} x={view.x(box.minX)} y={view.y(box.minY)} />;
}

function EdgeCutLabels({ edgeCuts, height, onEditOffset, width, x, y }: { edgeCuts: LayoutEdgeCuts; height: number; onEditOffset: (edge: keyof LayoutEdgeCuts) => void; width: number; x: number; y: number }) {
  const top = edgeCuts.top ?? 0;
  const bottom = edgeCuts.bottom ?? 0;
  const left = edgeCuts.left ?? 0;
  const right = edgeCuts.right ?? 0;
  return (
    <Group>
      {top > 0 ? <SmallMetricLabel x={x + width / 2} y={y - 20} text={`${top} мм`} onClick={() => onEditOffset('top')} /> : null}
      {bottom > 0 ? <SmallMetricLabel x={x + width / 2} y={y + height + 20} text={`${bottom} мм`} onClick={() => onEditOffset('bottom')} /> : null}
      {left > 0 ? <SmallMetricLabel x={x - 42} y={y + height / 2} text={`${left} мм`} onClick={() => onEditOffset('left')} /> : null}
      {right > 0 ? <SmallMetricLabel x={x + width + 42} y={y + height / 2} text={`${right} мм`} onClick={() => onEditOffset('right')} /> : null}
    </Group>
  );
}

function SmallMetricLabel({ onClick, x, y, text }: { onClick?: () => void; x: number; y: number; text: string }) {
  return (
    <Group x={x} y={y} onClick={onClick} onTap={onClick}>
      <Rect x={-34} y={-10} width={68} height={20} fill="#FFFFFF" stroke="#A385C4" strokeWidth={1} cornerRadius={4} shadowColor="rgba(30, 30, 40, 0.10)" shadowBlur={6} />
      <Text x={-32} y={-6} width={64} align="center" text={text} fill="#6F4F93" fontSize={11} />
    </Group>
  );
}

function getLayoutPieceFill(kind: 'full' | 'cut' | 'critical') {
  if (kind === 'critical') return 'rgba(111, 79, 147, 0.34)';
  if (kind === 'cut') return 'rgba(163, 133, 196, 0.24)';
  return 'rgba(255, 255, 255, 0.72)';
}

function getFloorLayoutPieceFill(kind: 'full' | 'cut' | 'critical') {
  if (kind === 'critical') return '#CEC0DC';
  if (kind === 'cut') return '#E9E0F0';
  return '#FFFFFF';
}

function getLayoutPieceStroke(kind: 'full' | 'cut' | 'critical') {
  if (kind === 'critical') return '#6F4F93';
  if (kind === 'cut') return '#A385C4';
  return '#C7B6D9';
}

function getZoneShapeLabel(zone: FinishZone): string {
  if (zone.shape.type === 'polygon') return 'По контуру';
  return `${zone.shape.widthMm} × ${zone.shape.heightMm} мм`;
}

function TemplatePickerDialog({ onSelect, selectedTemplateId }: { onSelect: (templateId: string) => void; selectedTemplateId: string }) {
  return (
    <div className="modal-backdrop template-picker-backdrop" role="presentation">
      <section className="confirm-dialog template-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="template-picker-title">
        <h2 id="template-picker-title">Выберите форму помещения</h2>
        <TemplateGrid onSelect={onSelect} selectedTemplateId={selectedTemplateId} />
      </section>
    </div>
  );
}

function TemplateGrid({ onSelect, selectedTemplateId }: { onSelect: (templateId: string) => void; selectedTemplateId: string }) {
  return (
    <div className="template-grid">
      {templates.map((template) => (
        <button
          type="button"
          className={template.id === selectedTemplateId ? 'template-card active' : 'template-card'}
          key={template.id}
          onClick={() => onSelect(template.id)}
        >
          <RoomIcon templateId={template.id} />
          <span>{template.name}</span>
          <small>{template.id === 'custom' ? 'Своя форма' : 'Редактируется на холсте'}</small>
        </button>
      ))}
    </div>
  );
}

function RoomTools({
  activeSurface,
  onAddDoor,
  onAddPassage,
  onAddPartition,
  onAddRoom,
  onAddWindow,
  partitionDrawingActive,
  project,
}: {
  activeSurface: TileProject['surfaces'][number] | null | undefined;
  onAddDoor: () => void;
  onAddPassage: () => void;
  onAddPartition: () => void;
  onAddRoom: () => void;
  onAddWindow: () => void;
  partitionDrawingActive: boolean;
  project: TileProject;
}) {
  const canAddOpening = activeSurface?.type === 'wall';
  return (
    <div className="room-tools">
      <strong>План помещений</strong>
      <div className="room-tools-stats">
        <span>Помещений: {project.room.areas?.length ?? 1}</span>
        <span>Проёмов: {project.room.openings?.length ?? 0}</span>
        <span>Перегородок: {project.room.partitions?.length ?? 0}</span>
      </div>
      <div className="room-tools-actions">
        {!canAddOpening ? <button type="button" onClick={onAddRoom}>Добавить помещение</button> : null}
        <button type="button" disabled={!canAddOpening} onClick={onAddDoor}>Дверь</button>
        <button type="button" disabled={!canAddOpening} onClick={onAddPassage}>Проход</button>
        {!canAddOpening ? <button type="button" className={partitionDrawingActive ? 'active' : ''} onClick={onAddPartition}>Перегородка</button> : null}
        <button type="button" disabled={!canAddOpening} onClick={onAddWindow}>Окно</button>
      </div>
    </div>
  );
}

function RoomIcon({ templateId }: { templateId: string }) {
  const pointsByTemplate: Record<string, string> = {
    rectangle: '18,18 74,18 74,58 18,58',
    square: '24,16 68,16 68,60 24,60',
    narrow: '34,12 58,12 58,64 34,64',
    'l-shape': '18,18 74,18 74,58 46,58 46,38 18,38',
    projection: '18,18 74,18 74,52 58,52 58,64 34,64 34,52 18,52',
    custom: '18,18 74,18 64,34 74,58 18,58 28,38',
  };
  return (
    <svg className="shape-icon" viewBox="0 0 92 76" aria-hidden="true">
      <polygon points={pointsByTemplate[templateId] ?? pointsByTemplate.rectangle} />
    </svg>
  );
}

function TilePresetCard({ active, onSelect, tile }: { active: boolean; onSelect: () => void; tile: TileSizePreset }) {
  const width = tile.widthMm ?? 600;
  const height = tile.heightMm ?? 600;
  const ratio = Math.min(42 / width, 42 / height);
  const rectWidth = Math.max(10, width * ratio);
  const rectHeight = Math.max(10, height * ratio);
  return (
    <button type="button" className={active ? 'tile-card active' : 'tile-card'} onClick={onSelect}>
      <span className="tile-card-preview">
        <span style={{ width: rectWidth, height: rectHeight }} />
      </span>
      <strong>{tile.label}</strong>
    </button>
  );
}

function LayoutControl({
  layout,
  layoutDragEnabled,
  material,
  openSection,
  onOpenSectionChange,
  onOriginModeChange,
  onOffsetInput,
  onOffsetReset,
  onOffsetStep,
  onPatternChange,
  onToggleLayoutDrag,
  surface,
  zone,
}: {
  layout: SurfaceLayout | undefined;
  layoutDragEnabled: boolean;
  material: TileMaterial | null | undefined;
  openSection: TilePanelSection | null;
  onOpenSectionChange: (section: TilePanelSection | null) => void;
  onOriginModeChange: (originMode: SurfaceLayout['originMode']) => void;
  onOffsetInput: (axis: 'x' | 'y', value: string) => void;
  onOffsetReset: () => void;
  onOffsetStep: (deltaXmm: number, deltaYmm: number) => void;
  onPatternChange: (pattern: LayoutPattern) => void;
  onToggleLayoutDrag: (enabled: boolean) => void;
  surface: TileProject['surfaces'][number] | null | undefined;
  zone: FinishZone | null | undefined;
}) {
  const handleSectionToggle = (section: TilePanelSection, open: boolean) => {
    onOpenSectionChange(open ? section : openSection === section ? null : openSection);
  };
  const modes: Array<{ label: string; title: string; value: SurfaceLayout['originMode'] }> = [
    { label: '↖', title: 'Левый верх', value: 'corner-tl' },
    { label: '↑', title: 'Сверху', value: 'corner-t' },
    { label: '↗', title: 'Правый верх', value: 'corner-tr' },
    { label: '←', title: 'Слева', value: 'corner-l' },
    { label: '•', title: 'Плитка в центре', value: 'tile-center' },
    { label: '→', title: 'Справа', value: 'corner-r' },
    { label: '↙', title: 'Левый низ', value: 'corner-bl' },
    { label: '↓', title: 'Снизу', value: 'corner-b' },
    { label: '↘', title: 'Правый низ', value: 'corner-br' },
  ];
  const offsetX = layout?.originXmm ?? 0;
  const offsetY = layout?.originYmm ?? 0;
  const patterns: Array<{ label: string; value: LayoutPattern }> = [
    { label: 'Без смещения', value: 'straight' },
    { label: '1/2', value: 'half-offset' },
    { label: '1/3', value: 'third-offset' },
    { label: '1/4', value: 'quarter-offset' },
    { label: 'Под дерево', value: 'wood-random' },
    { label: 'Диагональ', value: 'diagonal' },
  ];

  return (
    <>
      <section className="panel-module layout-module">
        <h1 className="panel-module-title">Укладка</h1>
        <details
          className="panel-card panel-section layout-options-select"
          open={openSection === 'laying'}
          onToggle={(event) => handleSectionToggle('laying', event.currentTarget.open)}
        >
          <summary className="layout-options-summary">
            <strong>Центрирование и схема</strong>
          </summary>
          <div className="layout-page single-page">
            <div className="layout-secondary-grid">
              <button type="button" className={zone?.layout.originMode === 'tile-center' ? 'active' : ''} disabled={!zone} onClick={() => onOriginModeChange('tile-center')}>Плитка в центре</button>
              <button type="button" className={zone?.layout.originMode === 'joint-center' ? 'active' : ''} disabled={!zone} onClick={() => onOriginModeChange('joint-center')}>Шов в центре</button>
              {patterns.map((pattern) => (
                <button key={pattern.value} type="button" className={zone?.layout.pattern === pattern.value ? 'active' : ''} disabled={!zone} onClick={() => onPatternChange(pattern.value)}>{pattern.label}</button>
              ))}
              <button
                type="button"
                disabled={!zone}
                onClick={() => {
                  onOriginModeChange('corner-tl');
                  onPatternChange('straight');
                  onOffsetReset();
                  onToggleLayoutDrag(false);
                }}
              >
                Сбросить
              </button>
            </div>
            <LayoutMetrics material={material} surface={surface} zone={zone} />
          </div>
        </details>
      </section>
      <section className="panel-module origin-module">
        <h1 className="panel-module-title">Точка старта</h1>
        <details
          className="panel-card panel-section layout-options-select origin-options-select"
          open={openSection === 'origin'}
          onToggle={(event) => handleSectionToggle('origin', event.currentTarget.open)}
        >
          <summary className="layout-options-summary"><strong>Выберите точку старта</strong></summary>
          <div className="origin-options-content">
            <div className="origin-mode-grid">
              {modes.map((mode) => (
                <button key={mode.value} type="button" title={mode.title} aria-label={mode.title} className={zone?.layout.originMode === mode.value ? 'active' : ''} disabled={!zone} onClick={() => onOriginModeChange(mode.value)}>{mode.label}</button>
              ))}
            </div>
          </div>
        </details>
      </section>
      <section className="panel-module movement-module">
        <h1 className="panel-module-title">Движение</h1>
        <details
          className="panel-card panel-section layout-options-select movement-options-select"
          open={openSection === 'movement'}
          onToggle={(event) => handleSectionToggle('movement', event.currentTarget.open)}
        >
          <summary className="layout-options-summary"><strong>Перемещение плитки</strong></summary>
          <div className="movement-options-content">
            <div className="layout-control layout-move-card">
              <button type="button" className={layoutDragEnabled ? 'layout-drag-button active' : 'layout-drag-button'} disabled={!zone} aria-pressed={layoutDragEnabled} onClick={() => onToggleLayoutDrag(!layoutDragEnabled)}>Двигать мышью</button>
              <div className="layout-offset-control">
                <button type="button" aria-label="Сдвинуть влево вверх" disabled={!zone} onClick={() => onOffsetStep(-10, -10)}>↖</button>
                <button type="button" aria-label="Сдвинуть вверх" disabled={!zone} onClick={() => onOffsetStep(0, -10)}><ArrowUp size={15} /></button>
                <button type="button" aria-label="Сдвинуть вправо вверх" disabled={!zone} onClick={() => onOffsetStep(10, -10)}>↗</button>
                <button type="button" aria-label="Сдвинуть влево" disabled={!zone} onClick={() => onOffsetStep(-10, 0)}><ArrowLeft size={15} /></button>
                <button type="button" aria-label="Сбросить смещение" disabled={!zone} onClick={onOffsetReset}><RotateCcw size={15} /></button>
                <button type="button" aria-label="Сдвинуть вправо" disabled={!zone} onClick={() => onOffsetStep(10, 0)}><ArrowRight size={15} /></button>
                <button type="button" aria-label="Сдвинуть влево вниз" disabled={!zone} onClick={() => onOffsetStep(-10, 10)}>↙</button>
                <button type="button" aria-label="Сдвинуть вниз" disabled={!zone} onClick={() => onOffsetStep(0, 10)}><ArrowDown size={15} /></button>
                <button type="button" aria-label="Сдвинуть вправо вниз" disabled={!zone} onClick={() => onOffsetStep(10, 10)}>↘</button>
              </div>
              <div className="layout-offset-fields">
                <label>X<input type="number" step={10} value={offsetX} disabled={!zone} onChange={(event) => onOffsetInput('x', event.currentTarget.value)} /></label>
                <label>Y<input type="number" step={10} value={offsetY} disabled={!zone} onChange={(event) => onOffsetInput('y', event.currentTarget.value)} /></label>
              </div>
            </div>
          </div>
        </details>
      </section>
      <PromoCard />
    </>
  );
}

function LayoutMetrics({ material, surface, zone }: { material: TileMaterial | null | undefined; surface: TileProject['surfaces'][number] | null | undefined; zone: FinishZone | null | undefined }) {
  if (!surface || !zone || !material) return <p>Выберите пол или стену.</p>;
  const stats = getZoneLayoutResult(surface, zone, material);
  return (
    <div className="layout-metrics">
      <span>{stats.minCutMm ? `Мин. подрезка ${Math.round(stats.minCutMm)} мм` : 'Без подрезок'}</span>
      <span>{stats.criticalCount ? `Критичных ${stats.criticalCount}` : 'Критичных нет'}</span>
    </div>
  );
}

function ZonesPanel({
  activeSurface,
  activeZone,
  onCreateZone,
  onDeleteZone,
  onSelectZone,
  onZoneShapeChange,
  project,
  selectedSurfaceId,
  selectedZoneId,
}: {
  activeSurface: TileProject['surfaces'][number] | null | undefined;
  activeZone: FinishZone | null | undefined;
  onCreateZone: (kind: ZonePresetKind) => void;
  onDeleteZone: () => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onZoneShapeChange: (patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
}) {
  const surface = activeSurface ?? project.surfaces.find((item) => item.id === 'surface-floor');
  const baseZone = surface?.zones[0] ?? null;
  const extraZones = surface?.zones.slice(1) ?? [];
  const editableShape = activeZone?.shape.type === 'rect' && selectedZoneId ? activeZone.shape : null;

  return (
    <section className="panel-card panel-section zones-panel">
      <h1>Зоны</h1>
      <div className="zone-actions">
        <button type="button" onClick={() => onCreateZone('rect')}>Прямоугольник</button>
        {surface?.type === 'floor' ? <button type="button" onClick={() => onCreateZone('shower')}>Душевая</button> : null}
        <button type="button" onClick={() => onCreateZone('horizontal-band')}>Горизонталь</button>
        <button type="button" onClick={() => onCreateZone('vertical-band')}>Вертикаль</button>
      </div>
      <div className="zone-list">
        {baseZone ? (
          <button
            type="button"
            className={selectedSurfaceId === surface?.id && !selectedZoneId ? 'active' : ''}
            onClick={() => surface && onSelectZone(surface.id, null)}
          >
            <strong>{surface?.name ?? 'Поверхность'}</strong>
            <span>Базовая зона</span>
          </button>
        ) : null}
        {extraZones.map((zone) => (
          <button
            type="button"
            key={zone.id}
            className={selectedZoneId === zone.id ? 'active' : ''}
            onClick={() => surface && onSelectZone(surface.id, zone.id)}
          >
            <strong>{zone.name}</strong>
            <span>{getZoneShapeLabel(zone)}</span>
          </button>
        ))}
      </div>
      {editableShape ? (
        <div className="zone-editor">
          <label>
            X
            <input type="number" min={0} step={1} value={editableShape.xMm} onChange={(event) => onZoneShapeChange({ xMm: Number(event.currentTarget.value) })} />
          </label>
          <label>
            Y
            <input type="number" min={0} step={1} value={editableShape.yMm} onChange={(event) => onZoneShapeChange({ yMm: Number(event.currentTarget.value) })} />
          </label>
          <label>
            Ш
            <input type="number" min={100} step={1} value={editableShape.widthMm} onChange={(event) => onZoneShapeChange({ widthMm: Number(event.currentTarget.value) })} />
          </label>
          <label>
            В
            <input type="number" min={100} step={1} value={editableShape.heightMm} onChange={(event) => onZoneShapeChange({ heightMm: Number(event.currentTarget.value) })} />
          </label>
          <button type="button" className="zone-delete" onClick={onDeleteZone}>
            <Trash2 size={15} />
            Удалить зону
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CalculationDialog({ calculation, onClose }: { calculation: ReturnType<typeof calculateProject>; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog calculation-dialog" role="dialog" aria-modal="true" aria-labelledby="calculation-title">
        <h2 id="calculation-title">Расчёт плитки</h2>
        <div className="calculation-summary">
          <span>
            <strong>{calculation.totalPurchasePieces}</strong>
            к покупке
          </span>
          <span>
            <strong>{calculation.totalAreaM2.toFixed(2)} м²</strong>
            площадь
          </span>
          <span>
            <strong>{calculation.totalBoxes ?? '—'}</strong>
            коробок
          </span>
        </div>
        <div className="calculation-list">
          {calculation.materials.map((item) => (
            <article key={item.material.id}>
              <strong>{item.material.label ?? item.material.name}</strong>
              <span>{item.totalPieces} шт. + запас {item.reservePieces} шт. = {item.purchasePieces} шт.</span>
              <small>{item.areaM2.toFixed(2)} м², зон: {item.zones.length}, коробок: {item.boxes ?? 'не задано'}</small>
              <div className="calculation-zone-list">
                {item.zones.map((zone) => (
                  <span key={zone.zoneId}>
                    {zone.surfaceName} · {zone.zoneName}: {zone.areaM2.toFixed(2)} м², {zone.purchasePieces} шт.{zone.criticalPieces ? ', критичных ' + zone.criticalPieces : ''}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
        {calculation.warnings.length ? (
          <div className="calculation-warnings">
            {calculation.warnings.slice(0, 4).map((warning) => <span key={warning}>{warning}</span>)}
          </div>
        ) : null}
        <p>Расчёт консервативный: зоны считаются отдельными областями, без вычитания окон, мебели и сантехники.</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-submit" onClick={onClose}>Закрыть</button>
        </div>
      </section>
    </div>
  );
}

function PromoCard() {
  return (
    <aside className="promo-card" aria-label="Vilray Studio">
      <span>Проект Vilray</span>
      <strong>Нужен такой калькулятор для вашего бренда?</strong>
      <p>Разрабатываем визуализаторы, конфигураторы и сервисы для отделочных материалов.</p>
      <a href="https://vilraystudio.ru/" target="_blank" rel="noreferrer">
        Обсудить проект
      </a>
    </aside>
  );
}

interface PlanViewTransform {
  scale: number;
  toPoint: (x: number, y: number) => PointMm;
  x: (value: number) => number;
  y: (value: number) => number;
}

interface WallFrame {
  areaId: string;
  height: number;
  heightMm: number;
  id: string;
  index: number;
  name: string;
  segmentIndex: number;
  width: number;
  widthMm: number;
  x: number;
  y: number;
}

interface WallAreaSection {
  areaId: string;
  expanded: boolean;
  headerY: number;
  name: string;
  width: number;
  x: number;
}

interface WallLayout {
  frames: WallFrame[];
  sections: WallAreaSection[];
}

function getFloorDimensionPosition(contour: PointMm[], index: number, view: PlanViewTransform) {
  const point = contour[index];
  const next = contour[(index + 1) % contour.length];
  return getFloorSegmentDimensionPosition(contour, point, next, view);
}

function getFloorSegmentDimensionPosition(contour: PointMm[], point: PointMm, next: PointMm, view: PlanViewTransform) {
  const box = getBoundingBox(contour);
  const center = { x: view.x(box.minX + box.width / 2), y: view.y(box.minY + box.height / 2) };
  const mid = { x: (view.x(point.x) + view.x(next.x)) / 2, y: (view.y(point.y) + view.y(next.y)) / 2 };
  const horizontal = point.y === next.y;

  if (horizontal) {
    return { x: mid.x, y: mid.y < center.y ? mid.y - 24 : mid.y + 24 };
  }

  return { x: mid.x < center.x ? mid.x - 58 : mid.x + 58, y: mid.y };
}

function getSharedFloorLayoutBox(project: TileProject, areaId: string): ReturnType<typeof getBoundingBox> {
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour }];
  const areaIndex = areas.findIndex((area) => area.id === areaId);
  const floorId = areaIndex <= 0 ? 'surface-floor' : `surface-floor-${areaId}`;
  const floor = project.surfaces.find((surface) => surface.id === floorId);
  const baseZone = floor?.zones[0];
  const sourceKey = baseZone ? `${baseZone.materialId ?? ''}|${JSON.stringify(baseZone.layout)}` : '';
  const connectedAreaIds = getConnectedAreaIdsForUi(project, areaId);
  const sharedAreas = areas.filter((area, index) => {
    if (!connectedAreaIds.has(area.id)) return false;
    const candidateFloorId = index === 0 ? 'surface-floor' : `surface-floor-${area.id}`;
    const candidateZone = project.surfaces.find((surface) => surface.id === candidateFloorId)?.zones[0];
    return Boolean(candidateZone) && `${candidateZone?.materialId ?? ''}|${JSON.stringify(candidateZone?.layout)}` === sourceKey;
  });
  return getBoundingBox((sharedAreas.length ? sharedAreas : areas.filter((area) => area.id === areaId)).flatMap((area) => area.contour));
}

function getConnectedAreaIdsForUi(project: TileProject, areaId: string): Set<string> {
  const connectedAreaIds = new Set<string>([areaId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const opening of project.room.openings ?? []) {
      if (!opening.connectedOpeningId) continue;
      const linked = project.room.openings?.find((item) => item.id === opening.connectedOpeningId);
      const firstAreaId = getAreaIdBySurfaceId(project, opening.surfaceId);
      const secondAreaId = linked ? getAreaIdBySurfaceId(project, linked.surfaceId) : null;
      if (!firstAreaId || !secondAreaId) continue;
      if (connectedAreaIds.has(firstAreaId) && !connectedAreaIds.has(secondAreaId)) { connectedAreaIds.add(secondAreaId); changed = true; }
      if (connectedAreaIds.has(secondAreaId) && !connectedAreaIds.has(firstAreaId)) { connectedAreaIds.add(firstAreaId); changed = true; }
    }
  }
  return connectedAreaIds;
}

function getAreaIdBySurfaceId(project: TileProject, surfaceId: string): string | null {
  const parts = project.surfaces.find((surface) => surface.id === surfaceId)?.sourceRef?.split(':') ?? [];
  return parts[0] === 'wall' ? parts[1] ?? null : null;
}

function getSelectedAreaId(project: TileProject, surfaceId: string | null): string {
  if (surfaceId) {
    const surface = project.surfaces.find((item) => item.id === surfaceId);
    const sourceParts = surface?.sourceRef?.split(':') ?? [];
    if ((sourceParts[0] === 'floor' || sourceParts[0] === 'wall') && sourceParts[1]) return sourceParts[1];
  }
  return project.room.areas?.[0]?.id ?? 'room-1';
}

function pointerToDraftPoint(pointer: { x: number; y: number }, viewport: CanvasViewport): PointMm {
  const canvasX = (pointer.x - viewport.x) / viewport.zoom;
  const canvasY = (pointer.y - viewport.y) / viewport.zoom;
  return {
    x: Math.max(0, canvasToMm(canvasX - PLAN_OFFSET_X)),
    y: Math.max(0, canvasToMm(canvasY - PLAN_OFFSET_Y)),
  };
}

function pointerToPlanPoint(pointer: { x: number; y: number }, viewport: CanvasViewport, view: PlanViewTransform): PointMm {
  const canvasX = (pointer.x - viewport.x) / viewport.zoom;
  const canvasY = (pointer.y - viewport.y) / viewport.zoom;
  return view.toPoint(canvasX, canvasY);
}

function getPlanView(_contour: PointMm[]): PlanViewTransform {
  return {
    scale: PX_PER_MM,
    toPoint: (x: number, y: number) => ({
      x: Math.round((x - PLAN_OFFSET_X) / PX_PER_MM),
      y: Math.round((y - PLAN_OFFSET_Y) / PX_PER_MM),
    }),
    x: (value: number) => PLAN_OFFSET_X + mmToCanvas(value),
    y: (value: number) => PLAN_OFFSET_Y + mmToCanvas(value),
  };
}

function getWallLayout(project: TileProject, view: PlanViewTransform, collapsedAreaIds: Set<string>): WallLayout {
  const walls = project.surfaces.filter((surface) => surface.type === 'wall');
  const startX = 220;
  const floorBottomY = Math.max(...(project.room.areas ?? [{ contour: project.room.contour }]).flatMap((area) => area.contour.map((point) => view.y(point.y))));
  let sectionY = calculateWallsStartY(floorBottomY);
  const gap = 96;
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour, heightMm: project.room.heightMm }];
  const areaIds = areas.map((area) => area.id);
  const wallsByArea = new Map<string, Array<{ index: number; wall: TileProject['surfaces'][number] }>>();

  walls.forEach((wall, index) => {
    const sourceParts = wall.sourceRef?.split(':') ?? [];
    const partition = sourceParts[0] === 'partition' ? project.room.partitions?.find((item) => item.id === sourceParts[1]) : null;
    const areaId = sourceParts[0] === 'wall' ? sourceParts[1] : partition?.areaId ?? areaIds[0] ?? 'room-1';
    const bucket = wallsByArea.get(areaId) ?? [];
    bucket.push({ index, wall });
    wallsByArea.set(areaId, bucket);
  });

  const frames: WallFrame[] = [];
  const sections: WallAreaSection[] = [];
  for (const area of areas) {
    const areaWalls = wallsByArea.get(area.id) ?? [];
    const expanded = !collapsedAreaIds.has(area.id);
    const sectionWidth = 320;
    const headerY = sectionY;
    sections.push({ areaId: area.id, expanded, headerY, name: area.name, width: sectionWidth, x: startX });

    if (!expanded) {
      sectionY += 48;
      continue;
    }

    const frameY = headerY + 66;
    let frameX = startX;
    let maxHeight = mmToCanvas(area.heightMm ?? project.room.heightMm);
    for (const { index, wall } of areaWalls) {
      const sourceParts = wall.sourceRef?.split(':') ?? [];
      const frame: WallFrame = {
        areaId: area.id,
        height: mmToCanvas(wall.heightMm),
        heightMm: wall.heightMm,
        id: wall.id,
        index,
        name: wall.name,
        segmentIndex: sourceParts[0] === 'wall' ? Math.max(0, Number(sourceParts[2]) - 1) : index,
        width: mmToCanvas(wall.widthMm),
        widthMm: wall.widthMm,
        x: frameX,
        y: frameY,
      };
      frames.push(frame);
      frameX += frame.width + gap;
      maxHeight = Math.max(maxHeight, frame.height);
    }
    sectionY = frameY + maxHeight + 150;
  }

  return { frames, sections };
}

function getInlineEdit(
  project: TileProject,
  target: Exclude<EditTarget, null>,
  view: PlanViewTransform,
  frames: WallFrame[],
  viewport: CanvasViewport,
): InlineEdit {
  if (target.type === 'wall-height') {
    const firstFrame = frames.find((frame) => frame.areaId === target.areaId) ?? frames[0];
    const area = project.room.areas?.find((item) => item.id === target.areaId);
    const markerX = firstFrame ? firstFrame.x - 144 : 80;
    const markerY = firstFrame ? firstFrame.y + firstFrame.height / 2 : 520;
    return {
      left: Math.round(viewport.x + markerX * viewport.zoom),
      max: 4500,
      min: 1800,
      target,
      top: Math.round(viewport.y + markerY * viewport.zoom),
      value: area?.heightMm ?? project.room.heightMm,
    };
  }

  if (target.type === 'layout-offset') {
    const metric = getLayoutOffsetMetric(project, target, view, frames);
    return {
      left: Math.round(viewport.x + metric.x * viewport.zoom),
      max: 15000,
      min: 0,
      target,
      top: Math.round(viewport.y + metric.y * viewport.zoom),
      value: metric.value,
    };
  }

  const { index } = target;
  const contour = project.room.areas?.find((area) => area.id === target.areaId)?.contour ?? project.room.contour;
  const current = contour[index];
  const next = contour[(index + 1) % contour.length];
  const canvasScale = viewport.zoom;
  if (target.type === 'wall-segment') {
    const frame = frames.find((item) => item.id === target.surfaceId) ?? frames[index];
    return {
      left: Math.round(viewport.x + (frame.x + frame.width / 2) * canvasScale),
      max: 15000,
      min: 1,
      target,
      top: Math.round(viewport.y + (frame.y + frame.height + 50) * canvasScale),
      value: segmentLength(current, next),
    };
  }

  const label = getFloorDimensionPosition(contour, index, view);
  return {
    left: Math.round(viewport.x + label.x * canvasScale),
    max: 15000,
    min: 1,
    target,
    top: Math.round(viewport.y + label.y * canvasScale),
    value: segmentLength(current, next),
  };
}

function getLayoutOffsetMetric(
  project: TileProject,
  target: Extract<EditTarget, { type: 'layout-offset' }>,
  view: PlanViewTransform,
  frames: WallFrame[],
) {
  const surface = project.surfaces.find((item) => item.id === target.surfaceId);
  const zone = surface?.zones.find((item) => item.id === target.zoneId);
  const material = surface && zone ? getZoneMaterial(project, surface.id, zone.id) : null;
  if (!surface || !zone || !material) return { value: 0, x: 80, y: 80 };

  const result = getZoneLayoutResult(surface, zone, material);
  const value = result.edgeOffsets[target.edge] ?? 0;
  const rect = getSurfaceRectOnCanvas(surface, zone, view, frames);
  return {
    value,
    x: target.edge === 'left' ? rect.x - 42 : target.edge === 'right' ? rect.x + rect.width + 42 : rect.x + rect.width / 2,
    y: target.edge === 'top' ? rect.y - 20 : target.edge === 'bottom' ? rect.y + rect.height + 20 : rect.y + rect.height / 2,
  };
}

function getZoneLayoutResult(surface: TileProject['surfaces'][number], zone: FinishZone, material: TileMaterial) {
  if (surface.type === 'floor' && zone.shape.type === 'polygon') {
    return generatePolygonLayout({ layout: zone.layout, points: zone.shape.points, tileHeightMm: material.heightMm, tileWidthMm: material.widthMm });
  }
  const rectShape = zone.shape.type === 'rect' ? zone.shape : null;
  return generateRectLayout({
    blockedRects:
      surface.type === 'wall' && rectShape
        ? surface.openings.map((opening) => ({
            type: 'rect' as const,
            xMm: Math.max(0, opening.xMm - rectShape.xMm),
            yMm: Math.max(0, opening.yMm - rectShape.yMm),
            widthMm: Math.min(opening.widthMm, rectShape.widthMm),
            heightMm: Math.min(opening.heightMm, rectShape.heightMm),
          }))
        : [],
    heightMm: rectShape ? rectShape.heightMm : surface.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: rectShape ? rectShape.widthMm : surface.widthMm,
  });
}

function getSurfaceRectOnCanvas(surface: TileProject['surfaces'][number], zone: FinishZone, view: PlanViewTransform, frames: WallFrame[]) {
  if (surface.type === 'wall') {
    const frame = frames.find((item) => item.id === surface.id);
    if (!frame) return { height: 1, width: 1, x: 80, y: 80 };
    if (zone.shape.type === 'rect' && !zone.id.endsWith('base-zone')) {
      return {
        height: mmToCanvas(zone.shape.heightMm),
        width: mmToCanvas(zone.shape.widthMm),
        x: frame.x + mmToCanvas(zone.shape.xMm),
        y: frame.y + mmToCanvas(zone.shape.yMm),
      };
    }
    return { height: frame.height, width: frame.width, x: frame.x, y: frame.y };
  }

  if (zone.shape.type === 'rect') {
    return {
      height: mmToCanvas(zone.shape.heightMm),
      width: mmToCanvas(zone.shape.widthMm),
      x: view.x(zone.shape.xMm),
      y: view.y(zone.shape.yMm),
    };
  }

  const box = getBoundingBox(zone.shape.points);
  return { height: mmToCanvas(box.height), width: mmToCanvas(box.width), x: view.x(box.minX), y: view.y(box.minY) };
}

function handleWallDrag(event: Konva.KonvaEventObject<DragEvent>, areaId: string, index: number, horizontal: boolean, scale: number, onMoveWall: (areaId: string, index: number, deltaMm: number) => void) {
  const node = event.currentTarget;
  const deltaPx = horizontal ? node.y() : node.x();
  node.position({ x: 0, y: 0 });
  const deltaMm = Math.round(deltaPx / scale);
  if (Math.abs(deltaMm) >= 10) onMoveWall(areaId, index, deltaMm);
}

function constrainPartitionEnd(start: PointMm, pointer: PointMm): PointMm {
  const deltaX = Math.abs(pointer.x - start.x);
  const deltaY = Math.abs(pointer.y - start.y);
  return deltaX >= deltaY ? { x: Math.round(pointer.x), y: start.y } : { x: start.x, y: Math.round(pointer.y) };
}

function findNearestRoomBoundary(project: TileProject, point: PointMm, maxDistanceMm: number, preferredAreaId?: string) {
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour }];
  let best: { areaId: string; distance: number; point: PointMm } | null = null;
  for (const area of areas) {
    if (preferredAreaId && area.id !== preferredAreaId) continue;
    for (let index = 0; index < area.contour.length; index += 1) {
      const start = area.contour[index];
      const end = area.contour[(index + 1) % area.contour.length];
      const projected = projectPointToSegment(point, start, end);
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (distance <= maxDistanceMm && (!best || distance < best.distance)) best = { areaId: area.id, distance, point: projected };
    }
  }
  return best;
}

function projectPointToSegment(point: PointMm, start: PointMm, end: PointMm): PointMm {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return { ...start };
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return { x: Math.round(start.x + dx * ratio), y: Math.round(start.y + dy * ratio) };
}

function findBoundarySegmentIndex(contour: PointMm[], point: PointMm): number {
  return contour.findIndex((start, index) => isPointOnSegment(point, start, contour[(index + 1) % contour.length]));
}

function isPointOnSegment(point: PointMm, start: PointMm, end: PointMm, toleranceMm = 2): boolean {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!length) return Math.hypot(point.x - start.x, point.y - start.y) <= toleranceMm;
  const cross = Math.abs((point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x));
  if (cross / length > toleranceMm) return false;
  return point.x >= Math.min(start.x, end.x) - toleranceMm
    && point.x <= Math.max(start.x, end.x) + toleranceMm
    && point.y >= Math.min(start.y, end.y) - toleranceMm
    && point.y <= Math.max(start.y, end.y) + toleranceMm;
}

function isPartitionInsideContour(contour: PointMm[], start: PointMm, end: PointMm): boolean {
  if ((start.x !== end.x && start.y !== end.y) || segmentLength(start, end) < 250) return false;
  for (let step = 1; step <= 20; step += 1) {
    const ratio = step / 20;
    const point = { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    if (!pointInPolygonOrBoundary(point, contour)) return false;
  }
  return true;
}

function pointInPolygonOrBoundary(point: PointMm, polygon: PointMm[]): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
    if (Math.abs(cross) < 0.001 && point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x) && point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y)) return true;
  }
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if ((currentPoint.y > point.y) !== (previousPoint.y > point.y) && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: PointMm, b: PointMm, c: PointMm, d: PointMm): boolean {
  const cross = (first: PointMm, second: PointMm, third: PointMm) => (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
}

function getPreferredTemplateSize(template: RoomTemplate): [number, number] | undefined {
  if (template.id === 'rectangle') return template.sizes.find(([width, depth]) => width === 1700 && depth === 2000) ?? template.sizes[0];
  return template.sizes[0];
}
