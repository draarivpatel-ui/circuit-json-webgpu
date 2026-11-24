import assert from "node:assert/strict"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import { PNG } from "pngjs"
import { createServer } from "vite"
import { launchWebGpuBrowser } from "../scripts/lib/launch-webgpu-browser"
import {
  LayerChangeBoard,
  LoadEndMeanderBoard,
  LocalCompensationBoard,
  MatchedPairBoard,
  renderBoard,
} from "./fixtures/phase-skew/example-boards.fixture"
import {
  FORUM_BOARD_HEIGHT_MM,
  FORUM_BOARD_WIDTH_MM,
  renderForumExampleBoard,
} from "./fixtures/phase-skew/forum-example-board.fixture"
import { prepareComparison } from "./parity/prepare"
import { renderSvg } from "./parity/render-svg"
import { compareFeatureSnapshot } from "./parity/snapshot"

const phaseSkewCases = [
  {
    name: "matched-pair",
    caption: "Matched pair. Both traces stay white when they are in step.",
    render: () => renderBoard(MatchedPairBoard()),
    width: 28,
    height: 8,
  },
  {
    name: "load-end-meander",
    caption: "Load-end meander. Red and blue fade back to white near the load.",
    render: () => renderBoard(LoadEndMeanderBoard()),
    width: 28,
    height: 9,
  },
  {
    name: "local-compensation",
    caption:
      "Local compensation. The upper pair returns to white while the lower pair holds its skew.",
    render: () => renderBoard(LocalCompensationBoard()),
    width: 28,
    height: 11,
  },
  {
    name: "layer-change",
    caption:
      "Layer change. Skew carries through the vias and the drills stay visible.",
    render: () => renderBoard(LayerChangeBoard()),
    width: 28,
    height: 9,
  },
  {
    name: "kicad-forum",
    caption:
      "KiCad forum board. The upper pair changes polarity and realigns at the load.",
    render: renderForumExampleBoard,
    width: FORUM_BOARD_WIDTH_MM,
    height: FORUM_BOARD_HEIGHT_MM,
  },
]

const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  logLevel: "error",
})
await server.listen()
let browser
try {
  browser = await launchWebGpuBrowser()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto(server.resolvedUrls!.local[0])
  await page.waitForFunction(() => window.gpuTest, null, { timeout: 30_000 })

  for (const fixture of phaseSkewCases) {
    const elements = fixture.render()
    const pixelsPerMm = 24
    const width = (fixture.width + 2) * pixelsPerMm
    const height = (fixture.height + 2) * pixelsPerMm
    const { scene, reason } = prepareComparison({
      width,
      height,
      elements,
      matrix: {
        a: pixelsPerMm,
        b: 0,
        c: 0,
        d: -pixelsPerMm,
        e: width / 2,
        f: height / 2,
      },
      contextTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      options: {},
    })
    assert(scene, reason ?? "Could not prepare the phase skew comparison")
    const gpu = await page.evaluate(
      ({ elements, width, height, transform }) => {
        const { drawer, captureFrame } = window.gpuTest
        const canvas = document.querySelector("canvas")!
        canvas.width = width
        canvas.height = height
        drawer.drawElements(elements, {
          transform,
          hiddenLayerOpacity: 1,
          background: [0, 0, 0, 1],
        })
        return captureFrame()
      },
      { elements, width, height, transform: scene.transform },
    )
    const svg = convertCircuitJsonToPcbSvg(elements, {
      width,
      height,
      viewport: scene.viewport,
      showDifferentialPairPhaseSkew: true,
      showSolderMask: false,
      shouldDrawErrors: false,
      shouldDrawRatsNest: false,
      includeVersion: false,
      backgroundColor: scene.background,
      colorOverrides: { boardOutline: "#d0d2cd" },
    })
    assert(
      svg.includes('data-type="pcb_differential_pair_phase_skew"'),
      fixture.name,
    )
    const key = `phase-skew-${fixture.name}`
    const snapshot = await compareFeatureSnapshot({
      id: key,
      svg: PNG.sync.read(await renderSvg(svg)),
      gpu: PNG.sync.read(Buffer.from(gpu, "base64")),
      key,
      caption: fixture.caption,
    })
    assert(
      snapshot.pass,
      `${key}: ${snapshot.error ?? `${snapshot.changedPixels} changed pixels`}`,
    )
    console.log(`snapshot ${key} (circuit-to-svg / circuit-json-webgpu)`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await server.close()
}
