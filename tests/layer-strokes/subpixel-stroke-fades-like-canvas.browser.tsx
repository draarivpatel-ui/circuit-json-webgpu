import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_LINE,
  FIT_TRANSFORM,
  openStrokePage,
} from "../fixtures/stroke-page"

/** 0.1 canvas pixels at the fixture's 20 px per mm. */
const SUBPIXEL_WIDTH_MM = 0.005

/** Puts the centreline through the middle of canvas row 100 (y = 100.5 px). */
const CENTRELINE_Y_MM = -0.025

/** Largest channel difference allowed between the two rasterisers. */
const MAX_CHANNEL_DIFFERENCE = 4

test("a stroke narrower than a pixel paints as faintly as the same line on a 2D canvas", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const { webGpuPixel, canvasPixel } = await page.evaluate(
      ({ elements, line, transform, widthMm, centrelineYMm }) => {
        const { drawer } = window.gpuTest
        const gpuCanvas = document.querySelector("canvas")!
        const reference = document.createElement("canvas")
        reference.width = gpuCanvas.width
        reference.height = gpuCanvas.height
        const context = reference.getContext("2d")!
        drawer.drawElements(elements, { hiddenLayerOpacity: 1, transform })
        context.drawImage(gpuCanvas, 0, 0)
        const [red, green, blue] = context.getImageData(130, 100, 1, 1).data
        drawer.render({
          layerStrokes: [
            {
              ...line,
              start: { x: line.start.x, y: centrelineYMm },
              end: { x: line.end.x, y: centrelineYMm },
              widthMm,
              color: [0, 1, 0, 1],
            },
          ],
        })
        context.drawImage(gpuCanvas, 0, 0)
        const webGpuPixel = [...context.getImageData(130, 100, 1, 1).data]
        // The same line on the copper's colour, drawn by the 2D canvas.
        context.fillStyle = `rgb(${red}, ${green}, ${blue})`
        context.fillRect(0, 0, reference.width, reference.height)
        context.setTransform(
          transform.a,
          transform.b,
          transform.c,
          transform.d,
          transform.e,
          transform.f,
        )
        context.lineWidth = widthMm
        context.strokeStyle = "rgb(0, 255, 0)"
        context.beginPath()
        context.moveTo(line.start.x, centrelineYMm)
        context.lineTo(line.end.x, centrelineYMm)
        context.stroke()
        context.resetTransform()
        const canvasPixel = [...context.getImageData(130, 100, 1, 1).data]
        return { webGpuPixel, canvasPixel }
      },
      {
        elements,
        line: BOTTOM_LINE,
        transform: FIT_TRANSFORM,
        widthMm: SUBPIXEL_WIDTH_MM,
        centrelineYMm: CENTRELINE_Y_MM,
      },
    )
    const largestChannelDifference = Math.max(
      ...webGpuPixel
        .slice(0, 3)
        .map((channel, index) => Math.abs(channel - canvasPixel[index])),
    )
    expect(
      largestChannelDifference,
      JSON.stringify({ webGpuPixel, canvasPixel }),
    ).toBeLessThanOrEqual(MAX_CHANNEL_DIFFERENCE)
  } finally {
    await close()
  }
}, 30_000)
