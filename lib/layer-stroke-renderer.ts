import {
  getDifferentialPairPhaseSkewStrokes,
  type PhaseSkewStroke,
} from "circuit-json-to-differential-pair-phase-skew"
import { normalizeLayer, parseColor } from "./colors"
import type { CircuitJson, RenderOptions } from "./types"

type LayerName = ReturnType<typeof normalizeLayer>

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

const strokeShader = /* wgsl */ `
struct Camera { rowX: vec4f, rowY: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
struct VertexIn {
  @builtin(vertex_index) vertex: u32,
  @location(0) boardEndpointsMm: vec4f,
  @location(1) color: vec4f,
  @location(2) widthMm: f32,
}
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
// Overlap of a 1 px box with a span centered at zero, along one axis.
fn boxOverlap(centerPixels: f32, halfWidthPixels: f32) -> f32 {
  return clamp(min(centerPixels + 0.5, halfWidthPixels) - max(centerPixels - 0.5, -halfWidthPixels), 0, 1);
}
fn direction(delta: vec2f, minLength: f32) -> vec2f {
  return select(vec2f(1, 0), delta / max(length(delta), minLength), length(delta) > minLength);
}
@vertex fn vertexMain(in: VertexIn) -> VertexOut {
  let corners = array<vec2f, 6>(vec2f(0,-1), vec2f(1,-1), vec2f(0,1),
                               vec2f(0,1), vec2f(1,-1), vec2f(1,1));
  let corner = corners[in.vertex];
  let startPixels = boardToCanvas(in.boardEndpointsMm.xy);
  let endPixels = boardToCanvas(in.boardEndpointsMm.zw);
  let tangent = direction(endPixels - startPixels, MIN_SEGMENT_LENGTH_PIXELS);
  let normal = vec2f(-tangent.y, tangent.x);
  // Canvas pixels per mm across the stroke: |det A| / |A t| for the board
  // direction t, so a non-uniform transform keeps the board width.
  let boardToCanvasLinearTransform = mat2x2f(camera.rowX.x, camera.rowY.x, camera.rowX.y, camera.rowY.y);
  let boardTangent = direction(in.boardEndpointsMm.zw - in.boardEndpointsMm.xy, MIN_SEGMENT_LENGTH_MM);
  let pixelsPerMmAcrossStroke = abs(determinant(boardToCanvasLinearTransform)) / max(length(boardToCanvasLinearTransform * boardTangent), MIN_PIXELS_PER_MM);
  let strokeWidthPixels = in.widthMm * pixelsPerMmAcrossStroke;
  let radiusPixels = strokeWidthPixels * 0.5;
  let pixel = mix(startPixels, endPixels, corner.x) + (tangent * (2 * corner.x - 1) + normal * corner.y) * (radiusPixels + 1);
  let ndc = pixel / camera.viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  return VertexOut(vec4f(ndc, 0, 1), pixel, vec4f(startPixels, endPixels), radiusPixels, in.color);
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
    let beyondEndPixels = max(max(-sampleAlongPixels, sampleAlongPixels - segmentLengthPixels), 0);
    let halfWidthPixels = sqrt(max(in.radiusPixels * in.radiusPixels - beyondEndPixels * beyondEndPixels, 0));
    coverage += boxOverlap(acrossPixels, halfWidthPixels);
  }
  coverage /= f32(COVERAGE_INTEGRATION_STEPS);
  let alpha = in.color.a * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`

/**
 * Draws strokes after layer geometry and before erasures in the same render
 * pass. Widths are measured across the stroke under the affine transform.
 * Round caps are circles on the canvas.
 */
export class LayerStrokeRenderer {
  private device: GPUDevice
  private cameraUniformBuffer: GPUBuffer
  private sampleCount: number
  private blend: GPUBlendState
  private pipeline?: GPURenderPipeline
  private cameraBindGroup?: GPUBindGroup
  private phaseSkewColorKey?: string
  private instanceBuffers = new Map<
    LayerName,
    { buffer: GPUBuffer; strokeInstanceCount: number }
  >()

  constructor({
    device,
    cameraUniformBuffer,
    sampleCount,
    blend,
  }: {
    device: GPUDevice
    /** The drawer's camera uniform buffer. */
    cameraUniformBuffer: GPUBuffer
    sampleCount: number
    blend: GPUBlendState
  }) {
    this.device = device
    this.cameraUniformBuffer = cameraUniformBuffer
    this.sampleCount = sampleCount
    this.blend = blend
  }

  updatePhaseSkewStrokes({
    circuitJson,
    phaseSkewColors,
    stats,
  }: {
    circuitJson?: CircuitJson
    phaseSkewColors?: RenderOptions["phaseSkewColors"]
    stats: { phaseSkewUploads: number }
  }) {
    if (!circuitJson) return
    const phaseSkewColorKey = JSON.stringify([
      phaseSkewColors?.positive,
      phaseSkewColors?.negative,
      phaseSkewColors?.zero,
      phaseSkewColors?.unknown,
    ])
    if (phaseSkewColorKey === this.phaseSkewColorKey) return
    const strokes = getDifferentialPairPhaseSkewStrokes([...circuitJson], {
      colors: phaseSkewColors,
    })
    if (this.setStrokes({ strokes })) stats.phaseSkewUploads++
    this.phaseSkewColorKey = phaseSkewColorKey
  }

  /** Replaces the buffer for each layer. Returns whether any strokes uploaded. */
  private setStrokes({ strokes }: { strokes: readonly PhaseSkewStroke[] }) {
    this.dispose()
    const strokesByLayer = new Map<LayerName, PhaseSkewStroke[]>()
    for (const stroke of strokes) {
      if (
        stroke.width <= 0 ||
        (stroke.start.x === stroke.end.x && stroke.start.y === stroke.end.y)
      )
        continue
      const layer = normalizeLayer(stroke.layer)
      const layerStrokes = strokesByLayer.get(layer)
      if (layerStrokes) {
        layerStrokes.push(stroke)
        continue
      }
      strokesByLayer.set(layer, [stroke])
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
    return strokesByLayer.size > 0
  }

  /** Draws the strokes of `layer` into `pass`, if it has any. */
  draw({
    pass,
    layer,
  }: {
    pass: GPURenderPassEncoder
    layer: LayerName
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

  /** Clears the color cache and destroys the uploaded buffers. */
  dispose() {
    this.phaseSkewColorKey = undefined
    for (const { buffer } of this.instanceBuffers.values()) buffer.destroy()
    this.instanceBuffers.clear()
  }
}

/** One stroke's instance attributes, in the order the shader reads them. */
function packStrokeInstanceAttributes(stroke: PhaseSkewStroke): number[] {
  const color = parseColor(stroke.color)
  const floats = new Array<number>(FLOATS_PER_STROKE)
  floats[ENDPOINTS_OFFSET_FLOATS] = stroke.start.x
  floats[ENDPOINTS_OFFSET_FLOATS + 1] = stroke.start.y
  floats[ENDPOINTS_OFFSET_FLOATS + 2] = stroke.end.x
  floats[ENDPOINTS_OFFSET_FLOATS + 3] = stroke.end.y
  for (let channel = 0; channel < 4; channel++) {
    floats[COLOR_OFFSET_FLOATS + channel] = color[channel]
  }
  floats[WIDTH_OFFSET_FLOATS] = stroke.width
  return floats
}
