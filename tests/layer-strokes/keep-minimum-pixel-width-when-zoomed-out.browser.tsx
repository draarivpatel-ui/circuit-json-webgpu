import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { BOTTOM_LINE, openStrokePage, pixelAt } from "../fixtures/stroke-page"

test("zoomed out, a stroke keeps its minimum width in canvas pixels", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const png = await page.evaluate(
      ({ elements, line }) => {
        window.gpuTest.drawer.drawElements(elements, {
          layerStrokes: [{ ...line, minWidthPixels: 6, color: [0, 1, 0, 1] }],
          hiddenLayerOpacity: 1,
          // 2 px per mm: the 0.5 mm stroke would be 1 px wide.
          transform: { a: 2, b: 0, c: 0, d: -2, e: 100, f: 100 },
          background: [1, 1, 1, 1],
        })
        return document.querySelector("canvas")!.toDataURL().split(",")[1]
      },
      { elements, line: BOTTOM_LINE },
    )
    // 6 px wide spans y = 97 to 103.
    expect(pixelAt({ png, x: 104, y: 102 })).toEqual([0, 255, 0])
  } finally {
    await close()
  }
}, 30_000)
