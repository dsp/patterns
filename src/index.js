// Communal pixel mosaic on Cloudflare Workers + a single SQLite-backed
// Durable Object. The DO is the source of truth for every claimed cell.

// NOTE: GW/GH must match the same constants in public/index.html.
const GW = 320; // grid width  (16:9 -> fills a widescreen viewport)
const GH = 180; // grid height
const CELLS = GW * GH; // 57,600 (8px cells on a 2560x1440 display)

// Binary delta wire format (must match the decoder in public/index.html):
const HEADER = 8; // [ver: uint32][count: uint32]
const REC = 7; //    per cell: [idx: uint32][r,g,b: uint8]

// Per-IP rate limit on /api/pick: at most RATE_MAX picks per RATE_WINDOW ms.
const RATE_MAX = 8;
const RATE_WINDOW = 10_000;

// ---------------------------------------------------------------------------
// Worker: serves the API. Static assets (index.html) are served automatically
// by the assets binding for any path we don't handle here.
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Not an API route -> let the static asset handler take it.
      return new Response("Not found", { status: 404 });
    }

    const stub = env.CANVAS.get(env.CANVAS.idFromName("global-v3"));
    const forward = () => {
      // Forward to the DO, tagging picks with the caller's country + IP (from CF).
      const headers = new Headers(request.headers);
      headers.set("x-cc", (request.cf && request.cf.country) || "XX");
      headers.set("x-ip", request.headers.get("cf-connecting-ip") || "anon");
      return stub.fetch(
        new Request(url.toString(), {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
        }),
      );
    };

    // Edge-cache deltas keyed by ?v= so all clients at the same version share a
    // single DO computation (~1 origin hit per version instead of one per poll).
    if (url.pathname === "/api/delta" && request.method === "GET") {
      const cache = caches.default;
      const key = new Request(url.toString());
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await forward();
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "public, max-age=2");
      ctx.waitUntil(cache.put(key, out.clone()));
      return out;
    }

    return forward();
  },
};

// ---------------------------------------------------------------------------
// Durable Object: the canvas.
//   cells(idx, r, g, b, cc, ver, ts) -> one row per *claimed* cell
// Unclaimed cells are never stored; the client renders them as gray.
// The global version counter is derived from MAX(ver) on cold start.
// ---------------------------------------------------------------------------
export class Canvas {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS cells(
         idx INTEGER PRIMARY KEY,
         r INTEGER NOT NULL, g INTEGER NOT NULL, b INTEGER NOT NULL,
         cc TEXT NOT NULL, ver INTEGER NOT NULL,
         ts INTEGER NOT NULL
       )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS cells_ver ON cells(ver)`);
    // ver is monotonic and every claimed cell is stamped with it, so the live
    // counter is exactly MAX(ver) (0 when empty). No separate meta row needed.
    const row = [...this.sql.exec(`SELECT COALESCE(MAX(ver), 0) AS v FROM cells`)];
    this.ver = row[0].v;
    // In-memory sliding window of recent pick times per IP (best-effort; resets
    // if the DO is evicted, which is fine for rate limiting).
    this.hits = new Map();
  }

  // Returns true if `ip` is within its pick budget, recording the attempt.
  allowPick(ip) {
    const now = Date.now();
    const recent = (this.hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
    if (recent.length >= RATE_MAX) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/delta" && request.method === "GET") {
        const v = Number(url.searchParams.get("v"));
        return this.delta(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
      }
      if (url.pathname === "/api/cell" && request.method === "GET") {
        return this.cell(Number(url.searchParams.get("i")));
      }
      if (url.pathname === "/api/pick" && request.method === "POST") {
        if (!this.allowPick(request.headers.get("x-ip") || "anon")) {
          return new Response("Slow down — too many picks.", { status: 429 });
        }
        return this.pick(await request.json(), request.headers.get("x-cc") || "XX");
      }
    } catch (err) {
      console.error(err);
      return json({ error: "bad request" }, 400);
    }
    return new Response("Not found", { status: 404 });
  }

  // Binary stream of every cell changed since version `v`.
  delta(v) {
    const rows = [
      ...this.sql.exec(`SELECT idx, r, g, b FROM cells WHERE ver > ?`, v),
    ];
    const buf = new ArrayBuffer(HEADER + rows.length * REC);
    const dv = new DataView(buf);
    dv.setUint32(0, this.ver);
    dv.setUint32(4, rows.length);
    let o = HEADER;
    for (const c of rows) {
      dv.setUint32(o, c.idx);
      dv.setUint8(o + 4, c.r);
      dv.setUint8(o + 5, c.g);
      dv.setUint8(o + 6, c.b);
      o += REC;
    }
    return new Response(buf, {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
  }

  // Country + creation time of a single claimed cell (for the hover tooltip).
  cell(i) {
    if (!Number.isInteger(i) || i < 0 || i >= CELLS) {
      return json({ cc: null, ts: null });
    }
    const row = [...this.sql.exec(`SELECT cc, ts FROM cells WHERE idx = ?`, i)];
    return json(row.length ? { cc: row[0].cc, ts: row[0].ts } : { cc: null, ts: null });
  }

  // Claim a random cell with the chosen color + caller's country.
  pick(body, cc) {
    const rgb = parseColor(body && body.color);
    if (!rgb) return json({ error: "bad color" }, 400);
    const idx = Math.floor(Math.random() * CELLS);
    this.ver += 1;
    const ts = Date.now();
    const [r, g, b] = rgb;
    this.sql.exec(
      `INSERT INTO cells(idx, r, g, b, cc, ver, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idx) DO UPDATE SET
         r = excluded.r, g = excluded.g, b = excluded.b,
         cc = excluded.cc, ver = excluded.ver, ts = excluded.ts`,
      idx, r, g, b, cc, this.ver, ts,
    );
    return json({ idx, r, g, b, cc, ts, ver: this.ver });
  }
}

function parseColor(s) {
  if (typeof s !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
