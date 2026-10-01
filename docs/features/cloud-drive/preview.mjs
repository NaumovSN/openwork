import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["/", ["prototype.html", "text/html; charset=utf-8"]],
  ["/prototype.html", ["prototype.html", "text/html; charset=utf-8"]],
  ["/model.mjs", ["model.mjs", "text/javascript; charset=utf-8"]],
]);
const server = createServer(async (request, response) => {
  const asset = assets.get(request.url?.split("?")[0]);
  if (!asset || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const bytes = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": asset[1], "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(500).end("Preview file unavailable");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`Cloud Drive concept: http://127.0.0.1:${address.port}`);
});
