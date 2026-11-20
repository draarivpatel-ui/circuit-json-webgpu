import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import type { CircuitJson, LayerStroke } from "../lib"
import { PNG } from "pngjs"
import { createServer } from "vite"
import { launchWebGpuBrowser } from "../scripts/lib/launch-webgpu-browser"

test("retained round strokes paint after their copper and before foreground copper", async () => {
  const circuit = new Circuit()
  circuit.add(
    <board width={10} height={10} routingDisabled>
      <smtpad shape="rect" layer="top" width={1} height={6} />
      <smtpad shape="rect" layer="bottom" width={6} height={0.5} />
    </board>,
  )
  await circuit.renderUntilSettled()
  const elements = circuit.getCircuitJson() as CircuitJson
  const line = {
    layer: "bottom",
    start: { x: -3, y: 0 },
    end: { x: 3, y: 0 },
    width: 0.5,
  }
  const strokes: LayerStroke[] = [
    { ...line, extraWidthPixels: 4, maxWidth: 1, color: [0, 0, 0, 1] },
    { ...line, color: [0, 1, 0, 1] },
  ]
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await server.listen()
  const browser = await launchWebGpuBrowser().catch(async (error) => {
    await server.close()
    throw error
  })
  try {
    const page = await browser.newPage()
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => window.gpuTest)
    const result = await page.evaluate(
      async ({ elements, strokes }) => {
        const canvas = document.querySelector("canvas")!
        canvas.width = canvas.height = 200
        const { drawer } = window.gpuTest
        const initialUploads = drawer.stats.geometryUploads
        drawer.drawElements(elements, {
          layerStrokes: strokes,
          hiddenLayerOpacity: 1,
          transform: { a: 20, b: 0, c: 0, d: -20, e: 100, f: 100 },
          background: [1, 1, 1, 1],
        })
        const png = canvas.toDataURL().split(",")[1]
        const covered = await drawer.pickLayerAt({ x: 100, y: 100 }, ["bottom"])
        const visible = await drawer.pickLayerAt({ x: 130, y: 100 }, ["bottom"])
        drawer.render({ selectedLayer: "bottom" })
        const flipped = await drawer.pickLayerAt({ x: 100, y: 100 }, ["bottom"])
        return {
          covered,
          visible,
          png,
          flipped,
          uploads: drawer.stats.geometryUploads - initialUploads,
        }
      },
      { elements, strokes },
    )
    const frame = PNG.sync.read(Buffer.from(result.png, "base64"))
    const pixel = (x: number, y: number) =>
      frame.data.subarray(
        (y * frame.width + x) * 4,
        (y * frame.width + x) * 4 + 3,
      )
    expect([...pixel(100, 100)]).toEqual([200, 52, 52])
    expect([...pixel(130, 100)]).toEqual([0, 255, 0])
    expect([...pixel(130, 106)]).toEqual([0, 0, 0])
    expect(result.covered).toBeUndefined()
    expect(result.visible).toBe("bottom")
    expect(result.flipped).toBe("bottom")
    expect(result.uploads).toBe(1)
  } finally {
    await browser.close()
    await server.close()
  }
}, 30_000)
