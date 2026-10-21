import { Option, Schema } from "effect";

type Headers = Readonly<Record<string, string | undefined>>;

/** A client's name as the usage history keeps it: printable, and short enough to show. */
const Name = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{1,64}$/));

const asName = Schema.decodeOption(Name);

/** A User-Agent's first product, as `opencode/1.19.3`: the harness and its version. */
const PRODUCT = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)?/;

/** The User-Agent of OpenAI's own SDK, which harnesses built on it, such as Roo Code, send. */
const SDK = /^OpenAI\//;

const productOf = (userAgent: string | undefined) =>
  Option.fromNullishOr(userAgent).pipe(
    Option.flatMap((agent) => Option.fromNullishOr(PRODUCT.exec(agent.trim())?.[0])),
    Option.flatMap(asName),
  );

/**
 * The harness a request comes from, with its version when it says: the first
 * product of its User-Agent, as `codex_cli_rs/0.40.0`, unless that names OpenAI's
 * SDK and the harness names itself in `x-title` (as Roo Code and Kilo Code do) or
 * `originator` (as Codex does).
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
