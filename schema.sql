-- D1 database "tili-store". The worker also creates these tables automatically on first use.
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, pw TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS orders (no TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', customer_id INTEGER, name TEXT, phone TEXT, emirate TEXT, area TEXT, addr TEXT, note TEXT, items TEXT NOT NULL, n INTEGER, sub REAL, fee REAL, total REAL, eta TEXT, history TEXT, admin_note TEXT);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS orders_at ON orders(at);
CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, price REAL, off INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
