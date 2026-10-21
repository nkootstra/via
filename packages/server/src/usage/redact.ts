// What via does to a request body before it keeps it: secrets become markers, such as
// `[redacted:openai-key]`, and images and files a note of what they were. It works by
// pattern, so it can miss a secret it has no pattern for; see docs/README.md.
import { Predicate, type Schema } from "effect";

/** How many strings of one kind were replaced. */
interface Redaction {
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

/** A name a secret is assigned to, such as `OPENAI_API_KEY` or `"accessToken"`, in text. */
const SECRET_NAME =
  "\\b[A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,40}";

/** The patterns, the most specific first: what one replaces, the next doesn't see. */
const patterns: ReadonlyArray<Pattern> = [
  {
    kind: "private-key",
    // To its END line or, when it has none, such as a key cut off, to the end of the text.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g,
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
      /(\bauthorization["']?\s*[:=]\s*["']?(?:basic|digest|token|apikey|api-key|ssws|negotiate|ntlm|dpop)[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi,
    keep: true,
  },
  {
    // An Authorization header with no scheme or one via doesn't know; Bearer is the next pattern's.
    kind: "authorization",
    pattern:
      /(\bauthorization["']?\s*[:=]\s*["']?(?!bearer[ \t])(?:[A-Za-z][\w-]*[ \t]+)?)([^\s"'`,;<>]{8,})/gi,
    keep: true,
    secret: (value) => credentialLike(value),
  },
  {
    // A Cookie or Set-Cookie header's value: `name=value`, and whatever follows on its line.
    kind: "cookie",
    pattern: /(\bcookie["']?\s*[:=][ \t]*["']?)([^\s=;"'`]+=[^\r\n"'`]*)/gi,
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
    pattern: new RegExp(
      `(${SECRET_NAME}["']?\\s*[:=]\\s*["']?(?:(?:basic|digest|token|apikey)[ \\t]+)?)([^\\s"'\`,;<>]{12,})`,
      "gi",
    ),
    keep: true,
    secret: looksSecret,
  },
];

/** An array of strings assigned to a secret-looking name, in text: `"api_keys": ["…", "…"]`. */
const SECRET_ARRAY = new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)\\[([^\\[\\]]*)\\]`, "gi");

/** A quoted item of such an array. */
const QUOTED = /(["'])([^"'\s]*)\1/g;

/**
 * Whether `value`, after an Authorization header with no scheme via knows, is a credential
 * rather than a word: it has digits, symbols or capitals inside it, or is long.
 */
const credentialLike = (value: string) =>
  /[\d._~+/=-]/.test(value) || /[A-Z]/.test(value.slice(1)) || value.length >= 20;

/** A JSON key whose value is a header's credential, kept as a marker whatever it looks like. */
const credentialKeys: ReadonlyArray<readonly [kind: string, key: RegExp]> = [
  ["authorization", /(?:^|[_-])authorization$/i],
  ["cookie", /(?:^|[_-])cookie$/i],
];

/** A JSON key whose value, when it looks like one, is a secret. */
const secretKey =
  /(?:^|[_-])(?:api[_-]?keys?|apikeys?|secrets?|secret[_-]?keys?|tokens?|passwords?|passwd|credentials?|access[_-]?keys?|private[_-]?keys?|auth)$/i;

/** What a JSON key's value is a secret of, if it is one: camelCase names as snake_case ones. */
const keyKind = (key: string) => {
  const name = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");

  return (
    credentialKeys.find(([, pattern]) => pattern.test(name))?.[0] ??
    (secretKey.test(name) ? "secret" : undefined)
  );
};

/** A credential's scheme, as in `Basic dXNlcjpwYXNz`, and the credential after it. */
const SCHEMED =
  /^((?:basic|digest|bearer|token|apikey|api-key|ssws|negotiate|ntlm|dpop)[ \t]+)(\S[\s\S]*)$/i;

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

    const patterned = patterns.reduce((sofar, { kind, pattern, keep, secret }) => {
      // Every pattern is global, so `replace` starts each search afresh.
      return sofar.replace(pattern, (match: string, ...rest: ReadonlyArray<string | number>) => {
        // After the groups come the match's offset and the whole text.
        const parts = rest.slice(0, -2).filter(Predicate.isString);
        const value = keep === true ? (parts.at(-1) ?? match) : match;

        if (value.startsWith(MARKER) || (secret !== undefined && !secret(value))) return match;
        count(kind);

        return keep === true ? `${parts.slice(0, -1).join("")}${marker(kind)}` : marker(kind);
      });
    }, input);

    // Each item of an array under a secret-looking name is a secret when it looks like one.
    return patterned.replace(SECRET_ARRAY, (_match, name: string, items: string) => {
      const kept = items.replace(QUOTED, (item, quote: string, value: string) => {
        if (!looksSecret(value)) return item;
        count("secret");

        return `${quote}${marker("secret")}${quote}`;
      });

      return `${name}[${kept}]`;
    });
  };

  const json = (value: Schema.Json, key?: string, siblings?: Schema.JsonObject): Schema.Json => {
    if (Predicate.isString(value)) {
      const named = key === undefined ? undefined : keyKind(key);

      if (named !== undefined) {
        // A scheme, such as `Basic `, is kept; the credential after it never is.
        const schemed = SCHEMED.exec(value);
        const credential = schemed?.[2] ?? value;
        const always = schemed !== null || (named !== "secret" && value.trim() !== "");

        if (!credential.startsWith(MARKER) && (always || looksSecret(value))) {
          count(named);

          return `${schemed?.[1] ?? ""}${marker(named)}`;
        }
      }

      if (key !== undefined && fileKeys.has(key) && isBase64Blob(value, 64)) {
        const kind = key === "image_url" || key === "image" ? "image" : "file";
        const format = siblings === undefined ? undefined : formatOf(siblings);
        count(kind);

        return `[${kind}: ${format === undefined ? "" : `${format}, `}${sizeOf(decodedSize(value))}]`;
      }

      return text(value);
    }

    // An array's items are its key's: each of `"api_keys": [...]` is a key.
    if (Array.isArray(value)) return value.map((item) => json(item, key, siblings));

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

  return { text, json, redactions };
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

/** `text` with every secret via has a pattern for replaced by a marker, as `redact` does. */
export const redactText = (text: string): string => redactor().text(text);

/** How many bytes `value` takes as JSON. */
const jsonSize = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value)).length;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * How many bytes `text`'s UTF-16 unit at `index` takes in JSON, as UTF-8: an escaped quote,
 * backslash or control character, or one to three bytes. A surrogate pair takes four, all
 * counted on its first half; a lone surrogate is escaped.
 */
const unitBytes = (text: string, index: number) => {
  const code = text.charCodeAt(index);

  if (code < 0x80) {
    if (code === 0x22 || code === 0x5c) return 2;

    if (code >= 0x20) return 1;

    // \b, \t, \n, \f and \r; any other control character is \u00XX.
    return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
      ? 2
      : 6;
  }

  if (code < 0x800) return 2;

  if (isHigh(code)) return isLow(text.charCodeAt(index + 1)) ? 4 : 6;

  if (isLow(code)) return isHigh(text.charCodeAt(index - 1)) ? 0 : 6;

  return 3;
};

/** How many units a block of {@link Measured.blocks} spans. */
const BLOCK = 1024;

/** A string, measured once, so how much of it any cut leaves takes no second look at it all. */
interface Measured {
  readonly text: string;
  /** Its bytes as JSON, quotes included. */
  readonly bytes: number;
  /** The bytes, as JSON, of the text before each block of {@link BLOCK} units. */
  readonly blocks: Uint32Array;
}

const measure = (text: string): Measured => {
  const blocks = new Uint32Array(Math.floor(text.length / BLOCK) + 1);
  let bytes = 0;

  for (let index = 0; index < text.length; index++) {
    if (index % BLOCK === 0) blocks[index / BLOCK] = bytes;
    bytes += unitBytes(text, index);
  }

  return { text, bytes: bytes + 2, blocks };
};

/** The bytes, as JSON, of `measured`'s first `end` units. */
const prefixBytes = (measured: Measured, end: number) => {
  const block = Math.floor(end / BLOCK);
  let bytes = measured.blocks[block] ?? 0;

  for (let index = block * BLOCK; index < end; index++) bytes += unitBytes(measured.text, index);

  return bytes;
};

/** Where a string cut to `limit` units ends: not in the middle of a character that takes two. */
const cutEnd = (text: string, limit: number) =>
  Math.max(0, /[\uD800-\uDBFF]/.test(text.charAt(limit - 1)) ? limit - 1 : limit);

/** What follows a cut string: how much went. */
const cutNote = (text: string, end: number) => `…[truncated ${text.length - end} characters]`;

/** The bytes, as JSON, of `measured` cut to `limit` units, its note included. */
const cutBytes = (measured: Measured, limit: number) => {
  if (measured.text.length <= limit) return measured.bytes;
  const end = cutEnd(measured.text, limit);

  // The note is ASCII but for its ellipsis, which takes three bytes.
  return 2 + prefixBytes(measured, end) + cutNote(measured.text, end).length + 2;
};

/** Every string in `value`, its keys' aside. */
const stringsOf = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value];

  if (Array.isArray(value)) return value.flatMap(stringsOf);

  if (isJsonObject(value)) return Object.values(value).flatMap(stringsOf);

  return [];
};

/** `value` with each string longer than `limit` characters cut to it, and a note of how much went. */
const cutTo = (value: Schema.Json, limit: number): Schema.Json => {
  if (Predicate.isString(value)) {
    if (value.length <= limit) return value;
    const end = cutEnd(value, limit);

    return `${value.slice(0, end)}${cutNote(value, end)}`;
  }

  if (Array.isArray(value)) return value.map((item) => cutTo(item, limit));

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, cutTo(inner, limit)]),
    );
  }

  return value;
};

/** JSON cut to fit, whether it had to be, and its size as JSON. */
export interface Capped {
  readonly value: Schema.Json;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}

/**
 * `value` cut to at most `maxBytes` as JSON, whether it had to be, and its size: its long
 * strings cut, the longest first, as little as needed. JSON too big even with every string
 * cut becomes only a note of its size. Each string is measured once, not again for every
 * length tried, as a failed turn's body can be megabytes.
 */
export const capped = (value: Schema.Json, maxBytes: number): Capped => {
  const size = jsonSize(value);

  if (size <= maxBytes) return { value, truncated: false, sizeBytes: size };

  const strings = stringsOf(value).map(measure);
  // What isn't a string: keys, punctuation, numbers and the like, which no cut changes.
  const rest = strings.reduce((bytes, measured) => bytes - measured.bytes, size);

  const sizeAt = (limit: number) =>
    strings.reduce((bytes, measured) => bytes + cutBytes(measured, limit), rest);

  // The longest every string can be and the JSON still fit, found by halving.
  let low = 0;
  let high = strings.reduce((most, measured) => Math.max(most, measured.text.length), 0);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (sizeAt(middle) <= maxBytes) low = middle;
    else high = middle - 1;
  }

  const cut = cutTo(value, low);
  const cutSize = jsonSize(cut);

  if (cutSize <= maxBytes) return { value: cut, truncated: true, sizeBytes: cutSize };

  const note = `[truncated: ${sizeOf(size)}]`;

  return { value: note, truncated: true, sizeBytes: note.length + 2 };
};
