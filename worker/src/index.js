// v0.41
const CC_BASE = "https://api.collectorcrypt.com";
const ALT_BASE = "https://alt-platform-server.production.internal.onlyalt.com";
const SNKRDUNK_BASE = "https://snkrdunk.com";
// Public Firebase web client key from CardLadder's JS bundle (not a secret)
const CL_FIREBASE_KEY = "AIzaSyBqbxgaaGlpeb1F6HRvEW319OcuCsbkAHM";

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

// Upstream deadlines. ALT's is deliberately generous: SNKRDUNK builds its
// search keywords from ALT's clean card name, so a timed-out ALT lookup
// silently degrades SD match quality. Only cut off a genuine hang.
const ALT_TIMEOUT_MS = 15000;
const SD_TIMEOUT_MS = 8000;

// Key-order-independent JSON, so equivalent variables share a cache entry.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// Shared time windows for "recent sales" averaging (SNKRDUNK + CardLadder)
const ONE_WEEK_MS   = 7  * 24 * 60 * 60 * 1000;
const THREE_WEEK_MS = 21 * 24 * 60 * 60 * 1000;

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

    if (path === "/card-pops") {
      return cardPopsByCert(url, env);
    }

    if (path === "/cgc-cert") {
      return cgcCert(url);
    }

    if (path === "/cardladder-price") {
      return cardladderPrice(url, env);
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

    if (path === "/beezie/listings") {
      return beezieListings(request);
    }

    if (path === "/phygitals/listings") {
      return phygitalsListings(url);
    }

    if (path.startsWith("/marketplace") || path.startsWith("/cart")) {
      return proxyCC(path, url);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

// The worker owns the GraphQL text for every ALT operation it will run.
// This endpoint signs requests with our ALT token, so it must never forward a
// caller-supplied query — otherwise anyone who knows the worker URL could run
// arbitrary queries against ALT as us. Callers may only pick an operation by
// name and pass variables; the query itself is fixed here.
const ALT_QUERIES = {
  Cert: `query Cert($certNumber: String!) {
    cert(certNumber: $certNumber) {
      certNumber gradeNumber gradingCompany
      asset { id subject attributes { cardNumber } __typename }
      __typename
    }
  }`,
  // Single-round-trip variant, selected when the caller passes a tsFilter.
  CertFull: `query Cert($certNumber: String!, $tsFilter: TimeSeriesFilter!) {
    cert(certNumber: $certNumber) {
      certNumber gradeNumber gradingCompany
      asset {
        id subject attributes { cardNumber }
        altValueInfo(tsFilter: $tsFilter) { currentAltValue }
        cardPops { gradingCompany gradeNumber count }
        __typename
      }
      __typename
    }
  }`,
  AssetDetails: `query AssetDetails($id: ID!, $tsFilter: TimeSeriesFilter!) {
    asset(id: $id) {
      id
      altValueInfo(tsFilter: $tsFilter) { currentAltValue }
      __typename
    }
  }`,
  AssetCardPops: `query AssetCardPops($id: ID!) {
    asset(id: $id) {
      id
      cardPops { gradingCompany gradeNumber count }
    }
  }`,
};

// A cert's card identity never changes, so it caches for a week; anything
// carrying value/population data moves slowly, so hours.
const ALT_CACHE_TTL = {
  Cert: 7 * 24 * 3600,
  CertFull: 6 * 3600,
  AssetDetails: 6 * 3600,
  AssetCardPops: 6 * 3600,
};

async function proxyAlt(request, path, env) {
  const operation = path.slice(5); // strip "/alt/"
  if (!Object.prototype.hasOwnProperty.call(ALT_QUERIES, operation) || operation === "CertFull") {
    return new Response(JSON.stringify({ error: `unsupported operation: ${operation}` }), {
      status: 403, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let variables = {};
  try {
    variables = (JSON.parse(await request.text()) || {}).variables ?? {};
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Cert has two shapes; pick the richer one only when a tsFilter is supplied.
  const queryKey = operation === "Cert" && variables.tsFilter ? "CertFull" : operation;

  const cache = caches.default;
  const cacheKey = new Request(
    `https://alt-cache.internal/${queryKey}?v=${encodeURIComponent(stableStringify(variables))}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) {
    return new Response(await hit.text(), {
      headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "hit" },
    });
  }

  const upstream = await fetch(`${ALT_BASE}/graphql/${operation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.ALT_TOKEN}`,
    },
    body: JSON.stringify({ operationName: operation, query: ALT_QUERIES[queryKey], variables }),
    signal: AbortSignal.timeout(ALT_TIMEOUT_MS),
  });
  const data = await upstream.text();

  // Only cache a genuine result — never an error or an empty lookup, so a
  // transient failure can't get frozen in for the whole TTL.
  if (upstream.ok) {
    let cacheable = false;
    try {
      const parsed = JSON.parse(data);
      cacheable = !parsed.errors && parsed.data &&
        Object.values(parsed.data).some(v => v != null);
    } catch {}
    if (cacheable) {
      try {
        await cache.put(cacheKey, new Response(data, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `s-maxage=${ALT_CACHE_TTL[queryKey] ?? 21600}`,
          },
        }));
      } catch {}
    }
  }

  return new Response(data, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "miss" },
  });
}

// Shared edge-cache helper. Every client currently hits upstream itself for
// rates and SNKRDUNK lookups; caching at the edge collapses that to one call
// per TTL across all users, sessions and isolates.
// Returns the cached body if present, else runs produce(), caches it when
// ttlFor() gives a positive TTL, and returns it.
async function cachedJson(keyUrl, ttlFor, produce) {
  const cache = caches.default;
  const cacheKey = new Request(keyUrl);
  const hit = await cache.match(cacheKey);
  if (hit) {
    return new Response(await hit.text(), {
      headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "hit" },
    });
  }
  const body = await produce();
  let ttl = 0;
  try { ttl = ttlFor(JSON.parse(body)); } catch { ttl = 0; }
  if (ttl > 0) {
    try {
      await cache.put(cacheKey, new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${ttl}` },
      }));
    } catch {}
  }
  return new Response(body, {
    headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "miss" },
  });
}

