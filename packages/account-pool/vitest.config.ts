import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A file that starts on modules of its own starts cold: its first test
    // runs Effect's, Bun's HTTP and the fakes' code for the first time, and
    // takes three times the CPU of the next, which under load ran past its
    // time. The files share a worker's modules instead, so only a worker's
    // first test starts cold. Every test still builds its own layers, and
    // nothing here keeps state at module level.
    isolate: false,
  },
});
