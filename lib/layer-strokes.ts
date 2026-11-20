import { normalizeLayer } from "./colors"
import type { LayerStroke } from "./types"

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
fn project(p: vec2f) -> vec2f {
  return vec2f(dot(camera.rowX.xyz, vec3f(p, 1)), dot(camera.rowY.xyz, vec3f(p, 1)));
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
  let delta = end - start;
  let tangent = select(vec2f(1, 0), delta / max(length(delta), 1e-6), length(delta) > 1e-6);
  let normal = vec2f(-tangent.y, tangent.x);
  let scale = length(vec2f(camera.rowX.x, camera.rowY.x));
  let base = max(widths.x * scale, widths.y);
  let width = min(base + widths.z, widths.w * scale);
  let radius = width * 0.5;
  let pixel = mix(start, end, corner.x) + (tangent * (2 * corner.x - 1) + normal * corner.y) * (radius + 1);
  let ndc = pixel / camera.viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  let enabled = widths.z == 0 || width > base;
  return VertexOut(vec4f(ndc, 0, 1), pixel, vec4f(start, end), radius, select(vec4f(0), color, enabled));
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let offset = in.pixel - in.endpoints.xy;
  let delta = in.endpoints.zw - in.endpoints.xy;
  let nearest = clamp(dot(offset, delta) / max(dot(delta, delta), 1e-6), 0, 1);
  let coverage = clamp(in.radius - length(offset - nearest * delta) + 0.5, 0, 1);
  let alpha = in.color.a * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`

export class LayerStrokes {
  private pipeline?: GPURenderPipeline
  private camera?: GPUBindGroup
  private strokes?: readonly LayerStroke[]
  private buffers = new Map<string, { buffer: GPUBuffer; count: number }>()

  constructor(
    private device: GPUDevice,
    private uniform: GPUBuffer,
    private sampleCount: number,
    private blend: GPUBlendState,
  ) {}

  set(strokes?: readonly LayerStroke[]) {
    if (strokes === this.strokes) return
    this.dispose()
    this.strokes = strokes
    if (!strokes?.length) return

    const groups = new Map<string, LayerStroke[]>()
    for (const stroke of strokes) {
      const name = normalizeLayer(stroke.layer)
      const group = groups.get(name)
      if (group) group.push(stroke)
      else groups.set(name, [stroke])
    }
    for (const [layer, lines] of groups) {
      const vertices = Float32Array.from(
        lines.flatMap(
          ({
            start,
            end,
            width,
            minWidthPixels,
            extraWidthPixels,
            maxWidth,
            color,
          }) => [
            start.x,
            start.y,
            end.x,
            end.y,
            width,
            minWidthPixels ?? 0,
            extraWidthPixels ?? 0,
            maxWidth ?? 1e20,
            ...color,
          ],
        ),
      )
      const buffer = this.device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(buffer, 0, vertices)
      this.buffers.set(layer, { buffer, count: lines.length })
    }
  }

  draw(pass: GPURenderPassEncoder, layer: string) {
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
              arrayStride: 48,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x4" },
                { shaderLocation: 1, offset: 16, format: "float32x4" },
                { shaderLocation: 2, offset: 32, format: "float32x4" },
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

  dispose() {
    for (const { buffer } of this.buffers.values()) buffer.destroy()
    this.buffers.clear()
  }
}
