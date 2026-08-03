/**
 * Emerald Pantry API Proxy - Cloudflare Worker
 * Proxies LLM requests to DeepSeek and fetches live catalogue data from Google Sheets
 * All API keys stored as Cloudflare environment variables
 *
 * Deploy: npx wrangler deploy
 * Set secrets: npx wrangler secret put LLM_KEY
 */
var CATALOGUE_URL = "https://docs.google.com/spreadsheets/d/1fY7974AdL4rrO2gnCxcCBUFWWSkVhOi9euJI7lNjo2Q/export?format=csv";
var OFF_URL = "https://world.openfoodfacts.org/api/v2/product/";

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      var response;

      if (url.pathname === "/api/llm") {
        var body = await request.json();
        response = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.LLM_KEY,
          },
          body: JSON.stringify(body),
        });
      } else if (url.pathname === "/api/catalogue") {
        response = await getCatalogue(env, url);
      } else if (url.pathname === "/api/enriched-catalogue") {
        response = await getEnrichedCatalogue(env, url, ctx);
      } else {
        return new Response("Not found", { status: 404, headers });
      }

      var responseHeaders = new Headers(response.headers);
      Object.keys(headers).forEach(function(k) { responseHeaders.set(k, headers[k]); });
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: Object.assign({}, headers, { "Content-Type": "application/json" }),
      });
    }
  },
};

async function getCatalogue(env, url) {
  // Fetch fresh from Google Sheets every time -- no caching, to guarantee live data
  var resp = await fetch(CATALOGUE_URL + "&t=" + Date.now());
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch catalogue" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  var csv = await resp.text();
  var products = parseCSV(csv);

  var search = (url.searchParams.get("q") || "").toLowerCase().trim();
  if (search) {
    products = products.filter(function(p) {
      return p.product_name.toLowerCase().indexOf(search) > -1
        || p.category.toLowerCase().indexOf(search) > -1
        || (p.description && p.description.toLowerCase().indexOf(search) > -1);
    });
  }

  var category = (url.searchParams.get("category") || "").toLowerCase().trim();
  if (category) {
    products = products.filter(function(p) {
      return p.category.toLowerCase() === category;
    });
  }

  return new Response(JSON.stringify({
    count: products.length,
    products: products,
    updated: new Date().toISOString(),
  }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

async function getEnrichedCatalogue(env, url, ctx) {
  // Step 1: Fetch fresh catalogue from Google Sheets (no cache for live price/stock)
  var resp = await fetch(CATALOGUE_URL + "&t=" + Date.now());
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch catalogue" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  var csv = await resp.text();
  var products = parseCSV(csv);

  // Step 2: Batch-enrich with OpenFoodFacts data (all barcodes in parallel)
  // OFF nutritional data cached 1 hour; Google Sheet price/stock always live
  var offCache = caches.default;
  var enrichmentFutures = products.map(function(p) {
    return enrichProduct(p, offCache);
  });
  var enrichedProducts = await Promise.all(enrichmentFutures);

  // Step 3: Apply search/category filters
  var search = (url.searchParams.get("q") || "").toLowerCase().trim();
  if (search) {
    enrichedProducts = enrichedProducts.filter(function(p) {
      return p.product_name.toLowerCase().indexOf(search) > -1
        || p.category.toLowerCase().indexOf(search) > -1
        || (p.description && p.description.toLowerCase().indexOf(search) > -1);
    });
  }

  var category = (url.searchParams.get("category") || "").toLowerCase().trim();
  if (category) {
    enrichedProducts = enrichedProducts.filter(function(p) {
      return p.category.toLowerCase() === category;
    });
  }

  return new Response(JSON.stringify({
    count: enrichedProducts.length,
    products: enrichedProducts,
    updated: new Date().toISOString(),
    source: "emerald-pantry + openfoodfacts",
  }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

async function enrichProduct(product, offCache) {
  var barcode = product.barcode;
  if (!barcode || barcode.length < 8) return product;

  // Try OFF cache first (1-hour TTL for nutritional data)
  var cacheKey = "https://cache.off/" + barcode;
  var cacheReq = new Request(cacheKey, { method: "GET" });
  var cached = await offCache.match(cacheReq);
  if (cached) {
    var cachedData = await cached.json();
    return Object.assign({}, product, cachedData);
  }

  // Fetch from OFF API
  try {
    var offResp = await fetch(OFF_URL + barcode + ".json");
    if (!offResp.ok) return product;
    var offData = await offResp.json();
    if (offData.status !== 1 || !offData.product) return product;

    var enrichment = extractOffFields(offData.product);

    // Cache for 1 hour
    var cacheResp = new Response(JSON.stringify(enrichment), {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
    // Use ctx if available, otherwise skip caching
    if (typeof ctx !== "undefined" && ctx && ctx.waitUntil) {
      ctx.waitUntil(offCache.put(cacheReq, cacheResp));
    }

    return Object.assign({}, product, enrichment);
  } catch (e) {
    return product;
  }
}

function extractOffFields(p) {
  return {
    nutriscore_grade: p.nutriscore_grade || null,
    nova_group: p.nova_group || null,
    ecoscore_grade: p.ecoscore_grade || null,
    allergens: p.allergens || "",
    image_url: p.image_front_small_url || p.image_url || "",
    ingredients_analysis_tags: p.ingredients_analysis_tags || [],
    labels_tags: p.labels_tags || [],
    nutrient_levels: p.nutrient_levels || {},
    origins: p.origins || "",
    brands: p.brands || "",
    categories_off: (p.categories_tags || []).filter(function(t) { return t.indexOf("en:") === 0; }).slice(0, 3),
  };
}

function parseCSV(csv) {
  var lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  var headers = parseCSVLine(lines[0]);
  var products = [];

  for (var i = 1; i < lines.length; i++) {
    var values = parseCSVLine(lines[i]);
    var product = {};
    for (var j = 0; j < headers.length; j++) {
      var key = headers[j];
      var val = values[j] || "";
      if (key === "price_eur") val = parseFloat(val) || 0;
      if (key === "stock_this_week") val = parseInt(val) || 0;
      product[key] = val;
    }
    products.push(product);
  }

  return products;
}

function parseCSVLine(line) {
  var result = [];
  var current = "";
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}
