import type { AnyCircuitElement } from "circuit-json"
export type CircuitJson = readonly AnyCircuitElement[]
export type Point = { x: number; y: number }
export type Matrix = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}
export type Color = readonly [number, number, number, number]
/** A round stroke painted on top of the geometry for an existing layer. */
export type LayerStroke = {
  layer: string
  start: Point
  end: Point
  /** Width on the board, in mm. */
  widthMm: number
  /** Minimum width in canvas pixels. */
  minWidthPixels?: number
  /** Extra canvas pixels added after applying the minimum, for an outset stroke. */
  extraWidthPixels?: number
  /** Maximum width on the board, in mm. An outset that cannot expand is skipped. */
  maxWidthMm?: number
  color: Color
}
export type RenderOptions = {
  /** Draw in array order, before layer erasures and compositing. Reuse the array while the strokes are unchanged. */
  layerStrokes?: readonly LayerStroke[]
  transform?: Matrix
  layers?: readonly string[]
  selectedLayer?: string
  hiddenLayerOpacity?: number
  /** Copper-pour alpha multiplier (0–1, default 0.5, matching Canvas/SVG). showCopperPours=false overrides it. */
  copperPourOpacity?: number
  showCopperPours?: boolean
  /** Board substrate is hidden by default; outlines remain visible. */
  showBoardMaterial?: boolean
  showSolderMask?: boolean
  showSilkscreen?: boolean
  showFabricationNotes?: boolean
  showPcbNotes?: boolean
  showCourtyards?: boolean
  highlightedElementIds?: readonly string[]
  /** Copper belonging to an inspected net. Supply resolved PCB element IDs.
   * Selected copper is opaque on every layer; other copper uses hiddenLayerOpacity.
   * Omit or pass [] to exit. Explicit layers and visibility toggles still apply.
   * Selected via and plated-hole drills stay visible; all other non-copper
   * layers and hover highlights are hidden until X-Ray is cleared.
   * Selection changes reuse the retained geometry buffers.
   */
  xRayElementIds?: readonly string[]
  background?: Color
}
export type Diagnostic = { elementId: string; type: string; message: string }
export type Mesh = { vertices: Float32Array; indices: Uint32Array }
/** The paint mesh retains covered traces for the drawer's visibility toggle. */
export type CompiledLayer = { name: string; paint: Mesh; erase: Mesh }
export type CompiledScene = {
  layers: CompiledLayer[]
  elementIds: string[]
  diagnostics: Diagnostic[]
  triangleCount: number
}
export type CompileOptions = {
  /** Use down for Canvas-style coordinates; PCB world coordinates default to up. */
  textYAxis?: "up" | "down"
  layerColors?: Record<string, Color>
  /** Set false to reduce via mesh size while targeting 0.0025 mm chord error. */
  renderViasInHighDetail?: boolean
}
export type DrawerOptions = CompileOptions & {
  sampleCount?: 1 | 4
  onDeviceLost?: (message: string) => void
}
