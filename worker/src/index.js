// v0.34
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

    if (path === "/alt-price") {
      return altPriceByCert(url, env);
    }

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

function parseSnkrdunkAge(dateStr) {
  const m = dateStr?.match(/(\d+)(時間|日|週間|週|ヶ月|か月|年)前/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const table = { '時間': 3600000, '日': 86400000, '週間': 604800000, '週': 604800000, 'ヶ月': 2592000000, 'か月': 2592000000, '年': 31536000000 };
  return n * (table[m[2]] || 0);
}

function priceMedian(prices) {
  const s = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function snkrdunkPrice(url) {
  const keywords = url.searchParams.get("keywords") || "";
  const grade = (url.searchParams.get("grade") || "").replace(/\s+/g, ""); // "PSA 10" → "PSA10"
  const hasMasterBallParam = url.searchParams.get("masterball") === "1";
  const setNum = url.searchParams.get("setnum") || ""; // e.g. "069/086"

  const none = new Response(JSON.stringify({ price: null }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });

  if (!keywords) return none;

  // Pad bare card number token in keywords so SNKRDUNK finds the right card
  // e.g. "Umbreon 69" → "Umbreon 069", "Umbreon 069" unchanged
  const kwTokens = keywords.trim().split(/\s+/);
  const lastTok = kwTokens[kwTokens.length - 1];
  const searchKeywords = /^\d{1,2}$/.test(lastTok)
    ? [...kwTokens.slice(0, -1), lastTok.padStart(3, '0')].join(' ')
    : keywords;

  // Fetch search page HTML to extract apparel IDs
  let html;
  try {
    const searchRes = await fetch(
      `${SNKRDUNK_BASE}/search?keywords=${encodeURIComponent(searchKeywords)}`,
      { headers: SNKRDUNK_HEADERS }
    );
    if (!searchRes.ok) return none;
    html = await searchRes.text();
  } catch { return none; }

  // Extract unique apparel IDs from href="/apparels/{id}" links
  const matches = [...html.matchAll(/\/apparels\/(\d+)/g)];
  const ids = [...new Set(matches.map(m => m[1]))].slice(0, 10);
  if (ids.length === 0) return none;

  // For each apparel ID, check whether マスターボール appears in the surrounding
  // search-result HTML (±600 chars). This is more reliable than checking the API
  // name field, which may omit the stamp label.
  const masterBallIds = new Set();
  for (const m of matches) {
    const ctx = html.slice(Math.max(0, m.index - 600), m.index + 600);
    if (ctx.includes("マスターボール")) masterBallIds.add(m[1]);
  }

  // Card number — if setnum contains "/" use numerator, else treat the whole value as denominator only
  const hasSlash = setNum.includes("/");
  const cardNum = (setNum && hasSlash) ? setNum.split("/")[0] : (keywords.trim().split(/\s+/).pop() || "");
  const cardTotal = setNum ? (hasSlash ? setNum.split("/")[1] : setNum) : "";
  const cardNumNorm = parseInt(cardNum, 10);   // normalise: 58 == 058
  const cardTotalNorm = cardTotal ? parseInt(cardTotal, 10) : null;
  const hasMasterBall = hasMasterBallParam || keywords.toLowerCase().includes("master ball");

  const ONE_WEEK_MS   = 7  * 24 * 60 * 60 * 1000;
  const THREE_WEEK_MS = 21 * 24 * 60 * 60 * 1000;
  const apiHeaders = { "Accept": "application/json", "User-Agent": SNKRDUNK_HEADERS["User-Agent"] };

  let naCandidate = null;

  for (const id of ids) {
    try {
      // Stage 1: fetch one used listing to get the apparel name for validation
      const usedRes = await fetch(
        `${SNKRDUNK_BASE}/v1/apparels/${id}/used?perPage=1&page=1&sizeId=0&isSaleOnly=false`,
        { headers: apiHeaders }
      );
      if (!usedRes.ok) continue;
      const usedData = await usedRes.json();
      const apparelObj = usedData.apparelUsedItems?.[0]?.apparel ?? {};
      let apparelName = apparelObj.name ?? "";
      const pickImage = o => o?.primaryMedia?.imageUrl ?? o?.image ?? o?.imageUrl ?? o?.image_url ?? o?.thumbnail ?? o?.thumbnailUrl ?? o?.thumbnail_url ?? (Array.isArray(o?.images) ? o.images[0] : null) ?? null;
      let apparelImage = pickImage(apparelObj);

      // Verify card number (and total if setnum provided) against bracket notation [SetCode NUM/TOTAL]
      if (cardNum && apparelName) {
        const bm = apparelName.match(/\[\S+ (\d+)\/(\d+)\]/);
        if (bm) {
          if (parseInt(bm[1], 10) !== cardNumNorm) continue;
          if (cardTotalNorm !== null && parseInt(bm[2], 10) !== cardTotalNorm) continue;
        }
      }

      // Stage 2: fetch sales history for price data
      const histRes = await fetch(
        `${SNKRDUNK_BASE}/v1/apparels/${id}/sales-history?size_id=0&page=1&per_page=100`,
        { headers: apiHeaders }
      );
      if (!histRes.ok) continue;
      const histData = await histRes.json();

      // Fallback: get apparel name/image from sales-history response if Stage 1 returned nothing
      if (!apparelName) apparelName = histData.apparel?.name ?? "";
      if (!apparelImage) apparelImage = pickImage(histData.apparel);

      // Skip Master Ball stamp variants unless the search card is also a Master Ball.
      // Primary signal: search-HTML context; fallback: API name field.
      const isMasterBallApparel = masterBallIds.has(id) || apparelName.includes("マスターボール");
      if (isMasterBallApparel && !hasMasterBall) continue;

      const history = histData.history || [];

      // Filter by grade condition (condition field contains e.g. "PSA10" directly)
      const gradeHistory = grade ? history.filter(s => s.condition === grade) : history;

      if (gradeHistory.length > 0) {
        const withAge = gradeHistory.map(s => ({ price: s.price, age: parseSnkrdunkAge(s.date) }));
        const inWeekRaw = withAge.filter(s => s.age <= ONE_WEEK_MS);
        const inThreeWeeks = withAge.filter(s => s.age <= THREE_WEEK_MS);

        // Apply 3× median outlier filter to the 1-week window
        let inWeek = inWeekRaw;
        if (inWeekRaw.length >= 2) {
          const med = priceMedian(inWeekRaw.map(s => s.price));
          inWeek = inWeekRaw.filter(s => s.price <= med * 3);
        }

        const useItems = (inWeek.length >= 2 ? inWeek
                       : inThreeWeeks.length >= 1 ? inThreeWeeks
                       : [withAge[0]]).slice(0, 5);

        const avg = Math.round(useItems.reduce((sum, s) => sum + s.price, 0) / useItems.length);
        return new Response(JSON.stringify({ price: avg, apparelId: Number(id), name: apparelName, image: apparelImage, salesCount: useItems.length, priceType: "avg" }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Right card found but no grade-matching sales — keep as N/A candidate and try next
      if (!naCandidate) naCandidate = { apparelId: Number(id), name: apparelName, image: apparelImage };

    } catch { continue; }
  }

  if (naCandidate) {
    return new Response(JSON.stringify({ price: null, apparelId: naCandidate.apparelId, name: naCandidate.name, image: naCandidate.image, priceType: "na" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  return none;
}

async function altPriceByCert(url, env) {
  const cert = url.searchParams.get("cert") || "";
  if (!cert) {
    return new Response(JSON.stringify({ error: "cert param required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const altGql = async (operation, query, variables) => {
    const res = await fetch(`${ALT_BASE}/graphql/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ALT_TOKEN}` },
      body: JSON.stringify({ operationName: operation, query, variables }),
    });
    return res.json();
  };

  try {
    const certData = await altGql("Cert", `query Cert($certNumber: String!) { cert(certNumber: $certNumber) { certNumber gradeNumber gradingCompany asset { id } } }`, { certNumber: cert });
    const certObj = certData.data?.cert;
    if (!certObj?.asset?.id) {
      return new Response(JSON.stringify({ price: null, assetId: null }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const assetData = await altGql("AssetDetails", `query AssetDetails($id: ID!, $tsFilter: TimeSeriesFilter!) { asset(id: $id) { id predictedPrice(tsFilter: $tsFilter) } }`, {
      id: certObj.asset.id,
      tsFilter: { gradeNumber: certObj.gradeNumber, gradingCompany: certObj.gradingCompany },
    });
    const price = assetData.data?.asset?.predictedPrice ?? null;
    return new Response(JSON.stringify({
      price,
      assetId: certObj.asset.id,
      certNumber: certObj.certNumber,
      gradeNumber: certObj.gradeNumber,
      gradingCompany: certObj.gradingCompany,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ price: null }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
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
