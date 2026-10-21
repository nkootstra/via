// What via does to a request body before it keeps it: secrets become markers, such as
// `[redacted:openai-key]`, and images and files a note of what they were. It works by
// pattern, so it can miss a secret it has no pattern for; see docs/README.md.
import { Predicate, type Schema } from "effect";

/** How many strings of one kind were replaced. */
export interface Redaction {
  readonly kind: string;
  readonly count: number;
}

/** A value with its secrets replaced, and what was replaced, by kind. */
export interface Redacted {
  readonly value: Schema.Json;
  readonly redactions: ReadonlyArray<Redaction>;
}

/** What a marker starts with, so a value already replaced isn't replaced again. */
const MARKER = "[redacted:";

const marker = (kind: string) => `${MARKER}${kind}]`;

/** Shannon entropy of `text`, in bits per character. */
const entropy = (text: string) => {
  const counts = new Map<string, number>();

  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);

  return [...counts.values()].reduce((bits, count) => {
    const p = count / text.length;

    return bits - p * Math.log2(p);
  }, 0);
};

/**
 * Whether `value`, assigned to a secret-looking name, looks like a secret: long, with letters
 * and digits, and random enough. A password such as `hunter2` doesn't; see the docs.
 */
const looksSecret = (value: string) =>
  !value.startsWith(MARKER) &&
  value.length >= 12 &&
  !/\s/.test(value) &&
  /[A-Za-z]/.test(value) &&
  /\d/.test(value) &&
  entropy(value) >= 3;

/**
 * A secret's pattern, and what replaces a match: the whole match, or, with `keep`, all but
 * its last group, such as the `Bearer ` before a token.
 */
interface Pattern {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly keep?: boolean;
  /** Whether a match's secret, its last group, really is one. */
  readonly secret?: (value: string) => boolean;
}

