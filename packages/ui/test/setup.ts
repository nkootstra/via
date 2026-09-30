import { cleanup, configure, getConfig } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach } from "vitest";

// Tests assert behaviour, not motion. happy-dom's Web Animations reject an
// interrupted animation's `finished` promise with nobody listening, so every
// motion animation completes at once instead.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);

// Testing Library's waits (findBy…, waitFor, user-event's actions) that are
// still running. Vitest gives up on a test that runs out of time, but can't
// stop its waits: they go on polling the page, which after cleanup is the next
// test's, and the test goes on in it once they find what they wait for. So a
// test's waits settle, each within asyncUtilTimeout, before its page goes.
const running = new Set<Promise<unknown>>();

// React Testing Library's own wrapper, which runs a wait outside act().
const { asyncWrapper } = getConfig();

configure({
  asyncWrapper: (callback) => {
    const wait = asyncWrapper(callback);
    const settle = () => running.delete(wait);

    running.add(wait);
    wait.then(settle, settle);

    return wait;
  },
});

// Registered last, so it runs first: vitest runs a file's afterEach hooks in reverse.
afterEach(async () => {
  while (running.size > 0) await Promise.allSettled(running);
});
