/**
 * What privacy mode shows in place of what identifies someone: emails, the
 * last characters of a key, and an address's host. Each keeps the shape of
 * what it hides, so the page still reads right.
 */

const HIDDEN = "•••••";

/** An email: a local part, `@`, and a domain ending in its top-level part. */
const EMAIL = /[^\s@<>()[\]"',;:]+@(?:[^\s@<>()[\]"',;:.]+\.)+([a-z]{2,})\b/gi;

/** `text` with every email in it hidden, but for its top-level domain: `•••••@•••••.com`. */
export const maskEmails = (text: string) =>
  text.replace(EMAIL, (_email, tld: string) => `${HIDDEN}@${HIDDEN}.${tld}`);

/** `text` with a key's last characters hidden, as via shows them: `…1234` becomes `…••••`. */
export const maskKeyTail = (text: string) =>
  text.replace(/…(\S+)/g, (_tail, rest: string) => `…${"•".repeat(rest.length)}`);

/** An address with its host hidden, character by character, keeping its scheme, dots and port. */
export const maskAddress = (address: string) =>
  address.replace(
    /^([a-z]+:\/\/)?([^/:]+)/i,
    (_all, scheme: string | undefined, host: string) =>
      `${scheme ?? ""}${host.replace(/[^.]/g, "•")}`,
  );