/** The patterns, the most specific first: what one replaces, the next doesn't see. */
const patterns: ReadonlyArray<Pattern> = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openrouter-key", pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    kind: "aws-secret-key",
    pattern:
      /(\baws_?secret(?:_?access)?_?key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    keep: true,
  },
  {
    kind: "authorization",
    pattern:
      /(\bauthorization["']?\s*[:=]\s*["']?(?:basic|digest|token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    keep: true,
  },
  {
    kind: "bearer-token",
    pattern: /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    keep: true,
    // A token has digits, or is long; "bearer instruments" is prose.
    secret: (value) => /\d/.test(value) || value.length >= 20,
  },
  {
    kind: "secret",
    pattern:
      /(\b[A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,40}["']?\s*[:=]\s*["']?)([^\s"'`,;<>]{12,})/gi,
    keep: true,
    secret: looksSecret,
  },
];

/** A JSON key whose value, when it looks like one, is a secret. */
const secretKey =
  /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|auth|authorization)$/i;

/** `bytes` as a person reads a size: `768 B`, `412 KB`, `1.2 MB`. */
const sizeOf = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** How many bytes `base64` holds. */
const decodedSize = (base64: string) => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

const DATA_URL = /^data:([\w.+-]+\/([\w.+-]+))?(?:;[\w.+-]+=[^;,]*)*(;base64)?,/i;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A string base64 holds as a file: a long one, of nothing but base64. */
const isBase64Blob = (text: string, least: number) => text.length >= least && BASE64.test(text);

/** What an image or a file as a data URL is replaced with, as `[image: png, 412 KB]`. */
const dataUrlNote = (url: string) => {
  const found = DATA_URL.exec(url);

  if (found === null) return undefined;
  const [prefix, mime = "", subtype] = found;
  const content = url.slice(prefix.length);
  const bytes = found[3] === undefined ? content.length : decodedSize(content);
  const kind = mime.toLowerCase().startsWith("image/") ? "image" : "file";
  const format = subtype === undefined ? "" : `${subtype.toLowerCase()}, `;

  return { kind, note: `[${kind}: ${format}${sizeOf(bytes)}]` };
};

/** The keys that hold an image or a file as plain base64, rather than as a data URL. */
const fileKeys = new Set(["image_url", "file_data", "data", "b64_json", "image"]);

/** The format a file's siblings name: its `filename`'s extension, or its `format`. */
const formatOf = (siblings: Schema.JsonObject) => {
  const { filename, format } = siblings;

  if (Predicate.isString(filename) && filename.includes(".")) {
    return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  }

  return Predicate.isString(format) ? format.toLowerCase() : undefined;
};

/** Whether `value` is a JSON object: what a JSON value is that isn't a string, array or other primitive. */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

/** Replaces values one at a time, counting what it replaced by kind. */
const redactor = () => {
  const counts = new Map<string, number>();
  const count = (kind: string, by = 1) => counts.set(kind, (counts.get(kind) ?? 0) + by);

  const text = (input: string): string => {
    const url = dataUrlNote(input);

    if (url !== undefined) {
      count(url.kind);

      return url.note;
    }

    // A long blob of base64 anywhere is a file, whatever its key.
    if (isBase64Blob(input, 1024)) {
      count("file");

      return `[file: ${sizeOf(decodedSize(input))}]`;
    }

    return patterns.reduce((sofar, { kind, pattern, keep, secret }) => {
      // Every pattern is global, so `replace` starts each search afresh.
      return sofar.replace(pattern, (match: string, ...rest: ReadonlyArray<string | number>) => {
        // After the groups come the match's offset and the whole text.
        const parts = rest.slice(0, -2).filter(Predicate.isString);
        const value = keep === true ? (parts.at(-1) ?? match) : match;

        if (secret !== undefined && !secret(value)) return match;
        count(kind);

        return keep === true ? `${parts.slice(0, -1).join("")}${marker(kind)}` : marker(kind);
      });
    }, input);
  };

  const json = (value: Schema.Json, key?: string, siblings?: Schema.JsonObject): Schema.Json => {
    if (Predicate.isString(value)) {
      if (key !== undefined && secretKey.test(key) && looksSecret(value)) {
        count("secret");

        return marker("secret");
      }

      if (key !== undefined && fileKeys.has(key) && isBase64Blob(value, 64)) {
        const kind = key === "image_url" || key === "image" ? "image" : "file";
        const format = siblings === undefined ? undefined : formatOf(siblings);
        count(kind);

        return `[${kind}: ${format === undefined ? "" : `${format}, `}${sizeOf(decodedSize(value))}]`;
      }

      return text(value);
    }

    if (Array.isArray(value)) return value.map((item) => json(item));

    if (isJsonObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [name, json(inner, name, value)]),
      );
    }

    return value;
  };

  const redactions = () =>
    [...counts]
      .map(([kind, n]) => ({ kind, count: n }))
      .toSorted((a, b) => (a.kind < b.kind ? -1 : 1));

  return { json, redactions };
};

/**
 * `value` with every secret via has a pattern for replaced by a marker such as
 * `[redacted:openai-key]`, and every image or file sent inline by a note of what
 * it was, such as `[image: png, 412 KB]`, and what was replaced, by kind. Its keys,
 * array lengths and every value but a string are as they were.
 */
export const redact = (value: Schema.Json): Redacted => {
  const run = redactor();

  return { value: run.json(value), redactions: run.redactions() };
};

/** How many bytes `value` takes as JSON. */
export const jsonSize = (value: Schema.Json) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** The longest string in `value`, in characters. */
const longest = (value: Schema.Json): number => {
  if (Predicate.isString(value)) return value.length;

  if (Array.isArray(value))
    return value.reduce((most: number, item) => Math.max(most, longest(item)), 0);

  if (isJsonObject(value)) {
    return Object.values(value).reduce((most: number, item) => Math.max(most, longest(item)), 0);
  }

  return 0;
};

/** `value` with each string longer than `limit` characters cut to it, and a note of how much went. */
const cutTo = (value: Schema.Json, limit: number): Schema.Json => {
  if (Predicate.isString(value)) {
    if (value.length <= limit) return value;
    // Not in the middle of a character that takes two.
    const end = /[\uD800-\uDBFF]/.test(value.charAt(limit - 1)) ? limit - 1 : limit;

    return `${value.slice(0, Math.max(0, end))}…[truncated ${value.length - end} characters]`;
  }

  if (Array.isArray(value)) return value.map((item) => cutTo(item, limit));

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, cutTo(inner, limit)]),
    );
  }

  return value;
};

/** JSON cut to fit, and whether it had to be. */
export interface Capped {
  readonly value: Schema.Json;
  readonly truncated: boolean;
}

/**
 * `value` cut to at most `maxBytes` as JSON, and whether it had to be: its long strings
 * cut, the longest first, as little as needed. JSON too big even with every string cut
 * becomes only a note of its size.
 */
export const capped = (value: Schema.Json, maxBytes: number): Capped => {
  const size = jsonSize(value);

  if (size <= maxBytes) return { value, truncated: false };

  // The longest every string can be and the JSON still fit, found by halving.
  let low = 0;
  let high = longest(value);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (jsonSize(cutTo(value, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }

  const cut = cutTo(value, low);

  return jsonSize(cut) <= maxBytes
    ? { value: cut, truncated: true }
    : { value: `[truncated: ${sizeOf(size)}]`, truncated: true };
};
