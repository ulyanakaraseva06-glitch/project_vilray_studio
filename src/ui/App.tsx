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
  addAdjacentRoom,
  addFloorZone,
  addOpening,
  addPartition,
  addWallZone,
  createProjectFromTemplate,
  deleteZone,
  ensureProjectDefaults,
  getInitialProject,
  getSurfaceMaterial,
  getZoneMaterial,
  updatePrimaryCustomTileMaterial,
  updatePrimaryTileMaterial,
  updateRoomContour,
  updateRoomHeight,
  updateRoomSegmentLength,
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
} from '../project/projectFactory';
import { generatePolygonLayout, generateRectLayout, type LayoutEdgeCuts } from '../layout/layoutEngine';
import { calculateProject } from '../calculation/calculateProject';
import { clearProject, loadProject, saveProject } from '../project/storage';
import { getBoundingBox, moveWall, segmentLength, validateContour } from '../project/geometry';
import {
  buildClosedOrthogonalContour,
  canCloseContour,
  constrainOrthogonalPoint,
  CUSTOM_DRAW_MAX_POINTS,
} from '../canvas/drawing';
import { calculateWallsStartY } from '../canvas/layout';
import { canvasToMm, gridPxForMm, MINOR_GRID_MM, MM_PER_MAJOR_GRID, mmToCanvas, PX_PER_MM } from '../canvas/scale';
import { clampZoom, panViewport, resetViewport, type CanvasViewport } from '../canvas/viewport';
import type { FinishZone, LayoutPattern, Opening, PointMm, RoomTemplate, TileMaterial, TileProject, TileSizePreset } from '../types/project';

type EditTarget =
  | { type: 'floor-segment'; index: number }
  | { type: 'wall-segment'; index: number }
  | { type: 'wall-height' }
  | { type: 'layout-offset'; edge: keyof LayoutEdgeCuts; surfaceId: string; zoneId: string }
  | null;

type CanvasLayers = {
  grid: boolean;
  floor: boolean;
  walls: boolean;
  dimensions: boolean;
};

