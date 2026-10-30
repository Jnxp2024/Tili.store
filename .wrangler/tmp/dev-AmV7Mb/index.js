var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var FREE_OVER = 100;
var FEE = 10;
var STATUSES = ["new", "confirmed", "out", "delivered", "cancelled"];
var EMIRATES = ["Dubai", "Sharjah", "Ajman", "Abu Dhabi", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }), "json");
var bad = /* @__PURE__ */ __name((error, status = 400) => json({ ok: false, error }, status), "bad");
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var randHex = /* @__PURE__ */ __name((n) => hex(crypto.getRandomValues(new Uint8Array(n))), "randHex");
function same(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
__name(same, "same");
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1e5 }, key, 256));
}
__name(hashPassword, "hashPassword");
function cleanPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("971")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? d : null;
}
__name(cleanPhone, "cleanPhone");
var bearer = /* @__PURE__ */ __name((req, name = "Authorization") => {
  const v = req.headers.get(name) || "";
  return v.startsWith("Bearer ") ? v.slice(7) : "";
}, "bearer");
async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
__name(body, "body");
async function catalog(request, env) {
  const r = await env.ASSETS.fetch(new URL("/products.json", request.url));
  const list = await r.json();
  const { results } = await env.DB.prepare("SELECT id, price, off FROM catalog").all();
  const ovr = {};
  results.forEach((x) => {
    ovr[x.id] = x;
  });
  const byId = {};
  list.forEach((p) => {
    const o = ovr[p.id] || {};
    byId[p.id] = { ...p, price: o.price > 0 ? o.price : p.price, off: !!o.off };
  });
  return { byId, ovr };
}
__name(catalog, "catalog");
async function customer(request, env) {
  const t = bearer(request);
  if (!t) return null;
  return env.DB.prepare("SELECT c.id, c.name, c.phone FROM sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token = ? AND s.created_at > datetime('now','-180 days')").bind(t).first();
}
__name(customer, "customer");
async function newSession(env, id) {
  const token = randHex(24);
  await env.DB.prepare("INSERT INTO sessions (token, customer_id) VALUES (?, ?)").bind(token, id).run();
  return token;
}
__name(newSession, "newSession");
async function authCheck(request, env) {
  const { phone } = await body(request);
  const p = cleanPhone(phone);
  if (!p) return bad("Enter a valid UAE mobile number, like 050 123 4567.");
  const c = await env.DB.prepare("SELECT id FROM customers WHERE phone = ?").bind(p).first();
  return json({ ok: true, exists: !!c });
}
__name(authCheck, "authCheck");
async function authRegister(request, env) {
  const b = await body(request);
  const p = cleanPhone(b.phone), name = String(b.name || "").trim().slice(0, 80), pw = String(b.password || "");
  if (!p) return bad("Enter a valid UAE mobile number.");
  if (name.length < 2) return bad("Enter your full name.");
  if (pw.length < 6) return bad("Choose a password of at least 6 characters.");
  if (await env.DB.prepare("SELECT id FROM customers WHERE phone = ?").bind(p).first()) return json({ ok: false, exists: true, error: "This number already has an account. Sign in instead." }, 409);
  const salt = randHex(16), h = await hashPassword(pw, salt);
  const r = await env.DB.prepare("INSERT INTO customers (name, phone, salt, pw) VALUES (?, ?, ?, ?)").bind(name, p, salt, h).run();
  return json({ ok: true, token: await newSession(env, r.meta.last_row_id), name, phone: p });
}
__name(authRegister, "authRegister");
async function authLogin(request, env) {
  const b = await body(request);
  const p = cleanPhone(b.phone);
  const c = p && await env.DB.prepare("SELECT id, name, phone, salt, pw FROM customers WHERE phone = ?").bind(p).first();
  if (!c) return bad("No account for this number.", 404);
  if (!same(await hashPassword(String(b.password || ""), c.salt), c.pw)) return bad("That password isn't right. Try again.", 401);
  return json({ ok: true, token: await newSession(env, c.id), name: c.name, phone: c.phone });
}
__name(authLogin, "authLogin");
async function authLogout(request, env) {
  const t = bearer(request);
  if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
  return json({ ok: true });
}
__name(authLogout, "authLogout");
var rowToOrder = /* @__PURE__ */ __name((r) => ({ no: r.no, at: r.at, status: r.status, customer: { name: r.name, phone: r.phone }, address: { emirate: r.emirate, area: r.area, addr: r.addr }, note: r.note || "", items: JSON.parse(r.items || "[]"), n: r.n, sub: r.sub, fee: r.fee, total: r.total, eta: r.eta, history: JSON.parse(r.history || "[]"), adminNote: r.admin_note || "" }), "rowToOrder");
async function myOrders(request, env) {
  const c = await customer(request, env);
  if (!c) return bad("Sign in again.", 401);
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE customer_id = ? OR phone = ? ORDER BY at DESC LIMIT 200").bind(c.id, c.phone).all();
  return json({ ok: true, orders: results.map((r) => {
    const o = rowToOrder(r);
    delete o.adminNote;
    return o;
  }) });
}
__name(myOrders, "myOrders");
async function createOrder(request, env) {
  const c = await customer(request, env);
  if (!c) return bad("Sign in to place your order.", 401);
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
  await env.DB.prepare("INSERT INTO orders (no, at, status, customer_id, name, phone, emirate, area, addr, note, items, n, sub, fee, total, eta, history) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(no, at, c.id, name, c.phone, emirate, area, addr, note, JSON.stringify(items), n, sub, fee, total, eta, JSON.stringify(history)).run();
  return json({ ok: true, order: { no, at, status: "new", customer: { name, phone: c.phone }, address: { emirate, area, addr }, note, items, n, sub, fee, total, eta, history } });
}
__name(createOrder, "createOrder");
async function isAdmin(request, env) {
  const t = bearer(request, "X-Admin");
  if (!t) return false;
  const s = await env.DB.prepare("SELECT exp FROM admin_sessions WHERE token = ?").bind(t).first();
  return !!(s && s.exp > Date.now());
}
__name(isAdmin, "isAdmin");
async function adminLogin(request, env) {
  const b = await body(request);
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return bad("Admin login isn't set up yet. Add ADMIN_USER and ADMIN_PASSWORD in the Worker settings.", 503);
  await new Promise((r) => setTimeout(r, 400));
  if (!same(String(b.user || "").trim().toLowerCase(), env.ADMIN_USER.trim().toLowerCase()) || !same(String(b.pass || ""), env.ADMIN_PASSWORD)) return bad("Wrong username or password.", 401);
  const token = randHex(24), exp = Date.now() + (b.remember ? 7 * 864e5 : 8 * 36e5);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE exp < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO admin_sessions (token, exp) VALUES (?, ?)").bind(token, exp).run();
  return json({ ok: true, token, exp });
}
__name(adminLogin, "adminLogin");
async function adminLogout(request, env) {
  const t = bearer(request, "X-Admin");
  if (t) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(t).run();
  return json({ ok: true });
}
__name(adminLogout, "adminLogout");
async function adminOrders(request, env) {
  const { results } = await env.DB.prepare("SELECT * FROM orders ORDER BY at DESC LIMIT 2000").all();
  return json({ ok: true, orders: results.map(rowToOrder) });
}
__name(adminOrders, "adminOrders");
async function adminOrder(request, env) {
  const b = await body(request);
  const r = await env.DB.prepare("SELECT * FROM orders WHERE no = ?").bind(String(b.no || "")).first();
  if (!r) return bad("Order not found.", 404);
  if (b.status !== void 0) {
    if (!STATUSES.includes(b.status)) return bad("Unknown status.");
    const h = JSON.parse(r.history || "[]");
    h.push({ s: b.status, at: Date.now() });
    await env.DB.prepare("UPDATE orders SET status = ?, history = ? WHERE no = ?").bind(b.status, JSON.stringify(h), r.no).run();
  }
  if (b.adminNote !== void 0) await env.DB.prepare("UPDATE orders SET admin_note = ? WHERE no = ?").bind(String(b.adminNote).slice(0, 1e3), r.no).run();
  const u = await env.DB.prepare("SELECT * FROM orders WHERE no = ?").bind(r.no).first();
  return json({ ok: true, order: rowToOrder(u) });
}
__name(adminOrder, "adminOrder");
async function adminCatalog(request, env) {
  const b = await body(request);
  const p = b.p && typeof b.p === "object" ? b.p : {};
  const stmts = [env.DB.prepare("DELETE FROM catalog")];
  for (const [id, o] of Object.entries(p).slice(0, 2e3)) {
    const price = typeof o.price === "number" && o.price > 0 ? Math.round(o.price * 100) / 100 : null, off = o.off ? 1 : 0;
    if (price || off) stmts.push(env.DB.prepare("INSERT INTO catalog (id, price, off) VALUES (?, ?, ?)").bind(String(id).slice(0, 40), price, off));
  }
  await env.DB.batch(stmts);
  return json({ ok: true });
}
__name(adminCatalog, "adminCatalog");
async function adminSettings(request, env) {
  const b = await body(request);
  if (b.best !== void 0) {
    const { byId } = await catalog(request, env);
    const best = [...new Set(Array.isArray(b.best) ? b.best.map(String) : [])].filter((id) => byId[id]);
    if (best.length > 4) return bad("Pick up to 4 bestsellers.");
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('best', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(best), Date.now()).run();
  }
  return json({ ok: true });
}
__name(adminSettings, "adminSettings");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, m = request.method;
    if (path.startsWith("/api/")) {
      try {
        if (m === "GET" && path === "/api/catalog") {
          const { ovr } = await catalog(request, env);
          const p = {};
          Object.values(ovr).forEach((o) => {
            p[o.id] = {};
            if (o.price > 0) p[o.id].price = o.price;
            if (o.off) p[o.id].off = true;
          });
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
          if (!await isAdmin(request, env)) return bad("Sign in to the admin panel again.", 401);
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

// ../../../tmp/claude-0/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../tmp/claude-0/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body2 = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body2);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body2, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-PHhk7Y/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../tmp/claude-0/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-PHhk7Y/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
