import { normalizeLayer } from "./colors"
import type { LayerStroke } from "./types"

/** Each stroke is one instance of 9 floats: endpoints, colour, width. */
const FLOATS_PER_STROKE = 9
const BYTES_PER_FLOAT = 4
/** Floats before each attribute within a stroke. */
const ENDPOINTS_OFFSET_FLOATS = 0
const COLOR_OFFSET_FLOATS = 4
const WIDTH_OFFSET_FLOATS = 8
/** Board segments at or below this length use the fallback direction. */
const MIN_SEGMENT_LENGTH_MM = 1e-6
/** Canvas segments at or below this length use the fallback direction. */
const MIN_SEGMENT_LENGTH_PIXELS = 1e-6
/** Lower bound for the transformed tangent length in pixels per mm. */
const MIN_PIXELS_PER_MM = 1e-6
/** Integration steps along the stroke used to estimate pixel coverage. */
const COVERAGE_INTEGRATION_STEPS = 8

/** A PCB layer name after `normalizeLayer`. */
type NormalizedLayerName = string

const strokeShader = /* wgsl */ `
struct Camera { rowX: vec4f, rowY: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) pixel: vec2f,
  @location(1) @interpolate(flat) canvasEndpointsPixels: vec4f,
  @location(2) @interpolate(flat) radiusPixels: f32,
  @location(3) @interpolate(flat) color: vec4f,
}
const MIN_SEGMENT_LENGTH_MM = ${MIN_SEGMENT_LENGTH_MM};
const MIN_SEGMENT_LENGTH_PIXELS = ${MIN_SEGMENT_LENGTH_PIXELS};
const MIN_PIXELS_PER_MM = ${MIN_PIXELS_PER_MM};
const COVERAGE_INTEGRATION_STEPS = ${COVERAGE_INTEGRATION_STEPS};
fn boardToCanvas(p: vec2f) -> vec2f {
  return vec2f(dot(camera.rowX.xyz, vec3f(p, 1)), dot(camera.rowY.xyz, vec3f(p, 1)));
}
// The length of [center - 0.5, center + 0.5] inside [low, high]: how much of
// a 1 px box around a pixel lies within a span, along one axis.
fn boxOverlap(center: f32, low: f32, high: f32) -> f32 {
  return clamp(min(center + 0.5, high) - max(center - 0.5, low), 0, 1);
}
// Half the stroke's width at a distance along it from its start, in
// canvas pixels: the radius along the segment, narrowing around each cap.
fn capsuleHalfWidth(alongPixels: f32, lengthPixels: f32, radiusPixels: f32) -> f32 {
  let beyondEnd = max(max(-alongPixels, alongPixels - lengthPixels), 0);
  return sqrt(max(radiusPixels * radiusPixels - beyondEnd * beyondEnd, 0));
}
fn direction(delta: vec2f, minLength: f32) -> vec2f {
  return select(vec2f(1, 0), delta / max(length(delta), minLength), length(delta) > minLength);
}
@vertex fn vertexMain(
  @builtin(vertex_index) vertex: u32,
  @location(0) boardEndpointsMm: vec4f,
  @location(1) color: vec4f,
  @location(2) widthMm: f32,
) -> VertexOut {
  let corners = array<vec2f, 6>(vec2f(0,-1), vec2f(1,-1), vec2f(0,1),
                               vec2f(0,1), vec2f(1,-1), vec2f(1,1));
  let corner = corners[vertex];
  let start = boardToCanvas(boardEndpointsMm.xy);
  let end = boardToCanvas(boardEndpointsMm.zw);
  let tangent = direction(end - start, MIN_SEGMENT_LENGTH_PIXELS);
  let normal = vec2f(-tangent.y, tangent.x);
  // Canvas pixels per mm across the stroke: |det A| / |A t| for the board
  // direction t, so a non-uniform transform keeps the board width.
  let linear = mat2x2f(camera.rowX.x, camera.rowY.x, camera.rowX.y, camera.rowY.y);
  let boardTangent = direction(boardEndpointsMm.zw - boardEndpointsMm.xy, MIN_SEGMENT_LENGTH_MM);
  let pixelsPerMmAcrossStroke = abs(determinant(linear)) / max(length(linear * boardTangent), MIN_PIXELS_PER_MM);
  let strokeWidthPixels = widthMm * pixelsPerMmAcrossStroke;
  let radiusPixels = strokeWidthPixels * 0.5;
  let pixel = mix(start, end, corner.x) + (tangent * (2 * corner.x - 1) + normal * corner.y) * (radiusPixels + 1);
  let ndc = pixel / camera.viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  return VertexOut(vec4f(ndc, 0, 1), pixel, vec4f(start, end), radiusPixels, color);
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let offset = in.pixel - in.canvasEndpointsPixels.xy;
  let delta = in.canvasEndpointsPixels.zw - in.canvasEndpointsPixels.xy;
  // The fraction of a 1 px box around the pixel, in the stroke's own frame,
  // that lies within the stroke: the overlap across the stroke, averaged at
  // points along it, so round caps and short pieces get only their area.
  let segmentLengthPixels = length(delta);
  let tangent = direction(delta, MIN_SEGMENT_LENGTH_PIXELS);
  let alongPixels = dot(offset, tangent);
  let acrossPixels = dot(offset, vec2f(-tangent.y, tangent.x));
  var coverage = 0.0;
  for (var step = 0; step < COVERAGE_INTEGRATION_STEPS; step++) {
    let sampleAlongPixels = alongPixels - 0.5 + (f32(step) + 0.5) / f32(COVERAGE_INTEGRATION_STEPS);
    let halfWidthPixels = capsuleHalfWidth(sampleAlongPixels, segmentLengthPixels, in.radiusPixels);
    coverage += boxOverlap(acrossPixels, -halfWidthPixels, halfWidthPixels);
  }
  coverage /= f32(COVERAGE_INTEGRATION_STEPS);
  let alpha = in.color.a * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`

