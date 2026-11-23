import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_PAD_STROKE,
  openStrokePage,
  rgbAt,
} from "../fixtures/stroke-page"

test("a horizontal stroke is as tall as its board width when Y is scaled less than X", async () => {
  const elements = await renderCrossedPadsBoard()
  const { page, close } = await openStrokePage()
  try {
    const png = await page.evaluate(
      ({ elements, line }) => {
        window.gpuTest.drawer.drawElements(elements, {
          layerStrokes: [{ ...line, color: [0, 1, 0, 1] }],
          hiddenLayerOpacity: 1,
          // 20 px per mm across X, 10 px per mm down Y.
          transform: { a: 20, b: 0, c: 0, d: -10, e: 100, f: 100 },
          background: [1, 1, 1, 1],
        })
        return document.querySelector("canvas")!.toDataURL().split(",")[1]
      },
      { elements, line: BOTTOM_PAD_STROKE },
    )
    // 0.5 mm at 10 px per mm spans y = 97.5 to 102.5.
    expect(rgbAt({ png, x: 130, y: 101 })).toEqual([0, 255, 0])
    expect(rgbAt({ png, x: 130, y: 104 })).toEqual([255, 255, 255])
  } finally {
    await close()
  }
}, 30_000)
