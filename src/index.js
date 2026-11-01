// Tili Store — Cloudflare Worker.
// Serves the site (static assets) and the API under /api/*.
// Bindings (wrangler.jsonc): ASSETS (the site), DB (D1 "tili-store").
// Secrets (Worker → Settings → Variables and Secrets): ADMIN_USER, ADMIN_PASSWORD.

const FREE_OVER = 100, FEE = 10;
const STATUSES = ["new", "confirmed", "out", "delivered", "cancelled"];
const EMIRATES = ["Dubai", "Sharjah", "Ajman", "Abu Dhabi", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const bad = (error, status = 400) => json({ ok: false, error }, status);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
// UAE mobile: keep the 9 digits after +971 / 0, starting with 5.
function cleanPhone(v) { let d = String(v || "").replace(/\D/g, ""); if (d.startsWith("971")) d = d.slice(3); if (d.startsWith("0")) d = d.slice(1); return /^5\d{8}$/.test(d) ? d : null; }
const bearer = (req, name = "Authorization") => { const v = req.headers.get(name) || ""; return v.startsWith("Bearer ") ? v.slice(7) : ""; };
async function body(req) { try { return await req.json(); } catch { return {}; } }

/* ---------- catalog (products.json + price/stock overrides) ---------- */
async function catalog(request, env) {
  const r = await env.ASSETS.fetch(new URL("/products.json", request.url));
  const list = await r.json();
  const { results } = await env.DB.prepare("SELECT id, price, off FROM catalog").all();
  const ovr = {}; results.forEach(x => { ovr[x.id] = x; });
  const byId = {};
  list.forEach(p => { const o = ovr[p.id] || {}; byId[p.id] = { ...p, price: o.price > 0 ? o.price : p.price, off: !!o.off }; });
  return { byId, ovr };
}

/* ---------- customers ---------- */
async function customer(request, env) {
  const t = bearer(request); if (!t) return null;
  return env.DB.prepare("SELECT c.id, c.name, c.phone FROM sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token = ? AND s.created_at > datetime('now','-180 days')").bind(t).first();
}
async function newSession(env, id) { const token = randHex(24); await env.DB.prepare("INSERT INTO sessions (token, customer_id) VALUES (?, ?)").bind(token, id).run(); return token; }

async function authCheck(request, env) {
  const { phone } = await body(request); const p = cleanPhone(phone);
  if (!p) return bad("Enter a valid UAE mobile number, like 050 123 4567.");
  const c = await env.DB.prepare("SELECT id FROM customers WHERE phone = ?").bind(p).first();
  return json({ ok: true, exists: !!c });
}
async function authRegister(request, env) {
  const b = await body(request); const p = cleanPhone(b.phone), name = String(b.name || "").trim().slice(0, 80), pw = String(b.password || "");
  if (!p) return bad("Enter a valid UAE mobile number.");
  if (name.length < 2) return bad("Enter your full name.");
  if (pw.length < 6) return bad("Choose a password of at least 6 characters.");
  if (await env.DB.prepare("SELECT id FROM customers WHERE phone = ?").bind(p).first()) return json({ ok: false, exists: true, error: "This number already has an account. Sign in instead." }, 409);
  const salt = randHex(16), h = await hashPassword(pw, salt);
  const r = await env.DB.prepare("INSERT INTO customers (name, phone, salt, pw) VALUES (?, ?, ?, ?)").bind(name, p, salt, h).run();
  return json({ ok: true, token: await newSession(env, r.meta.last_row_id), name, phone: p });
}
async function authLogin(request, env) {
  const b = await body(request); const p = cleanPhone(b.phone);
  const c = p && await env.DB.prepare("SELECT id, name, phone, salt, pw FROM customers WHERE phone = ?").bind(p).first();
  if (!c) return bad("No account for this number.", 404);
  if (!same(await hashPassword(String(b.password || ""), c.salt), c.pw)) return bad("That password isn't right. Try again.", 401);
  return json({ ok: true, token: await newSession(env, c.id), name: c.name, phone: c.phone });
}
async function authLogout(request, env) { const t = bearer(request); if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run(); return json({ ok: true }); }

const rowToOrder = r => ({ no: r.no, at: r.at, status: r.status, customer: { name: r.name, phone: r.phone }, address: { emirate: r.emirate, area: r.area, addr: r.addr }, note: r.note || "", items: JSON.parse(r.items || "[]"), n: r.n, sub: r.sub, fee: r.fee, total: r.total, eta: r.eta, history: JSON.parse(r.history || "[]"), adminNote: r.admin_note || "" });

async function myOrders(request, env) {
  const c = await customer(request, env); if (!c) return bad("Sign in again.", 401);
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE customer_id = ? OR phone = ? ORDER BY at DESC LIMIT 200").bind(c.id, c.phone).all();
  return json({ ok: true, orders: results.map(r => { const o = rowToOrder(r); delete o.adminNote; return o; }) });
}

async function createOrder(request, env) {
  const c = await customer(request, env); if (!c) return bad("Sign in to place your order.", 401);
  const b = await body(request);
  const area = String(b.area || "").trim().slice(0, 80), addr = String(b.addr || "").trim().slice(0, 160), note = String(b.note || "").trim().slice(0, 300);
  const name = String(b.name || c.name).trim().slice(0, 80) || c.name;
  const emirate = EMIRATES.includes(b.emirate) ? b.emirate : null;
  if (!emirate || !area || !addr) return bad("Add your emirate, area and building.");
  const { byId } = await catalog(request, env);
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 60) : []) {
    const p = byId[it.id], q = Math.max(1, Math.min(99, parseInt(it.q) || 0));
    if (!p) continue;
    if (p.off) return bad(`${p.name} is out of stock. Remove it from your bag to continue.`, 409);
    items.push({ id: p.id, q, name: p.name, brand: p.brand, size: p.size || "", price: p.price });
  }
  if (!items.length) return bad("Your bag is empty.");
  const sub = Math.round(items.reduce((s, i) => s + i.price * i.q, 0) * 100) / 100;
  const fee = sub >= FREE_OVER ? 0 : FEE, total = Math.round((sub + fee) * 100) / 100, n = items.reduce((s, i) => s + i.q, 0);
  const at = Date.now(), no = "TS-" + String(at).slice(-6) + Math.floor(Math.random() * 90 + 10);
  const eta = String(b.eta || "").slice(0, 60), history = [{ s: "new", at }];
  await env.DB.prepare("INSERT INTO orders (no, at, status, customer_id, name, phone, emirate, area, addr, note, items, n, sub, fee, total, eta, history) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(no, at, c.id, name, c.phone, emirate, area, addr, note, JSON.stringify(items), n, sub, fee, total, eta, JSON.stringify(history)).run();
  return json({ ok: true, order: { no, at, status: "new", customer: { name, phone: c.phone }, address: { emirate, area, addr }, note, items, n, sub, fee, total, eta, history } });
}

