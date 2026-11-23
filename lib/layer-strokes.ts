import { normalizeLayer } from "./colors"
import type { LayerStroke } from "./types"

/** Each stroke is one instance of 12 floats: endpoints, widths, colour. */
const FLOATS_PER_STROKE = 12
const BYTES_PER_FLOAT = 4
/** Floats before each vec4 attribute within a stroke. */
const ENDPOINTS_OFFSET_FLOATS = 0
const WIDTHS_OFFSET_FLOATS = 4
const COLOR_OFFSET_FLOATS = 8
/** Stands in for "no maximum width" in mm: wider than any canvas. */
const UNBOUNDED_WIDTH_SENTINEL_MM = 1e20
/** Board segments shorter than this are dots, so they still get a direction. */
const MIN_BOARD_DIRECTION_LENGTH_MM = 1e-6
/** Canvas vectors shorter than this are treated as zero length. */
const MIN_CANVAS_DIRECTION_LENGTH_PIXELS = 1e-6
/** Canvas segments with a squared length below this are dots. */
const MIN_CANVAS_SEGMENT_LENGTH_PIXELS_SQUARED = 1e-6

/** A layer name after `normalizeLayer`, as the drawer names its layer passes. */
type RenderLayerName = string

const strokeShader = /* wgsl */ `
struct Camera { rowX: vec4f, rowY: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) pixel: vec2f,
  @location(1) @interpolate(flat) endpoints: vec4f,
  @location(2) @interpolate(flat) radius: f32,
  @location(3) @interpolate(flat) color: vec4f,
}
const MIN_BOARD_DIRECTION_LENGTH_MM = ${MIN_BOARD_DIRECTION_LENGTH_MM};
const MIN_CANVAS_DIRECTION_LENGTH_PIXELS = ${MIN_CANVAS_DIRECTION_LENGTH_PIXELS};
const MIN_CANVAS_SEGMENT_LENGTH_PIXELS_SQUARED = ${MIN_CANVAS_SEGMENT_LENGTH_PIXELS_SQUARED};
fn project(p: vec2f) -> vec2f {
  return vec2f(dot(camera.rowX.xyz, vec3f(p, 1)), dot(camera.rowY.xyz, vec3f(p, 1)));
}
fn direction(delta: vec2f, minLength: f32) -> vec2f {
  return select(vec2f(1, 0), delta / max(length(delta), minLength), length(delta) > minLength);
}
@vertex fn vertexMain(
  @builtin(vertex_index) vertex: u32,
  @location(0) endpoints: vec4f,
  @location(1) widths: vec4f,
  @location(2) color: vec4f,
) -> VertexOut {
  let corners = array<vec2f, 6>(vec2f(0,-1), vec2f(1,-1), vec2f(0,1),
                               vec2f(0,1), vec2f(1,-1), vec2f(1,1));
  let corner = corners[vertex];
  let start = project(endpoints.xy);
  let end = project(endpoints.zw);
  let tangent = direction(end - start, MIN_CANVAS_DIRECTION_LENGTH_PIXELS);
  let normal = vec2f(-tangent.y, tangent.x);
  // Canvas pixels per mm across the stroke: |det A| / |A t| for the board
  // direction t, so a non-uniform transform keeps the board width.
  let linear = mat2x2f(camera.rowX.x, camera.rowY.x, camera.rowX.y, camera.rowY.y);
  let boardTangent = direction(endpoints.zw - endpoints.xy, MIN_BOARD_DIRECTION_LENGTH_MM);
  let pixelsPerMmAcrossStroke = abs(determinant(linear)) / max(length(linear * boardTangent), MIN_CANVAS_DIRECTION_LENGTH_PIXELS);
  let baseWidthPixels = max(widths.x * pixelsPerMmAcrossStroke, widths.y);
  let strokeWidthPixels = min(baseWidthPixels + widths.z, widths.w * pixelsPerMmAcrossStroke);
  let radius = strokeWidthPixels * 0.5;
  let pixel = mix(start, end, corner.x) + (tangent * (2 * corner.x - 1) + normal * corner.y) * (radius + 1);
  let ndc = pixel / camera.viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  let enabled = widths.z == 0 || strokeWidthPixels > baseWidthPixels;
  return VertexOut(vec4f(ndc, 0, 1), pixel, vec4f(start, end), radius, select(vec4f(0), color, enabled));
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let offset = in.pixel - in.endpoints.xy;
  let delta = in.endpoints.zw - in.endpoints.xy;
  let nearestSegmentFraction = clamp(dot(offset, delta) / max(dot(delta, delta), MIN_CANVAS_SEGMENT_LENGTH_PIXELS_SQUARED), 0, 1);
  let coverage = clamp(in.radius - length(offset - nearestSegmentFraction * delta) + 0.5, 0, 1);
  let alpha = in.color.a * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`

/** Counts each time stroke buffers are rebuilt and uploaded. */
export type StrokeStats = { strokeUploads: number }

/**
 * Per-layer stroke buffers, drawn inside each layer's paint pass. Buffers
 * are rebuilt only when a different stroke array is set. Widths are kept
 * across the stroke under any affine transform; round caps are circles on
 * the canvas.
 */
