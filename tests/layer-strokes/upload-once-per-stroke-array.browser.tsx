import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_LINE,
  FIT_TRANSFORM,
  openStrokePage,
} from "../fixtures/stroke-page"

test("stroke buffers upload once per array, not per camera change, and clear without an upload", async () => {
  const elements = await renderCrossedPadsBoard({ layers: 2 })
  const { page, close } = await openStrokePage()
  try {
    const uploads = await page.evaluate(
      ({ elements, line, transform }) => {
        const { drawer } = window.gpuTest
        const strokes = [{ ...line, color: [0, 1, 0, 1] as const }]
        const counts: number[] = []
        const before = drawer.stats.strokeUploads
        drawer.drawElements(elements, { layerStrokes: strokes, transform })
        counts.push(drawer.stats.strokeUploads - before)
        drawer.render({ transform: { ...transform, e: 80 } })
        counts.push(drawer.stats.strokeUploads - before)
        drawer.render({ layerStrokes: [...strokes] })
        counts.push(drawer.stats.strokeUploads - before)
        drawer.render({ layerStrokes: undefined })
        counts.push(drawer.stats.strokeUploads - before)
        return counts
      },
      { elements, line: BOTTOM_LINE, transform: FIT_TRANSFORM },
    )
    expect(uploads).toEqual([1, 1, 2, 2])
  } finally {
    await close()
  }
}, 30_000)