async function solPrice() {
  return cachedJson(
    "https://rate-cache.internal/sol",
    d => (d.usd != null ? 300 : 0), // 5 min; never cache a failed lookup
    async () => {
      try {
        const res = await fetch(
          "https://api.coinbase.com/v2/prices/SOL-USD/spot",
          { headers: { "Accept": "application/json" } }
        );
        const data = await res.json();
        const price = parseFloat(data?.data?.amount ?? null);
        return JSON.stringify({ usd: isNaN(price) ? null : price });
      } catch {
        return JSON.stringify({ usd: null });
      }
    }
  );
}

async function jpyRate() {
  return cachedJson(
    "https://rate-cache.internal/jpy",
    d => (d.usdPerJpy != null ? 3600 : 0), // 1 hour; the feed updates daily
    async () => {
      try {
        const res = await fetch("https://api.frankfurter.app/latest?from=JPY&to=USD", {
          headers: { "Accept": "application/json" },
        });
        const data = await res.json();
        return JSON.stringify({ usdPerJpy: data?.rates?.USD ?? null });
      } catch {
        return JSON.stringify({ usdPerJpy: null });
      }
    }
  );
}

function parseSnkrdunkAge(dateStr) {
  const m = dateStr?.match(/(\d+)(時間|日|週間|週|ヶ月|か月|年)前/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const table = { '時間': 3600000, '日': 86400000, '週間': 604800000, '週': 604800000, 'ヶ月': 2592000000, 'か月': 2592000000, '年': 31536000000 };
  return n * (table[m[2]] || 0);
}

// "069"→"069", "120/SV-P"→"SV-P 120", "294XYP"→"XY-P 294", "RC32"→"RC32"
function normalizeCardNum(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return String(parseInt(raw, 10)).padStart(3, "0");
  const parts = raw.split("/");
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && !/^\d+$/.test(parts[1]))
    return `${parts[1]} ${parts[0].padStart(3, "0")}`;
  const m = raw.match(/^(\d+)([A-Za-z].*)$/);
  if (m) {
    const code = m[2].replace(/([A-Za-z])P$/i, "$1-P");
    return `${code} ${m[1].padStart(3, "0")}`;
  }
  return raw;
}

