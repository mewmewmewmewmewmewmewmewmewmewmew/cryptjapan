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
  const hasMasterBall = keywords.toLowerCase().includes("master ball");

  // Try each apparel ID, find one with data at the requested grade
  const gradeCondition = grade ? `tradingCardSingleCondition${grade}` : null;
  const now = Date.now();
  const ONE_WEEK_MS  = 7  * 24 * 60 * 60 * 1000;
  const THREE_WEEK_MS = 21 * 24 * 60 * 60 * 1000;

  for (const id of ids) {
    try {
      const listRes = await fetch(
        `${SNKRDUNK_BASE}/v1/apparels/${id}/used?perPage=100&page=1&sizeId=0&isSaleOnly=false`,
        { headers: { "Accept": "application/json", "User-Agent": SNKRDUNK_HEADERS["User-Agent"] } }
      );
      if (!listRes.ok) continue;
      const data = await listRes.json();

      const items = data.apparelUsedItems || [];
      if (items.length === 0) continue;

      const apparelName = items[0]?.apparel?.name ?? "";

      // Verify card number matches the first number in bracket notation [SetCode NUM/TOTAL]
      // Normalise for leading zeros: "58" == "058"  ([SM3+ 058/072] vs cardNum "58")
      if (cardNum && apparelName) {
        const bracketNum = apparelName.match(/\[\S+ (\d+)\//)?.[1];
        if (bracketNum !== undefined && parseInt(bracketNum, 10) !== cardNumNorm) continue;
      }

      // Skip Master Ball stamp variants unless the search card is also a Master Ball
      if (apparelName.includes("マスターボール") && !hasMasterBall) continue;

      const sold = items.filter(item =>
        item.isDisplaySold === true && (!gradeCondition || item.wearCount === gradeCondition)
      );

      if (sold.length > 0) {
        sold.sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        });

        const age = i => (i.createdAt ? now - new Date(i.createdAt).getTime() : Infinity);
        const inWeek       = sold.filter(i => age(i) <= ONE_WEEK_MS);
        const inThreeWeeks = sold.filter(i => age(i) <= THREE_WEEK_MS);

        // >= 2 in last week → avg last week
        // any in last 3 weeks → avg last 3 weeks
        // otherwise → last single sale
        const useItems = inWeek.length >= 2 ? inWeek
                       : inThreeWeeks.length >= 1 ? inThreeWeeks
                       : [sold[0]];

        const avg = Math.round(useItems.reduce((sum, i) => sum + i.price, 0) / useItems.length);
        return new Response(JSON.stringify({ price: avg, apparelId: Number(id), name: apparelName, salesCount: useItems.length, priceType: "avg" }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // No sold items — try active listings as fallback
      const active = items.filter(item =>
        item.status === 0 && (!gradeCondition || item.wearCount === gradeCondition)
      );
      if (active.length > 0) {
        const minPrice = Math.min(...active.map(i => i.price));
        return new Response(JSON.stringify({ price: minPrice, apparelId: Number(id), name: apparelName, priceType: "ask" }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Right card confirmed, no data for this grade — N/A but still link to the page
      return new Response(JSON.stringify({ price: null, apparelId: Number(id), name: apparelName, priceType: "na" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
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
