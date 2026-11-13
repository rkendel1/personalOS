/**
 * The extension authenticates with its own bearer token and nothing else. Chrome attaches the browser's
 * cookies for a host the extension has permission for, so a person who is also signed in to the web app
 * would otherwise reach the server with an ambient session cookie from the extension's origin, which the
 * server's CSRF check refuses ("Cross-site request refused") before the panel has a token of its own.
 * Every request the extension makes therefore omits cookies.
 */
export const fetchWithoutCookies: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "omit" });
