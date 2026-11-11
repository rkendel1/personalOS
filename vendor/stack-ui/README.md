# Vendored: Boundry design foundation (@stack-ui 0.8.0)

The shared design foundation (`rkendel1/stack-ui`), vendored because the packages are not on npm
(stack-ui `docs/decisions.md` D9). Each directory is an unpacked release package (`pnpm pack` of
`packages/<name>`), unmodified. `SHA256SUMS` covers every file and equals stack-ui
`releases/0.8.0/packages.SHA256SUMS`. `tests/design-foundation.test.ts` checks it.

0.8.0 is the release with the Shell's opt-in narrow menu (rkendel1/stack-ui#21, released in
rkendel1/stack-ui#22), which PersonalOS uses on phones and in the extension's side panel.

To upgrade: in stack-ui at the release tag, run `pnpm build`. Then run
`node <stack-ui>/scripts/vendor-packages.mjs vendor/stack-ui` here and `npm install`, and update
the version in the test.

PersonalOS uses the tokens, `core.css` and the React `Shell`. It is not a Boundry portfolio product and
passes no `product.id`. Joining the portfolio is a product decision, not something adoption requires.
