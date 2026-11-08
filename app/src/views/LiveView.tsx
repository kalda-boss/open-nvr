/**
 * Copyright (c) 2026 OpenNVR
 * This file is part of OpenNVR.
 * 
 * OpenNVR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * OpenNVR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useRef, useState } from 'react'
import { apiService } from '../lib/apiService'
import { QrScanner } from '../components/QrScanner'
import { useFullscreen } from '../hooks/useFullscreen'
import { useClickOutside } from '../hooks/useClickOutside'
import { usePermissions } from '../hooks/usePermissions'
import { Camera, Maximize, Minimize, Play, Settings, Save, Image as ImageIcon, Book, HardDrive, Power, LayoutGrid, Menu as MenuIcon, Move, ChevronDown, ChevronUp, Video, Search, Expand, Scan, ScanEye, Tv } from 'lucide-react'
import { 
  DndContext, 
  DragOverlay, 
  useDraggable, 
  useDroppable, 
  closestCenter, 
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent, 
  type DragStartEvent
} from '@dnd-kit/core'
import { restrictToWindowEdges } from '@dnd-kit/modifiers'
import { useTranslation } from '../i18n'
import { useNavigate } from 'react-router-dom'
import { useSnackbar } from '../components/Snackbar'
import { Modal } from '../components/Modal'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { MiniSegment } from './dashboard/WidgetFrame'
import { clsx } from 'clsx'
import { PREDEFINED_LAYOUTS, type LayoutDefinition } from '../lib/liveLayouts'
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout'
import { Tile, type LiveCamera } from './live/LiveTile'
import { PhoneLiveView } from './live/PhoneLiveView'

interface WindowSettings {
  layouts_enabled: Record<string, boolean>
  custom_layouts: Array<{
    id: string
    name: string
    description?: string
    enabled: boolean
    grid_columns: number
    grid_rows: number
    tiles: Array<{ row: number; col: number; rowSpan: number; colSpan: number }>
  }>
  default_layout: string
}

/**
 * Live View. Phones get their own view, one big camera (or four) with every
 * camera listed underneath to tap; everything wider gets the wall. Chosen in
 * JS, not CSS, so the wall's players unmount instead of decoding hidden.
 */
export function LiveView() {
  return useIsPhoneLayout() ? <PhoneLiveView /> : <DesktopLiveView />
}

