import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach } from "vitest";

// Tests assert behaviour, not motion. happy-dom's Web Animations reject an
// interrupted animation's `finished` promise with nobody listening, so every
// motion animation completes at once instead.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);
