import { Option, Schema } from "effect";

type Headers = Readonly<Record<string, string | undefined>>;

/** A client's name as the usage history keeps it: printable, and short enough to show. */
const Name = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{1,64}$/));

const asName = Schema.decodeOption(Name);

/** A User-Agent's first product, with every `/` segment, as `opencode/latest/2.0.32/cli`. */
const PRODUCT = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*/;

/** A segment that reads as a version, as `2.0.32` or `2.1.0-beta.3`. */
const VERSION = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.+-]*)?$/;

/**
 * The harness and its version from a product: its name and the first segment
 * that reads as a version (`opencode/latest/2.0.32/cli` → `opencode/2.0.32`),
 * else the segment after the name (`OpenAI/JS`).
 */
const nameAndVersion = (product: string) => {
  const [name = product, ...rest] = product.split("/");
  const version = rest.find((segment) => VERSION.test(segment)) ?? rest[0];

  return version === undefined ? name : `${name}/${version}`;
};

/** The User-Agent of OpenAI's own SDK, which harnesses built on it, such as Roo Code, send. */
const SDK = /^OpenAI\//;

const productOf = (userAgent: string | undefined) =>
  Option.fromNullishOr(userAgent).pipe(
    Option.flatMap((agent) => Option.fromNullishOr(PRODUCT.exec(agent.trim())?.[0])),
    Option.map(nameAndVersion),
    Option.flatMap(asName),
  );

/**
 * The harness a request comes from, with its version when it says: the first
 * product of its User-Agent and the version among its segments, as
 * `codex_cli_rs/0.40.0`, unless that names OpenAI's SDK and the harness names
 * itself in `x-title` (as Roo Code and Kilo Code do) or `originator` (as Codex
 * does).
 */
export const clientOf = (headers: Headers): Option.Option<string> => {
  const product = productOf(headers["user-agent"]);

  const own = Option.firstSomeOf(
    [headers["x-title"], headers["originator"]].map((value) =>
      Option.flatMap(Option.fromNullishOr(value?.trim()), asName),
    ),
  );

  return Option.isSome(product) && !SDK.test(product.value)
    ? product
    : Option.orElse(own, () => product);
};
