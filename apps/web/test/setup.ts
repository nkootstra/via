import { cleanup, configure } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach } from "vitest";

// Tests assert behaviour, not motion: every animation completes at once.
MotionGlobalConfig.skipAnimations = true;

// A route's code compiles the first time a test reaches it, which on a slow CI
// runner can take longer than Testing Library's default second to find a screen.
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);

// The app keeps its queries in sessionStorage; each test starts from a fresh tab.
// The build's own tests run in Node, which has none.
afterEach(() => {
  if ("sessionStorage" in globalThis) sessionStorage.clear();
});
