/**
 * The page reader (feltkit/_pages.ts) against a real HTTP server on loopback: what happens to a page
 * is always one of read, unavailable, extraction-failed or not-allowed, with the reason. Loopback is
 * private, so the test names it as the one host the reader may read (PERSONALOS_PAGE_READER_ALLOW_HOSTS,
 * never honoured in production); every other private address stays refused.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { htmlText, quoted, readPage } from "../feltkit/_pages.js";

let server: Server;
let base = "";
const LONG = "Acme Ops builds internal tools for operations teams across North America. ".repeat(4);

before(async () => {
  process.env.PERSONALOS_PAGE_READER_ALLOW_HOSTS = "127.0.0.1";
  server = createServer((req, res) => {
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    switch (req.url) {
      case "/robots.txt": return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /\n");
      case "/": return html(`<html><head><title>Acme &amp; Co</title><meta name="description" content="Tools for ops teams."><script>var x = "not text";</script><style>p{}</style></head><body><nav>Home</nav><p>${LONG}</p><p>We are hiring TypeScript&nbsp;engineers.</p></body></html>`);
      case "/missing": return res.writeHead(404, { "content-type": "text/html" }).end("<p>not found</p>");
      case "/spa": return html(`<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
      case "/pdf": return res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
      case "/private/page": return html(`<p>${LONG}</p>`);
      case "/private/ok": return html(`<p>${LONG}</p>`);
      case "/to-local": return res.writeHead(302, { location: "http://localhost/admin" }).end();
      case "/to-home": return res.writeHead(301, { location: "/" }).end();
      default: return res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { delete process.env.PERSONALOS_PAGE_READER_ALLOW_HOSTS; server.closeAllConnections(); await new Promise((r) => server.close(r)); });

test("a page is read: its title, description and text, without scripts or styles", async () => {
  const p = await readPage(`${base}/`);
  assert.deepEqual([p.status, p.httpStatus, p.title], ["read", 200, "Acme & Co"]);
  assert.match(p.text, /^Tools for ops teams\./);
  assert.match(p.text, /We are hiring TypeScript engineers\./);
  assert.doesNotMatch(p.text, /not text|p\{\}/);
  const redirected = await readPage(`${base}/to-home`);
  assert.deepEqual([redirected.status, redirected.finalUrl], ["read", `${base}/`], "redirects are followed, and where it ended up is recorded");
});

test("each failure says what happened, and none is treated as a page that says something", async () => {
  const missing = await readPage(`${base}/missing`);
  assert.deepEqual([missing.status, missing.httpStatus, missing.text], ["unavailable", 404, ""]);
  const spa = await readPage(`${base}/spa`);
  assert.equal(spa.status, "extraction-failed");
  assert.match(spa.detail, /rendered by scripts/);
  const pdf = await readPage(`${base}/pdf`);
  assert.deepEqual([pdf.status, pdf.detail], ["extraction-failed", "not a web page (application/pdf)"]);
  const robots = await readPage(`${base}/private/page`);
  assert.deepEqual([robots.status, robots.detail], ["not-allowed", "its robots.txt asks automated readers not to read this page"]);
  assert.equal((await readPage(`${base}/private/ok`)).status, "read", "a more specific Allow wins");
  const local = await readPage(`${base}/to-local`);
  assert.deepEqual([local.status, local.detail], ["not-allowed", "localhost is a local name"], "a redirect to a local address is refused before it is fetched");
  for (const url of ["http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "http://user:pw@example.com/"]) {
    assert.equal((await readPage(url)).status, "not-allowed", url);
  }
  const down = await readPage("http://127.0.0.1:1/");
  assert.equal(down.status, "unavailable");
});

test("a quote counts only if it is in the page's text, ignoring spacing, case and typographic quotes", () => {
  const { text } = htmlText(`<p>We’re hiring  TypeScript\nengineers — now.</p>`);
  assert.ok(quoted("we're hiring TypeScript engineers - now.", text));
  assert.ok(!quoted("We're hiring Rust engineers", text));
  assert.ok(!quoted("hiring", text), "too short to be a quote");
});
