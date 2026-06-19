// Communal pixel mosaic on Cloudflare Workers + a single SQLite-backed
// Durable Object. The DO is the source of truth for every claimed cell.

const GW = 320; // grid width  (16:9 -> fills a widescreen viewport)
const GH = 180; // grid height
const CELLS = GW * GH; // 57,600 (8px cells on a 2560x1440 display)

// ---------------------------------------------------------------------------
// Worker: serves the API. Static assets (index.html) are served automatically
// by the assets binding for any path we don't handle here.
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Not an API route -> let the static asset handler take it.
      return new Response("Not found", { status: 404 });
    }

    const stub = env.CANVAS.get(env.CANVAS.idFromName("global"));

    // Forward to the DO, tagging picks with the caller's country (from CF).
    const headers = new Headers(request.headers);
    headers.set("x-cc", (request.cf && request.cf.country) || "XX");
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
  },
};

// ---------------------------------------------------------------------------
// Durable Object: the canvas.
//   meta(k, v)                       -> stores the global version counter
//   cells(idx, r, g, b, cc, ver)     -> one row per *claimed* cell
// Unclaimed cells are never stored; the client renders them as gray.
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER)`);
    const row = [...this.sql.exec(`SELECT v FROM meta WHERE k = 'ver'`)];
    this.ver = row.length ? row[0].v : 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/delta" && request.method === "GET") {
        return this.delta(Number(url.searchParams.get("v")) || 0);
      }
      if (url.pathname === "/api/cell" && request.method === "GET") {
        return this.cell(Number(url.searchParams.get("i")));
      }
      if (url.pathname === "/api/pick" && request.method === "POST") {
        return this.pick(await request.json(), request.headers.get("x-cc") || "XX");
      }
    } catch (err) {
      return json({ error: String(err) }, 400);
    }
    return new Response("Not found", { status: 404 });
  }

  // Binary stream of every cell changed since version `v`.
  // Layout: [ver: uint32][ count: uint32 ] then count * { idx:uint32, r,g,b:uint8 }
  delta(v) {
    const rows = [
      ...this.sql.exec(
        `SELECT idx, r, g, b FROM cells WHERE ver > ? ORDER BY ver`,
        v,
      ),
    ];
    const buf = new ArrayBuffer(8 + rows.length * 7);
    const dv = new DataView(buf);
    dv.setUint32(0, this.ver);
    dv.setUint32(4, rows.length);
    let o = 8;
    for (const c of rows) {
      dv.setUint32(o, c.idx);
      dv.setUint8(o + 4, c.r);
      dv.setUint8(o + 5, c.g);
      dv.setUint8(o + 6, c.b);
      o += 7;
    }
    return new Response(buf, {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
  }

  // Country + creation time of a single claimed cell (for the hover tooltip).
  cell(i) {
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
       ON CONFLICT(idx) DO UPDATE SET r = ?, g = ?, b = ?, cc = ?, ver = ?, ts = ?`,
      idx, r, g, b, cc, this.ver, ts,
      r, g, b, cc, this.ver, ts,
    );
    this.sql.exec(
      `INSERT INTO meta(k, v) VALUES ('ver', ?) ON CONFLICT(k) DO UPDATE SET v = ?`,
      this.ver, this.ver,
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