function priceMedian(prices) {
  const s = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// A single SNKRDUNK lookup costs a search-page fetch plus up to ~10 candidate
// cards x 2 API calls each, so it is by far the heaviest thing this worker
// does. Cache on the search inputs (not the request URL — altPriceByCert calls
// this internally with a different host) so repeat lookups across users and
// sessions are free, and we stay polite toward snkrdunk.com.
async function snkrdunkPrice(url) {
  const p = url.searchParams;
  const keyParams = new URLSearchParams({
    keywords: p.get("keywords") || "",
    grade: p.get("grade") || "",
    masterball: p.get("masterball") || "",
    setnum: p.get("setnum") || "",
    year: p.get("year") || "",
  });
  return cachedJson(
    `https://snkr-cache.internal/price?${keyParams}`,
    // Found a card: 6h. Found nothing: 1h, so a newly listed card can appear
    // without waiting out the full window.
    d => (d.price != null || d.apparelId != null ? 21600 : 3600),
    async () => (await snkrdunkPriceUncached(url)).text()
  );
}

async function snkrdunkPriceUncached(url) {
  const keywords = url.searchParams.get("keywords") || "";
  const grade = (url.searchParams.get("grade") || "").replace(/\s+/g, ""); // "PSA 10" → "PSA10"
  const hasMasterBallParam = url.searchParams.get("masterball") === "1";
  const setNum = url.searchParams.get("setnum") || ""; // e.g. "069/086"
  const expectedYear = parseInt(url.searchParams.get("year") || "0") || null;

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
      { headers: SNKRDUNK_HEADERS, signal: AbortSignal.timeout(SD_TIMEOUT_MS) }
    );
    if (!searchRes.ok) return none;
    html = await searchRes.text();
  } catch { return none; }

  // Extract unique apparel IDs from href="/apparels/{id}" links
  const matches = [...html.matchAll(/\/apparels\/(\d+)/g)];
  const ids = [...new Set(matches.map(m => m[1]))].slice(0, 10);
  if (ids.length === 0) return none;

  // Extract releasedAt dates from the page's embedded Next.js JSON (id → releasedAt)
  // IDs may be numbers or strings in JSON, so handle both
  const releasedAtMap = new Map();
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const walkAndCollect = obj => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walkAndCollect); return; }
        if (typeof obj.releasedAt === 'string') {
          const idStr = typeof obj.id === 'number' ? String(obj.id)
                      : (typeof obj.id === 'string' && /^\d+$/.test(obj.id) ? obj.id : null);
          if (idStr) releasedAtMap.set(idStr, obj.releasedAt);
        }
        for (const v of Object.values(obj)) walkAndCollect(v);
      };
      walkAndCollect(JSON.parse(nextDataMatch[1]));
    } catch {}
  }
  // Regex fallback: scan raw HTML for JSON objects containing both an id and releasedAt
  // Covers cases where Next.js data is not in __NEXT_DATA__ or uses a different structure
  if (releasedAtMap.size === 0) {
    for (const m of html.matchAll(/"id"\s*:\s*(\d{4,9})\b[^{}]{0,600}?"releasedAt"\s*:\s*"([^"]{10,30})"/g)) {
      releasedAtMap.set(m[1], m[2]);
    }
  }

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

  const apiHeaders = { "Accept": "application/json", "User-Agent": SNKRDUNK_HEADERS["User-Agent"] };
  const pickImage = o => o?.primaryMedia?.imageUrl ?? o?.image ?? o?.imageUrl ?? o?.image_url ?? o?.thumbnail ?? o?.thumbnailUrl ?? o?.thumbnail_url ?? (Array.isArray(o?.images) ? o.images[0] : null) ?? null;

  // Extract IDs from the ランキング section specifically (left-to-right = rank order)
  // The ランキング section is SNKRDUNK's own relevance ranking — trust it over generic results
  const rankingPos = html.indexOf('ランキング');
  let rankingIds = [];
  if (rankingPos >= 0) {
    const rankingSlice = html.slice(rankingPos, rankingPos + 5000);
    const moreIdx = rankingSlice.indexOf('もっと見る');
    const rankingSection = moreIdx > 0 ? rankingSlice.slice(0, moreIdx) : rankingSlice;
    rankingIds = [...new Set([...rankingSection.matchAll(/\/apparels\/(\d+)/g)].map(m => m[1]))].slice(0, 5);
  }

  // Shared price calculator
  const calcAvg = gradeHistory => {
    const withAge = gradeHistory.map(s => ({ price: s.price, age: parseSnkrdunkAge(s.date) }));
    const inWeekRaw = withAge.filter(s => s.age <= ONE_WEEK_MS);
    const inThreeWeeks = withAge.filter(s => s.age <= THREE_WEEK_MS);
    let inWeek = inWeekRaw;
    if (inWeekRaw.length >= 2) {
      const med = priceMedian(inWeekRaw.map(s => s.price));
      inWeek = inWeekRaw.filter(s => s.price <= med * 3);
    }
    const useItems = (inWeek.length >= 2 ? inWeek : inThreeWeeks.length >= 1 ? inThreeWeeks : [withAge[0]]).slice(0, 5);
    return { avg: Math.round(useItems.reduce((sum, s) => sum + s.price, 0) / useItems.length), count: useItems.length };
  };

  // Shared per-apparel fetch: returns null if skipped, otherwise { apparelName, apparelImage, gradeHistory }
  // The used-listings and sales-history requests are independent, so they run
  // in parallel; early-return paths simply abandon the history promise.
  const fetchApparel = async id => {
    const sdOpts = { headers: apiHeaders, signal: AbortSignal.timeout(SD_TIMEOUT_MS) };
    const usedPromise = fetch(`${SNKRDUNK_BASE}/v1/apparels/${id}/used?perPage=1&page=1&sizeId=0&isSaleOnly=false`, sdOpts);
    const histPromise = fetch(`${SNKRDUNK_BASE}/v1/apparels/${id}/sales-history?size_id=0&page=1&per_page=100`, sdOpts);
    histPromise.catch(() => {}); // suppress unhandled rejection when we return early
    const usedRes = await usedPromise;
    if (!usedRes.ok) return null;
    const usedData = await usedRes.json();
    const apparelObj = usedData.apparelUsedItems?.[0]?.apparel ?? {};
    let apparelName = apparelObj.name ?? "";
    let apparelImage = pickImage(apparelObj);

    // Card number validation against bracket notation [SetCode NUM/TOTAL]
    if (cardNum && apparelName) {
      const bm = apparelName.match(/\[\S+ (\d+)\/(\d+)\]/);
      if (bm) {
        if (parseInt(bm[1], 10) !== cardNumNorm) return null;
        if (cardTotalNorm !== null && parseInt(bm[2], 10) !== cardTotalNorm) return null;
      }
    }

    const histRes = await histPromise;
    if (!histRes.ok) return null;
    const histData = await histRes.json();

    if (!apparelName) apparelName = histData.apparel?.name ?? "";
    if (!apparelImage) apparelImage = pickImage(histData.apparel);

    // Card number re-check with Stage 2 name when Stage 1 had no listings
    if (cardNum && !usedData.apparelUsedItems?.[0] && apparelName) {
      const bm = apparelName.match(/\[\S+ (\d+)\/(\d+)\]/);
      if (bm) {
        if (parseInt(bm[1], 10) !== cardNumNorm) return null;
        if (cardTotalNorm !== null && parseInt(bm[2], 10) !== cardTotalNorm) return null;
      }
    }

    const isMasterBallApparel = masterBallIds.has(id) || apparelName.includes("マスターボール");
    if (isMasterBallApparel && !hasMasterBall) return null;

    const history = histData.history || [];
    const gradeHistory = grade ? history.filter(s => s.condition === grade) : history;
    const releasedAt = apparelObj.releasedAt ?? releasedAtMap.get(id) ?? histData.apparel?.releasedAt ?? null;

    return { apparelName, apparelImage, gradeHistory, releasedAt };
  };

  // Pass 1 — ランキング section: check items left-to-right, with year filtering.
  // SNKRDUNK's own ranking is the strongest relevance signal. The first ranking item
  // that passes validation wins — even if it has no grade-matching sales (N/A).
  // Candidate lookups were fully serial, so a card that isn't matched early
  // cost one round trip per candidate. The top-ranked candidate is still
  // fetched alone (the common case, so no extra load on SNKRDUNK); only if it
  // fails do we fetch the rest concurrently. Selection order is unchanged.
  const fetchApparelSafe = async id => { try { return await fetchApparel(id); } catch { return null; } };

  let restOfRanking = null;
  for (let i = 0; i < rankingIds.length; i++) {
    const id = rankingIds[i];
    try {
      if (i === 1 && !restOfRanking) {
        restOfRanking = await Promise.all(rankingIds.slice(1).map(fetchApparelSafe));
      }
      const r = i === 0 ? await fetchApparelSafe(id) : restOfRanking[i - 1];
      if (!r) continue;
      if (expectedYear && r.releasedAt) {
        if (new Date(r.releasedAt).getFullYear() !== expectedYear) continue;
      }
      if (r.gradeHistory.length > 0) {
        const { avg, count } = calcAvg(r.gradeHistory);
        return new Response(JSON.stringify({ price: avg, apparelId: Number(id), name: r.apparelName, image: r.apparelImage, salesCount: count, priceType: "avg" }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      // Valid ranking item but no grade sales — return N/A immediately; don't fall through
      return new Response(JSON.stringify({ price: null, apparelId: Number(id), name: r.apparelName, image: r.apparelImage, priceType: "na" }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch { continue; }
  }

  // Pass 2 — full search results (non-ranking), with year filtering.
  // Only reached when no ranking item passed validation.
  const rankingIdSet = new Set(rankingIds);
  const remainingIds = ids.filter(id => !rankingIdSet.has(id));

  let verifiedPriced = null, verifiedNa = null, unverifiedPriced = null, unverifiedNa = null;

  // Fetched 4-wide but still evaluated strictly in rank order, so the chosen
  // result is identical to the old one-at-a-time walk.
  outer:
  for (let start = 0; start < remainingIds.length; start += 4) {
    const chunk = remainingIds.slice(start, start + 4);
    const chunkResults = await Promise.all(chunk.map(fetchApparelSafe));
    for (let j = 0; j < chunk.length; j++) {
      const id = chunk[j];
      const r = chunkResults[j];
      if (!r) continue;

      let yearVerified = false;
      if (expectedYear && r.releasedAt) {
        if (new Date(r.releasedAt).getFullYear() !== expectedYear) continue;
        yearVerified = true;
      }

      if (r.gradeHistory.length > 0) {
        const { avg, count } = calcAvg(r.gradeHistory);
        const result = { price: avg, apparelId: Number(id), name: r.apparelName, image: r.apparelImage, salesCount: count, priceType: "avg" };
        if (yearVerified) { verifiedPriced = result; break outer; }
        if (!unverifiedPriced) unverifiedPriced = result;
        if (!expectedYear) break outer;
        continue;
      }

      const naResult = { price: null, apparelId: Number(id), name: r.apparelName, image: r.apparelImage, priceType: "na" };
      if (yearVerified) { if (!verifiedNa) verifiedNa = naResult; }
      else { if (!unverifiedNa) unverifiedNa = naResult; }
    }
  }

  const best = expectedYear
    ? (verifiedPriced ?? verifiedNa ?? unverifiedPriced ?? unverifiedNa)
    : (verifiedPriced ?? unverifiedPriced ?? verifiedNa ?? unverifiedNa);

  if (best) return new Response(JSON.stringify(best), { headers: { ...CORS, "Content-Type": "application/json" } });

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
      signal: AbortSignal.timeout(ALT_TIMEOUT_MS),
    });
    return res.json();
  };

  try {
    const certData = await altGql("Cert", `query Cert($certNumber: String!) { cert(certNumber: $certNumber) { certNumber gradeNumber gradingCompany asset { id name subject attributes { cardNumber } } } }`, { certNumber: cert });
    const certObj = certData.data?.cert;
    if (!certObj?.asset?.id) {
      return new Response(JSON.stringify({ altPrice: null, assetId: null }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const [assetData, popsData] = await Promise.all([
      altGql("AssetDetails", `query AssetDetails($id: ID!, $tsFilter: TimeSeriesFilter!) { asset(id: $id) { id altValueInfo(tsFilter: $tsFilter) { currentAltValue } } }`, {
        id: certObj.asset.id,
        tsFilter: { gradeNumber: certObj.gradeNumber, gradingCompany: certObj.gradingCompany, autograph: null },
      }),
      altGql("AssetCardPops", `query AssetCardPops($id: ID!) { asset(id: $id) { id cardPops { gradingCompany gradeNumber count } } }`, {
        id: certObj.asset.id,
      }),
    ]);
    const altPrice = assetData.data?.asset?.altValueInfo?.currentAltValue ?? null;
    const cardPops = popsData.data?.asset?.cardPops ?? [];
    const popEntry = cardPops.find(p => p.gradingCompany === certObj.gradingCompany && p.gradeNumber === certObj.gradeNumber);
    const pop = popEntry?.count ?? null;
    const gradeFloor = `${Math.floor(parseFloat(certObj.gradeNumber))}.0`;
    const psaEntry = cardPops.find(p => p.gradingCompany === "PSA" && p.gradeNumber === certObj.gradeNumber)
                  ?? cardPops.find(p => p.gradingCompany === "PSA" && p.gradeNumber === gradeFloor);
    const psaPop = psaEntry?.count ?? null;
    const psaPops = cardPops.filter(p => p.gradingCompany === "PSA").map(p => ({ gradeNumber: p.gradeNumber, count: p.count }));

    // subject = card name; attributes.cardNumber e.g. "069", "RC32", "120/SV-P"
    const cardName = certObj.asset.subject ?? null;
    const cardNumber = normalizeCardNum(certObj.asset.attributes?.cardNumber ?? null);

    // gradeNumber comes back as "10.0" — normalise for PSA grade string
    const psaGrade = `PSA${Math.floor(parseFloat(certObj.gradeNumber))}`;

    let snkrdunk = null;
    if (cardName && cardNumber) {
      const snkrUrl = new URL("http://internal/snkrdunk/price");
      snkrUrl.searchParams.set("keywords", `${cardName} ${cardNumber}`);
      snkrUrl.searchParams.set("grade", psaGrade);
      const snkrRes = await snkrdunkPrice(snkrUrl);
      snkrdunk = await snkrRes.json();
    }

    return new Response(JSON.stringify({
      altPrice,
      pop,
      psaPop,
      psaPops,
      assetId: certObj.asset.id,
      certNumber: certObj.certNumber,
      gradeNumber: certObj.gradeNumber,
      gradingCompany: certObj.gradingCompany,
      psaGrade,
      cardName,
      cardNumber,
      snkrdunk,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ altPrice: null, error: String(e) }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// ALT doesn't index CGC certs, so those cards arrive with no usable name and
// the marketplace title is all we have — which embeds the set and makes search
// unreliable. CGC's own cert page renders the details as <dt>/<dd> pairs, so
// key off the visible labels rather than CSS classes: the labels are the part
// least likely to change. A cert's card identity never changes, so a hit is
// cached at the edge for 30 days — roughly one request per cert, ever.
const CGC_TIMEOUT_MS = 8000;
const CGC_CACHE_TTL = 30 * 24 * 3600;

// Card and set names carry accents ("Pok&eacute;mon"), so cover the Latin-1
// named entities as well as the structural ones.
const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  agrave: "à", egrave: "è", igrave: "ì", ograve: "ò", ugrave: "ù",
  acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô", ucirc: "û",
  auml: "ä", euml: "ë", iuml: "ï", ouml: "ö", uuml: "ü",
  ntilde: "ñ", atilde: "ã", otilde: "õ", ccedil: "ç",
  aring: "å", oslash: "ø", aelig: "æ", szlig: "ß",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Ntilde: "Ñ", Ccedil: "Ç",
};
function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => HTML_ENTITIES[n] ?? HTML_ENTITIES[n.toLowerCase()] ?? m);
}

const stripTags = html => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

async function cgcCert(url) {
  const cert = (url.searchParams.get("cert") || "").trim();
  if (!cert) {
    return new Response(JSON.stringify({ error: "cert param required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://cgc-cache.internal/cert?cert=${encodeURIComponent(cert)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    return new Response(await hit.text(), {
      headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "hit" },
    });
  }

  try {
    const res = await fetch(`https://www.cgccards.com/certlookup/${encodeURIComponent(cert)}/`, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": SNKRDUNK_HEADERS["User-Agent"],
        "Referer": "https://www.cgccards.com/",
      },
      signal: AbortSignal.timeout(CGC_TIMEOUT_MS),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `CGC HTTP ${res.status}`, cert }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const html = await res.text();

    const fields = {};
    for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
      const label = stripTags(m[1]);
      const value = stripTags(m[2]);
      if (label && value && !(label in fields)) fields[label] = value;
    }

    const cardName = fields["Card Name"] ?? null;
    if (!cardName) {
      // Unknown cert, a changed page shape, or a bot challenge — none of which
      // should be cached. Include a sample so the three are distinguishable.
      const looksChallenged = /captcha|are you a robot|cf-challenge|just a moment|checking your browser/i.test(html);
      return new Response(JSON.stringify({
        error: looksChallenged ? "blocked by bot protection" : "card name not found",
        cert,
        fields,
        htmlBytes: html.length,
        sample: stripTags(html).slice(0, 300),
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const payload = JSON.stringify({
      cert,
      cardName,
      cardNumber: fields["Card Number"] ?? null,
      set: fields["Card Set"] ?? null,
      year: fields["Year"] ?? null,
      game: fields["Game"] ?? null,
      language: fields["Language"] ?? null,
      variant: fields["Variant 1"] ?? null,
      grade: fields["Grade"] ?? null,
      collectibleId: (html.match(/collectible\/(\d+)/) || [])[1] ?? null,
    });
    try {
      await cache.put(cacheKey, new Response(payload, {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CGC_CACHE_TTL}` },
      }));
    } catch {}
    return new Response(payload, {
      headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "miss" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), cert }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// Per-card population by cert number (for the Google Sheets integration).
// Resolves the cert via ALT, then returns PSA 8/9/10 counts plus the full
// per-grader pop list. ALT encodes BGS Black Label as a synthetic "10.5"
// grade (10.0 = Pristine 10, 10.5 = Black Label), so bgsBlackLabel reads
// straight from that. Pop data moves slowly, so responses are edge-cached 24h.
async function cardPopsByCert(url, env) {
  const cert = url.searchParams.get("cert") || "";
  if (!cert) {
    return new Response(JSON.stringify({ error: "cert param required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://pops-cache.internal/pops?cert=${encodeURIComponent(cert)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    return new Response(await hit.text(), {
      headers: { ...CORS, "Content-Type": "application/json", "X-Pops-Cache": "hit" },
    });
  }

  const altGql = async (operation, query, variables) => {
    const res = await fetch(`${ALT_BASE}/graphql/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ALT_TOKEN}` },
      body: JSON.stringify({ operationName: operation, query, variables }),
      signal: AbortSignal.timeout(ALT_TIMEOUT_MS),
    });
    return res.json();
  };

  try {
    const certData = await altGql("Cert", `query Cert($certNumber: String!) { cert(certNumber: $certNumber) { certNumber gradeNumber gradingCompany asset { id subject attributes { cardNumber } cardPops { gradingCompany gradeNumber count } } } }`, { certNumber: cert });
    const certObj = certData.data?.cert;
    if (!certObj?.asset?.id) {
      return new Response(JSON.stringify({ error: "cert not found", cert }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const pops = certObj.asset.cardPops ?? [];
    const countOf = (company, grade) => pops.find(p => p.gradingCompany === company && p.gradeNumber === grade)?.count ?? 0;
    const psaCount = grade => countOf("PSA", `${grade}.0`);

    const payload = JSON.stringify({
      cert: certObj.certNumber,
      cardName: certObj.asset.subject ?? null,
      cardNumber: certObj.asset.attributes?.cardNumber ?? null,
      grade: certObj.gradeNumber,
      grader: certObj.gradingCompany,
      psa8: psaCount(8),
      psa9: psaCount(9),
      psa10: psaCount(10),
      // ALT encodes the top BGS tier as a synthetic "10.5" grade: 10.0 is the
      // regular Pristine 10, 10.5 is the Black Label (all four 10 subgrades).
      bgs10: countOf("BGS", "10.0"),
      bgsBlackLabel: countOf("BGS", "10.5"),
      pops,
    });
    try {
      await cache.put(cacheKey, new Response(payload, {
        headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=86400" },
      }));
    } catch {}
    return new Response(payload, {
      headers: { ...CORS, "Content-Type": "application/json", "X-Pops-Cache": "miss" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// Upstream calls get a hard deadline: without one, a hung CardLadder request
// blocks a whole client-side batch indefinitely (Promise.all waits for the
// slowest), which is what made long lists appear to hang forever.
const CL_TIMEOUT_MS = 8000;

// Firebase idToken cache — survives across requests within a worker isolate.
// Tokens last 1 hour; refresh via refreshToken when possible, else re-sign-in.
let clAuth = { token: null, refreshToken: null, exp: 0 };
// Dedupe concurrent token requests within an isolate so a burst of price
// lookups doesn't fire several signInWithPassword calls at once (Firebase
// rate-limits repeated sign-ins for the same account).
let clAuthPromise = null;

async function cardladderToken(env) {
  const now = Date.now();
  if (clAuth.token && now < clAuth.exp - 60_000) return clAuth.token;
  if (clAuthPromise) return clAuthPromise;

  clAuthPromise = (async () => {
    if (clAuth.refreshToken) {
      try {
        const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${CL_FIREBASE_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: clAuth.refreshToken }),
          signal: AbortSignal.timeout(CL_TIMEOUT_MS),
        });
        if (res.ok) {
          const d = await res.json();
          clAuth = { token: d.id_token, refreshToken: d.refresh_token, exp: Date.now() + parseInt(d.expires_in) * 1000 };
          return clAuth.token;
        }
      } catch {}
    }

    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CL_FIREBASE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (env.CARDLADDER_EMAIL || "").trim(),
        password: (env.CARDLADDER_PASSWORD || "").trim(),
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(CL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CardLadder auth failed: HTTP ${res.status} ${body}`);
    }
    const d = await res.json();
    clAuth = { token: d.idToken, refreshToken: d.refreshToken, exp: Date.now() + parseInt(d.expiresIn) * 1000 };
    return clAuth.token;
  })();

  try {
    return await clAuthPromise;
  } finally {
    clAuthPromise = null;
  }
}

// Project hash for CardLadder's Cloud Run v2 functions (region "uc" = us-central1).
// httpcertinfo/httpcardestimate (the originally documented chain) no longer
// exist; httpbuildcollectioncard (card info + pop) and httpprofilesales
// (recent eBay sales) work directly from {cert, grader} without a gemRateId.
const CL_HASH = "zzvl7ri3bq";

// When CardLadder returns its daily quota error, skip further CardLadder
// calls within this isolate for a while rather than re-auth + re-fetch on
// every card, since retries are guaranteed to fail until the quota resets.
let clQuotaExceededUntil = 0;
const isQuotaError = msg => /RESOURCE_EXHAUSTED|Daily request limit/i.test(msg);

// Successful CL responses are cached at the edge for 12h — sales data doesn't
// move fast enough to matter, and every cache hit is CardLadder quota saved
// across all users/sessions/isolates.
const CL_CACHE_TTL_SECONDS = 12 * 60 * 60;

async function cardladderPrice(url, env) {
  const cert = url.searchParams.get("cert") || "";
  const grader = (url.searchParams.get("grader") || "psa").toLowerCase();
  if (!cert) {
    return new Response(JSON.stringify({ error: "cert param required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const json = obj => new Response(JSON.stringify(obj), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });

  const cache = caches.default;
  const cacheKey = new Request(`https://cl-cache.internal/price?cert=${encodeURIComponent(cert)}&grader=${encodeURIComponent(grader)}`);
  // fresh=1 (the UI's "Refresh CL" button) bypasses the cache read but still
  // overwrites the cached entry with the new result.
  const fresh = url.searchParams.get("fresh") === "1";
  const cached = fresh ? null : await cache.match(cacheKey);
  if (cached) {
    return new Response(await cached.text(), {
      headers: { ...CORS, "Content-Type": "application/json", "X-CL-Cache": "hit" },
    });
  }

  if (Date.now() < clQuotaExceededUntil) {
    return json({ clPrice: null, error: "CardLadder daily request limit reached", quotaExceeded: true });
  }

  const jsonAndCache = async obj => {
    const payload = JSON.stringify(obj);
    try {
      await cache.put(cacheKey, new Response(payload, {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CL_CACHE_TTL_SECONDS}` },
      }));
    } catch {}
    return new Response(payload, {
      headers: { ...CORS, "Content-Type": "application/json", "X-CL-Cache": "miss" },
    });
  };

  try {
    const token = await cardladderToken(env);
    const clPostOnce = async (fn, data) => {
      const res = await fetch(`https://${fn}-${CL_HASH}-uc.a.run.app`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Referer": "https://app.cardladder.com/",
        },
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(CL_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`${fn} HTTP ${res.status} ${errBody}`);
      }
      const body = await res.json();
      if (body.error) throw new Error(`${fn} error: ${JSON.stringify(body.error)}`);
      return body.result ?? null;
    };
    // CardLadder rate-limits under concurrent load (HTTP 429) — retry once
    // after a short delay, unless it's the daily quota (won't recover on retry).
    const clPost = async (fn, data) => {
      try {
        return await clPostOnce(fn, data);
      } catch (e) {
        const msg = String(e);
        if (isQuotaError(msg)) {
          clQuotaExceededUntil = Date.now() + 60 * 60 * 1000;
          throw e;
        }
        if (!/HTTP 429/.test(msg)) throw e;
        await new Promise(r => setTimeout(r, 500));
        return clPostOnce(fn, data);
      }
    };

    // Only httpprofilesales is needed — pop/description used to come from a
    // second call (httpbuildcollectioncard) but the UI gets pop from ALT,
    // so skipping it halves CardLadder quota spend per card.
    const salesRes = await clPost("httpprofilesales", { cert, grader });

    const sales = salesRes?.sales ?? [];
    if (!sales.length) {
      return jsonAndCache({ clPrice: null, salesCount: 0 });
    }

    // Same windowed-average approach as SNKRDUNK: prefer sales from the last
    // week (with outlier filtering), widen to 3 weeks if too few, and for
    // low-movement cards with nothing recent fall back to the single most
    // recent sale rather than averaging stale sales from different eras.
    const now = Date.now();
    const withAge = sales.map(s => ({ price: Number(s.price), age: now - new Date(s.date).getTime() }));
    const inWeekRaw = withAge.filter(s => s.age <= ONE_WEEK_MS);
    const inThreeWeeks = withAge.filter(s => s.age <= THREE_WEEK_MS);
    let inWeek = inWeekRaw;
    if (inWeekRaw.length >= 2) {
      const med = priceMedian(inWeekRaw.map(s => s.price));
      inWeek = inWeekRaw.filter(s => s.price <= med * 3);
    }
    const useItems = (inWeek.length >= 2 ? inWeek : inThreeWeeks.length >= 1 ? inThreeWeeks : [withAge[0]]).slice(0, 3);
    const clPrice = useItems.reduce((sum, s) => sum + s.price, 0) / useItems.length;

    return jsonAndCache({
      clPrice: Math.round(clPrice * 100) / 100,
      avgCount: useItems.length,
      lastSalePrice: Number(sales[0].price),
      lastSaleDate: sales[0].date,
      salesCount: sales.length,
    });
  } catch (e) {
    const msg = String(e);
    return json({ clPrice: null, error: msg, quotaExceeded: isQuotaError(msg) });
  }
}

async function phygitalsListings(workerUrl) {
  const upstream = await fetch(`https://api.phygitals.com/api/marketplace/marketplace-listings${workerUrl.search}`, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://www.phygitals.com",
      "Referer": "https://www.phygitals.com/",
    },
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function beezieListings(request) {
  const body = await request.text();
  const upstream = await fetch("https://api.beezie.com/dropItems/byCategory", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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
