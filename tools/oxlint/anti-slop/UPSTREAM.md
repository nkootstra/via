# anti-slop

Vendored from https://github.com/dmmulroy/anti-slop at commit
`c44ef22ca116`: `skills/install-anti-slop/assets/anti-slop`, which is `src/`
without its tests. The tests were not vendored, here or for
`vendor/eslint-stylistic`: `bun run lint` running the rules over this
repository is the only check on them. MIT licensed; see `LICENSE`.

The rules are ours to change. Record any deviation from upstream here.

## Deviations

- `package.json`, marking the rules as ES modules so Node loads them without a warning.
