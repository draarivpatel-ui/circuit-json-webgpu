import { normalizeLayer } from "./colors"
import type { LayerStroke } from "./types"

/** Each stroke is one instance of 12 floats: endpoints, widths, colour. */
const FLOATS_PER_STROKE = 12
const BYTES_PER_FLOAT = 4
/** Floats before each vec4 attribute within a stroke. */
const ENDPOINTS_OFFSET_FLOATS = 0
const WIDTHS_OFFSET_FLOATS = 4
const COLOR_OFFSET_FLOATS = 8
/** Stands in for "no maximum" in board units: wider than any canvas. */
const UNCAPPED_MAX_WIDTH = 1e20
/** Lengths below this are treated as zero, so a dot still gets a direction. */
const MIN_LENGTH = 1e-6

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
const MIN_LENGTH = ${MIN_LENGTH};
fn project(p: vec2f) -> vec2f {
  return vec2f(dot(camera.rowX.xyz, vec3f(p, 1)), dot(camera.rowY.xyz, vec3f(p, 1)));
}
fn direction(delta: vec2f) -> vec2f {
  return select(vec2f(1, 0), delta / max(length(delta), MIN_LENGTH), length(delta) > MIN_LENGTH);
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
  let tangent = direction(end - start);
  let normal = vec2f(-tangent.y, tangent.x);
  // Canvas pixels per board unit across the stroke: |det A| / |A t| for the
  // board direction t, so a non-uniform transform keeps the board width.
  let linear = mat2x2f(camera.rowX.x, camera.rowY.x, camera.rowX.y, camera.rowY.y);
  let boardTangent = direction(endpoints.zw - endpoints.xy);
  let across = abs(determinant(linear)) / max(length(linear * boardTangent), MIN_LENGTH);
  let base = max(widths.x * across, widths.y);
  let width = min(base + widths.z, widths.w * across);
  let radius = width * 0.5;
  let pixel = mix(start, end, corner.x) + (tangent * (2 * corner.x - 1) + normal * corner.y) * (radius + 1);
  let ndc = pixel / camera.viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  let enabled = widths.z == 0 || width > base;
  return VertexOut(vec4f(ndc, 0, 1), pixel, vec4f(start, end), radius, select(vec4f(0), color, enabled));
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let offset = in.pixel - in.endpoints.xy;
  let delta = in.endpoints.zw - in.endpoints.xy;
  let nearest = clamp(dot(offset, delta) / max(dot(delta, delta), MIN_LENGTH), 0, 1);
  let coverage = clamp(in.radius - length(offset - nearest * delta) + 0.5, 0, 1);
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
  private buffers = new Map<string, { buffer: GPUBuffer; count: number }>()

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

    const groups = new Map<string, LayerStroke[]>()
    for (const stroke of strokes) {
      const name = normalizeLayer(stroke.layer)
      const group = groups.get(name)
      if (group) {
        group.push(stroke)
        continue
      }
      groups.set(name, [stroke])
    }
    for (const [layer, lines] of groups) {
      const vertices = new Float32Array(lines.length * FLOATS_PER_STROKE)
      lines.forEach((stroke, index) => {
        vertices.set(strokeFloats(stroke), index * FLOATS_PER_STROKE)
      })
      const buffer = this.device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(buffer, 0, vertices)
      this.buffers.set(layer, { buffer, count: lines.length })
    }
    this.stats.strokeUploads++
  }

  /** Draws the strokes of `layer` into `pass`, if it has any. */
  draw({ pass, layer }: { pass: GPURenderPassEncoder; layer: string }) {
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
    pass.draw(6, strokes.count)
  }

  /** Destroys the uploaded buffers. */
  dispose() {
    for (const { buffer } of this.buffers.values()) buffer.destroy()
    this.buffers.clear()
  }
}

/** One stroke's instance floats, in the order the shader's attributes read them. */
function strokeFloats(stroke: LayerStroke): number[] {
  const floats = new Array<number>(FLOATS_PER_STROKE)
  floats[ENDPOINTS_OFFSET_FLOATS] = stroke.start.x
  floats[ENDPOINTS_OFFSET_FLOATS + 1] = stroke.start.y
  floats[ENDPOINTS_OFFSET_FLOATS + 2] = stroke.end.x
  floats[ENDPOINTS_OFFSET_FLOATS + 3] = stroke.end.y
  floats[WIDTHS_OFFSET_FLOATS] = stroke.width
  floats[WIDTHS_OFFSET_FLOATS + 1] = stroke.minWidthPixels ?? 0
  floats[WIDTHS_OFFSET_FLOATS + 2] = stroke.extraWidthPixels ?? 0
  floats[WIDTHS_OFFSET_FLOATS + 3] = stroke.maxWidth ?? UNCAPPED_MAX_WIDTH
  for (let channel = 0; channel < 4; channel++) {
    floats[COLOR_OFFSET_FLOATS + channel] = stroke.color[channel]
  }
  return floats
}
