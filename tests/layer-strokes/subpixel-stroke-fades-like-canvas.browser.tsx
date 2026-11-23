import { expect, test } from "bun:test"
import type { Point } from "../../lib"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { FIT_TRANSFORM, openStrokePage } from "../fixtures/stroke-page"

/** 0.1 canvas pixels at the fixture's 20 px per mm. */
const SUBPIXEL_WIDTH_MM = 0.005

/** Largest channel difference allowed between the two rasterisers. */
const MAX_CHANNEL_DIFFERENCE = 4

/** A board point at canvas pixel (`x`, `y`) under the fixture's transform. */
function canvasToBoard(x: number, y: number): Point {
  return { x: (x - 100) / 20, y: (100 - y) / 20 }
}

/** 0.1 px strokes around the sampled pixel, whose centre is (130.5, 100.5). */
const SUBPIXEL_STROKES = {
  longInterior: [canvasToBoard(40, 100.5), canvasToBoard(160, 100.5)],
  roundCapStartingBesideCentre: [
    canvasToBoard(130.9, 100.5),
    canvasToBoard(160, 100.5),
  ],
  dotOnCentre: [canvasToBoard(130.5, 100.5), canvasToBoard(130.5, 100.5)],
  shortSegmentOnCentre: [
    canvasToBoard(130.35, 100.5),
    canvasToBoard(130.65, 100.5),
  ],
}

test("a stroke narrower than a pixel, its ends and its short pieces paint no more strongly than on a 2D canvas", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const samples = await page.evaluate(
      ({ elements, transform, widthMm, strokes }) => {
        const { drawer } = window.gpuTest
        const gpuCanvas = document.querySelector("canvas")!
        const reference = document.createElement("canvas")
        reference.width = gpuCanvas.width
        reference.height = gpuCanvas.height
        const context = reference.getContext("2d")!
        const readPixel = () => [
          ...context.getImageData(130, 100, 1, 1).data.slice(0, 3),
        ]
        drawer.drawElements(elements, { hiddenLayerOpacity: 1, transform })
        context.drawImage(gpuCanvas, 0, 0)
        const baselinePixel = readPixel()
        return Object.entries(strokes).map(([name, [start, end]]) => {
          drawer.render({
            layerStrokes: [
              { layer: "bottom", start, end, widthMm, color: [0, 1, 0, 1] },
            ],
          })
          context.drawImage(gpuCanvas, 0, 0)
          const webGpuPixel = readPixel()
          // The same stroke on the copper's colour, drawn by the 2D canvas.
          context.fillStyle = `rgb(${baselinePixel.join(", ")})`
          context.fillRect(0, 0, reference.width, reference.height)
          context.setTransform(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f,
          )
          context.lineCap = "round"
          context.lineWidth = widthMm
          context.strokeStyle = "rgb(0, 255, 0)"
          context.beginPath()
          context.moveTo(start.x, start.y)
          context.lineTo(end.x, end.y)
          context.stroke()
          context.resetTransform()
          return { name, baselinePixel, webGpuPixel, canvasPixel: readPixel() }
        })
      },
      {
        elements,
        transform: FIT_TRANSFORM,
        widthMm: SUBPIXEL_WIDTH_MM,
        strokes: SUBPIXEL_STROKES,
      },
    )
    const changes = samples.map(
      ({ name, baselinePixel, webGpuPixel, canvasPixel }) => ({
        name,
        webGpuChange: largestChannelDifference(webGpuPixel, baselinePixel),
        canvasChange: largestChannelDifference(canvasPixel, baselinePixel),
        difference: largestChannelDifference(webGpuPixel, canvasPixel),
      }),
    )
    const message = JSON.stringify(samples)
    // Along the stroke both renderers paint the same faint line.
    const [longInterior, ...ends] = changes
    expect(longInterior.difference, message).toBeLessThanOrEqual(
      MAX_CHANNEL_DIFFERENCE,
    )
    // Near its ends WebGPU paints no more than the stroke's area there.
    for (const { webGpuChange, canvasChange } of ends) {
      expect(webGpuChange, message).toBeLessThanOrEqual(
        canvasChange + MAX_CHANNEL_DIFFERENCE,
      )
    }
  } finally {
    await close()
  }
}, 30_000)

/** The largest difference between two pixels in any colour channel. */
function largestChannelDifference(first: number[], second: number[]): number {
  return Math.max(
    ...first.map((channel, index) => Math.abs(channel - second[index])),
  )
}
