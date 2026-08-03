/**
 * Emerald Pantry API Proxy - Cloudflare Worker
 * Proxies LLM requests to DeepSeek and fetches live catalogue data from Google Sheets
 * All API keys stored as Cloudflare environment variables
 *
 * Deploy: npx wrangler deploy
 * Set secrets: npx wrangler secret put LLM_KEY
 */
var CATALOGUE_URL = "https://docs.google.com/spreadsheets/d/1fY7974AdL4rrO2gnCxcCBUFWWSkVhOi9euJI7lNjo2Q/export?format=csv";

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
