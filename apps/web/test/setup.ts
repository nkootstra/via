import { cleanup, configure, getConfig } from "@testing-library/react";
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

// Each test starts from a fresh page: no state from a shell, no stream open,
// and the real clock.
afterEach(() => {
  vi.useRealTimers();
  sources.length = 0;

  if ("document" in globalThis) document.getElementById("via-state")?.remove();
});

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
