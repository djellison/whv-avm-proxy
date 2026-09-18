// Cloudflare Worker: secure proxy for RentCast AVM + Market Data
// Keeps the RentCast API key server-side (never sent to the browser).
// Deploy this Worker, then set a secret named RENTCAST_API_KEY on it
// (Worker Settings -> Variables and Secrets -> Add -> type: Secret).

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

async function handleValue(url, env, origin) {
  const address = url.searchParams.get("address");
  if (!address) return json({ error: "address is required" }, 400, origin);

  const cache = caches.default;
  const cacheKey = new Request("https://cache.internal/value?address=" + encodeURIComponent(address.toLowerCase()));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const result = await rentcastFetch("/avm/value", { address: address, compCount: 10 }, env.RENTCAST_API_KEY);
  if (!result.ok || !result.data) {
    return json({ error: "avm_unavailable", status: result.status }, 502, origin);
  }
  const out = {
    price: result.data.price,
    priceRangeLow: result.data.priceRangeLow,
    priceRangeHigh: result.data.priceRangeHigh
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
    if (!env.RENTCAST_API_KEY) {
      return json({ error: "server_misconfigured" }, 500, origin);
    }

    if (url.pathname === "/value") return handleValue(url, env, origin);
    if (url.pathname === "/stats") return handleStats(url, env, origin, ctx);
    return json({ error: "not_found" }, 404, origin);
  }
};
