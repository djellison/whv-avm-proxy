// Cloudflare Worker: secure proxy for RentCast AVM + Market Data
// Keeps the RentCast API key server-side (never sent to the browser).
// Deploy this Worker, then set a secret named RENTCAST_API_KEY on it
// (Worker Settings -> Variables and Secrets -> Add -> type: Secret).
//
// v2 (Sept 2026): /value now accepts optional bedrooms, bathrooms,
// squareFootage, propertyType overrides so callers can correct RentCast's
// auto-detected subject-property attributes when public records are stale
// (e.g. a renovation or finished basement not reflected in county records).
// compCount raised from 10 to 20 for a larger comparable pool.
// Root path ("/") now returns a friendly info page instead of a raw
// {"error":"not_found"} JSON blob.

const ALLOWED_ORIGIN = "https://davidjellisonrealtor.homes";
const RENTCAST_BASE = "https://api.rentcast.io/v1";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin))
  });
}

function rootPage(origin) {
  const html = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>whv-avm-proxy</title>" +
    "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#222}" +
    "code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style></head><body>" +
    "<h1>whv-avm-proxy</h1>" +
    "<p>This is a private data proxy that powers the &ldquo;What&rsquo;s Your Home Worth&rdquo; tool on " +
    "<a href=\"https://davidjellisonrealtor.homes/whats-your-home-worth\">davidjellisonrealtor.homes</a>. " +
    "It is not meant to be browsed directly.</p>" +
    "<p>Available routes:</p>" +
    "<ul><li><code>GET /value?address=...</code></li><li><code>GET /stats?zipCode=...</code></li></ul>" +
    "</body></html>";
  return new Response(html, {
    status: 200,
    headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, corsHeaders(origin))
  });
}

async function rentcastFetch(path, params, apiKey) {
  const url = new URL(RENTCAST_BASE + path);
  Object.keys(params).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
      url.searchParams.set(k, params[k]);
    }
  });
  const resp = await fetch(url.toString(), {
    headers: { "Accept": "application/json", "X-Api-Key": apiKey }
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { ok: resp.ok, status: resp.status, data: data };
}

// Narrows RentCast's price range around the target price by half: the
// target (price) is unchanged, and each bound is moved to the midpoint
// between itself and the target — so the low bound ends up half as far
// below price, and the high bound half as far above it.
function narrowRangeByHalf(price, low, high) {
  const narrowedLow = (typeof price === "number" && typeof low === "number")
  ? Math.round((price + low) / 2)
    : low;
  const narrowedHigh = (typeof price === "number" && typeof high === "number")
  ? Math.round((price + high) / 2)
    : high;
  return { low: narrowedLow, high: narrowedHigh };
}

async function handleValue(url, env, origin) {
  const address = url.searchParams.get("address");
  if (!address) return json({ error: "address is required" }, 400, origin);

  const bedrooms = url.searchParams.get("bedrooms");
  const bathrooms = url.searchParams.get("bathrooms");
  const squareFootage = url.searchParams.get("squareFootage");
  const propertyType = url.searchParams.get("propertyType");

  const cache = caches.default;
  const cacheKeyParts = [
    "address=" + encodeURIComponent(address.toLowerCase()),
    bedrooms ? "bd=" + encodeURIComponent(bedrooms) : "",
    bathrooms ? "ba=" + encodeURIComponent(bathrooms) : "",
    squareFootage ? "sf=" + encodeURIComponent(squareFootage) : "",
    propertyType ? "pt=" + encodeURIComponent(propertyType) : ""
    ].filter(function (p) { return p; }).join("&");
  const cacheKey = new Request("https://cache.internal/value?" + cacheKeyParts);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const rcParams = { address: address, compCount: 20 };
  if (bedrooms) rcParams.bedrooms = bedrooms;
  if (bathrooms) rcParams.bathrooms = bathrooms;
  if (squareFootage) rcParams.squareFootage = squareFootage;
  if (propertyType) rcParams.propertyType = propertyType;

  const result = await rentcastFetch("/avm/value", rcParams, env.RENTCAST_API_KEY);
  if (!result.ok || !result.data) {
    return json({ error: "avm_unavailable", status: result.status }, 502, origin);
  }
  const narrowed = narrowRangeByHalf(result.data.price, result.data.priceRangeLow, result.data.priceRangeHigh);
  const out = {
    price: result.data.price,
    priceRangeLow: narrowed.low,
    priceRangeHigh: narrowed.high
  };
  const resp = json(out, 200, origin);
  const cacheResp = resp.clone();
  cacheResp.headers.set("Cache-Control", "max-age=21600"); // 6 hours
  await cache.put(cacheKey, cacheResp);
  return resp;
}

async function handleStats(url, env, origin, ctx) {
  const zipCode = url.searchParams.get("zipCode");
  if (!zipCode) return json({ error: "zipCode is required" }, 400, origin);

  const cache = caches.default;
  const cacheKey = new Request("https://cache.internal/stats?zipCode=" + encodeURIComponent(zipCode));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [marketRes, listingsRes] = await Promise.all([
    rentcastFetch("/markets", { zipCode: zipCode, dataType: "Sale" }, env.RENTCAST_API_KEY),
    rentcastFetch("/listings/sale", { zipCode: zipCode, status: "Active", limit: 25 }, env.RENTCAST_API_KEY)
    ]);

  if (!marketRes.ok || !marketRes.data || !marketRes.data.saleData) {
    return json({ error: "stats_unavailable" }, 502, origin);
  }

  const sale = marketRes.data.saleData;
  let avgListPrice = null;
  if (listingsRes.ok && Array.isArray(listingsRes.data) && listingsRes.data.length > 0) {
    const prices = listingsRes.data
    .map(function (l) { return l.price; })
    .filter(function (p) { return typeof p === "number" && p > 0; });
    if (prices.length > 0) {
      avgListPrice = Math.round(prices.reduce(function (a, b) { return a + b; }, 0) / prices.length);
    }
  }

  const out = {
    zip: zipCode,
    avgSalePrice: sale.averagePrice || null,
    avgListPrice: avgListPrice,
    avgDaysOnMarket: sale.averageDaysOnMarket || null,
    sampleSize: (listingsRes.ok && Array.isArray(listingsRes.data)) ? listingsRes.data.length : 0
  };

  const resp = json(out, 200, origin);
  const cacheResp = resp.clone();
  cacheResp.headers.set("Cache-Control", "max-age=86400"); // 24 hours
  ctx.waitUntil(cache.put(cacheKey, cacheResp));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, origin);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return rootPage(origin);
    }
    if (!env.RENTCAST_API_KEY) {
      return json({ error: "server_misconfigured" }, 500, origin);
    }

    if (url.pathname === "/value") return handleValue(url, env, origin);
    if (url.pathname === "/stats") return handleStats(url, env, origin, ctx);
    return json({ error: "not_found" }, 404, origin);
  }
};
  
