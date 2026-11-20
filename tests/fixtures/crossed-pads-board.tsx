import { Circuit } from "@tscircuit/core"
import type { CircuitJson } from "../../lib"

/** A 10 mm board where a 1 × 6 mm top pad crosses a 6 × 0.5 mm bottom pad at the origin. */
export async function renderCrossedPadsBoard({
  layers,
}: {
  layers: 2 | 4
}): Promise<CircuitJson> {
  const circuit = new Circuit()
  circuit.add(
    <board width={10} height={10} layers={layers} routingDisabled>
      <smtpad shape="rect" layer="top" width={1} height={6} />
      <smtpad shape="rect" layer="bottom" width={6} height={0.5} />
    </board>,
  )
  await circuit.renderUntilSettled()
  return circuit.getCircuitJson() as CircuitJson
}