export class LayerStrokes {
  private device: GPUDevice
  private uniform: GPUBuffer
  private sampleCount: number
  private blend: GPUBlendState
  private stats: StrokeStats
  private pipeline?: GPURenderPipeline
  private camera?: GPUBindGroup
  private strokes?: readonly LayerStroke[]
  private buffers = new Map<
    RenderLayerName,
    { buffer: GPUBuffer; strokeInstanceCount: number }
  >()

  constructor({
    device,
    uniform,
    sampleCount,
    blend,
    stats,
  }: {
    device: GPUDevice
    /** The drawer's camera uniform. */
    uniform: GPUBuffer
    sampleCount: number
    blend: GPUBlendState
    stats: StrokeStats
  }) {
    this.device = device
    this.uniform = uniform
    this.sampleCount = sampleCount
    this.blend = blend
    this.stats = stats
  }

  /** Uses `strokes` from now on; the same array keeps the uploaded buffers. */
  set(strokes?: readonly LayerStroke[]) {
    if (strokes === this.strokes) return
    this.dispose()
    this.strokes = strokes
    if (!strokes?.length) return

    const strokesByRenderLayer = new Map<RenderLayerName, LayerStroke[]>()
    for (const stroke of strokes) {
      const name = normalizeLayer(stroke.layer)
      const layerStrokes = strokesByRenderLayer.get(name)
      if (layerStrokes) {
        layerStrokes.push(stroke)
        continue
      }
      strokesByRenderLayer.set(name, [stroke])
    }
    for (const [layer, layerStrokes] of strokesByRenderLayer) {
      const strokeInstanceAttributes = new Float32Array(
        layerStrokes.length * FLOATS_PER_STROKE,
      )
      layerStrokes.forEach((stroke, index) => {
        strokeInstanceAttributes.set(
          packStrokeInstanceAttributes(stroke),
          index * FLOATS_PER_STROKE,
        )
      })
      const buffer = this.device.createBuffer({
        size: strokeInstanceAttributes.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(buffer, 0, strokeInstanceAttributes)
      this.buffers.set(layer, {
        buffer,
        strokeInstanceCount: layerStrokes.length,
      })
    }
    this.stats.strokeUploads++
  }

  /** Draws the strokes of `layer` into `pass`, if it has any. */
  draw({
    pass,
    layer,
  }: {
    pass: GPURenderPassEncoder
    layer: RenderLayerName
  }) {
    const strokes = this.buffers.get(layer)
    if (!strokes) return
    if (!this.pipeline) {
      const module = this.device.createShaderModule({ code: strokeShader })
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vertexMain",
          buffers: [
            {
              arrayStride: FLOATS_PER_STROKE * BYTES_PER_FLOAT,
              stepMode: "instance",
              attributes: [
                {
                  shaderLocation: 0,
                  offset: ENDPOINTS_OFFSET_FLOATS * BYTES_PER_FLOAT,
                  format: "float32x4",
                },
                {
                  shaderLocation: 1,
                  offset: WIDTHS_OFFSET_FLOATS * BYTES_PER_FLOAT,
                  format: "float32x4",
                },
                {
                  shaderLocation: 2,
                  offset: COLOR_OFFSET_FLOATS * BYTES_PER_FLOAT,
                  format: "float32x4",
                },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: "fragmentMain",
          targets: [{ format: "rgba8unorm", blend: this.blend }],
        },
        multisample: { count: this.sampleCount },
      })
      this.camera = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform } }],
      })
    }
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.camera!)
    pass.setVertexBuffer(0, strokes.buffer)
    pass.draw(6, strokes.strokeInstanceCount)
  }

  /** Destroys the uploaded buffers. */
  dispose() {
    for (const { buffer } of this.buffers.values()) buffer.destroy()
    this.buffers.clear()
  }
}

/** One stroke's instance attributes, in the order the shader reads them. */
function packStrokeInstanceAttributes(stroke: LayerStroke): number[] {
  const floats = new Array<number>(FLOATS_PER_STROKE)
  floats[ENDPOINTS_OFFSET_FLOATS] = stroke.start.x
  floats[ENDPOINTS_OFFSET_FLOATS + 1] = stroke.start.y
  floats[ENDPOINTS_OFFSET_FLOATS + 2] = stroke.end.x
  floats[ENDPOINTS_OFFSET_FLOATS + 3] = stroke.end.y
  floats[WIDTHS_OFFSET_FLOATS] = stroke.widthMm
  floats[WIDTHS_OFFSET_FLOATS + 1] = stroke.minWidthPixels ?? 0
  floats[WIDTHS_OFFSET_FLOATS + 2] = stroke.extraWidthPixels ?? 0
  floats[WIDTHS_OFFSET_FLOATS + 3] =
    stroke.maxWidthMm ?? UNBOUNDED_WIDTH_SENTINEL_MM
  for (let channel = 0; channel < 4; channel++) {
    floats[COLOR_OFFSET_FLOATS + channel] = stroke.color[channel]
  }
  return floats
}
