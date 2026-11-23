import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_PAD_STROKE,
  FIT_TRANSFORM,
  openStrokePage,
  rgbAt,
} from "../fixtures/stroke-page"

test("a stroke paints over its own layer's copper and under the foreground layer", async () => {
  const elements = await renderCrossedPadsBoard()
  const { page, close } = await openStrokePage()
  try {
    const png = await page.evaluate(
      ({ elements, line, transform }) => {
        window.gpuTest.drawer.drawElements(elements, {
          layerStrokes: [{ ...line, color: [0, 1, 0, 1] }],
          hiddenLayerOpacity: 1,
          transform,
          background: [1, 1, 1, 1],
        })
        return document.querySelector("canvas")!.toDataURL().split(",")[1]
      },
      { elements, line: BOTTOM_PAD_STROKE, transform: FIT_TRANSFORM },
    )
    // The top pad covers the stroke at the origin.
    expect(rgbAt({ png, x: 100, y: 100 })).toEqual([200, 52, 52])
    expect(rgbAt({ png, x: 130, y: 100 })).toEqual([0, 255, 0])
  } finally {
    await close()
  }
}, 30_000)
