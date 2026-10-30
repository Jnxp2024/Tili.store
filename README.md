# Tili Store — store.tili.ae

Online store for Tili Star Trading's own range (Küche Dubai Chocolate, Alien's Sour, Takis, Warheads and more).
Cash on delivery, delivered within one day across the UAE.

Static site + a Cloudflare Worker (`src/index.js`) for the API, with orders and accounts in D1.
Every push to `main` deploys automatically (Workers Builds).

- `index.html` — the whole store: home, category and brand pages, product pages, bag, checkout, account. Pages are routed by `#hash`.
- `index.html#admin` — admin panel (dashboard, orders, customers, products). Not linked anywhere on the store.
- `products.json` — every product: barcode `id`, brand, name, size, category, selling `price` (MSL price + 30%), `img`.
  The same list is embedded in `index.html`; the Worker reads `products.json` to price orders.
- `img/` — product photos (white background, 640 px webp), named by Drive file id.
- `src/index.js` — API: customer sign-up/sign-in by mobile number, orders, admin login, order status, price/stock overrides.
- `schema.sql` — D1 tables (already applied to the `tili-store` database).

## Admin login

Set these in Cloudflare → Workers → **tili-store** → Settings → Variables and Secrets (type: Secret):

- `ADMIN_USER` — the admin username
- `ADMIN_PASSWORD` — the admin password

Then open `/#admin`. Change either secret any time to change the login.

## Bestsellers

Admin → Settings: pick up to 4 products for the Bestsellers row and tag (stored in D1, `settings` table).

## Prices and stock

Change prices or switch products out of stock from Admin → Products. Overrides are stored in D1 (`catalog` table)
and apply to the store and to new orders straight away. Delivery is free from AED 100, otherwise AED 10.
