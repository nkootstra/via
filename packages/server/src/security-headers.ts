/**
 * Headers for a page via serves to a browser. Its CSP allows nothing but
 * `sources`, the fetch directives the page needs, and no page may frame it.
 */
export const securityHeaders = (sources: ReadonlyArray<string>) => ({
  "content-security-policy": [
    "default-src 'none'",
    ...sources,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});
