const CC_BASE = "https://api.collectorcrypt.com";
const ALT_BASE = "https://alt-platform-server.production.internal.onlyalt.com";
const SNKRDUNK_BASE = "https://snkrdunk.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SNKRDUNK_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://snkrdunk.com/",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/alt/")) {
      return proxyAlt(request, path, env);
    }

    if (path === "/sol-price") {
      return solPrice();
    }

    if (path === "/jpy-rate") {
      return jpyRate();
    }

    if (path === "/snkrdunk/price") {
      return snkrdunkPrice(url);
    }

    if (path.startsWith("/marketplace") || path.startsWith("/cart")) {
      return proxyCC(path, url);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

async function proxyAlt(request, path, env) {
  const operation = path.slice(5); // strip "/alt/"
  const body = await request.text();
  const upstream = await fetch(`${ALT_BASE}/graphql/${operation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.ALT_TOKEN}`,
    },
    body,
  });
  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function solPrice() {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    { headers: { "Accept": "application/json" } }
  );
  const data = await res.json();
  const price = parseFloat(data?.data?.amount ?? null);
  return new Response(JSON.stringify({ usd: isNaN(price) ? null : price }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function jpyRate() {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=JPY&to=USD", {
      headers: { "Accept": "application/json" },
    });
    const data = await res.json();
    const rate = data?.rates?.USD ?? null;
    return new Response(JSON.stringify({ usdPerJpy: rate }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ usdPerJpy: null }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

async function snkrdunkPrice(url) {
  const keywords = url.searchParams.get("keywords") || "";
  const grade = (url.searchParams.get("grade") || "").replace(/\s+/g, ""); // "PSA 10" → "PSA10"

  const none = new Response(JSON.stringify({ price: null }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });

  if (!keywords) return none;

  // Fetch search page HTML to extract apparel IDs
  let html;
  try {
    const searchRes = await fetch(
      `${SNKRDUNK_BASE}/search?keywords=${encodeURIComponent(keywords)}`,
      { headers: SNKRDUNK_HEADERS }
    );
    if (!searchRes.ok) return none;
    html = await searchRes.text();
  } catch { return none; }

  // Extract unique apparel IDs from href="/apparels/{id}" links
  const matches = [...html.matchAll(/\/apparels\/(\d+)/g)];
  const ids = [...new Set(matches.map(m => m[1]))].slice(0, 10);
  if (ids.length === 0) return none;

  // Card number is the last token of keywords (e.g. "Greninja EX 083" → "083")
  const cardNum = keywords.trim().split(/\s+/).pop() || "";
  const cardNumNorm = parseInt(cardNum, 10); // normalise for leading-zero comparison (58 == 058)

  // Try each apparel ID, find one with data at the requested grade
  const gradeCondition = grade ? `tradingCardSingleCondition${grade}` : null;

  for (const id of ids) {
    try {
      const listRes = await fetch(
        `${SNKRDUNK_BASE}/v1/apparels/${id}/used?perPage=100&page=1&sizeId=0&isSaleOnly=false`,
        { headers: { "Accept": "application/json", "User-Agent": SNKRDUNK_HEADERS["User-Agent"] } }
      );
      if (!listRes.ok) continue;
      const data = await listRes.json();

      // Verify card number matches the first number in bracket notation [SetCode NUM/TOTAL]
      // Normalise for leading zeros: "58" == "058"  ([SM3+ 058/072] vs cardNum "58")
      const apparelName = (data.apparelUsedItems || [])[0]?.apparel?.name ?? "";
      if (cardNum && apparelName) {
        const bracketNum = apparelName.match(/\[\S+ (\d+)\//)?.[1];
        if (bracketNum !== undefined && parseInt(bracketNum, 10) !== cardNumNorm) continue;
      }

      const items = data.apparelUsedItems || [];

      // Prefer completed sales: avg of last 4 matching grade
      const sold = items.filter(item =>
        item.isDisplaySold === true && (!gradeCondition || item.wearCount === gradeCondition)
      );
      if (sold.length > 0) {
        sold.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        const recent = sold.slice(0, 4);
        const avg = Math.round(recent.reduce((sum, i) => sum + i.price, 0) / recent.length);
        return new Response(JSON.stringify({ price: avg, apparelId: Number(id), name: apparelName, salesCount: recent.length, priceType: "avg" }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Fallback: lowest active listing for this grade (no sales history yet)
      const active = items.filter(item =>
        item.status === 0 && (!gradeCondition || item.wearCount === gradeCondition)
      );
      if (active.length > 0) {
        const minPrice = Math.min(...active.map(i => i.price));
        return new Response(JSON.stringify({ price: minPrice, apparelId: Number(id), name: apparelName, priceType: "ask" }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
    } catch { continue; }
  }

  return none;
}

async function proxyCC(path, url) {
  const target = `${CC_BASE}${path}${url.search}`;
  const upstream = await fetch(target, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://collectorcrypt.com/",
      "Origin": "https://collectorcrypt.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  });
}
