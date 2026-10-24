// Password-protected static server for the built app (dist/), for hosting as a
// Render Web Service. Node built-ins only. Every request needs HTTP Basic auth
// with SITE_PASSWORD (any username); /health stays open for Render's checks.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";

const PASSWORD = process.env.SITE_PASSWORD;
const PORT = Number(process.env.PORT ?? 10000);
const ROOT = resolve(import.meta.dirname, "dist");

if (!PASSWORD) {
  console.error("SITE_PASSWORD is not set — refusing to serve the table unprotected.");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

// compare digests so the check takes the same time whatever the guess
const digest = (s) => createHash("sha256").update(s).digest();
const expected = digest(PASSWORD);

function authorised(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(digest(password), expected);
}

createServer((req, res) => {
  // a throw from serve() must not become an unhandled rejection: that ends the process
  serve(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" });
    res.end();
  });
}).listen(PORT, () => console.log(`table on :${PORT}`));

async function serve(req, res) {
  // `//x` or a malformed %-escape makes these throw
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (!authorised(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="Blackjack prototype", charset="UTF-8"' }).end("Password required");
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(ROOT, rel || "index.html");
  if (!file.startsWith(ROOT)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, "index.html") : file;
    const size = info.isDirectory() ? (await stat(target)).size : info.size;
    const hashed = rel.startsWith("assets/");
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": size,
      // Vite's hashed bundles never change; footage and manifest may on redeploy
      "cache-control": hashed ? "private, max-age=31536000, immutable" : "private, max-age=3600",
    });
    if (req.method === "HEAD") return res.end();
    // the file can vanish between stat and read during a redeploy: fail this response, not the server
    createReadStream(target).on("error", () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}
