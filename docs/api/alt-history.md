# ALT value history API

Daily ALT valuation history for a graded card, by certification number.

**Base URL:** `https://cryptjapan-proxy.mew-860.workers.dev`

No authentication. CORS is open (`Access-Control-Allow-Origin: *`), so it can be
called directly from a browser.

---

## Single card

```
GET /alt-history?cert=112689981
```

```json
{
  "cert": "112689981",
  "assetId": "6d41818c-e279-4cbf-8c12-a3026d51aace",
  "subject": "Sylveon V",
  "grade": "10.0",
  "grader": "PSA",
  "currentValue": 172.97477028586647,
  "points": 409,
  "history": [
    { "date": "2025-08-22", "value": 127.73780837773272 },
    { "date": "2025-08-23", "value": 129.2958067708199 }
  ],
  "window": "startDate=2000-01-01",
  "fields": { "path": ["pricingData", "altValueTimeSeries"], "mode": "parallel" }
}
```

| Field | Meaning |
|---|---|
| `cert` | The certification number you asked for |
| `assetId` | ALT's internal id for the card. Links to `https://alt.xyz/itm/{assetId}/research` |
| `subject` | Card name, e.g. "Sylveon V" |
| `grade` / `grader` | The grade whose series this is, e.g. `10.0` / `PSA` |
| `currentValue` | Today's ALT value, USD |
| `points` | Number of points in `history` |
| `history` | `[{ date: "YYYY-MM-DD", value: Number }]`, oldest first, one point per day |
| `window` | Which time window was requested upstream — informational |
| `fields` | Where the series was found in ALT's schema — diagnostic, ignore in app code |

## Several cards

```
GET /alt-history?certs=112689981,112689982,112689983
```

```json
{
  "count": 3,
  "withHistory": 3,
  "results": [ { "cert": "112689981", "history": [] } ]
}
```

Each entry in `results` has the same shape as a single-card response. Maximum
**20 certs per request**, resolved 5 at a time.

---

## Real sales

```
GET /alt-history?cert=112689981&sales=1
```

Adds ALT's recorded transactions for the card alongside the value series. They
come from the same upstream call, so asking for them costs nothing extra.

```json
{
  "currentValue": 27113.77713969713,
  "salesCount": 8,
  "sales": [
    { "date": "2026-10-01", "price": 40000, "auctionHouse": "eBay" },
    { "date": "2026-07-26", "price": 22200, "auctionHouse": "PWCC Weekly Auctions" },
    { "date": "2021-08-15", "price": 1800, "auctionHouse": "eBay" }
  ],
  "salesFilter": { "gradeNumber": "10.0", "gradingCompany": "PSA" }
}
```

Sales are newest first. Each carries `date`, `price` (a number, USD) and
`auctionHouse`. `salesFilter` shows the filter sent for this card — it always carries that
card's own grade and grader, and is useful only when a card returns nothing.

**Sales reach back much further than the value series.** The index covers about
13 months; transactions go back years, 2021 in the example above. For long-range
history, sales are the better source.

Not every card has them. A modern bulk card may return `salesCount: 0` while a
vintage card returns a full record — that is ALT's coverage, not an error.

Sales and the value series come from the same upstream call, so there is no
request to save by splitting them. If you only want sales, add `history=0`:
the response drops the series (a few hundred points per card) and keeps
`currentValue`, and on a cold cache it also skips discovering the series'
shape.

```
GET /alt-history?cert=112689981&sales=1&history=0
```

Sales are far sparser than the daily series — a card may have hundreds of index
points and a handful of actual sales — so plot the series as the line and the
sales as markers on it.

## Parameters

| Parameter | Required | Notes |
|---|---|---|
| `cert` | one of | A single certification number. 4–20 chars, `A–Z a–z 0–9 -` |
| `certs` | one of | Comma-separated list, max 20 |
| `grade` | no | Override which grade to fetch, e.g. `9` or `9.5`. Defaults to the cert's own. Written back in ALT's format, so `10` and `10.0` behave the same |
| `grader` | no | Override the grading company, e.g. `BGS`. Defaults to the cert's own |
| `sales` | no | `1` also returns ALT's recorded transactions for the card |
| `history` | no | `0` omits the value series. Use with `sales=1` for sales only |
| `fresh` | no | `1` bypasses the cache and re-runs schema discovery. Slow; for debugging |

## Errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "pass ?cert=…"}` | Missing or malformed cert |
| 400 | `{"error": "at most 20 certs per request"}` | Too many certs |
| 404 | `{"cert": "…", "history": null, "error": "cert not found on ALT"}` | ALT doesn't know that cert |
| 500 | `{"error": "…"}` | Upstream failure |

In a batch, a cert that fails returns its own entry with `history: null` and an
`error`; the rest still succeed. If a request hits its upstream call limit, the
remaining certs come back with a budget error and a top-level `note` — ask for
them again, since the ones that succeeded are now cached.

## Caching and limits

- Each cert is cached **6 hours**; `X-Edge-Cache: hit|miss` says which.
- A repeated batch of already-cached certs costs **no** upstream calls.
- A first call for 20 uncached certs can leave one or two short of the request's
  call ceiling. They resolve on the next call.

## About the data

- **Source:** ALT's own valuation (`alt.xyz`), the same number their site shows.
- **Currency:** USD.
- **Range:** roughly the last **13 months**, daily. Asking for a wider window
  returns the same series, so this is ALT's limit, not a restriction here.
- **`history` is a smoothed index, not sales.** Points are ALT's modelled value,
  not individual transactions — good for trend, wrong for "it sold for this".
  For actual transactions use `sales=1`.
- **The last few points often repeat.** ALT carries the most recent value
  forward, so day-over-day change can read as 0%. Compare across a week or more.
- A card with few comparable sales will have a flatter, more extrapolated line.

## Examples

```js
// one card
const r = await fetch("https://cryptjapan-proxy.mew-860.workers.dev/alt-history?cert=112689981");
const { subject, currentValue, history } = await r.json();

// a collection, 20 at a time
async function histories(certs) {
  const out = [];
  for (let i = 0; i < certs.length; i += 20) {
    const batch = certs.slice(i, i + 20).join(",");
    const res = await fetch(`https://cryptjapan-proxy.mew-860.workers.dev/alt-history?certs=${batch}`);
    out.push(...(await res.json()).results);
  }
  return out;
}
```

```
# percentage change over the last 90 days, per card
value_now = history[-1].value
value_then = history[-91].value
change = (value_now - value_then) / value_then * 100
```

## Worth knowing before you build on it

The endpoint is backed by one shared Cloudflare Worker and one ALT account's
credentials. It has no authentication and no rate limiting, and the URL will be
visible in any page that calls it. For a public site, consider asking for an
origin allowlist and a per-IP limit first.

ALT keeps about 13 months. If you want history beyond that, record a daily
snapshot of `currentValue` into your own store as you go — that accumulates
past ALT's horizon and survives any change on their side.
