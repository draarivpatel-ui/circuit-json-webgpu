import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_PAD_STROKE,
  FIT_TRANSFORM,
  openStrokePage,
  rgbAt,
} from "../fixtures/stroke-page"

/** Puts the centerline through the middle of canvas row 100 (y = 100.5 px). */
const CENTERLINE_Y_MM = -0.025

test("a zero-width stroke leaves its layer's copper unpainted", async () => {
  const elements = await renderCrossedPadsBoard()
  const { page, close } = await openStrokePage()
  try {
    const pngs = await page.evaluate(
      ({ elements, line, transform, centerlineYMm }) => {
        const { drawer } = window.gpuTest
        const options = { hiddenLayerOpacity: 1, transform }
        drawer.drawElements(elements, options)
        const withoutStroke = document
          .querySelector("canvas")!
          .toDataURL()
          .split(",")[1]
        drawer.render({
          layerStrokes: [
            {
              ...line,
              start: { x: line.start.x, y: centerlineYMm },
              end: { x: line.end.x, y: centerlineYMm },
              widthMm: 0,
              color: [0, 1, 0, 1],
            },
          ],
        })
        const withStroke = document
          .querySelector("canvas")!
          .toDataURL()
          .split(",")[1]
        return { withoutStroke, withStroke }
      },
      {
        elements,
        line: BOTTOM_PAD_STROKE,
        transform: FIT_TRANSFORM,
        centerlineYMm: CENTERLINE_Y_MM,
      },
    )
    expect(rgbAt({ png: pngs.withStroke, x: 130, y: 100 })).toEqual(
      rgbAt({ png: pngs.withoutStroke, x: 130, y: 100 }),
    )
  } finally {
    await close()
  }
}, 30_000)
