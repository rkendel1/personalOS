# Vendored: Boundry design foundation (@stack-ui 0.8.1)

The shared design foundation (`rkendel1/stack-ui`), vendored because the packages are not on npm
(stack-ui `docs/decisions.md` D9). Each directory is an unpacked release package (`pnpm pack` of
`packages/<name>`), unmodified. `SHA256SUMS` covers every file and equals stack-ui
`releases/0.8.1/packages.SHA256SUMS`. `tests/design-foundation.test.ts` checks it.

0.8.0 added the Shell's opt-in narrow menu (rkendel1/stack-ui#21, #22), which PersonalOS uses on phones
and in the extension's side panel. 0.8.1 is the same code under the MIT license (stack-ui D38,
rkendel1/stack-ui#23). Each package carries its `LICENSE`.

To upgrade: in stack-ui at the release tag, run `pnpm build`. Then run
`node <stack-ui>/scripts/vendor-packages.mjs vendor/stack-ui` here and `npm install`, and update
the version in the test.

PersonalOS uses the tokens, `core.css` and the React `Shell`. It is not a Boundry portfolio product and
passes no `product.id`. Joining the portfolio is a product decision, not something adoption requires.
