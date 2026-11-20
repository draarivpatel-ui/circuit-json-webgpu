import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { FIT_TRANSFORM, openStrokePage } from "../fixtures/stroke-page"

test("a pick returns the foremost candidate layer", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const picked = await page.evaluate(
      async ({ elements, transform }) => {
        const { drawer } = window.gpuTest
        drawer.drawElements(elements, { hiddenLayerOpacity: 1, transform })
        return drawer.pickLayerAt({
          point: { x: 130, y: 100 },
          candidates: ["bottom", "top"],
        })
      },
      { elements, transform: FIT_TRANSFORM },
    )
    expect(picked).toBe("top")
  } finally {
    await close()
  }
}, 30_000)
