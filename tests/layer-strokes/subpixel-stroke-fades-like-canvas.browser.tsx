import { expect, test } from "bun:test"
import type { Point } from "../../lib"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { FIT_TRANSFORM, openStrokePage } from "../fixtures/stroke-page"

/** Canvas pixels per mm under the fixture's transform. */
const PIXELS_PER_MM = 20

/** The sampled pixel, whose centre is (130.5, 100.5). */
const SAMPLED_PIXEL = { x: 130, y: 100 }

/** Stroke widths below a pixel, in canvas pixels. */
const SUBPIXEL_WIDTHS = [0.1, 0.4, 0.8]

/** Largest channel difference allowed where both renderers draw the stroke's body. */
const MAX_INTERIOR_DIFFERENCE = 4

/**
 * Largest channel difference allowed from the stroke's exact area in the
 * pixel at a cap or short piece. The 2D canvas misses that area by up to
 * 30 there, so it is no reference; across a diagonal the pixel's box is
 * measured in the stroke's own frame.
 */
const MAX_AREA_DIFFERENCE = 12

/** Samples per axis when measuring a stroke's exact area in the pixel. */
const AREA_SAMPLES_PER_AXIS = 100

/** A stroke from `start` to `end`, in canvas pixels, and what it is checked against. */
type SubpixelCase = {
  name: string
  start: Point
  end: Point
  reference: "canvas" | "area"
}

/** Horizontal and 45° strokes near the sampled pixel's centre. */
const SUBPIXEL_CASES: SubpixelCase[] = [
  {
    name: "horizontal interior",
    start: { x: 40, y: 100.5 },
    end: { x: 160, y: 100.5 },
    reference: "canvas",
  },
  {
    name: "diagonal interior",
    start: { x: 110.5, y: 80.5 },
    end: { x: 150.5, y: 120.5 },
    reference: "canvas",
  },
  {
    name: "horizontal cap",
    start: { x: 130.9, y: 100.5 },
    end: { x: 160, y: 100.5 },
    reference: "area",
  },
  {
    name: "diagonal cap",
    start: { x: 130.8, y: 100.8 },
    end: { x: 150, y: 120 },
    reference: "area",
  },
  {
    name: "horizontal short piece",
    start: { x: 130.35, y: 100.5 },
    end: { x: 130.65, y: 100.5 },
    reference: "area",
  },
  {
    name: "diagonal short piece",
    start: { x: 130.4, y: 100.4 },
    end: { x: 130.6, y: 100.6 },
    reference: "area",
  },
]

