# anti-slop

Vendored from https://github.com/dmmulroy/anti-slop at commit
`c44ef22ca116`: `skills/install-anti-slop/assets/anti-slop`, which is `src/`
without its tests. The tests were not vendored, here or for
`vendor/eslint-stylistic`: `bun run lint` running the rules over this
repository is the only check on them. MIT licensed; see `LICENSE`.

The rules are ours to change. Record any deviation from upstream here.

## Deviations

- `package.json`, marking the rules as ES modules so Node loads them without a warning.
- `require-safety-comment-for-type-assertion`: `if`, `for`, `for…in`, `for…of`,
  `while`, `do…while` and `switch` statements own the comment before them, and
  the walk up from an assertion stops at a block (`BlockStatement`,
  `StaticBlock`, `TSModuleBlock`). Upstream climbed past a control statement's
  header to the enclosing function, so one `// SAFETY:` above a function
  excused every assertion in its `if`/`for`/`while` headers.
- `effect/shared/tagged-values.ts`: `tagMember` replaces `isTagMember` and
  reads through optional chains, parentheses, `!`, `as`, `<T>` and
  `satisfies`, so `no-manual-tag-comparison` and `no-manual-effect-error-tag`
  report `e?._tag === "Foo"`, `e._tag! === "Foo"`,
  `(e._tag as string) === "Foo"`, `(e._tag satisfies string) === "Foo"` and
  `switch (e?._tag)`, which upstream let through.
- `no-shape-in-symbol-names`: skips the name an import reads from its module
  when the import renames it (`import { shapeFoo as foo }`; the local name is
  still checked) and JSX attribute names (Recharts' `shape` prop). Object keys
  are still checked, since most, such as a `Schema.Struct` field, are names the
  code owns; a key a library owns is written computed, `{ ["shape"]: … }`.
  A quoted key won't do: oxfmt unquotes it.

### Probe cases

With no tests vendored, these changes were checked by running the repo's
config over probe files
(`oxlint -c .oxlintrc.json <dir>`, outside the ignored `tools/` tree):

```ts
// require-safety-comment-for-type-assertion: three reports.
// SAFETY: about something else
export function outer() {
  if (check(x as string)) return 1;
  for (const k of [x as string]) void k;
  while (check(x as string)) break;
  return 0;
}

// None: each comment sits on the statement holding the assertion.
export function inner() {
  // SAFETY: x is a string here.
  if (check(x as string)) return 1;
  // SAFETY: x is a string here.
  switch (x as string) {
    case "a":
      return 2;
  }
  return 0;
}
// SAFETY: x is a string here.
export const toText = () => x as string;
// SAFETY: x is a string here.
export function withDefault(value = x as string) {
  return value;
}
```

```ts
// no-manual-tag-comparison: eight reports; no-manual-effect-error-tag: one.
export const isFoo = e?._tag === "Foo";
export const isBar = "Bar" === e?.["_tag"];
export const isBaz = e!._tag === "Baz";
export const isQux = e._tag! === "Qux";
export const isCast = (e._tag as string) === "Cast";
export const isOld = <string>e._tag === "Old";
export const isChecked = (e._tag satisfies string) === "Checked";
switch (e?._tag) {}
Effect.catch((error) => (error?.reason?._tag === "Qux" ? Effect.void : Effect.fail(error)));
```

```tsx
// no-shape-in-symbol-names: reports `shapeKept` (once, at the import),
// the `shape` key and `shapeOfThing`; not `shapeFoo`, the `shape` prop or `["shape"]`.
import { shapeFoo as renamed } from "lib";
import { shapeKept } from "lib";
export const el = <Bar shape={renamed} />;
export const opts = { shape: renamed };
export const computed = { ["shape"]: renamed };
export const shapeOfThing = 1;
```
