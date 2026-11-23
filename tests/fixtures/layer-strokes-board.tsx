import { Circuit } from "@tscircuit/core"
import type { LayerStroke } from "../../lib"

export async function renderLayerStrokesBoard() {
  const circuit = new Circuit()
  circuit.add(
    <board width={16} height={10} layers={4} routingDisabled>
      <smtpad shape="rect" layer="top" pcbX={-2.75} width={1.6} height={3} />
      <smtpad
        shape="rect"
        layer="bottom"
        pcbX={1.6}
        pcbY={1.75}
        width={3}
        height={1.55}
      />
      <via
        pcbX={3.2}
        pcbY={0}
        fromLayer="top"
        toLayer="bottom"
        outerDiameter={1.45}
        holeDiameter={0.65}
      />
    </board>,
  )
  await circuit.renderUntilSettled()
  return circuit.getCircuitJson()
}

const zigzag = [
  { x: -6.5, y: 2.9 },
  { x: -4.8, y: 3.9 },
  { x: -3, y: 2.7 },
  { x: -0.7, y: 3.4 },
]
export const layerStrokes: LayerStroke[] = [
  {
    layer: "top",
    start: { x: -6.5, y: 0 },
    end: { x: 5.8, y: 0 },
    widthMm: 0.58,
    color: [0.12, 0.9, 1, 0.85],
  },
  {
    layer: "bottom",
    start: { x: 1.6, y: -3.8 },
    end: { x: 1.6, y: 3.8 },
    widthMm: 0.95,
    color: [1, 0.56, 0.12, 1],
  },
  {
    layer: "inner1",
    start: { x: -5, y: -3.5 },
    end: { x: 5.8, y: 3.4 },
    widthMm: 0.5,
    color: [0.65, 0.45, 1, 1],
  },
  ...zigzag.slice(1).map(
    (end, i): LayerStroke => ({
      layer: "top",
      start: zigzag[i],
      end,
      widthMm: 0.42,
      color: [0.55, 1, 0.25, 1],
    }),
  ),
  {
    layer: "top",
    start: { x: -3.8, y: -3.5 },
    end: { x: -0.8, y: -1.35 },
    widthMm: 0.14,
    color: [1, 0.42, 0.68, 0.65],
  },
  {
    layer: "top",
    start: { x: 2.3, y: -3.1 },
    end: { x: 6.6, y: -3.1 },
    widthMm: 0.022, // 0.792 px at 36 px/mm.
    color: [1, 1, 1, 1],
  },
]