test("strokes narrower than a pixel paint their area at caps and short pieces, match the 2D canvas along their body, and paint nothing when their ends coincide", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const strokes = SUBPIXEL_WIDTHS.flatMap((widthPixels) => [
    ...SUBPIXEL_CASES.map((subpixelCase) => ({ ...subpixelCase, widthPixels })),
    {
      name: "coincident ends",
      start: { x: 130.5, y: 100.5 },
      end: { x: 130.5, y: 100.5 },
      reference: "canvas" as const,
      widthPixels,
    },
  ])
  const { page, close } = await openStrokePage()
  try {
    const samples = await page.evaluate(
      ({ elements, transform, strokes, pixel, pixelsPerMm }) => {
        const { drawer } = window.gpuTest
        const gpuCanvas = document.querySelector("canvas")!
        const reference = document.createElement("canvas")
        reference.width = gpuCanvas.width
        reference.height = gpuCanvas.height
        const context = reference.getContext("2d")!
        const readPixel = () => [
          ...context.getImageData(pixel.x, pixel.y, 1, 1).data.slice(0, 3),
        ]
        drawer.drawElements(elements, { hiddenLayerOpacity: 1, transform })
        context.drawImage(gpuCanvas, 0, 0)
        const baselinePixel = readPixel()
        return strokes.map((stroke) => {
          const toBoard = (point: { x: number; y: number }) => ({
            x: (point.x - transform.e) / pixelsPerMm,
            y: (transform.f - point.y) / pixelsPerMm,
          })
          drawer.render({
            layerStrokes: [
              {
                layer: "bottom",
                start: toBoard(stroke.start),
                end: toBoard(stroke.end),
                widthMm: stroke.widthPixels / pixelsPerMm,
                color: [0, 1, 0, 1],
              },
            ],
          })
          context.drawImage(gpuCanvas, 0, 0)
          const webGpuPixel = readPixel()
          // The same stroke on the copper's colour, drawn by the 2D canvas.
          context.fillStyle = `rgb(${baselinePixel.join(", ")})`
          context.fillRect(0, 0, reference.width, reference.height)
          context.lineCap = "round"
          context.lineWidth = stroke.widthPixels
          context.strokeStyle = "rgb(0, 255, 0)"
          context.beginPath()
          context.moveTo(stroke.start.x, stroke.start.y)
          context.lineTo(stroke.end.x, stroke.end.y)
          context.stroke()
          return { baselinePixel, webGpuPixel, canvasPixel: readPixel() }
        })
      },
      {
        elements,
        transform: FIT_TRANSFORM,
        strokes,
        pixel: SAMPLED_PIXEL,
        pixelsPerMm: PIXELS_PER_MM,
      },
    )
    const results = strokes.map((stroke, index) => {
      const { baselinePixel, webGpuPixel, canvasPixel } = samples[index]
      const name = `${stroke.widthPixels} px ${stroke.name}`
      if (stroke.name === "coincident ends") {
        return { name, webGpuPixel, canvasPixel, expected: baselinePixel }
      }
      if (stroke.reference === "canvas") {
        return { name, webGpuPixel, expected: canvasPixel }
      }
      const share = getStrokeShareOfPixel(stroke)
      const areaPixel = baselinePixel.map((channel, channelIndex) =>
        Math.round(channel + ([0, 255, 0][channelIndex] - channel) * share),
      )
      return { name, webGpuPixel, expected: areaPixel }
    })
    for (const result of results) {
      const message = JSON.stringify(result)
      if (result.name.endsWith("coincident ends")) {
        expect(result.webGpuPixel, message).toEqual(result.expected)
        expect(result.canvasPixel, message).toEqual(result.expected)
        continue
      }
      const tolerance = result.name.endsWith("interior")
        ? MAX_INTERIOR_DIFFERENCE
        : MAX_AREA_DIFFERENCE
      expect(
        largestChannelDifference(result.webGpuPixel, result.expected),
        message,
      ).toBeLessThanOrEqual(tolerance)
    }
  } finally {
    await close()
  }
}, 30_000)

/** The share of the sampled pixel inside a round-capped stroke, by sampling it on a grid. */
function getStrokeShareOfPixel({
  start,
  end,
  widthPixels,
}: {
  start: Point
  end: Point
  widthPixels: number
}): number {
  let insideSamples = 0
  for (let column = 0; column < AREA_SAMPLES_PER_AXIS; column++) {
    for (let row = 0; row < AREA_SAMPLES_PER_AXIS; row++) {
      const samplePoint = {
        x: SAMPLED_PIXEL.x + (column + 0.5) / AREA_SAMPLES_PER_AXIS,
        y: SAMPLED_PIXEL.y + (row + 0.5) / AREA_SAMPLES_PER_AXIS,
      }
      const distance = getDistanceToSegment({ point: samplePoint, start, end })
      if (distance <= widthPixels / 2) insideSamples++
    }
  }
  return insideSamples / AREA_SAMPLES_PER_AXIS ** 2
}

/** The distance from `point` to the segment from `start` to `end`. */
function getDistanceToSegment({
  point,
  start,
  end,
}: {
  point: Point
  start: Point
  end: Point
}): number {
  const segmentX = end.x - start.x
  const segmentY = end.y - start.y
  const lengthSquared = segmentX ** 2 + segmentY ** 2
  let fraction = 0
  if (lengthSquared > 0) {
    fraction =
      ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
      lengthSquared
  }
  const clampedFraction = Math.max(0, Math.min(1, fraction))
  return Math.hypot(
    point.x - start.x - clampedFraction * segmentX,
    point.y - start.y - clampedFraction * segmentY,
  )
}

/** The largest difference between two pixels in any colour channel. */
function largestChannelDifference(first: number[], second: number[]): number {
  return Math.max(
    ...first.map((channel, index) => Math.abs(channel - second[index])),
  )
}
