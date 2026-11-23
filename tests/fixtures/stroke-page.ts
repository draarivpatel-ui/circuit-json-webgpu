import type { Browser, Page } from "playwright"
import { PNG } from "pngjs"
import { type ViteDevServer, createServer } from "vite"
import type { LayerStroke, Matrix } from "../../lib"
import { launchWebGpuBrowser } from "../../scripts/lib/launch-webgpu-browser"

/** The test site with its WebGPU drawer on a 200 × 200 canvas, and how to shut it down. */
export type StrokePage = { page: Page; close: () => Promise<void> }

/** 20 canvas pixels per mm, board origin at the canvas centre (100, 100). */
export const FIT_TRANSFORM: Matrix = {
  a: 20,
  b: 0,
  c: 0,
  d: -20,
  e: 100,
  f: 100,
}

/** A 0.5 mm horizontal stroke along the bottom pad, from x = -3 to 3 mm. */
export const BOTTOM_LINE: Omit<LayerStroke, "color"> = {
  layer: "bottom",
  start: { x: -3, y: 0 },
  end: { x: 3, y: 0 },
  widthMm: 0.5,
}

/** Opens the test site in WebGPU Chromium. */
export async function openStrokePage(): Promise<StrokePage> {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await server.listen()
  let browser: Browser | undefined
  try {
    browser = await launchWebGpuBrowser()
    const page = await browser.newPage()
    await page.goto(server.resolvedUrls!.local[0])
    await page.waitForFunction(() => window.gpuTest)
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!
      canvas.width = 200
      canvas.height = 200
    })
    const openBrowser = browser
    return {
      page,
      close: () => closeStrokePage({ browser: openBrowser, server }),
    }
  } catch (error) {
    await closeStrokePage({ browser, server })
    throw error
  }
}

/** Closes the browser, then the Vite server. */
async function closeStrokePage({
  browser,
  server,
}: {
  browser: Browser | undefined
  server: ViteDevServer
}): Promise<void> {
  try {
    await browser?.close()
  } finally {
    await server.close()
  }
}

/** The RGB of one pixel in a base64 PNG of the canvas. */
export function pixelAt({
  png,
  x,
  y,
}: {
  png: string
  x: number
  y: number
}): number[] {
  const frame = PNG.sync.read(Buffer.from(png, "base64"))
  const offset = (y * frame.width + x) * 4
  return [...frame.data.subarray(offset, offset + 3)]
}
