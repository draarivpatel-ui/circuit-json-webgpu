import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import { FIT_TRANSFORM, openStrokePage } from "../fixtures/stroke-page"

test("opaque paint on a layer above blocks a pick until that layer moves behind", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const picks = await page.evaluate(
      async ({ elements, transform }) => {
        const { drawer } = window.gpuTest
        drawer.drawElements(elements, { hiddenLayerOpacity: 1, transform })
        const bottom = { candidates: ["bottom"] }
        const underTopPad = await drawer.pickLayerAt({
          ...bottom,
          point: { x: 100, y: 100 },
        })
        const besideTopPad = await drawer.pickLayerAt({
          ...bottom,
          point: { x: 130, y: 100 },
        })
        drawer.render({ selectedLayer: "bottom" })
        const bottomSelected = await drawer.pickLayerAt({
          ...bottom,
          point: { x: 100, y: 100 },
        })
        return { underTopPad, besideTopPad, bottomSelected }
      },
      { elements, transform: FIT_TRANSFORM },
    )
    expect(picks).toEqual({
      underTopPad: undefined,
      besideTopPad: "bottom",
      bottomSelected: "bottom",
    })
  } finally {
    await close()
  }
}, 30_000)
