import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_LINE,
  FIT_TRANSFORM,
  openStrokePage,
  pixelAt,
} from "../fixtures/stroke-page"

/** Puts the centreline through the middle of canvas row 100 (y = 100.5 px). */
const CENTRELINE_Y_MM = -0.025

test("a zero-width stroke leaves its layer's copper unpainted", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const pngs = await page.evaluate(
      ({ elements, line, transform, centrelineYMm }) => {
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
              start: { x: line.start.x, y: centrelineYMm },
              end: { x: line.end.x, y: centrelineYMm },
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
        line: BOTTOM_LINE,
        transform: FIT_TRANSFORM,
        centrelineYMm: CENTRELINE_Y_MM,
      },
    )
    expect(pixelAt({ png: pngs.withStroke, x: 130, y: 100 })).toEqual(
      pixelAt({ png: pngs.withoutStroke, x: 130, y: 100 }),
    )
  } finally {
    await close()
  }
}, 30_000)
