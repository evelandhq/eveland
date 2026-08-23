// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ObservabilityCaptureForm } from "./capture-form";

describe("ObservabilityCaptureForm", () => {
  test("associates the trace sampling label with its percentage input", () => {
    render(
      <ObservabilityCaptureForm
        capture={{
          enabled: true,
          sampling: { ratio: 1 },
          recordInputs: true,
          recordOutputs: true,
        }}
        pending={false}
        saved={false}
        onChange={() => undefined}
        onSubmit={(event) => event.preventDefault()}
      />,
    );

    expect(screen.getByLabelText("Trace sampling").getAttribute("id")).toBe("agent-sampling-ratio");
  });
});