/* ---------- admin ---------- */
async function isAdmin(request, env) {
  const t = bearer(request, "X-Admin"); if (!t) return false;
  const s = await env.DB.prepare("SELECT exp FROM admin_sessions WHERE token = ?").bind(t).first();
  return !!(s && s.exp > Date.now());
}
async function adminLogin(request, env) {
  const b = await body(request);
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return bad("Admin login isn't set up yet. Add ADMIN_USER and ADMIN_PASSWORD in the Worker settings.", 503);
  await new Promise(r => setTimeout(r, 400));
  if (!same(String(b.user || "").trim().toLowerCase(), env.ADMIN_USER.trim().toLowerCase()) || !same(String(b.pass || ""), env.ADMIN_PASSWORD)) return bad("Wrong username or password.", 401);
  const token = randHex(24), exp = Date.now() + (b.remember ? 7 * 864e5 : 8 * 36e5);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE exp < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO admin_sessions (token, exp) VALUES (?, ?)").bind(token, exp).run();
  return json({ ok: true, token, exp });
}
async function adminLogout(request, env) { const t = bearer(request, "X-Admin"); if (t) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(t).run(); return json({ ok: true }); }
async function adminOrders(request, env) {
  const { results } = await env.DB.prepare("SELECT * FROM orders ORDER BY at DESC LIMIT 2000").all();
  return json({ ok: true, orders: results.map(rowToOrder) });
}
async function adminOrder(request, env) {
  const b = await body(request);
  const r = await env.DB.prepare("SELECT * FROM orders WHERE no = ?").bind(String(b.no || "")).first();
  if (!r) return bad("Order not found.", 404);
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad("Unknown status.");
    const h = JSON.parse(r.history || "[]"); h.push({ s: b.status, at: Date.now() });
    await env.DB.prepare("UPDATE orders SET status = ?, history = ? WHERE no = ?").bind(b.status, JSON.stringify(h), r.no).run();
  }
  if (b.adminNote !== undefined) await env.DB.prepare("UPDATE orders SET admin_note = ? WHERE no = ?").bind(String(b.adminNote).slice(0, 1000), r.no).run();
  const u = await env.DB.prepare("SELECT * FROM orders WHERE no = ?").bind(r.no).first();
  return json({ ok: true, order: rowToOrder(u) });
}
async function adminCatalog(request, env) {
  const b = await body(request); const p = b.p && typeof b.p === "object" ? b.p : {};
  const stmts = [env.DB.prepare("DELETE FROM catalog")];
  for (const [id, o] of Object.entries(p).slice(0, 2000)) {
    const price = typeof o.price === "number" && o.price > 0 ? Math.round(o.price * 100) / 100 : null, off = o.off ? 1 : 0;
    if (price || off) stmts.push(env.DB.prepare("INSERT INTO catalog (id, price, off) VALUES (?, ?, ?)").bind(String(id).slice(0, 40), price, off));
  }
  await env.DB.batch(stmts);
  return json({ ok: true });
}

