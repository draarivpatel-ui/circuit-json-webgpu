import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { PNG } from "pngjs"
import { cloneElement, type ReactElement, type ReactNode } from "react"
import { createServer, type ViteDevServer } from "vite"
import type { RenderOptions } from "../lib"
import { launchWebGpuBrowser } from "../scripts/lib/launch-webgpu-browser"
import {
  LayerChangeBoard,
  MatchedPairBoard,
  renderBoard,
} from "./fixtures/phase-skew/example-boards.fixture"

let server: ViteDevServer
let browser: Browser
let page: Page

beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await server.listen()
  browser = await launchWebGpuBrowser()
  page = await browser.newPage()
  await page.goto(server.resolvedUrls!.local[0])
  await page.waitForFunction(() => window.gpuTest)
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

const transform = { a: 30, b: 0, c: 0, d: -30, e: 450, f: 150 }
const topCopper = [200, 52, 52]
const drill = [255, 38, 226]

function pixelAt(frame: string, x: number, y: number) {
  const png = PNG.sync.read(Buffer.from(frame, "base64"))
  const index = (y * png.width + x) * 4
  return [...png.data.subarray(index, index + 3)]
}

test("phase skew follows layer order and filtering, leaving via drills visible", async () => {
  const board = LayerChangeBoard() as ReactElement<{ children: ReactNode }>
  const elements = renderBoard(
    cloneElement(
      board,
      undefined,
      board.props.children,
      <chip
        name="FOREGROUND_PAD"
        pcbX={3}
        pcbY={0.6}
        footprint={
          <footprint>
            <smtpad width={1} height={0.6} shape="rect" portHints={["pin1"]} />
          </footprint>
        }
      />,
    ),
  )
  const frames = await page.evaluate(
    async ({ elements, transform }) => {
      const { drawer } = window.gpuTest
      const canvas = document.querySelector("canvas")!
      canvas.width = 900
      canvas.height = 300
      const capture = async (options: RenderOptions = {}) => {
        drawer.render(options)
        await drawer.flush()
        return canvas.toDataURL("image/png").split(",")[1]
      }
      drawer.drawElements(elements, {
        transform,
        showDifferentialPairPhaseSkew: true,
        hiddenLayerOpacity: 1,
        background: [0, 0, 0, 1],
      })
      return {
        top: await capture(),
        bottom: await capture({ selectedLayer: "bottom" }),
        topOnly: await capture({
          selectedLayer: "top",
          layers: ["top", "drill"],
        }),
      }
    },
    { elements, transform },
  )
  // The bottom trace runs behind the foreground pad and over its own copper.
  expect(pixelAt(frames.top, 540, 132)).toEqual(topCopper)
  expect(pixelAt(frames.bottom, 540, 132)).toEqual([0, 0, 255])
  expect(pixelAt(frames.top, 570, 132)).toEqual([0, 0, 255])
  expect(pixelAt(frames.topOnly, 570, 132)).toEqual([0, 0, 0])
  for (const frame of Object.values(frames)) {
    expect(pixelAt(frame, 450, 132)).toEqual(drill)
    expect(pixelAt(frame, 450, 168)).toEqual(drill)
  }
}, 30_000)

test("phase skew is opt-in and keeps its board width under non-uniform scaling", async () => {
  const elements = renderBoard(MatchedPairBoard())
  const frames = await page.evaluate(
    async ({ elements, transform }) => {
      const { drawer } = window.gpuTest
      const canvas = document.querySelector("canvas")!
      canvas.width = 900
      canvas.height = 300
      const capture = async () => {
        await drawer.flush()
        return canvas.toDataURL("image/png").split(",")[1]
      }
      drawer.drawElements(elements, {
        transform: { ...transform, d: -15 },
        phaseSkewColors: { zero: "#00ff00" },
        background: [0, 0, 0, 1],
      })
      const off = await capture()
      drawer.render({ showDifferentialPairPhaseSkew: true })
      const on = await capture()
      drawer.render({ showDifferentialPairPhaseSkew: false })
      return { off, on, disabled: await capture() }
    },
    { elements, transform },
  )
  expect(pixelAt(frames.off, 450, 141)).toEqual(topCopper)
  expect(pixelAt(frames.on, 450, 141)).toEqual([0, 255, 0])
  // 0.264 mm at 15 px/mm spans about 4 pixels, centered at y = 141.
  expect(pixelAt(frames.on, 450, 144)).toEqual([0, 0, 0])
  expect(frames.disabled).toBe(frames.off)
}, 30_000)

test("phase skew is hidden in X-Ray and uploads once per circuit and palette", async () => {
  const elements = renderBoard(MatchedPairBoard())
  const trace = elements.find((element) => element.type === "pcb_trace")!
  const result = await page.evaluate(
    async ({ elements, transform, traceId }) => {
      const { drawer } = window.gpuTest
      const canvas = document.querySelector("canvas")!
      canvas.width = 900
      canvas.height = 300
      const capture = async () => {
        await drawer.flush()
        return canvas.toDataURL("image/png").split(",")[1]
      }
      const counts: number[] = []
      const initialUploads = drawer.stats.phaseSkewUploads
      const recordUploads = () =>
        counts.push(drawer.stats.phaseSkewUploads - initialUploads)
      drawer.drawElements(elements, {
        transform,
        showDifferentialPairPhaseSkew: true,
        phaseSkewColors: { zero: "#00ff00" },
      })
      recordUploads()
      drawer.render({ transform: { ...transform, e: 460 } })
      recordUploads()
      drawer.render({ phaseSkewColors: { zero: "#00ff00" } })
      recordUploads()
      const before = await capture()
      drawer.render({ xRayElementIds: [traceId] })
      const xRay = await capture()
      recordUploads()
      drawer.render({ xRayElementIds: [] })
      const after = await capture()
      recordUploads()
      drawer.render({ phaseSkewColors: { zero: "#ff0" } })
      const newPalette = await capture()
      recordUploads()
      drawer.setCircuitJson([...elements])
      drawer.render()
      recordUploads()
      return { before, xRay, after, newPalette, counts }
    },
    { elements, transform, traceId: trace.pcb_trace_id },
  )
  expect(pixelAt(result.before, 460, 132)).toEqual([0, 255, 0])
  expect(pixelAt(result.xRay, 460, 132)).toEqual(topCopper)
  expect(result.after).toBe(result.before)
  expect(pixelAt(result.newPalette, 460, 132)).toEqual([255, 255, 0])
  expect(result.counts).toEqual([1, 1, 1, 1, 1, 2, 3])
}, 30_000)