type DrawingMode = 'idle' | 'custom-room';
type PanelTab = 'tile' | 'room' | 'objects' | 'zones';

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
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>('surface-floor');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedWallIndex, setSelectedWallIndex] = useState<number | null>(null);
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('tile');
  const [layoutDragEnabled, setLayoutDragEnabled] = useState(false);
  const [calculationOpen, setCalculationOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [layers, setLayers] = useState<CanvasLayers>({ grid: true, floor: true, walls: true, dimensions: true });
  const [viewport, setViewport] = useState<CanvasViewport>(resetViewport());
  const [hasRoomEdits, setHasRoomEdits] = useState(initialAppState.hasRoomEdits);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('idle');
  const [draftContour, setDraftContour] = useState<PointMm[]>([]);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const [customTileDialogOpen, setCustomTileDialogOpen] = useState(false);
  const [customTileError, setCustomTileError] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(initialAppState.templatePickerOpen);
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
      beginCustomDrawing();
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

  function beginCustomDrawing() {
    setSelectedTemplateId('custom');
    selectSurface(null);
    setEditTarget(null);
    setViewport(resetViewport());
    setLayers({ grid: true, floor: true, walls: false, dimensions: true });
    setDraftContour([]);
    setDrawingError(null);
    setDrawingMode('custom-room');
    setHasRoomEdits(false);
  }

  function addDraftPoint(point: PointMm) {
    setDraftContour((current) => {
      if (current.length >= CUSTOM_DRAW_MAX_POINTS) return current;
      const nextPoint = constrainOrthogonalPoint(current, point);
      const previousPoint = current[current.length - 1];
      if (previousPoint && previousPoint.x === nextPoint.x && previousPoint.y === nextPoint.y) return current;
      return [...current, nextPoint];
    });
    setDrawingError(null);
    setHasRoomEdits(true);
  }

  function undoDraftPoint() {
    setDraftContour((current) => current.slice(0, -1));
    setDrawingError(null);
  }

  function cancelCustomDrawing() {
    setDraftContour([]);
    setDrawingError(null);
    setDrawingMode('idle');
    setSelectedTemplateId(project.room.templateId ?? 'custom');
  }

  function completeCustomDrawing() {
    const contour = buildClosedOrthogonalContour(draftContour);
    if (!contour) return;
    const validation = validateContour(contour);
    if (!validation.ok) {
      setDrawingError(validation.message ?? 'Контур нельзя завершить.');
      return;
    }
    setProject((current) => updateRoomContour({ ...current, room: { ...current.room, templateId: null } }, contour));
    setSelectedTemplateId('custom');
    selectSurface('surface-floor');
    setDraftContour([]);
    setDrawingError(null);
    setDrawingMode('idle');
    setLayers({ grid: true, floor: true, walls: false, dimensions: true });
    setHasRoomEdits(true);
  }

  function changeHeight(value: string) {
    const nextHeight = Number(value);
    if (!Number.isFinite(nextHeight)) return;
    setHasRoomEdits(true);
    setProject((current) => updateRoomHeight(current, nextHeight));
  }

  function changeSegmentLength(index: number, value: string) {
    const length = Number(value);
    if (!Number.isFinite(length)) return;
    setHasRoomEdits(true);
    setProject((current) => updateRoomSegmentLength(current, index, length));
    setEditTarget(null);
  }

  function selectTilePreset(tile: TileSizePreset) {
    setCustomTileDialogOpen(false);
    setCustomTileError(null);
    setHasRoomEdits(true);
    setProject((current) => (activeSurfaceId && activeZoneId ? updateZoneTileMaterial(current, activeSurfaceId, activeZoneId, tile) : activeSurfaceId ? updateSurfaceTileMaterial(current, activeSurfaceId, tile) : updatePrimaryTileMaterial(current, tile)));
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
  }

  function dragWall(index: number, deltaMm: number) {
    setHasRoomEdits(true);
    setProject((current) => {
      const contour = moveWall(current.room.contour, index, deltaMm);
      return {
        ...updateRoomHeight(
          {
            ...current,
            room: { ...current.room, contour },
          },
          current.room.heightMm,
        ),
      };
    });
  }

  function selectSurface(surfaceId: string | null) {
    setSelectedSurfaceId(surfaceId);
    setSelectedZoneId(null);
    setSelectedWallIndex(surfaceId?.startsWith('surface-wall-') ? Number(surfaceId.replace('surface-wall-', '')) - 1 : null);
  }

  function selectZone(surfaceId: string, zoneId: string | null) {
    setSelectedSurfaceId(surfaceId);
    setSelectedZoneId(zoneId);
    setSelectedWallIndex(null);
  }

  function selectWall(index: number | null) {
    selectSurface(index === null ? null : `surface-wall-${index + 1}`);
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
    setHasRoomEdits(true);
    setProject((current) => addAdjacentRoom(current));
    setActivePanelTab('room');
  }

  function addSurfaceOpening(kind: Opening['kind']) {
    if (!activeSurfaceId) return;
    setHasRoomEdits(true);
    setProject((current) => addOpening(current, activeSurfaceId, kind));
  }

  function createPartition() {
    setHasRoomEdits(true);
    setProject((current) => addPartition(current));
    setActivePanelTab('room');
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
            canCompleteDrawing={canCloseContour(draftContour)}
            draftContour={draftContour}
            drawingError={drawingError}
            drawingMode={drawingMode}
            editTarget={editTarget}
            layers={layers}
            onAddDraftPoint={addDraftPoint}
            onChangeHeight={changeHeight}
            onCancelDrawing={cancelCustomDrawing}
            onCompleteDrawing={completeCustomDrawing}
            onEditSegment={setEditTarget}
            onLayersChange={setLayers}
            layoutDragEnabled={layoutDragEnabled}
            onLayoutDrag={shiftLayoutOrigin}
            onLayoutEdgeOffsetChange={setLayoutEdgeOffset}
            onMoveWall={dragWall}
            onSelectSurface={selectSurface}
            onSelectZone={selectZone}
            onSelectWall={selectWall}
            onSubmitSegment={changeSegmentLength}
            onUndoDraftPoint={undoDraftPoint}
            onViewportChange={setViewport}
            onZoneShapeChange={changeZoneShape}
            project={project}
            selectedSurfaceId={selectedSurfaceId}
            selectedZoneId={selectedZoneId}
            selectedWallIndex={selectedWallIndex}
            viewport={viewport}
          />
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
              <section className="panel-card panel-section compact">
                <h1>Форматы плитки</h1>
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
              </section>

              <LayoutControl
                layout={activeZone?.layout}
                layoutDragEnabled={layoutDragEnabled}
                material={activeTileMaterial}
                onOriginModeChange={changeOriginMode}
                onOffsetInput={setLayoutOriginOffset}
                onOffsetReset={resetLayoutOffset}
                onOffsetStep={shiftLayoutOrigin}
                onPatternChange={changeLayoutPattern}
                onToggleLayoutDrag={setLayoutDragEnabled}
                surface={activeSurface}
                zone={activeZone}
              />

              <PromoCard />
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
                onAddRoom={addRoom}
                project={project}
              />
            </section>
          ) : null}

          {activePanelTab === 'objects' ? <section className="panel-card panel-section"><h1>Объекты</h1></section> : null}
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

      {templatePickerOpen ? (
        <TemplatePickerDialog
          onSelect={applyTemplateNow}
          selectedTemplateId={selectedTemplateId}
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
  draftContour: PointMm[];
  drawingError: string | null;
  drawingMode: DrawingMode;
  editTarget: EditTarget;
  layers: CanvasLayers;
  layoutDragEnabled: boolean;
  onAddDraftPoint: (point: PointMm) => void;
  onChangeHeight: (value: string) => void;
  onCancelDrawing: () => void;
  onCompleteDrawing: () => void;
  onEditSegment: (target: EditTarget) => void;
  onLayersChange: (layers: CanvasLayers) => void;
  onLayoutDrag: (deltaXmm: number, deltaYmm: number) => void;
  onLayoutEdgeOffsetChange: (surfaceId: string, zoneId: string, edge: keyof LayoutEdgeCuts, value: number) => void;
  onMoveWall: (index: number, deltaMm: number) => void;
  onSelectSurface: (surfaceId: string | null) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onSelectWall: (index: number | null) => void;
  onSubmitSegment: (index: number, value: string) => void;
  onUndoDraftPoint: () => void;
  onViewportChange: (viewport: CanvasViewport) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
  viewport: CanvasViewport;
}

function WorkspaceCanvas({
  canCompleteDrawing,
  draftContour,
  drawingError,
  drawingMode,
  editTarget,
  layers,
  layoutDragEnabled,
  onAddDraftPoint,
  onChangeHeight,
  onCancelDrawing,
  onCompleteDrawing,
  onEditSegment,
  onLayersChange,
  onLayoutDrag,
  onLayoutEdgeOffsetChange,
  onMoveWall,
  onSelectSurface,
  onSelectZone,
  onSelectWall,
  onSubmitSegment,
  onUndoDraftPoint,
  onViewportChange,
  onZoneShapeChange,
  project,
  selectedSurfaceId,
  selectedZoneId,
  selectedWallIndex,
  viewport,
}: WorkspaceCanvasProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(initialCanvasSize);
  const [editError, setEditError] = useState<string | null>(null);
  const panRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const layoutDragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const planView = useMemo(() => getPlanView(project.room.contour), [project.room.contour]);
  const wallFrames = useMemo(() => getWallFrames(project, planView), [project, planView]);
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
    if (drawingMode === 'custom-room') {
      const pointer = event.target.getStage()?.getPointerPosition();
      if (!pointer) return;
      onAddDraftPoint(pointerToDraftPoint(pointer, viewport));
      return;
    }
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
      onChangeHeight(String(parsed));
    } else {
      onSubmitSegment(activeEdit.target.index, String(parsed));
    }
    setEditError(null);
    onEditSegment(null);
  }

  return (
    <div className="canvas-card" ref={holderRef}>
      <Stage
        width={size.width}
        height={size.height}
        className="konva-stage"
        onMouseDown={startPan}
        onMouseMove={movePan}
        onMouseUp={stopPan}
        onMouseLeave={stopPan}
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
            {drawingMode === 'custom-room' ? <DraftContourLayer points={draftContour} /> : null}
            {drawingMode === 'idle' && layers.floor ? (
              <FloorLayer
                dimensionsVisible={layers.dimensions}
                onEditSegment={onEditSegment}
                onMoveWall={onMoveWall}
                onSelectSurface={onSelectSurface}
                onSelectZone={onSelectZone}
                onSelectWall={onSelectWall}
                onEditLayoutOffset={onEditSegment}
                onZoneShapeChange={onZoneShapeChange}
                project={project}
                selectedSurfaceId={selectedSurfaceId}
                selectedZoneId={selectedZoneId}
                selectedWallIndex={selectedWallIndex}
                view={planView}
              />
            ) : null}
            {drawingMode === 'idle' && layers.walls ? (
              <WallsLayer
                dimensionsVisible={layers.dimensions}
                frames={wallFrames}
                onEditSegment={onEditSegment}
                onSelectWall={onSelectWall}
                onSelectZone={onSelectZone}
                onEditLayoutOffset={onEditSegment}
                onZoneShapeChange={onZoneShapeChange}
                project={project}
                selectedSurfaceId={selectedSurfaceId}
                selectedZoneId={selectedZoneId}
                selectedWallIndex={selectedWallIndex}
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
          <strong>Нарисовать помещение</strong>
          <span>{draftContour.length ? `${draftContour.length} точ.` : 'Ставьте точки по сетке'}</span>
          {drawingError ? <em>{drawingError}</em> : null}
          <button type="button" onClick={onCompleteDrawing} disabled={!canCompleteDrawing}>
            Завершить
          </button>
          <button type="button" onClick={onUndoDraftPoint} disabled={draftContour.length === 0}>
            Отменить точку
          </button>
          <button type="button" onClick={onCancelDrawing}>
            Отмена
          </button>
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

function DraftContourLayer({ points }: { points: PointMm[] }) {
  const canvasPoints = points.map(pointToCanvasPoint);
  const linePoints = canvasPoints.flatMap((point) => [point.x, point.y]);
  const closePreview = points.length >= 4 ? [...linePoints, canvasPoints[0].x, canvasPoints[0].y] : linePoints;

  return (
    <Group>
      <Text x={54} y={54} text="Новый контур" fill="#6B6B80" fontSize={18} />
      <Text x={54} y={82} text="Ставьте точки по сетке. Линии фиксируются под прямым углом." fill="#8F8FA3" fontSize={14} />
      {points.length > 1 ? <Line points={closePreview} closed={points.length >= 4} fill={points.length >= 4 ? '#F2EBF9' : undefined} stroke="#A385C4" strokeWidth={4} dash={points.length >= 4 ? undefined : [10, 8]} /> : null}
      {canvasPoints.map((point, index) => (
        <Group key={`${point.x}-${point.y}-${index}`}>
          <Circle x={point.x} y={point.y} radius={7} fill="#8A6AAE" />
          <Text x={point.x + 10} y={point.y - 18} text={`${index + 1}`} fill="#6B6B80" fontSize={13} />
        </Group>
      ))}
    </Group>
  );
}

function pointToCanvasPoint(point: PointMm) {
  return { x: PLAN_OFFSET_X + mmToCanvas(point.x), y: PLAN_OFFSET_Y + mmToCanvas(point.y) };
}

interface FloorLayerProps {
  dimensionsVisible: boolean;
  onEditSegment: (target: EditTarget) => void;
  onEditLayoutOffset: (target: EditTarget) => void;
  onMoveWall: (index: number, deltaMm: number) => void;
  onSelectSurface: (surfaceId: string | null) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onSelectWall: (index: number | null) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
  view: PlanViewTransform;
}

function FloorLayer({ dimensionsVisible, onEditSegment, onEditLayoutOffset, onMoveWall, onSelectSurface, onSelectZone, onSelectWall, onZoneShapeChange, project, selectedSurfaceId, selectedZoneId, selectedWallIndex, view }: FloorLayerProps) {
  const points = project.room.contour.flatMap((point) => [view.x(point.x), view.y(point.y)]);
  const floor = project.surfaces.find((surface) => surface.id === 'surface-floor');
  const extraFloors = project.surfaces.filter((surface) => surface.type === 'floor' && surface.id !== 'surface-floor');
  const baseZone = floor?.zones[0];
  const material = baseZone?.materialId ? project.materials.find((item) => item.id === baseZone.materialId) : null;
  const layout = baseZone?.layout;
  const active = selectedSurfaceId === 'surface-floor';
  const baseActive = active && !selectedZoneId;
  const layoutOpacity = selectedSurfaceId && !active ? 0.32 : selectedZoneId ? 0.34 : 1;

  return (
    <Group>
      <Text x={54} y={54} text="Пол" fill="#6B6B80" fontSize={18} />
      <Line points={points} closed fill={active ? '#F2EBF9' : '#FFFFFF'} stroke="#A385C4" strokeWidth={active ? 6 : 4} onClick={() => onSelectSurface('surface-floor')} onTap={() => onSelectSurface('surface-floor')} />
      {floor && material && layout ? <FloorTileLayout contour={project.room.contour} layout={layout} material={material} opacity={layoutOpacity} view={view} /> : null}
      {extraFloors.map((surface) => {
        const zone = surface.zones[0];
        const zoneMaterial = zone?.materialId ? project.materials.find((item) => item.id === zone.materialId) : null;
        const contour = zone?.shape.type === 'polygon' ? zone.shape.points : null;
        const surfaceActive = selectedSurfaceId === surface.id;
        if (!zone || !zoneMaterial || !contour) return null;
        return (
          <Group key={surface.id}>
            <Line
              points={contour.flatMap((point) => [view.x(point.x), view.y(point.y)])}
              closed
              fill={surfaceActive ? '#F2EBF9' : '#FFFFFF'}
              stroke="#A385C4"
              strokeWidth={surfaceActive ? 6 : 4}
              onClick={() => onSelectSurface(surface.id)}
              onTap={() => onSelectSurface(surface.id)}
            />
            <FloorTileLayout contour={contour} layout={zone.layout} material={zoneMaterial} opacity={selectedSurfaceId && !surfaceActive ? 0.32 : 1} view={view} />
            {surfaceActive && !selectedZoneId ? (
              <FloorEdgeCutLabels
                contour={contour}
                layout={zone.layout}
                material={zoneMaterial}
                onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: surface.id, zoneId: zone.id })}
                view={view}
              />
            ) : null}
          </Group>
        );
      })}
      {(project.room.partitions ?? []).map((partition) => (
        <Line
          key={partition.id}
          points={[view.x(partition.start.x), view.y(partition.start.y), view.x(partition.end.x), view.y(partition.end.y)]}
          stroke="#6F4F93"
          strokeWidth={6}
          dash={[12, 8]}
        />
      ))}
      {floor?.zones.slice(1).map((zone) => {
        const zoneMaterial = zone.materialId ? project.materials.find((item) => item.id === zone.materialId) : null;
        const zoneActive = selectedZoneId === zone.id;
        const zoneOpacity = active && !zoneActive ? 0.48 : 1;
        return zoneMaterial ? (
          <FloorZoneLayer
            key={zone.id}
            material={zoneMaterial}
            onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: 'surface-floor', zoneId: zone.id })}
            onSelect={() => onSelectZone('surface-floor', zone.id)}
            onShapeChange={(patch) => onZoneShapeChange('surface-floor', zone.id, patch)}
            selected={zoneActive}
            view={view}
            zone={zone}
            opacity={zoneOpacity}
          />
        ) : null;
      })}
      <Line points={points} closed stroke={active ? '#8A6AAE' : '#A385C4'} strokeWidth={active ? 6 : 4} onClick={() => onSelectSurface('surface-floor')} onTap={() => onSelectSurface('surface-floor')} />
      {baseActive && floor && material && layout && baseZone ? (
        <FloorEdgeCutLabels
          contour={project.room.contour}
          layout={layout}
          material={material}
          onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: floor.id, zoneId: baseZone.id })}
          view={view}
        />
      ) : null}
      {project.room.contour.map((point, index) => {
        const next = project.room.contour[(index + 1) % project.room.contour.length];
        const horizontal = point.y === next.y;
        const label = getFloorDimensionPosition(project.room.contour, index, view);
        return (
          <Group key={`floor-segment-${index}`}>
            {dimensionsVisible ? (
              <DimensionLabel
                x={label.x}
                y={label.y}
                text={`${segmentLength(point, next)} мм`}
                onClick={() => onEditSegment({ type: 'floor-segment', index })}
              />
            ) : null}
            <Line
              points={[view.x(point.x), view.y(point.y), view.x(next.x), view.y(next.y)]}
              stroke={selectedWallIndex === index ? '#8A6AAE' : 'transparent'}
              strokeWidth={selectedWallIndex === index ? 18 : 28}
              opacity={selectedWallIndex === index ? 0.22 : 1}
              draggable
              dragBoundFunc={(pos) => (horizontal ? { x: 0, y: pos.y } : { x: pos.x, y: 0 })}
              onClick={() => onSelectWall(index)}
              onTap={() => onSelectWall(index)}
              onDragEnd={(event) => handleWallDrag(event, index, horizontal, view.scale, onMoveWall)}
            />
          </Group>
        );
      })}
      {project.room.contour.map((point, index) => <Circle key={`point-${index}`} x={view.x(point.x)} y={view.y(point.y)} radius={6} fill="#8A6AAE" />)}
    </Group>
  );
}

