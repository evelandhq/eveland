import { observerEnvelopeV1Schema, type ObserverEnvelopeV1 } from "@eveland/core/observer";

export function parseObserverEnvelope(raw: string): ObserverEnvelopeV1 {
  const json = JSON.parse(raw) as unknown;
  return observerEnvelopeV1Schema.parse(json);
}
