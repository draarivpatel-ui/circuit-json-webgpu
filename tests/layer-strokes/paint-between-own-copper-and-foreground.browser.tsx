import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_LINE,
  FIT_TRANSFORM,
  openStrokePage,
  pixelAt,
} from "../fixtures/stroke-page"

test("a stroke paints over its own layer's copper and under the foreground layer", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const png = await page.evaluate(
      ({ elements, line, transform }) => {
        window.gpuTest.drawer.drawElements(elements, {
          layerStrokes: [
            {
              ...line,
              extraWidthPixels: 4,
              maxWidthMm: 1,
              color: [0, 0, 0, 1],
            },
            { ...line, color: [0, 1, 0, 1] },
          ],
          hiddenLayerOpacity: 1,
          transform,
          background: [1, 1, 1, 1],
        })
        return document.querySelector("canvas")!.toDataURL().split(",")[1]
      },
      { elements, line: BOTTOM_LINE, transform: FIT_TRANSFORM },
    )
    // The top pad covers the stroke at the origin.
    expect(pixelAt({ png, x: 100, y: 100 })).toEqual([200, 52, 52])
    expect(pixelAt({ png, x: 130, y: 100 })).toEqual([0, 255, 0])
    // The black outset adds 4 px to the 10 px stroke's total width, 2 px on each side.
    expect(pixelAt({ png, x: 130, y: 106 })).toEqual([0, 0, 0])
  } finally {
    await close()
  }
}, 30_000)