function DimensionLabel({ x, y, text, onClick }: { x: number; y: number; text: string; onClick: () => void }) {
  return (
    <Group x={x} y={y} onClick={onClick} onTap={onClick}>
      <Rect x={-48} y={-13} width={96} height={26} fill="#FFFFFF" stroke="#D9D9E2" strokeWidth={1} cornerRadius={4} shadowColor="rgba(30, 30, 40, 0.12)" shadowBlur={8} />
      <Text x={-46} y={-7} width={92} align="center" text={text} fill="#18181E" fontSize={14} />
    </Group>
  );
}

function WallsLayer({
  dimensionsVisible,
  frames,
  onEditLayoutOffset,
  onEditSegment,
  onSelectWall,
  onSelectZone,
  onZoneShapeChange,
  project,
  selectedSurfaceId,
  selectedZoneId,
  selectedWallIndex,
}: {
  dimensionsVisible: boolean;
  frames: WallFrame[];
  onEditLayoutOffset: (target: EditTarget) => void;
  onEditSegment: (target: EditTarget) => void;
  onSelectWall: (index: number | null) => void;
  onSelectZone: (surfaceId: string, zoneId: string | null) => void;
  onZoneShapeChange: (surfaceId: string, zoneId: string, patch: Partial<Extract<FinishZone['shape'], { type: 'rect' }>>) => void;
  project: TileProject;
  selectedSurfaceId: string | null;
  selectedZoneId: string | null;
  selectedWallIndex: number | null;
}) {
  const firstFrame = frames[0];
  const heightMarkerX = firstFrame ? firstFrame.x - 36 : 0;
  const titleY = firstFrame ? firstFrame.y - 38 : 372;

  return (
    <Group>
      <Text x={54} y={titleY} text="Стены" fill="#6B6B80" fontSize={18} />
      {frames.map((frame) => {
        const active = selectedSurfaceId === frame.id;
        const layoutOpacity = selectedSurfaceId && !active ? 0.38 : 1;
        const surface = project.surfaces.find((item) => item.id === frame.id);
        const material = surface?.zones[0]?.materialId ? project.materials.find((item) => item.id === surface.zones[0]?.materialId) : null;
        const layout = surface?.zones[0]?.layout;
        return (
          <Group key={frame.id} onClick={() => onSelectWall(frame.index)} onTap={() => onSelectWall(frame.index)}>
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
                onEditOffset={(edge) => onEditLayoutOffset({ type: 'layout-offset', edge, surfaceId: frame.id, zoneId: surface.zones[0]!.id })}
                openings={surface.openings}
                opacity={layoutOpacity}
                showEdgeCuts={active && !selectedZoneId}
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
            <Rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} stroke={active ? '#8A6AAE' : '#D0D0D8'} strokeWidth={active ? 3 : 1} />
            <Text x={frame.x} y={frame.y - 22} width={frame.width} align="center" text={frame.name} fill="#6B6B80" fontSize={13} fontStyle="bold" />
            {dimensionsVisible ? (
              <DimensionLabel
                x={frame.x + frame.width / 2}
                y={frame.y + frame.height + 21}
                text={`${frame.widthMm} мм`}
                onClick={() => onEditSegment({ type: 'wall-segment', index: frame.index })}
              />
            ) : null}
          </Group>
        );
      })}
      {dimensionsVisible && firstFrame ? (
        <Group>
          <Line points={[heightMarkerX, firstFrame.y, heightMarkerX, firstFrame.y + firstFrame.height]} stroke="#8F8FA3" strokeWidth={1.5} />
          <Line points={[heightMarkerX - 6, firstFrame.y, heightMarkerX + 6, firstFrame.y]} stroke="#8F8FA3" strokeWidth={1.5} />
          <Line points={[heightMarkerX - 6, firstFrame.y + firstFrame.height, heightMarkerX + 6, firstFrame.y + firstFrame.height]} stroke="#8F8FA3" strokeWidth={1.5} />
          <DimensionLabel x={heightMarkerX - 54} y={firstFrame.y + firstFrame.height / 2} text={`${firstFrame.heightMm} мм`} onClick={() => onEditSegment({ type: 'wall-height' })} />
        </Group>
      ) : null}
    </Group>
  );
}

