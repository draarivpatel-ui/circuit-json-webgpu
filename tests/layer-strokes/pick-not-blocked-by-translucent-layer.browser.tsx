import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { FIT_TRANSFORM, openStrokePage } from "../fixtures/stroke-page"

test("a translucent layer above does not block a pick", async () => {
  // With inner1 selected, top and bottom are both drawn at half opacity and
  // the top pad lies over the bottom pad at the origin.
  const elements = await renderCrossedPadsBoard({ layers: 4 })
  const { page, close } = await openStrokePage()
  try {
    const picked = await page.evaluate(
      async ({ elements, transform }) => {
        const { drawer } = window.gpuTest
        drawer.drawElements(elements, {
          selectedLayer: "inner1",
          hiddenLayerOpacity: 0.5,
          transform,
        })
        return drawer.pickLayerAt({
          point: { x: 100, y: 100 },
          candidates: ["bottom"],
        })
      },
      { elements, transform: FIT_TRANSFORM },
    )
    expect(picked).toBe("bottom")
  } finally {
    await close()
  }
}, 30_000)
