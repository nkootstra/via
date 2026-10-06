import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A browser test starts via and Chromium, then signs in and clicks through
    // pages: about 4–5 s alone, more when other tests share the machine, so
    // vitest's default of 5 s would stop it part way. 60 s fits that, and fits
    // a click or wait running out at Playwright's 30 s, so a stuck step fails
    // with Playwright's account of the page rather than as the test timing out.
    testTimeout: 60_000,
  },
});
