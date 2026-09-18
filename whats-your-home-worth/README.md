# What's Your Home Worth — RentCast AVM proxy

Cloudflare Worker that proxies RentCast API calls for the
"What's Your Home Worth" landing page on
https://davidjellisonrealtor.homes/whats-your-home-worth

## Why this exists

The page can't call RentCast directly from the browser — that would expose
the RentCast API key to anyone viewing the page source. MoxiWebsites (the
site's WordPress host) has no server-side code capability (no Plugins menu,
no Theme Editor), so this Worker fills that gap: it holds the key server-side
and the page calls the Worker instead.

## Routes

- `GET /value?address=...` → proxies RentCast's `/v1/avm/value` (AVM).
  Returns `{ price, priceRangeLow, priceRangeHigh }`. Cached 6 hours per address.
- `GET /stats?zipCode=...` → proxies RentCast's `/v1/markets` (sold-price
  stats) plus `/v1/listings/sale` (active listings, averaged in-Worker for a
  true current list-price figure, since RentCast's Markets endpoint only
  reports sold transactions). Returns
  `{ zip, avgSalePrice, avgListPrice, avgDaysOnMarket, sampleSize }`.
  Cached 24 hours per ZIP.

CORS is locked to `https://davidjellisonrealtor.homes`.

## Deploy

1. Cloudflare dashboard → Workers & Pages → Create → Create Worker.
2. Paste in `whv-avm-proxy-worker.js`, Save and Deploy.
3. Worker → Settings → Variables and Secrets → add `RENTCAST_API_KEY`
   (type: Secret) with the RentCast API key. Never hardcode it in this file.
4. Note the Worker's URL and set it as `WORKER_BASE` in the landing page's
   client-side script (see the Property CMA project's
   `whats_your_home_worth_landing_page.md` doc for the full page build notes).
