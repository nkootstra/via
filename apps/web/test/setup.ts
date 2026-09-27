import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach } from "vitest";

// Tests assert behaviour, not motion: every animation completes at once.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);
