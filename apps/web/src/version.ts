declare global {
  interface ImportMetaEnv {
    /** Set by the Vite and Vitest configs, from `via-version.ts`. */
    readonly VIA_VERSION: string;
  }
}

/** The version of via this page was built with. */
export const builtVersion = import.meta.env.VIA_VERSION;
