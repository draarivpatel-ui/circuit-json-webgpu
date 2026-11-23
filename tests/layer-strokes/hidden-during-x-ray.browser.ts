import { expect, test } from "bun:test"
import { renderCrossedPadsBoard } from "../fixtures/crossed-pads-board"
import {
  BOTTOM_PAD_STROKE,
  FIT_TRANSFORM,
  openStrokePage,
  rgbAt,
} from "../fixtures/stroke-page"

test("strokes are not drawn while X-Ray inspects a net", async () => {
  const elements = await renderCrossedPadsBoard()
  const bottomPad = elements.find(
    (element) => element.type === "pcb_smtpad" && element.layer === "bottom",
  )
  if (bottomPad?.type !== "pcb_smtpad") throw new Error("Missing bottom pad")
  const { page, close } = await openStrokePage()
  try {
    const png = await page.evaluate(
      ({ elements, line, transform, xRayElementIds }) => {
        window.gpuTest.drawer.drawElements(elements, {
          layerStrokes: [{ ...line, color: [0, 1, 0, 1] }],
          hiddenLayerOpacity: 1,
          transform,
          xRayElementIds,
          background: [1, 1, 1, 1],
        })
        return document.querySelector("canvas")!.toDataURL().split(",")[1]
      },
      {
        elements,
        line: BOTTOM_PAD_STROKE,
        transform: FIT_TRANSFORM,
        xRayElementIds: [bottomPad.pcb_smtpad_id],
      },
    )
    expect(rgbAt({ png, x: 130, y: 100 })).not.toEqual([0, 255, 0])
  } finally {
    await close()
  }
}, 30_000)
