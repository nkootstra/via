import { Effect, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { describe, expect, it } from "vitest";
import { maskAddress, maskEmails, maskKeyTail } from "../src/lib/mask.ts";

/** Whether `property` holds for every value `arbitrary` makes, else why not. */
const holds = <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => boolean) =>
  Effect.runPromise(
    Effect.map(Arbitrary.checkEffect(arbitrary, property), Arbitrary.formatCheckFailure),
  );

/** An email's local part, such as `niels.kootstra`, and a domain label, such as `gmail`. */
const Local = Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}(\.[a-z0-9]{1,8})?$/));

const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,12}$/));

describe("maskEmails", () => {
  it("hides each email in a text, keeping only its top-level domain", () => {
    expect(maskEmails("niels.kootstra@gmail.com")).toBe("•••••@•••••.com");
    expect(maskEmails("Sign in again to me@work.example and you@home.nl.")).toBe(
      "Sign in again to •••••@•••••.example and •••••@•••••.nl.",
    );
  });

  it("leaves a text without an email as it is", () => {
    expect(maskEmails("work")).toBe("work");
    expect(maskEmails("OpenCode Go …1234")).toBe("OpenCode Go …1234");
  });

  it("leaves what only looks like an email, with a one-letter ending, as it is", () => {
    expect(maskEmails("\u0000\u0000@\u0000\u0000.C and me@work.com")).toBe(
      "\u0000\u0000@\u0000\u0000.C and •••••@•••••.com",
    );
  });

  it("leaves no email behind, and hides one hidden already as it is", async () => {
    // The text around may hold something email-shaped too, such as `a@b.C`, which isn't an
    // email maskEmails knows; so the email looked for is the one put in.
    const texts = Arbitrary.map(
      Arbitrary.all([
        Arbitrary.schema(Schema.String),
        Arbitrary.schema(Local),
        Arbitrary.schema(Label),
      ]),
      ([around, local, domain]) => ({
        email: `${local}@${domain}.com`,
        text: `${around} ${local}@${domain}.com ${around}`,
      }),
    );

    expect(
      await holds(
        texts,
        ({ email, text }) =>
          !maskEmails(text).includes(email) && maskEmails(maskEmails(text)) === maskEmails(text),
      ),
    ).toBeUndefined();
  });
});

describe("maskKeyTail", () => {
  it("hides a key's last four characters", () => {
    expect(maskKeyTail("…1234")).toBe("…••••");
    expect(maskKeyTail("OpenCode Go …abcd")).toBe("OpenCode Go …••••");
  });
});

describe("maskAddress", () => {
  it("hides an address's host, keeping its scheme, dots and port", () => {
    expect(maskAddress("http://192.168.1.20:11434")).toBe("http://•••.•••.•.••:11434");
    expect(maskAddress("http://host.docker.internal:11434")).toBe(
      "http://••••.••••••.••••••••:11434",
    );
    expect(maskAddress("https://ollama.example.com")).toBe("https://••••••.•••••••.•••");
  });
});
