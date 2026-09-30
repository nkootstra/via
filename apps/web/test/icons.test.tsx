import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderLogo } from "../src/components/icons.tsx";

/** The shape a provider's logo draws. */
const drawn = (name: string) =>
  [...render(<ProviderLogo name={name} />).container.querySelectorAll("path")].map((path) =>
    path.getAttribute("d"),
  );

describe("ProviderLogo", () => {
  it("draws Ollama's own mark, not the generic glyph", () => {
    expect(drawn("ollama")).not.toEqual(drawn("openrouter"));
    expect(drawn("ollama")).not.toEqual(drawn("opencode-go"));
  });
});