function DesktopLiveView() {
  const { t } = useTranslation()
  const { hasPermission } = usePermissions()
  const canManageCameras = hasPermission('cameras.manage')
  const [currentLayout, setCurrentLayout] = useState<string>('3x3')
  const [windowSettings, setWindowSettings] = useState<WindowSettings | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const { toggle: toggleFs, isFullscreen } = useFullscreen(gridRef as React.RefObject<HTMLDivElement>)
  // FS toolbar visibility — toggled by the bottom-center handle button
  const [fsToolbarVisible, setFsToolbarVisible] = useState(false)
  const [availableCameras, setAvailableCameras] = useState<LiveCamera[]>([])
  
  // Camera display order - array of camera IDs in display sequence
  // This determines which camera appears in which tile position
  const [cameraDisplayOrder, setCameraDisplayOrder] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('liveview-camera-display-order')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  
  // Grid sizing mode, persisted per browser. Fill (default) stretches cells
  // to use the whole area (feeds letterbox inside against the panel bg);
  // Fit keeps strict 16:9 cells centered.
  const [fillMode, setFillMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('liveview-grid-mode') !== 'fit'
    } catch {
      return true
    }
  })
  const toggleFillMode = () => setFillMode(prev => {
    const next = !prev
    try { localStorage.setItem('liveview-grid-mode', next ? 'fill' : 'fit') } catch { /* private mode */ }
    return next
  })

  // Detection overlay: boxes + label + score from Tier-0, drawn over every
  // live tile. Per-browser preference like the grid mode — an operator at
  // the wall wants a clean picture; the one debugging a zone wants boxes.
  // Off by default: the picture is the product, the boxes are a tool.
  const [showDetections, setShowDetections] = useState<boolean>(() => {
    try {
      return localStorage.getItem('liveview-detections') === 'on'
    } catch {
      return false
    }
  })
  const toggleDetections = () => setShowDetections(prev => {
    const next = !prev
    try { localStorage.setItem('liveview-detections', next ? 'on' : 'off') } catch { /* private mode */ }
    return next
  })

  // Drag state for overlay
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  
  // Configure sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    })
  )
  
  // Custom modifier to center overlay on cursor
  const centerOnCursor = ({ transform, activeNodeRect, activatorEvent }: any) => {
    if (activeNodeRect && activatorEvent) {
      // Calculate where within the element the user clicked
      const offsetX = activatorEvent.clientX - activeNodeRect.left
      const offsetY = activatorEvent.clientY - activeNodeRect.top
      
      // Overlay size: 128px x 88px, we want cursor at center
      const overlayHalfWidth = 64
      const overlayHalfHeight = 44
      
      return {
        ...transform,
        x: transform.x + offsetX - overlayHalfWidth,
        y: transform.y + offsetY - overlayHalfHeight,
      }
    }
    return transform
  }
  
  // Function to reload cameras
  const loadCameras = () => {
    apiService.getCameras().then(({ data }) => {
      const cameras = data.cameras || data || []
      // live_online is kept so a tile that mounts while its camera is already
      // down can say so on first paint. The events socket only reports
      // transitions, so without this the overlay waits for the camera to
      // change state — which, for one that is simply still offline, never
      // happens, and the tile just shows a dead player.
      const cameraList = cameras.map((cam: any) => ({
        id: cam.id,
        name: cam.name,
        live_online: cam.live_online,
        // The display-aspect override rides along so the tile can render an
        // anamorphic stream at its true shape — see lib/aspect.ts (#354).
        display_aspect_ratio: cam.display_aspect_ratio,
        // A 360° camera's lens, so its tile can dewarp — see lib/fisheye.ts.
        fisheye: cam.fisheye ?? null,
      }))
      setAvailableCameras(cameraList)
      
      // Update display order: add new cameras, remove deleted ones
      setCameraDisplayOrder(prevOrder => {
        const existingIds = new Set(cameraList.map((c: {id: number}) => c.id))
        // Deleted cameras become empty slots (0), NOT dropped — dropping
        // would shift every later camera left and lose the empty-tile
        // positions that drag-drop and tile assignment create.
        const filtered = prevOrder.map(id => (id === 0 || existingIds.has(id) ? id : 0))
        // Add new cameras that aren't in the order yet
        const newCameras = cameraList
          .filter((c: {id: number}) => !filtered.includes(c.id))
          .map((c: {id: number}) => c.id)
        const updated = [...filtered, ...newCameras]
        // Trim trailing empties.
        while (updated.length > 0 && !updated[updated.length - 1]) {
          updated.pop()
        }
        // Persist to localStorage
        try {
          localStorage.setItem('liveview-camera-display-order', JSON.stringify(updated))
        } catch {}
        return updated
      })
    }).catch(console.error)
  }
  
  // Assign a camera to a specific tile position. Same sparse convention as
  // swapTilePositions: 0 marks an empty tile, so the camera lands on exactly
  // the tile that was clicked (the old dense-pack version collapsed
  // placeholders, which made "select existing camera" a visible no-op).
  const assignCameraToTile = (tileIndex: number, cameraId: number) => {
    setCameraDisplayOrder(prev => {
      const updated = [...prev]
      while (updated.length <= tileIndex) {
        updated.push(0) // empty-slot placeholder
      }
      const from = updated.indexOf(cameraId)
      const displaced = updated[tileIndex]
      updated[tileIndex] = cameraId
      if (from !== -1 && from !== tileIndex) {
        // Move/swap: the clicked tile's previous camera (if any) takes the
        // selected camera's old slot.
        updated[from] = displaced || 0
      } else if (from === -1 && displaced && displaced !== cameraId) {
        // Camera wasn't placed yet but the tile was occupied — keep the
        // displaced camera visible by appending it.
        updated.push(displaced)
      }
      // Trim trailing empties so shorter layouts aren't padded forever.
      while (updated.length > 0 && !updated[updated.length - 1]) {
        updated.pop()
      }
      try {
        localStorage.setItem('liveview-camera-display-order', JSON.stringify(updated))
      } catch {}
      return updated
    })
  }
  
  // Swap two tile positions (for drag and drop)
  const swapTilePositions = (fromIndex: number, toIndex: number) => {
    setCameraDisplayOrder(prev => {
      const updated = [...prev]
      // Ensure array is long enough for both indices
      const maxIndex = Math.max(fromIndex, toIndex)
      while (updated.length <= maxIndex) {
        updated.push(0) // placeholder for empty slots
      }
      // Swap the cameras at these positions
      const temp = updated[fromIndex]
      updated[fromIndex] = updated[toIndex]
      updated[toIndex] = temp
      // Filter out any 0 placeholders (empty swaps)
      const cleaned = updated.filter(id => id !== 0)
      try {
        localStorage.setItem('liveview-camera-display-order', JSON.stringify(cleaned))
      } catch {}
      return cleaned
    })
  }
  
  // Handle drag end - swap tiles
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveDragId(null)
    
    if (!over || active.id === over.id) return
    
    const fromIndex = parseInt(String(active.id).replace('tile-', ''))
    const toIndex = parseInt(String(over.id).replace('tile-', ''))
    
    if (isNaN(fromIndex) || isNaN(toIndex)) return
    
    swapTilePositions(fromIndex, toIndex)
  }
  
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }
  
  // Get current layout definition
  const getLayoutDef = (): LayoutDefinition => {
    // Check custom layouts first
    if (windowSettings?.custom_layouts) {
      const custom = windowSettings.custom_layouts.find(l => l.id === currentLayout && l.enabled)
      if (custom) {
        return {
          name: custom.name,
          gridCols: custom.grid_columns,
          gridRows: custom.grid_rows,
          tiles: custom.tiles.map(t => ({ row: t.row, col: t.col, rowSpan: t.rowSpan, colSpan: t.colSpan }))
        }
      }
    }
    // Fall back to predefined layouts
    return PREDEFINED_LAYOUTS[currentLayout] || PREDEFINED_LAYOUTS['3x3']
  }
  
  const layoutDef = getLayoutDef()

  // Fit the grid to the available area while keeping every cell 16:9: the
  // largest cell size is computed from the container's width AND height, so
  // videos fill their tiles edge-to-edge (overlays sit on the feed, not on
  // pillarbox bars) and the toolbar below stays on screen.
  const [gridSize, setGridSize] = useState<{ w: number; h: number } | null>(null)
  const GRID_GAP = 1 // matches the grid's Tailwind gap-px
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const compute = () => {
      const cols = layoutDef.gridCols
      const rows = layoutDef.gridRows
      const availW = el.clientWidth - GRID_GAP * (cols - 1)
      const availH = el.clientHeight - GRID_GAP * (rows - 1)
      const cellW = Math.max(0, Math.min(availW / cols, (availH / rows) * (16 / 9)))
      setGridSize({
        w: cellW * cols + GRID_GAP * (cols - 1),
        h: cellW * (9 / 16) * rows + GRID_GAP * (rows - 1),
      })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layoutDef.gridCols, layoutDef.gridRows])

  // Load window settings on mount
  useEffect(() => {
    apiService.getWindowSettings().then(({ data }) => {
      setWindowSettings(data)
      // Set default layout if available
      if (data?.default_layout) {
        setCurrentLayout(data.default_layout)
      }
    }).catch(console.error)
  }, [])

  useEffect(() => {
    // Load available cameras
    loadCameras()
  }, [])

  // Reset the toolbar when entering/leaving fullscreen so it never starts open.
  useEffect(() => {
    setFsToolbarVisible(false)
  }, [isFullscreen])
  
  // Get all available layouts (enabled predefined + enabled custom)
  const getAvailableLayouts = () => {
    const layouts: Array<{ id: string; name: string; tiles: number }> = []
    
    // Add enabled predefined layouts
    Object.entries(PREDEFINED_LAYOUTS).forEach(([id, def]) => {
      if (!windowSettings || windowSettings.layouts_enabled[id] !== false) {
        layouts.push({ id, name: def.name, tiles: def.tiles.length })
      }
    })
    
    // Add enabled custom layouts
    if (windowSettings?.custom_layouts) {
      windowSettings.custom_layouts
        .filter(l => l.enabled)
        .forEach(l => {
          layouts.push({ id: l.id, name: l.name, tiles: l.tiles.length })
        })
    }
    
    return layouts
  }
  
  const availableLayouts = getAvailableLayouts()

  return (
    // Fixed viewport-height layout: header + grid + toolbar must all fit
    // without a page scrollbar. 3rem = app header, 2rem = main's p-4.
    // One panel in the dashboard widgets' grammar: a slim header, then the
    // wall owns every remaining pixel, tiles split by hairlines.
    <section className="flex flex-col h-[calc(100vh-5rem)] border border-[var(--border)] bg-[var(--panel-2)] overflow-hidden">
      <header className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
        <Tv size={13} className="text-[var(--text-dim)] shrink-0" aria-hidden="true" />
        <h1 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text)] whitespace-nowrap">{t('live.title')}</h1>
        <span className="hidden sm:inline text-[11px] text-[var(--text-dim)] font-mono tabular-nums truncate min-w-0">
          {availableCameras.length} {t('dashboard.camerasPlural')} · {layoutDef.name}
        </span>
        <ToolbarContents
          currentLayout={currentLayout}
          setCurrentLayout={setCurrentLayout}
          availableLayouts={availableLayouts}
          onOpenMenu={() => setMenuOpen(true)}
          onToggleFullscreen={toggleFs}
          isFullscreen={isFullscreen}
          fillMode={fillMode}
          onToggleFillMode={toggleFillMode}
          showDetections={showDetections}
          onToggleDetections={toggleDetections}
        />
      </header>

      <DndContext 
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div ref={containerRef} className="flex-1 min-h-0 flex items-center justify-center bg-black">
        <div
          ref={gridRef}
          className="grid gap-px relative bg-[#1a1f29]"
          style={{
            gridTemplateColumns: `repeat(${layoutDef.gridCols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${layoutDef.gridRows}, minmax(0, 1fr))`,
            // Fullscreen and Fill mode: take the whole container (cells may
            // deviate from 16:9; the player letterboxes internally). Fit mode
            // uses the fitted 16:9-cell size (see effect).
            ...(isFullscreen || fillMode || !gridSize
              ? { width: '100%', height: '100%' }
              : { width: gridSize.w, height: gridSize.h }),
          }}
        >
          {layoutDef.tiles.map((tile, i) => {
            // cameraDisplayOrder maps tile index → camera id; 0 (or missing)
            // marks an empty tile, so empty slots can sit anywhere.
            const assignedCameraId = cameraDisplayOrder[i] || null
            
            return (
              <div
                key={i}
                style={{
                  gridRow: `${tile.row + 1} / span ${tile.rowSpan}`,
                  gridColumn: `${tile.col + 1} / span ${tile.colSpan}`,
                }}
              >
                <DroppableTile tileId={`tile-${i}`}>
                  <DraggableTile 
                    tileId={`tile-${i}`}
                    hasCameraAssigned={!!assignedCameraId}
                  >
                    <Tile 
                      index={i} 
                      availableCameras={availableCameras} 
                      assignedCameraId={assignedCameraId} 
                      onCameraSelected={(cameraId) => assignCameraToTile(i, cameraId)}
                      onCameraAdded={loadCameras}
                      isDragging={activeDragId === `tile-${i}`}
                      canManage={canManageCameras}
                      showDetections={showDetections}
                    />
                  </DraggableTile>
                </DroppableTile>
              </div>
            )
          })}
          {/* Fullscreen toolbar overlay — opened via the bottom-center handle
              so it never pops up over the bottom tiles' own controls */}
          {isFullscreen && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center">
              <button
                className="pointer-events-auto flex items-center justify-center w-12 h-5 bg-black/50 hover:bg-black/80 text-white/60 hover:text-white transition-colors"
                onClick={() => setFsToolbarVisible((v) => !v)}
                title={fsToolbarVisible ? t('live.hideToolbar') : t('live.showToolbar')}
              >
                {fsToolbarVisible ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {fsToolbarVisible && (
                <div className="pointer-events-auto self-stretch h-8 flex items-center gap-2 px-2.5 bg-[var(--panel-2)] border-t border-[var(--border)]">
                  <ToolbarContents
                    currentLayout={currentLayout}
                    setCurrentLayout={setCurrentLayout}
                    availableLayouts={availableLayouts}
                    onOpenMenu={() => setMenuOpen(true)}
                    onToggleFullscreen={toggleFs}
                    isFullscreen={isFullscreen}
                    showDetections={showDetections}
                    onToggleDetections={toggleDetections}
                    dropUp
                    showFitToggle={false}
                  />
                </div>
              )}
            </div>
          )}
          {/* Menu overlay inside fullscreen so it appears over the live view */}
          {isFullscreen && menuOpen && <MenuOverlay onClose={() => setMenuOpen(false)} />}
        </div>
        </div>

        {/* Drag overlay - small tile preview centered on cursor */}
        <DragOverlay dropAnimation={null} modifiers={[centerOnCursor]}>
          {activeDragId ? (() => {
            const tileIndex = parseInt(activeDragId.replace('tile-', ''))
            const cameraId = cameraDisplayOrder[tileIndex]
            const camera = availableCameras.find(c => c.id === cameraId)
            return (
              <div className="w-32 bg-[var(--bg-2)] border-2 border-[var(--accent)] shadow-2xl overflow-hidden pointer-events-none">
                <div className="flex flex-col">
                  {/* Camera name header */}
                  <div className="bg-black/80 px-2 py-1 flex items-center justify-between">
                    <span className="text-[10px] font-medium text-white truncate">
                      {camera?.name || `Camera ${cameraId}`}
                    </span>
                    <span className="text-[8px] bg-[var(--critical)] px-1 text-white">{t('live.live')}</span>
                  </div>
                  {/* Preview area */}
                  <div className="h-16 bg-[var(--panel-2)] flex items-center justify-center">
                    <div className="text-center">
                      <Move size={14} className="mx-auto text-[var(--accent)]" />
                    </div>
                  </div>
                </div>
              </div>
            )
          })() : null}
        </DragOverlay>
      </DndContext>

      {menuOpen && !isFullscreen && <MenuOverlay onClose={() => setMenuOpen(false)} />}
    </section>
  )
}

