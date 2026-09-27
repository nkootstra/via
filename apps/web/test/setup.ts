import { cleanup, configure } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach, vi } from "vitest";
import { FakeEventSource, sources } from "./event-source.ts";

// Tests assert behaviour, not motion: every animation completes at once.
MotionGlobalConfig.skipAnimations = true;

// A route's code compiles the first time a test reaches it, which on a slow CI
// runner can take longer than Testing Library's default second to find a screen.
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);

// happy-dom has no EventSource; the build's own tests run in Node, which needs none.
if ("document" in globalThis) vi.stubGlobal("EventSource", FakeEventSource);

// Each test starts from a fresh page: no state from a shell, no stream open.
afterEach(() => {
  sources.length = 0;

  if ("document" in globalThis) document.getElementById("via-state")?.remove();
});