/** Counts each time stroke buffers are rebuilt and uploaded. */
export type StrokeStats = { strokeUploads: number }

/**
 * Draws strokes after layer geometry and before erasures in the same render
 * pass. Buffers are rebuilt only when a different stroke array is set. Widths
 * are measured across the stroke under the affine transform. Round caps are
 * circles on the canvas.
 */
export class LayerStrokeRenderer {
  private device: GPUDevice
  private cameraUniformBuffer: GPUBuffer
  private sampleCount: number
  private blend: GPUBlendState
  private stats: StrokeStats
  private pipeline?: GPURenderPipeline
  private cameraBindGroup?: GPUBindGroup
  private strokes?: readonly LayerStroke[]
  private instanceBuffers = new Map<
    NormalizedLayerName,
    { buffer: GPUBuffer; strokeInstanceCount: number }
  >()

  constructor({
    device,
    cameraUniformBuffer,
    sampleCount,
    blend,
    stats,
  }: {
    device: GPUDevice
    /** The drawer's camera uniform buffer. */
    cameraUniformBuffer: GPUBuffer
    sampleCount: number
    blend: GPUBlendState
    stats: StrokeStats
  }) {
    this.device = device
    this.cameraUniformBuffer = cameraUniformBuffer
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

    const strokesByLayer = new Map<NormalizedLayerName, LayerStroke[]>()
    for (const stroke of strokes) {
      // A 2D canvas paints nothing for a line whose ends coincide.
      if (stroke.start.x === stroke.end.x && stroke.start.y === stroke.end.y)
        continue
      const name = normalizeLayer(stroke.layer)
      const layerStrokes = strokesByLayer.get(name)
      if (layerStrokes) {
        layerStrokes.push(stroke)
        continue
      }
      strokesByLayer.set(name, [stroke])
    }
    for (const [layer, layerStrokes] of strokesByLayer) {
      const strokeInstanceAttributes = new Float32Array(
        layerStrokes.length * FLOATS_PER_STROKE,
      )
      for (const [index, stroke] of layerStrokes.entries()) {
        strokeInstanceAttributes.set(
          packStrokeInstanceAttributes(stroke),
          index * FLOATS_PER_STROKE,
        )
      }
      const buffer = this.device.createBuffer({
        size: strokeInstanceAttributes.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(buffer, 0, strokeInstanceAttributes)
      this.instanceBuffers.set(layer, {
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
    layer: NormalizedLayerName
  }) {
    const instanceBuffer = this.instanceBuffers.get(layer)
    if (!instanceBuffer) return
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
                  offset: COLOR_OFFSET_FLOATS * BYTES_PER_FLOAT,
                  format: "float32x4",
                },
                {
                  shaderLocation: 2,
                  offset: WIDTH_OFFSET_FLOATS * BYTES_PER_FLOAT,
                  format: "float32",
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
      this.cameraBindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
        ],
      })
    }
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.cameraBindGroup!)
    pass.setVertexBuffer(0, instanceBuffer.buffer)
    pass.draw(6, instanceBuffer.strokeInstanceCount)
  }

  /** Destroys the uploaded buffers. */
  dispose() {
    for (const { buffer } of this.instanceBuffers.values()) buffer.destroy()
    this.instanceBuffers.clear()
  }
}

/** One stroke's instance attributes, in the order the shader reads them. */
function packStrokeInstanceAttributes(stroke: LayerStroke): number[] {
  const floats = new Array<number>(FLOATS_PER_STROKE)
  floats[ENDPOINTS_OFFSET_FLOATS] = stroke.start.x
  floats[ENDPOINTS_OFFSET_FLOATS + 1] = stroke.start.y
  floats[ENDPOINTS_OFFSET_FLOATS + 2] = stroke.end.x
  floats[ENDPOINTS_OFFSET_FLOATS + 3] = stroke.end.y
  for (let channel = 0; channel < 4; channel++) {
    floats[COLOR_OFFSET_FLOATS + channel] = stroke.color[channel]
  }
  floats[WIDTH_OFFSET_FLOATS] = stroke.widthMm
  return floats
}