// Droppable wrapper for tiles
function DroppableTile({ tileId, children }: { tileId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: tileId })
  
  return (
    <div ref={setNodeRef} className="h-full relative">
      {children}
      {isOver && <div className="pointer-events-none absolute inset-0 z-40 ring-2 ring-inset ring-[var(--accent)]" />}
    </div>
  )
}

// Draggable wrapper for tiles - entire tile is draggable
function DraggableTile({ 
  tileId, 
  hasCameraAssigned,
  children 
}: { 
  tileId: string
  hasCameraAssigned: boolean
  children: React.ReactNode 
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ 
    id: tileId,
    disabled: !hasCameraAssigned // Only allow dragging tiles with cameras
  })
  
  return (
    <div 
      ref={setNodeRef}
      {...(hasCameraAssigned ? listeners : {})}
      {...(hasCameraAssigned ? attributes : {})}
      className={`h-full relative ${isDragging ? 'opacity-50 scale-95' : ''} ${hasCameraAssigned ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      {children}
    </div>
  )
}

function ToolbarContents({
  currentLayout,
  setCurrentLayout,
  availableLayouts,
  onOpenMenu,
  onToggleFullscreen,
  isFullscreen = false,
  dropUp = false,
  fillMode,
  onToggleFillMode,
  showDetections,
  onToggleDetections,
  showFitToggle = true,
}: {
  currentLayout: string
  setCurrentLayout: (layout: string) => void
  availableLayouts: Array<{ id: string; name: string; tiles: number }>
  onOpenMenu: () => void
  onToggleFullscreen: () => void
  isFullscreen?: boolean
  /** Layout dropdown direction: up when the bar sits at the bottom (fullscreen). */
  dropUp?: boolean
  fillMode?: boolean
  onToggleFillMode?: () => void
  showDetections?: boolean
  onToggleDetections?: () => void
  showFitToggle?: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [layoutDropdownOpen, setLayoutDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  useClickOutside(dropdownRef, layoutDropdownOpen, () => setLayoutDropdownOpen(false))

  const quick = ['1x1', '2x2', '3x3', '4x4']
    .map((id) => availableLayouts.find((l) => l.id === id))
    .filter((l): l is { id: string; name: string; tiles: number } => !!l)

  return (
    <div className="ml-auto flex items-center gap-1 shrink-0">
      {/* Quick layouts — collapse into the dropdown below md */}
      {quick.length > 0 && (
        <div className="hidden md:flex">
          <MiniSegment
            label={t('live.layouts')}
            value={currentLayout}
            options={quick.map((l) => ({ value: l.id, label: l.name }))}
            onChange={setCurrentLayout}
          />
        </div>
      )}
      {/* More layouts dropdown */}
      <div className="relative" ref={dropdownRef}>
        <HeadButton
          onClick={() => setLayoutDropdownOpen(!layoutDropdownOpen)}
          aria-haspopup="menu"
          aria-expanded={layoutDropdownOpen}
          aria-label={t('live.layouts')}
          title={t('live.layouts')}
        >
          <LayoutGrid size={12} />
          <ChevronDown size={11} />
        </HeadButton>
        {layoutDropdownOpen && (
          <div className={`absolute right-0 z-50 bg-[var(--panel)] border border-[var(--border)] shadow-lg min-w-[160px] ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            {availableLayouts.map(layout => (
              <button
                key={layout.id}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--panel-2)] ${currentLayout === layout.id ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : ''}`}
                onClick={() => { setCurrentLayout(layout.id); setLayoutDropdownOpen(false) }}
              >
                {layout.name} <span className="text-[var(--text-dim)] font-mono">({layout.tiles})</span>
              </button>
            ))}
            <div className="border-t border-[var(--border)] px-3 py-1.5">
              <button
                className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]"
                onClick={() => {
                  setLayoutDropdownOpen(false)
                  navigate('/settings/more-settings/window-settings')
                }}
              >
                ⚙ {t('live.configureLayouts')}
              </button>
            </div>
          </div>
        )}
      </div>
      <span className="w-px h-4 bg-[var(--border)] mx-0.5" aria-hidden="true" />
      {/* Fit/Fill toggle (hidden in fullscreen, which always fills) */}
      {showFitToggle && onToggleFillMode && (
        <HeadButton active={fillMode} onClick={onToggleFillMode} title={fillMode ? t('live.fill') : t('live.fit')}>
          {fillMode ? <Expand size={12} /> : <Scan size={12} />}
          <span className="hidden sm:inline">{fillMode ? t('live.fill') : t('live.fit')}</span>
        </HeadButton>
      )}
      {/* Detection overlay on/off — icon only, lit when on like Fit/Fill;
          the tooltip says what it draws. */}
      {onToggleDetections && (
        <HeadButton
          active={showDetections}
          onClick={onToggleDetections}
          aria-pressed={showDetections}
          aria-label={t('live.boxes')}
          title={showDetections
            ? `${t('live.boxes')}: on — tracked objects are outlined with label and confidence`
            : `${t('live.boxes')}: off — outline tracked objects with label and confidence`}
        >
          <ScanEye size={12} />
        </HeadButton>
      )}
      <HeadButton
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? t('video.exitFullscreen') : t('live.fullscreen')}
        title={isFullscreen ? t('video.exitFullscreen') : t('live.fullscreen')}
      >
        {isFullscreen ? <Minimize size={12} /> : <Maximize size={12} />}
      </HeadButton>
      <HeadButton onClick={onOpenMenu} title={t('live.menu')} aria-label={t('live.menu')}>
        <MenuIcon size={12} />
      </HeadButton>
    </div>
  )
}

/** A header-sized button, matching the dashboard's MiniSegment: lit when active. */
function HeadButton({ active = false, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'h-5 px-1.5 inline-flex items-center gap-1 text-[10px] leading-none border',
        active
          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
          : 'border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--panel)]',
        className,
      )}
    >
      {children}
    </button>
  )
}

function MenuOverlay({ onClose }: { onClose: () => void }) {
  const items = [
    { icon: <Play />, label: 'Live View', action: 'live' },
    { icon: <Save />, label: 'Export', action: 'export' },
    { icon: <ImageIcon />, label: 'Image Search', action: 'image' },
    { icon: <Book />, label: 'Manual', action: 'manual' },
    { icon: <HardDrive />, label: 'HDD', action: 'hdd' },
    { icon: <Camera />, label: 'Camera', action: 'camera' },
    { icon: <Settings />, label: 'Configuration', action: 'settings', highlight: true },
    { icon: <Power />, label: 'Shutdown', action: 'shutdown' },
  ]
  return (
    <Modal open title="Menu" onClose={onClose} widthClassName="w-[520px] max-w-[92vw]">
      <div className="grid grid-cols-3 gap-3">
        {items.map((it) => (
          <MenuItem key={it.label} item={it as any} onClose={onClose} />
        ))}
      </div>
    </Modal>
  )
}

function MenuItem({ item, onClose }: { item: { icon: React.ReactNode; label: string; action: string; highlight?: boolean }, onClose: () => void }) {
  const navigate = useNavigate()
  const { showSuccess, showError } = useSnackbar()
  const confirm = useConfirm()
  async function handleClick() {
    switch (item.action) {
      case 'live':
        navigate('/live')
        break
      case 'export':
        navigate('/playback')
        break
      // /settings/webrtc was never a tab key; this is the real first tab.
      case 'settings':
        navigate('/settings/camera-config/device')
        break
      case 'hdd':
        navigate('/settings/media-source')
        break
      case 'image':
        navigate('/search')
        break
      // These two tiles did nothing at all before: no case handled them.
      case 'manual':
        navigate('/support')
        break
      case 'camera':
        navigate('/cameras')
        break
      case 'shutdown':
        try {
          const ok = await confirm({
            title: 'Shut down the system?',
            message: 'Live view, recording and every app stop until the machine is powered on again.',
            confirmLabel: 'Shut down',
            danger: true,
          })
          if (!ok) break
          await apiService.systemShutdown()
          showSuccess('Shutdown requested. The system may go offline shortly.')
        } catch (e: any) {
          showError(e?.message || 'Failed to request shutdown')
        }
        break
      default:
        break
    }
    onClose()
  }
  return (
    <button onClick={handleClick} className={`flex flex-col items-center gap-2 py-3 bg-[var(--bg-2)] border ${item.highlight ? 'border-[var(--accent)]' : 'border-[var(--border)]'} hover:border-[var(--accent)]`}>
      <div className="w-10 h-10 flex items-center justify-center bg-[var(--panel-2)] border border-[var(--border)]">
        {item.icon}
      </div>
      <span className="text-xs">{item.label}</span>
    </button>
  )
}