function WallTileLayout({
  frame,
  layout,
  material,
  onEditOffset,
  openings,
  opacity,
  showEdgeCuts,
}: {
  frame: WallFrame;
  layout: SurfaceLayout;
  material: TileMaterial;
  onEditOffset: (edge: keyof LayoutEdgeCuts) => void;
  openings: Opening[];
  opacity: number;
  showEdgeCuts: boolean;
}) {
  const result = generateRectLayout({
    blockedRects: openings.map((opening) => ({ type: 'rect', xMm: opening.xMm, yMm: opening.yMm, widthMm: opening.widthMm, heightMm: opening.heightMm })),
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
      {result.truncated ? <Text x={frame.x + 12} y={frame.y + frame.height - 28} text="Сетка упрощена" fill="#6F4F93" fontSize={13} /> : null}
      </Group>
      {openings.map((opening) => <WallOpening key={opening.id} frame={frame} opening={opening} />)}
      {showEdgeCuts ? <EdgeCutLabels edgeCuts={result.edgeOffsets} height={frame.height} onEditOffset={onEditOffset} width={frame.width} x={frame.x} y={frame.y} /> : null}
    </Group>
  );
}

function WallOpening({ frame, opening }: { frame: WallFrame; opening: Opening }) {
  return (
    <Group>
      <Rect
        x={frame.x + mmToCanvas(opening.xMm)}
        y={frame.y + mmToCanvas(opening.yMm)}
        width={mmToCanvas(opening.widthMm)}
        height={mmToCanvas(opening.heightMm)}
        fill="#FFFFFF"
        stroke="#A385C4"
        strokeWidth={1.5}
        dash={[8, 6]}
      />
      <Text x={frame.x + mmToCanvas(opening.xMm)} y={frame.y + mmToCanvas(opening.yMm) + 8} width={mmToCanvas(opening.widthMm)} align="center" text={opening.name} fill="#6F4F93" fontSize={12} />
    </Group>
  );
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
  const result = generateRectLayout({
    heightMm: zone.shape.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: zone.shape.widthMm,
  });
  const x = frame.x + mmToCanvas(zone.shape.xMm);
  const y = frame.y + mmToCanvas(zone.shape.yMm);
  const width = mmToCanvas(zone.shape.widthMm);
  const height = mmToCanvas(zone.shape.heightMm);

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
        onShapeChange({ xMm: zone.shape.xMm + canvasToMm(node.x()), yMm: zone.shape.yMm + canvasToMm(node.y()) });
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

type SurfaceLayout = TileProject['surfaces'][number]['zones'][number]['layout'];

function FloorTileLayout({ contour, layout, material, opacity, view }: { contour: PointMm[]; layout: SurfaceLayout; material: TileMaterial; opacity: number; view: PlanViewTransform }) {
  const box = getBoundingBox(contour);
  const result = generatePolygonLayout({
    layout,
    points: contour,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
  });

  return (
    <Group opacity={opacity}>
      {result.pieces.map((piece) =>
        piece.polygon ? (
          <Line
            key={piece.id}
            points={piece.polygon.flatMap((point) => [view.x(point.x + box.minX), view.y(point.y + box.minY)])}
            closed
            fill={getLayoutPieceFill(piece.kind)}
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
            fill={getLayoutPieceFill(piece.kind)}
            stroke={getLayoutPieceStroke(piece.kind)}
            strokeWidth={0.7}
          />
        ),
      )}
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
        <FloorTileLayout contour={zone.shape.points} layout={zone.layout} material={material} opacity={opacity} view={view} />
        {selected ? <FloorEdgeCutLabels contour={zone.shape.points} layout={zone.layout} material={material} view={view} /> : null}
      </Group>
    );
  }

  const result = generateRectLayout({
    heightMm: zone.shape.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: zone.shape.widthMm,
  });
  const x = view.x(zone.shape.xMm);
  const y = view.y(zone.shape.yMm);
  const width = mmToCanvas(zone.shape.widthMm);
  const height = mmToCanvas(zone.shape.heightMm);

  return (
    <Group
      opacity={opacity}
      draggable={selected}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.target;
        const nextX = zone.shape.xMm + canvasToMm(node.x());
        const nextY = zone.shape.yMm + canvasToMm(node.y());
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
  return (
    <Group>
      <SmallMetricLabel x={x + width / 2} y={y + 16} text={`${edgeCuts.top ?? 0} мм`} onClick={() => onEditOffset('top')} />
      <SmallMetricLabel x={x + width / 2} y={y + height - 16} text={`${edgeCuts.bottom ?? 0} мм`} onClick={() => onEditOffset('bottom')} />
      <SmallMetricLabel x={x + 24} y={y + height / 2} text={`${edgeCuts.left ?? 0} мм`} onClick={() => onEditOffset('left')} />
      <SmallMetricLabel x={x + width - 24} y={y + height / 2} text={`${edgeCuts.right ?? 0} мм`} onClick={() => onEditOffset('right')} />
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
  project,
}: {
  activeSurface: TileProject['surfaces'][number] | null | undefined;
  onAddDoor: () => void;
  onAddPassage: () => void;
  onAddPartition: () => void;
  onAddRoom: () => void;
  project: TileProject;
}) {
  const canAddOpening = activeSurface?.type === 'wall';
  return (
    <div className="room-tools">
      <strong>План помещений</strong>
      <div className="room-tools-stats">
        <span>{project.room.areas?.length ?? 1} помещ.</span>
        <span>{project.room.openings?.length ?? 0} проёмов</span>
        <span>{project.room.partitions?.length ?? 0} перегородок</span>
      </div>
      <div className="room-tools-actions">
        <button type="button" onClick={onAddRoom}>Добавить помещение</button>
        <button type="button" disabled={!canAddOpening} onClick={onAddDoor}>Дверь</button>
        <button type="button" disabled={!canAddOpening} onClick={onAddPassage}>Проход</button>
        <button type="button" onClick={onAddPartition}>Перегородка</button>
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
  onOriginModeChange: (originMode: SurfaceLayout['originMode']) => void;
  onOffsetInput: (axis: 'x' | 'y', value: string) => void;
  onOffsetReset: () => void;
  onOffsetStep: (deltaXmm: number, deltaYmm: number) => void;
  onPatternChange: (pattern: LayoutPattern) => void;
  onToggleLayoutDrag: (enabled: boolean) => void;
  surface: TileProject['surfaces'][number] | null | undefined;
  zone: FinishZone | null | undefined;
}) {
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
      <section className="panel-card panel-section layout-control">
        <h1>Раскладка</h1>
        <div className="layout-control-head">
          <span>Старт</span>
        </div>
        <div className="origin-mode-grid">
          {modes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              title={mode.title}
              aria-label={mode.title}
              className={zone?.layout.originMode === mode.value ? 'active' : ''}
              disabled={!zone}
              onClick={() => onOriginModeChange(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="center-mode-grid">
          <button type="button" className={zone?.layout.originMode === 'tile-center' ? 'active' : ''} disabled={!zone} onClick={() => onOriginModeChange('tile-center')}>
            Плитка в центре
          </button>
          <button type="button" className={zone?.layout.originMode === 'joint-center' ? 'active' : ''} disabled={!zone} onClick={() => onOriginModeChange('joint-center')}>
            Шов в центре
          </button>
        </div>
        <div className="layout-pattern-grid">
          {patterns.map((pattern) => (
            <button key={pattern.value} type="button" className={zone?.layout.pattern === pattern.value ? 'active' : ''} disabled={!zone} onClick={() => onPatternChange(pattern.value)}>
              {pattern.label}
            </button>
          ))}
        </div>
        <LayoutMetrics material={material} surface={surface} zone={zone} />
      </section>
      <details className="panel-card panel-section layout-control layout-move-card" open>
        <summary>Двигать</summary>
        <label className="layout-drag-toggle">
          <input type="checkbox" checked={layoutDragEnabled} disabled={!zone} onChange={(event) => onToggleLayoutDrag(event.currentTarget.checked)} />
          Двигать мышью
        </label>
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
          <label>
            X
            <input type="number" step={10} value={offsetX} disabled={!zone} onChange={(event) => onOffsetInput('x', event.currentTarget.value)} />
          </label>
          <label>
            Y
            <input type="number" step={10} value={offsetY} disabled={!zone} onChange={(event) => onOffsetInput('y', event.currentTarget.value)} />
          </label>
        </div>
      </details>
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
  x: (value: number) => number;
  y: (value: number) => number;
}

interface WallFrame {
  height: number;
  heightMm: number;
  id: string;
  index: number;
  name: string;
  width: number;
  widthMm: number;
  x: number;
  y: number;
}

function getFloorDimensionPosition(contour: PointMm[], index: number, view: PlanViewTransform) {
  const point = contour[index];
  const next = contour[(index + 1) % contour.length];
  const box = getBoundingBox(contour);
  const center = { x: view.x(box.minX + box.width / 2), y: view.y(box.minY + box.height / 2) };
  const mid = { x: (view.x(point.x) + view.x(next.x)) / 2, y: (view.y(point.y) + view.y(next.y)) / 2 };
  const horizontal = point.y === next.y;

  if (horizontal) {
    return { x: mid.x, y: mid.y < center.y ? mid.y - 24 : mid.y + 24 };
  }

  return { x: mid.x < center.x ? mid.x - 58 : mid.x + 58, y: mid.y };
}

function pointerToDraftPoint(pointer: { x: number; y: number }, viewport: CanvasViewport): PointMm {
  const canvasX = (pointer.x - viewport.x) / viewport.zoom;
  const canvasY = (pointer.y - viewport.y) / viewport.zoom;
  return {
    x: Math.max(0, canvasToMm(canvasX - PLAN_OFFSET_X)),
    y: Math.max(0, canvasToMm(canvasY - PLAN_OFFSET_Y)),
  };
}

function getPlanView(contour: PointMm[]): PlanViewTransform {
  const box = getBoundingBox(contour);

  return {
    scale: PX_PER_MM,
    x: (value: number) => PLAN_OFFSET_X + mmToCanvas(value - box.minX),
    y: (value: number) => PLAN_OFFSET_Y + mmToCanvas(value - box.minY),
  };
}

function getWallFrames(project: TileProject, view: PlanViewTransform): WallFrame[] {
  const walls = project.surfaces.filter((surface) => surface.type === 'wall');
  const startX = 170;
  const floorBottomY = Math.max(...project.room.contour.map((point) => view.y(point.y)));
  const startY = calculateWallsStartY(floorBottomY);
  const gap = mmToCanvas(350);
  let x = startX;

  return walls.map((wall, index) => {
    const frame = {
      height: mmToCanvas(wall.heightMm),
      heightMm: wall.heightMm,
      id: wall.id,
      index,
      name: wall.name,
      width: mmToCanvas(wall.widthMm),
      widthMm: wall.widthMm,
      x,
      y: startY,
    };
    x += frame.width + gap;
    return frame;
  });
}

function getInlineEdit(
  project: TileProject,
  target: Exclude<EditTarget, null>,
  view: PlanViewTransform,
  frames: WallFrame[],
  viewport: CanvasViewport,
): InlineEdit {
  if (target.type === 'wall-height') {
    const firstFrame = frames[0];
    const markerX = firstFrame ? firstFrame.x - 90 : 80;
    const markerY = firstFrame ? firstFrame.y + firstFrame.height / 2 : 520;
    return {
      left: Math.round(viewport.x + markerX * viewport.zoom),
      max: 4500,
      min: 1800,
      target,
      top: Math.round(viewport.y + markerY * viewport.zoom),
      value: project.room.heightMm,
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
  const contour = project.room.contour;
  const current = contour[index];
  const next = contour[(index + 1) % contour.length];
  const canvasScale = viewport.zoom;
  if (target.type === 'wall-segment') {
    const frame = frames[index];
    return {
      left: Math.round(viewport.x + (frame.x + frame.width / 2) * canvasScale),
      max: 15000,
      min: 1,
      target,
      top: Math.round(viewport.y + (frame.y + frame.height + 21) * canvasScale),
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
    x: target.edge === 'left' ? rect.x + 24 : target.edge === 'right' ? rect.x + rect.width - 24 : rect.x + rect.width / 2,
    y: target.edge === 'top' ? rect.y + 16 : target.edge === 'bottom' ? rect.y + rect.height - 16 : rect.y + rect.height / 2,
  };
}

function getZoneLayoutResult(surface: TileProject['surfaces'][number], zone: FinishZone, material: TileMaterial) {
  if (surface.type === 'floor' && zone.shape.type === 'polygon') {
    return generatePolygonLayout({ layout: zone.layout, points: zone.shape.points, tileHeightMm: material.heightMm, tileWidthMm: material.widthMm });
  }
  return generateRectLayout({
    blockedRects:
      surface.type === 'wall' && zone.shape.type === 'rect'
        ? surface.openings.map((opening) => ({
            type: 'rect' as const,
            xMm: Math.max(0, opening.xMm - zone.shape.xMm),
            yMm: Math.max(0, opening.yMm - zone.shape.yMm),
            widthMm: Math.min(opening.widthMm, zone.shape.widthMm),
            heightMm: Math.min(opening.heightMm, zone.shape.heightMm),
          }))
        : [],
    heightMm: zone.shape.type === 'rect' ? zone.shape.heightMm : surface.heightMm,
    layout: zone.layout,
    tileHeightMm: material.heightMm,
    tileWidthMm: material.widthMm,
    widthMm: zone.shape.type === 'rect' ? zone.shape.widthMm : surface.widthMm,
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

function handleWallDrag(event: Konva.KonvaEventObject<DragEvent>, index: number, horizontal: boolean, scale: number, onMoveWall: (index: number, deltaMm: number) => void) {
  const node = event.target;
  const deltaPx = horizontal ? node.y() : node.x();
  node.position({ x: 0, y: 0 });
  const deltaMm = Math.round(deltaPx / scale);
  if (Math.abs(deltaMm) >= 10) onMoveWall(index, deltaMm);
}

function getPreferredTemplateSize(template: RoomTemplate): [number, number] | undefined {
  if (template.id === 'rectangle') return template.sizes.find(([width, depth]) => width === 1700 && depth === 2000) ?? template.sizes[0];
  return template.sizes[0];
}