// Store settings. Bestsellers: up to 4 product ids shown first on the home page.
async function adminSettings(request, env) {
  const b = await body(request);
  if (b.best !== undefined) {
    const { byId } = await catalog(request, env);
    const best = [...new Set(Array.isArray(b.best) ? b.best.map(String) : [])].filter(id => byId[id]);
    if (best.length > 4) return bad("Pick up to 4 bestsellers.");
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('best', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(best), Date.now()).run();
  }
  return json({ ok: true });
}

// Creates the tables on first use, so a fresh D1 database needs no manual setup.
const SCHEMA = ["CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, pw TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));", "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));", "CREATE TABLE IF NOT EXISTS orders (no TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', customer_id INTEGER, name TEXT, phone TEXT, emirate TEXT, area TEXT, addr TEXT, note TEXT, items TEXT NOT NULL, n INTEGER, sub REAL, fee REAL, total REAL, eta TEXT, history TEXT, admin_note TEXT);", 'CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);',
  'CREATE INDEX IF NOT EXISTS orders_at ON orders(at);',
  'CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, price REAL, off INTEGER DEFAULT 0);',
  'CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, exp INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);'
];
let READY = null;
const ensure = env => READY || (READY = env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { READY = null; throw e; }));

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, m = request.method;
    if (path.startsWith("/api/")) {
      try {
        await ensure(env);
        if (m === "GET" && path === "/api/catalog") {
          const { ovr } = await catalog(request, env); const p = {};
          Object.values(ovr).forEach(o => { p[o.id] = {}; if (o.price > 0) p[o.id].price = o.price; if (o.off) p[o.id].off = true; });
          const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'best'").first();
          return json({ ok: true, p, best: s ? JSON.parse(s.value) : null });
        }
        if (m === "POST" && path === "/api/auth/check") return await authCheck(request, env);
        if (m === "POST" && path === "/api/auth/register") return await authRegister(request, env);
        if (m === "POST" && path === "/api/auth/login") return await authLogin(request, env);
        if (m === "POST" && path === "/api/auth/logout") return await authLogout(request, env);
        if (m === "GET" && path === "/api/my-orders") return await myOrders(request, env);
        if (m === "POST" && path === "/api/orders") return await createOrder(request, env);
        if (m === "POST" && path === "/api/admin/login") return await adminLogin(request, env);
        if (m === "POST" && path === "/api/admin/logout") return await adminLogout(request, env);
        if (path.startsWith("/api/admin/")) {
          if (!(await isAdmin(request, env))) return bad("Sign in to the admin panel again.", 401);
          if (m === "GET" && path === "/api/admin/orders") return await adminOrders(request, env);
          if (m === "POST" && path === "/api/admin/order") return await adminOrder(request, env);
          if (m === "PUT" && path === "/api/admin/catalog") return await adminCatalog(request, env);
          if (m === "PUT" && path === "/api/admin/settings") return await adminSettings(request, env);
        }
        return bad("Not found.", 404);
      } catch (e) {
        return bad("Something went wrong. Try again.", 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
