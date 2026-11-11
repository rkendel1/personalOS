# Vendored: Boundry design foundation (stack-ui)

The shared design foundation (`rkendel1/stack-ui`), vendored because the packages are not
on npm (stack-ui `docs/decisions.md` D9). Each directory is an unpacked package
(`pnpm pack` of `packages/<name>`), unmodified; `SHA256SUMS` covers every file.

**Source: stack-ui main at a28f999 (rkendel1/stack-ui#21 merged: the Shell's opt-in narrow menu),
which is not yet released.** The package versions still read 0.7.0, but this is not 0.7.0's
content. Replace it with the released version (all three packages bumped together) before
this is merged.

To upgrade: `node <stack-ui>/scripts/vendor-packages.mjs vendor/stack-ui` from this
directory (after `pnpm build` in stack-ui), then `npm install`.

PersonalOS uses the tokens, `core.css` and the React `Shell`. It is not a Boundry portfolio
product and does not pass a `product.id`. Joining the portfolio is a product decision, not
something adoption requires.
