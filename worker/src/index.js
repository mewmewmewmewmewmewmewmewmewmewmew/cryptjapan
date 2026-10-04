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

    if (path === "/cardladder-price") {
      return cardladderPrice(url, env);
    }

    if (path === "/alt-schema") {
      return altSchemaProbe(url, env);
    }

    if (path === "/alt-history") {
      return altHistory(url, env).catch(e => new Response(
        JSON.stringify({ error: String(e?.message ?? e) }, null, 1),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }));
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

    if (path.startsWith("/phygitals/orpc/")) {
      return phygitalsOrpc(path.slice("/phygitals/orpc/".length), url);
    }

    if (path === "/phygitals/probe") {
      return phygitalsProbe(url);
    }

    if (path === "/courtyard/probe") {
      return courtyardProbe();
    }

    if (path === "/courtyard/search") {
      return courtyardSearch(request);
    }

    if (path.startsWith("/marketplace") || path.startsWith("/cart") || path.startsWith("/cards/")) {
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

// Diagnostic. altValueInfo takes a TimeSeriesFilter and we only ever read
// currentAltValue from it, so the series behind that value is probably already
// one selection away. Introspect the schema to find out what the type actually
// offers; if introspection is disabled, ask for a field that cannot exist and
// read the validation error, which names the type and often suggests the real
// field. Runs here rather than in the page because only the worker holds the
// ALT token.
// Cloudflare allows a limited number of subrequests per invocation, and
// exceeding it throws rather than failing a call — which is how an over-eager
// probe sequence turned into a 1101. Every upstream call is counted and the
// search stops while there is still room to answer.
class SubrequestBudget {
  constructor(max = 32, parent = null) { this.max = max; this.used = 0; this.parent = parent; }
  take() {
    if (this.used >= this.max) return false;
    if (this.parent && !this.parent.take()) return false;
    this.used++;
    return true;
  }
  get exhausted() { return this.used >= this.max || !!this.parent?.exhausted; }
  // A sub-budget that draws on this one but stops sooner, so an open-ended
  // search can't spend what the actual lookups still need.
  child(max) { return new SubrequestBudget(max, this); }
}

async function altGraphql(operation, query, variables, env, budget = null) {
  if (budget && !budget.take()) {
    return { status: 0, body: { errors: [{ message: "subrequest budget exhausted" }] }, budgetExhausted: true };
  }
  const res = await fetch(`${ALT_BASE}/graphql/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ALT_TOKEN}` },
    body: JSON.stringify({ operationName: operation, query, variables }),
    signal: AbortSignal.timeout(ALT_TIMEOUT_MS),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, raw: text.slice(0, 300) }; }
}

const INTROSPECT = `query IntrospectType($name: String!) {
  __type(name: $name) {
    name kind
    fields {
      name
      args { name }
      type { name kind ofType { name kind ofType { name kind } } }
    }
  }
}`;

async function altSchemaProbe(workerUrl, env) {
  const out = {};
  const unwrap = t => t?.name ?? t?.ofType?.name ?? t?.ofType?.ofType?.name ?? null;
  const summarise = type => (type?.fields ?? []).map(f =>
    `${f.name}${f.args?.length ? `(${f.args.map(a => a.name).join(",")})` : ""}: ${unwrap(f.type) ?? "?"}`);

  // 1. What does Asset offer, and what type does altValueInfo return?
  const asset = await altGraphql("IntrospectType", INTROSPECT, { name: "Asset" }, env);
  out.introspectionEnabled = !!asset.body?.data?.__type;
  if (asset.body?.errors) out.assetErrors = asset.body.errors.map(e => e.message).slice(0, 3);

  if (out.introspectionEnabled) {
    const assetType = asset.body.data.__type;
    const fields = summarise(assetType);
    out.assetFields = fields;
    out.assetFieldsOfInterest = fields.filter(f => /value|sale|price|history|series|comp|chart|trend|market/i.test(f));

    const valueField = (assetType.fields ?? []).find(f => f.name === "altValueInfo");
    const valueTypeName = unwrap(valueField?.type);
    out.altValueInfoType = valueTypeName;
    if (valueTypeName) {
      const vt = await altGraphql("IntrospectType", INTROSPECT, { name: valueTypeName }, env);
      out.altValueInfoFields = summarise(vt.body?.data?.__type);
    }
    // The filter's own shape says what windows can be asked for.
    const tsf = await altGraphql("IntrospectType", INTROSPECT, { name: "TimeSeriesFilter" }, env);
    out.timeSeriesFilterType = tsf.body?.data?.__type
      ? (tsf.body.data.__type.inputFields ?? tsf.body.data.__type.fields ?? []).map(f => f.name)
      : "not introspectable";
    return new Response(JSON.stringify(out, null, 1), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // 2. Introspection is off: make the server tell us through a validation error.
  const cert = workerUrl.searchParams.get("cert") || "00000000";
  const bogus = `query Cert($certNumber: String!, $tsFilter: TimeSeriesFilter!) {
    cert(certNumber: $certNumber) {
      asset { altValueInfo(tsFilter: $tsFilter) { __typename zzUnknownFieldProbe } }
    }
  }`;
  const probe = await altGraphql("Cert", bogus, {
    certNumber: cert,
    tsFilter: { gradeNumber: "10", gradingCompany: "PSA", autograph: null },
  }, env);
  out.validationErrors = (probe.body?.errors ?? []).map(e => e.message).slice(0, 5);
  if (!out.validationErrors.length) out.rawProbe = probe.raw ?? JSON.stringify(probe.body).slice(0, 400);
  return new Response(JSON.stringify(out, null, 1), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── ALT value history ────────────────────────────────────────────────
// A standalone endpoint for other projects: give it a cert, get back the
// current ALT value and the series behind it. The field names on ALT's value
// type are not documented and not visible from here, so the shape is
// discovered by introspection on first use and cached — the alternative was
// hard-coding a guess that silently returns nothing when wrong.
const ALT_HISTORY_TTL = 6 * 3600;
const ALT_SHAPE_TTL = 24 * 3600;
const HISTORY_FIELD_RE = /history|series|values|points|trend|chart/i;
const DATE_FIELD_RE = /date|time|timestamp|day|period|week|month/i;
const VALUE_FIELD_RE = /value|price|amount|avg|average|median|close/i;

function unwrapType(t) {
  let cur = t, name = null, isList = false;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.kind === "LIST") isList = true;
    if (cur.name) name = cur.name;
    cur = cur.ofType;
  }
  return { name, isList };
}

async function discoverAltHistoryShape(env, budget = null) {
  const valueType = await altGraphql("IntrospectType", INTROSPECT, { name: "AltValueInfo" }, env, budget);
  const fields = valueType.body?.data?.__type?.fields;
  if (!fields) {
    return { error: valueType.body?.errors?.[0]?.message ?? "AltValueInfo is not introspectable" };
  }

  // A series is a list field; prefer one whose name says so. Keep the field and
  // its element type apart — the query needs the field, introspection the type.
  const lists = fields
    .map(f => ({ field: f.name, ...unwrapType(f.type) }))
    .filter(f => f.isList && f.field && f.name);
  const ordered = [...lists.filter(f => HISTORY_FIELD_RE.test(f.field)), ...lists];
  const seen = new Set();
  for (const candidate of ordered.slice(0, 6)) {
    if (seen.has(candidate.field)) continue;
    seen.add(candidate.field);
    const pointType = await altGraphql("IntrospectType", INTROSPECT, { name: candidate.name }, env, budget);
    const pointFields = pointType.body?.data?.__type?.fields;
    if (!pointFields?.length) continue;
    const names = pointFields.map(f => f.name);
    const dateField = names.find(n => DATE_FIELD_RE.test(n));
    const valueField = names.find(n => VALUE_FIELD_RE.test(n));
    if (dateField && valueField) {
      return { listField: candidate.field, pointType: candidate.name,
               dateField, valueField, pointFields: names.slice(0, 12) };
    }
  }
  return { error: "no list field on AltValueInfo carries a date and a value",
           listFields: lists.map(f => `${f.field}: [${f.name}]`).slice(0, 10),
           allFields: fields.map(f => f.name).slice(0, 20) };
}

// Introspection is disabled on ALT, but a GraphQL server still describes
// itself through validation errors, which are produced before anything
// executes. Asking for a field bare says whether it exists and, if it is an
// object, names its type ("must have a selection of subfields"); asking for one
// that doesn't exist often returns "Did you mean …" with the real neighbours.
// So probe a handful of plausible names and read the replies.
const LIST_PROBES = ["history", "valueHistory", "altValueHistory", "altValueTimeSeries",
                     "timeSeries", "series", "points", "dataPoints", "values", "trend", "chart",
                     "altValues", "valuesByDate", "historicalValues", "historical", "graph",
                     "priceGraph", "sparkline", "movement", "priceHistory", "valueOverTime"];
// A series is as likely to hang off the asset as off its value summary —
// sales and comps in particular belong to the card, not to one grade's value.
const ASSET_LIST_PROBES = ["pricingData", "salesHistory", "saleHistory", "sales", "recentSales",
                           "comps", "comparables", "priceHistory", "valueHistory", "history",
                           "timeSeries", "transactions", "marketData", "priceData", "chart"];
const DATE_PROBES = ["date", "timestamp", "time", "day", "periodStart", "startDate", "x"];
const VALUE_PROBES = ["value", "altValue", "price", "amount", "avgPrice", "median", "close", "y"];
const NEEDS_SUBFIELDS_RE = /must have a selection of subfields/i;
// The opposite complaint: the field is a scalar, or a list of them. Note this
// contains "must not have a selection", which the needs-subfields pattern must
// not be allowed to match — that near-miss is why 'date' and 'value' were
// reported as existing under a [Float].
const NO_SUBFIELDS_RE = /must not have a selection since type '([^']+)' has no subfields/i;
// A series can arrive as parallel arrays — the values in one field, their dates
// in a sibling — rather than a list of records.
const DATE_ARRAY_PROBES = ["dates", "timestamps", "times", "labels", "days", "periods",
                           "xAxis", "x", "dateLabels", "startDates", "dateRange"];
const VALUE_ARRAY_PROBES = ["data", "values", "prices", "amounts", "y"];
const SUGGESTION_RE = /Did you mean ([^?]+)\?/i;
// ALT quotes type names with apostrophes, graphql-js with double quotes.
const TYPE_IN_ERROR_RE = /of type ['"]\[?([A-Za-z0-9_]+)/;

// ALT quotes suggestions with apostrophes ("Did you mean 'pricingData'?"), not
// the double quotes graphql-js uses by default. Missing that threw away the
// one thing the server volunteers about its own schema.
function errorSuggestions(message) {
  const m = SUGGESTION_RE.exec(message || "");
  if (!m) return [];
  return [...m[1].matchAll(/[`'"]([A-Za-z0-9_]+)[`'"]/g)].map(x => x[1]);
}

// Variables a probe may reference; declarations are emitted only for the ones
// the selection actually uses, since an unused variable is a validation error.
const ALT_VAR_TYPES = { tsFilter: "TimeSeriesFilter!", mtf: "MarketTransactionFilter!" };
// Two phrasings for the same thing, and ALT emits both:
//   Argument 'x' of required type 'T!' was not provided.
//   Field 'f' argument 'x' of type 'T!' is required, but it was not provided.
const REQUIRED_ARG_RE = /[Aa]rgument '([A-Za-z0-9_]+)' of (?:required )?type '([A-Za-z0-9_\[\]!]+)'/g;
const REQUIRED_INPUT_RE = /Field '([A-Za-z0-9_]+)' of required type '([A-Za-z0-9_\[\]!]+)' was not provided/g;

async function probeAltSelection(selection, env, scope = "value", vars = {}, budget = null) {
  const used = Object.keys(ALT_VAR_TYPES).filter(v => selection.includes(`$${v}`));
  const decls = used.map(v => `$${v}: ${ALT_VAR_TYPES[v]}`).join(", ");
  const inner = scope === "asset"
    ? selection
    : `altValueInfo(tsFilter: $tsFilter) { ${selection} }`;
  const declList = scope === "asset"
    ? (decls ? `, ${decls}` : "")
    : `, $tsFilter: TimeSeriesFilter!${used.filter(v => v !== "tsFilter").map(v => `, $${v}: ${ALT_VAR_TYPES[v]}`).join("")}`;
  const query = `query Cert($certNumber: String!${declList}) {
    cert(certNumber: $certNumber) { asset { ${inner} } }
  }`;
  const variables = { certNumber: "00000000", ...vars };
  if (scope !== "asset" && variables.tsFilter == null) {
    variables.tsFilter = { gradeNumber: "10", gradingCompany: "PSA", autograph: null };
  }
  const res = await altGraphql("Cert", query, variables, env, budget);
  if (res.budgetExhausted) return { valid: false, error: null, errors: [], exhausted: true };
  const errors = (res.body?.errors ?? []).map(e => e.message);
  const invalid = errors.find(e =>
    /Cannot query field|must (not )?have a selection|is required|was not provided|Unknown argument/i.test(e));
  return { valid: !invalid, error: invalid ?? null, errors };
}

// A field can demand arguments before it will answer. The server names them,
// and sending an empty object for one names its required members in turn, so a
// usable argument can be assembled without documentation.
async function buildRequiredArgs(fieldName, errors, env, tsFilter, budget) {
  const args = {};
  const names = [...errors.join(" ").matchAll(REQUIRED_ARG_RE)].map(m => [m[1], m[2]]);
  for (const [arg] of names) {
    if (arg === "tsFilter") { args.tsFilter = "$tsFilter"; continue; }
    // Probe with an empty object to learn what the input type requires.
    const call = `${fieldName}(${[...Object.keys(args).map(a => `${a}: ${args[a]}`), `${arg}: $mtf`].join(", ")}) { __typename }`;
    const res = await probeAltSelection(call, env, "asset", { mtf: {}, tsFilter }, budget);
    const required = [...res.errors.join(" ").matchAll(REQUIRED_INPUT_RE)].map(m => [m[1], m[2]]);
    const value = {};
    for (const [field, type] of required) {
      if (/gradeNumber/i.test(field)) value[field] = tsFilter.gradeNumber;
      else if (/grad(ing)?Company|grader/i.test(field)) value[field] = tsFilter.gradingCompany;
      else if (/^\[/.test(type)) value[field] = [];
      else if (/Boolean/i.test(type)) value[field] = false;
      else if (/Int|Float/i.test(type)) value[field] = 0;
      else value[field] = null;
    }
    args[arg] = "$mtf";
    args.__mtfValue = value;
  }
  return args;
}

function callWithArgs(fieldName, args) {
  const pairs = Object.entries(args).filter(([k]) => !k.startsWith("__"));
  return pairs.length ? `${fieldName}(${pairs.map(([k, v]) => `${k}: ${v}`).join(", ")})` : fieldName;
}

// Walks down from a container looking for a list whose elements carry a
// date-like and a value-like field. A field that exists but reads as neither is
// treated as another container rather than mistaken for a leaf — which is how
// "data" came to be read as a date and "grade" as a price.
function nestSelection(parts, inner) {
  return parts.reduceRight((acc, f) => `${f} { ${acc} }`, inner);
}

async function findSeriesUnder(parts, env, scope, vars, tried, budget, depth = 0) {
  if (depth > 2 || budget.exhausted) return null;
  const probe = c => probeAltSelection(nestSelection(parts, c), env, scope, vars, budget);
  const label = parts.join(" > ");

  // Returns { leaf } for a plausible scalar, { container } for a field that
  // exists or needs subfields but can't be the value we're after.
  const classify = async (candidates, plausible) => {
    const containers = [];
    for (const c of candidates) {
      const { valid, error } = await probe(c);
      tried.push(`${label}.${c}: ${valid ? "exists" : (error ?? "").slice(0, 70)}`);
      if (valid && plausible.test(c)) return { leaf: c, containers };
      if (valid) { containers.push(c); continue; }
      if (NEEDS_SUBFIELDS_RE.test(error ?? "")) { containers.push(c); continue; }
      for (const sug of errorSuggestions(error)) {
        const check = await probe(sug);
        tried.push(`${label}.${sug} (suggested): ${check.valid ? "exists" : (check.error ?? "").slice(0, 50)}`);
        if (check.valid && plausible.test(sug)) return { leaf: sug, containers };
        if (check.valid || NEEDS_SUBFIELDS_RE.test(check.error ?? "")) containers.push(sug);
      }
    }
    return { leaf: null, containers };
  };

  // Parallel arrays: a scalar list of values here, with dates in a sibling.
  // A scalar list selects cleanly on its own; an object list demands subfields
  // and a missing field is rejected, so "selectable as-is" identifies it.
  for (const c of VALUE_ARRAY_PROBES) {
    const { valid, error } = await probe(c);
    tried.push(`${label}.${c}: ${valid ? "exists (scalar list)" : (error ?? "").slice(0, 70)}`);
    if (!valid) continue;
    // Anchors are worth two calls either way: with both ends the spacing is
    // measured across the points rather than assumed to be daily.
    const anchors = {};
    for (const a of ["startDate", "endDate"]) {
      const r = await probeAltSelection(nestSelection(parts, a), env, scope, vars, budget);
      tried.push(`${label}.${a}: ${r.valid ? "exists (anchor)" : (r.error ?? "").slice(0, 50)}`);
      if (r.valid) anchors[a === "startDate" ? "start" : "end"] = a;
    }
    for (const dc of DATE_ARRAY_PROBES) {
      const dr = await probeAltSelection(nestSelection(parts, dc), env, scope, vars, budget);
      tried.push(`${label}.${dc}: ${dr.valid ? "exists" : (dr.error ?? "").slice(0, 60)}`);
      if (dr.valid) return { path: [], mode: "parallel", valueField: c, dateField: dc, anchors };
      for (const sug of errorSuggestions(dr.error)) {
        if (sug === c) continue;
        const check = await probeAltSelection(nestSelection(parts, sug), env, scope, vars, budget);
        tried.push(`${label}.${sug} (suggested): ${check.valid ? "exists" : "no"}`);
        if (check.valid) return { path: [], mode: "parallel", valueField: c, dateField: sug, anchors };
      }
      if (budget.exhausted) break;
    }
    // No parallel date array: the anchors date the points on their own.
    return { path: [], mode: "parallel", valueField: c, dateField: null, anchors };
  }

  const d = await classify(DATE_PROBES, DATE_FIELD_RE);
  if (d.leaf) {
    const v = await classify(VALUE_PROBES, VALUE_FIELD_RE);
    if (v.leaf) return { path: [], mode: "objects", dateField: d.leaf, valueField: v.leaf };
  }

  // Not at this level: step into any container seen here, or the usual names.
  const seen = new Set();
  for (const c of [...d.containers, ...LIST_PROBES.slice(0, 6)]) {
    if (seen.has(c)) continue;
    seen.add(c);
    const { valid, error } = await probe(c);
    if (!valid && !NEEDS_SUBFIELDS_RE.test(error ?? "")) continue;
    const found = await findSeriesUnder([...parts, c], env, scope, vars, tried, budget, depth + 1);
    if (found) return { path: [c, ...found.path], dateField: found.dateField, valueField: found.valueField };
  }
  return null;
}

// ALT has already told us where its series lives: asset.pricingData, behind a
// tsFilter and a marketTransactionFilter, with altValueTimeSeries inside it.
// Starting there costs a handful of calls instead of a blind sweep, and the
// general search stays as a fallback for when that stops being true.
const ALT_KNOWN_SERIES = { scope: "asset", field: "pricingData", inner: ["altValueTimeSeries"] };

async function tryKnownSeries(env, tsFilter, budget, tried) {
  const { field, inner, scope } = ALT_KNOWN_SERIES;
  const first = await probeAltSelection(field, env, scope, { tsFilter }, budget);
  if (first.exhausted) return null;
  if (!/is required|was not provided|must have a selection/i.test(first.error ?? "")) {
    tried.push(`known.${field}: ${(first.error ?? "unexpectedly valid").slice(0, 70)}`);
    return null;
  }
  const args = await buildRequiredArgs(field, first.errors, env, tsFilter, budget);
  const call = callWithArgs(field, args);
  const vars = { tsFilter, mtf: args.__mtfValue ?? {} };

  for (const path of [inner, [...inner, "data"], []]) {
    const parts = [call, ...path];
    const found = await findSeriesUnder(parts, env, scope, vars, tried, budget);
    if (found) {
      return { listField: field, call, path: [field, ...path, ...found.path],
               mode: found.mode ?? "objects", anchors: found.anchors ?? null,
               dateField: found.dateField, valueField: found.valueField,
               scope, args: { mtf: vars.mtf }, discoveredBy: "known path", tried };
    }
    if (budget.exhausted) break;
  }
  return null;
}

// Our 409 points may be ALT's whole record or merely the window the filter
// defaults to. Work out how to ask for everything: a start date far enough back
// if the filter takes one, otherwise a period enum set to its widest value —
// and GraphQL names an enum's real values when it rejects a bad one.
const ENUM_VALUE_RE = /Did you mean[^?]*\?|Value '[^']*' does not exist in '([A-Za-z0-9_]+)' enum/i;
const WIDE_PERIODS = ["ALL", "ALL_TIME", "MAX", "LIFETIME", "FIVE_YEARS", "FIVE_YEAR", "THREE_YEARS"];
const EARLY_DATE = "2000-01-01";

async function findWidestWindow(env, tsFilter, budget) {
  const test = async extra => {
    const res = await altGraphql("Cert", `query Cert($certNumber: String!, $tsFilter: TimeSeriesFilter!) {
      cert(certNumber: $certNumber) { asset { altValueInfo(tsFilter: $tsFilter) { currentAltValue } } }
    }`, { certNumber: "00000000", tsFilter: { ...tsFilter, ...extra } }, env, budget);
    const errors = (res.body?.errors ?? []).map(e => e.message);
    return {
      ok: !errors.some(e => NOT_DEFINED_RE.test(e) || /Expected type|does not exist in|cannot represent|got invalid value/i.test(e)),
      errors,
    };
  };

  const byDate = await test({ startDate: EARLY_DATE });
  if (byDate.ok) return { extra: { startDate: EARLY_DATE }, how: `startDate=${EARLY_DATE}` };

  // Does a period-style member exist, and what values does it take?
  for (const field of ["period", "timePeriod", "range"]) {
    if (budget.exhausted) break;
    const junk = await test({ [field]: "ZZ_PROBE" });
    if (junk.errors.some(e => NOT_DEFINED_RE.test(e) && e.includes(field))) continue;
    // Exists. Its rejection of a bad value usually names the real ones.
    const suggested = junk.errors.flatMap(e => errorSuggestions(e))
      .concat(junk.errors.flatMap(e => [...e.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1])));
    const ordered = [...new Set([...suggested, ...WIDE_PERIODS])]
      .filter(v => !/^(ZZ_PROBE|TIME|ENUM|GRAPHQL)$/.test(v));
    for (const value of ordered.slice(0, 6)) {
      if (budget.exhausted) break;
      const attempt = await test({ [field]: value });
      if (attempt.ok) return { extra: { [field]: value }, how: `${field}=${value}` };
    }
  }
  return { extra: null, how: "ALT's default window (no wider one offered)" };
}

async function probeAltHistoryShape(env, budget, deep = false) {
  const tried = [];
  const tsFilter = { gradeNumber: "10", gradingCompany: "PSA", autograph: null };

  const known = await tryKnownSeries(env, tsFilter, budget, tried);
  if (known) {
    const window = await findWidestWindow(env, tsFilter, budget);
    return { ...known, windowExtra: window.extra, windowHow: window.how };
  }
  if (budget.exhausted) {
    return { error: "ran out of subrequest budget before identifying the series; re-run with fresh=1 to continue",
             tried };
  }
  // ALT has named where the series lives, so the open-ended sweep is no longer
  // the likely route to it — it just spends the budget and buries the one error
  // that matters. Keep it behind deep=1 for when the known path stops working.
  if (!deep) return { error: "the known path (asset.pricingData) did not yield a series", tried };

  for (const pass of [{ scope: "value", names: LIST_PROBES }, { scope: "asset", names: ASSET_LIST_PROBES }]) {
    const queue = [...pass.names];
    const seen = new Set();
    while (queue.length && !budget.exhausted) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      let probe = await probeAltSelection(name, env, pass.scope, { tsFilter }, budget);
      let call = name, vars = { tsFilter };

      // The field may demand arguments before it will answer.
      if (!probe.valid && /is required/i.test(probe.error ?? "")) {
        const args = await buildRequiredArgs(name, probe.errors, env, tsFilter, budget);
        call = callWithArgs(name, args);
        vars = { tsFilter, mtf: args.__mtfValue ?? {} };
        probe = await probeAltSelection(call, env, pass.scope, vars, budget);
        tried.push(`${pass.scope}.${name} with args: ${probe.valid ? "ok" : (probe.error ?? "").slice(0, 70)}`);
      } else {
        tried.push(`${pass.scope}.${name}: ${probe.valid ? "exists (scalar)" : (probe.error ?? "").slice(0, 70)}`);
      }

      if (!probe.valid && NEEDS_SUBFIELDS_RE.test(probe.error ?? "")) {
        const found = await findSeriesUnder([call], env, pass.scope, vars, tried, budget);
        if (found) {
          return { listField: name, call, path: [name, ...found.path],
                   mode: found.mode ?? "objects", anchors: found.anchors ?? null,
                   dateField: found.dateField, valueField: found.valueField,
                   scope: pass.scope, args: vars.mtf ? { mtf: vars.mtf } : null,
                   discoveredBy: "probing", tried };
        }
      }
      if (!probe.valid) for (const sug of errorSuggestions(probe.error)) if (!seen.has(sug)) queue.push(sug);
    }
  }
  return { error: budget.exhausted
             ? "ran out of subrequest budget before identifying the series; re-run with fresh=1 to continue"
             : "no value series field found by probing", tried };
}

// Bumped whenever the probe logic changes: a cached conclusion from older,
// weaker probing would otherwise be served after a deploy and look as if the
// new attempt had failed too.
const ALT_SHAPE_VERSION = 14;

// What else does TimeSeriesFilter accept? An input type rejects a member it
// doesn't define, by name — so a member that survives validation is real. A
// wrong value type is also a pass: the complaint is then about the value, which
// means the field itself exists. This is how we find out whether the window we
// get is ALT's limit or just our default.
const FILTER_PROBES = [
  ["startDate", "2020-01-01"], ["endDate", "2026-12-31"], ["from", "2020-01-01"], ["to", "2026-12-31"],
  ["since", "2020-01-01"], ["period", "ALL"], ["range", "ALL"], ["timeframe", "ALL"],
  ["interval", "DAILY"], ["granularity", "DAILY"], ["days", 3650], ["months", 120],
  ["limit", 5000], ["maxPoints", 5000], ["allTime", true],
];
const NOT_DEFINED_RE = /is not defined by type|Unknown (?:field|argument)/i;

async function probeTimeSeriesFilter(env, tsFilter, budget) {
  const query = `query Cert($certNumber: String!, $tsFilter: TimeSeriesFilter!) {
    cert(certNumber: $certNumber) { asset { altValueInfo(tsFilter: $tsFilter) { currentAltValue } } }
  }`;
  const results = [];
  for (const [field, value] of FILTER_PROBES) {
    if (budget.exhausted) break;
    const res = await altGraphql("Cert", query,
      { certNumber: "00000000", tsFilter: { ...tsFilter, [field]: value } }, env, budget);
    if (res.budgetExhausted) break;
    const errors = (res.body?.errors ?? []).map(e => e.message);
    const rejected = errors.find(e => NOT_DEFINED_RE.test(e) && e.includes(field));
    const typeComplaint = errors.find(e => /Expected type|cannot represent|got invalid value/i.test(e));
    results.push({
      field,
      accepted: !rejected,
      note: rejected ? rejected.slice(0, 110)
          : typeComplaint ? `exists, wrong value type: ${typeComplaint.slice(0, 90)}`
          : "accepted",
    });
  }
  return results;
}

// pricingData demands a marketTransactionFilter, which it would not do unless
// it also serves transactions — and we have only ever selected the value series
// from it. List what else it offers, so real sales can be had instead of, or
// alongside, ALT's modelled index.
const PRICING_FIELD_PROBES = [
  "marketTransactions", "transactions", "sales", "salesHistory", "recentSales",
  "comps", "comparables", "marketData", "salesData", "transactionHistory",
  "listings", "lastSale", "salesCount",
];

async function inspectPricingData(env, tsFilter, budget) {
  const first = await probeAltSelection("pricingData", env, "asset", { tsFilter }, budget);
  const args = await buildRequiredArgs("pricingData", first.errors, env, tsFilter, budget);
  const call = callWithArgs("pricingData", args);
  const vars = { tsFilter, mtf: args.__mtfValue ?? {} };

  const seen = new Set();
  const found = [];
  const queue = [...PRICING_FIELD_PROBES];
  while (queue.length && !budget.exhausted && found.length < 24) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const res = await probeAltSelection(`${call} { ${name} }`, env, "asset", vars, budget);
    if (res.exhausted) break;
    const needsSub = NEEDS_SUBFIELDS_RE.test(res.error ?? "");
    const elementType = needsSub ? (TYPE_IN_ERROR_RE.exec(res.error)?.[1] ?? null) : null;
    found.push({
      field: name,
      exists: res.valid || needsSub,
      kind: needsSub ? `object or list of ${elementType ?? "?"}` : res.valid ? "scalar" : "not defined",
      detail: res.valid || needsSub ? undefined : (res.error ?? "").slice(0, 100),
    });
    if (!res.valid && !needsSub) {
      for (const sug of errorSuggestions(res.error)) if (!seen.has(sug)) queue.push(sug);
    }
  }
  return { call, marketTransactionFilterSent: vars.mtf, fields: found };
}

// PricingData.marketTransactions is a list of MarketTransaction: actual sales,
// as opposed to the modelled value series. Its field names are unknown like
// everything else here, so probe for them once and cache the result.
const SALE_DATE_FIELDS = ["soldAt", "saleDate", "soldDate", "dateSold", "date", "timestamp", "createdAt"];
const SALE_PRICE_FIELDS = ["price", "salePrice", "soldPrice", "amount", "priceUsd", "value", "total"];
const SALE_EXTRA_FIELDS = ["currency", "grade", "gradingCompany", "certNumber", "source", "marketplace",
                           "venue", "auctionHouse", "seller", "url", "link", "title", "quantity"];
const ALT_SALES_VERSION = 3;

// An empty marketTransactionFilter validates, but validating is not the same as
// selecting anything. Find which members it accepts, then try a few filled-in
// filters against a real card and keep the first that actually returns sales.
const MTF_MEMBER_PROBES = [
  ["gradeNumber", t => t.gradeNumber], ["gradingCompany", t => t.gradingCompany],
  ["autograph", () => null], ["startDate", () => "2000-01-01"], ["endDate", () => "2100-01-01"],
];

async function chooseSalesFilter(env, tsFilter, assetId, call, selection, budget) {
  const accepted = {};
  for (const [member, valueOf] of MTF_MEMBER_PROBES) {
    if (budget.exhausted) break;
    const probe = { ...accepted, [member]: valueOf(tsFilter) };
    const res = await probeAltSelection(`${call} { marketTransactions { ${selection} } }`,
      env, "asset", { tsFilter, mtf: probe }, budget);
    if (!res.errors.some(e => NOT_DEFINED_RE.test(e) || /Expected type|got invalid value|cannot represent/i.test(e))) {
      accepted[member] = valueOf(tsFilter);
    }
  }

  const variants = [
    accepted,
    Object.fromEntries(Object.entries(accepted).filter(([k]) => /grade|grading|autograph/i.test(k))),
    Object.fromEntries(Object.entries(accepted).filter(([k]) => /date/i.test(k))),
    {},
  ];
  const tried = [];
  for (const mtf of variants) {
    if (budget.exhausted || !assetId) break;
    const query = `query AssetHistory($id: ID!, $tsFilter: TimeSeriesFilter!, $mtf: MarketTransactionFilter!) {
      asset(id: $id) { ${call} { marketTransactions { ${selection} } } }
    }`;
    const res = await altGraphql("AssetHistory", query, { id: assetId, tsFilter, mtf }, env, budget);
    const rows = res.body?.data?.asset?.pricingData?.marketTransactions;
    const count = Array.isArray(rows) ? rows.length : null;
    tried.push(`${JSON.stringify(mtf)} → ${count === null ? (res.body?.errors?.[0]?.message ?? "no data").slice(0, 60) : count + " sales"}`);
    if (count > 0) return { mtf, memberProbe: accepted, filterTried: tried };
  }
  return { mtf: accepted, memberProbe: accepted, filterTried: tried };
}

async function discoverSalesShape(env, tsFilter, budget, sampleAssetId = null) {
  const first = await probeAltSelection("pricingData", env, "asset", { tsFilter }, budget);
  const args = await buildRequiredArgs("pricingData", first.errors, env, tsFilter, budget);
  const call = callWithArgs("pricingData", args);
  const vars = { tsFilter, mtf: args.__mtfValue ?? {} };
  const tried = [];

  const has = async name => {
    const res = await probeAltSelection(`${call} { marketTransactions { ${name} } }`, env, "asset", vars, budget);
    if (res.exhausted) return false;
    tried.push(`${name}: ${res.valid ? "yes" : (res.error ?? "").slice(0, 60)}`);
    return res.valid;
  };
  const firstOf = async names => {
    for (const n of names) {
      if (budget.exhausted) break;
      if (await has(n)) return n;
    }
    return null;
  };

  const dateField = await firstOf(SALE_DATE_FIELDS);
  const priceField = await firstOf(SALE_PRICE_FIELDS);
  if (!dateField || !priceField) {
    return { error: "could not identify a date and price on MarketTransaction", dateField, priceField, tried };
  }
  const extras = [];
  for (const name of SALE_EXTRA_FIELDS) {
    if (budget.exhausted) break;
    if (await has(name)) extras.push(name);
  }
  const selection = [dateField, priceField, ...extras].join(" ");
  const chosen = await chooseSalesFilter(env, tsFilter, sampleAssetId, call, selection, budget);
  return { call, args: { mtf: chosen.mtf }, dateField, priceField, extras,
           filterTried: chosen.filterTried, tried };
}

async function altSalesShape(env, tsFilter, fresh, budget, sampleAssetId = null) {
  const cache = caches.default;
  const key = new Request(`https://alt-cache.internal/sales-shape?v=${ALT_SALES_VERSION}`);
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) { try { return JSON.parse(await hit.text()); } catch {} }
  }
  const shape = await discoverSalesShape(env, tsFilter, budget, sampleAssetId);
  try {
    await cache.put(key, new Response(JSON.stringify(shape), {
      headers: { "Content-Type": "application/json",
                 "Cache-Control": `s-maxage=${shape.priceField ? ALT_SHAPE_TTL : 3600}` },
    }));
  } catch {}
  return shape;
}

async function altHistoryShape(env, fresh = false, budget = null, deep = false) {
  const cache = caches.default;
  const key = new Request(`https://alt-cache.internal/history-shape?v=${ALT_SHAPE_VERSION}`);
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) { try { return JSON.parse(await hit.text()); } catch {} }
  }
  let shape = await discoverAltHistoryShape(env, budget);
  if (!shape.listField) {
    const probed = await probeAltHistoryShape(env, budget ?? new SubrequestBudget(40), deep);
    shape = probed.listField ? probed : { ...shape, probe: probed };
  }
  // Cache the answer either way: a successful shape for a day, a failed search
  // for an hour. Without the second, every request would re-run the whole probe
  // sequence against ALT for as long as the schema stays unreadable.
  const found = shape.listField && shape.valueField
    && (shape.dateField || shape.mode === "parallel");
  try {
    await cache.put(key, new Response(JSON.stringify(shape), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `s-maxage=${found ? ALT_SHAPE_TTL : 3600}`,
      },
    }));
  } catch {}
  return shape;
}

// Each uncached cert costs two upstream calls, against a platform limit of 50
// per invocation; cached ones cost none, so a repeat of a larger list is fine.
const MAX_CERTS_PER_REQUEST = 20;
const CERT_RE = /^[A-Za-z0-9-]{4,20}$/;

// Single or batch: ?cert=X for one card, ?certs=X,Y,Z for a list. Each cert is
// cached and resolved independently, so overlapping batches mostly hit cache
// and one bad cert can't fail the rest.
async function altHistory(workerUrl, env) {
  const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
  const raw = workerUrl.searchParams.get("certs") ?? workerUrl.searchParams.get("cert") ?? "";
  const certs = [...new Set(raw.split(",").map(c => c.trim()).filter(Boolean))];
  if (!certs.length || certs.some(c => !CERT_RE.test(c))) {
    return json({ error: "pass ?cert=<grading cert> or ?certs=<comma-separated list>" }, 400);
  }
  if (certs.length > MAX_CERTS_PER_REQUEST) {
    return json({ error: `at most ${MAX_CERTS_PER_REQUEST} certs per request`, received: certs.length }, 400);
  }

  const grade = workerUrl.searchParams.get("grade");
  const grader = workerUrl.searchParams.get("grader");
  // Escape hatch for exactly the case that bit here: re-run discovery instead
  // of being told what a previous, weaker attempt concluded.
  const fresh = workerUrl.searchParams.get("fresh") === "1";
  const deep = workerUrl.searchParams.get("deep") === "1";
  const inspectFilter = workerUrl.searchParams.get("inspectFilter") === "1";
  const inspectPricing = workerUrl.searchParams.get("inspectPricing") === "1";
  const wantSales = workerUrl.searchParams.get("sales") === "1";
  // history=0 drops the value series. It shares an upstream call with the sales,
  // so this saves response size rather than requests — and on a cold cache it
  // also skips discovering the series' shape, which does cost calls.
  const wantHistory = workerUrl.searchParams.get("history") !== "0";

  // One budget for the whole invocation: a batch of certs shares it with
  // discovery, so a long list can't walk into Cloudflare's subrequest limit —
  // which throws, rather than failing the call that crossed it.
  const budget = new SubrequestBudget(45);

  if (inspectFilter) {
    const certRes = await altGraphql("Cert", ALT_QUERIES.Cert, { certNumber: certs[0] }, env, budget);
    const cd = certRes.body?.data?.cert;
    const tsFilter = {
      gradeNumber: grade || cd?.gradeNumber || "10",
      gradingCompany: grader || cd?.gradingCompany || "PSA",
      autograph: null,
    };
    return json({
      tsFilterSent: tsFilter,
      accepts: await probeTimeSeriesFilter(env, tsFilter, budget.child(20)),
    });
  }

  if (inspectPricing) {
    const certRes = await altGraphql("Cert", ALT_QUERIES.Cert, { certNumber: certs[0] }, env, budget);
    const cd = certRes.body?.data?.cert;
    const tsFilter = {
      gradeNumber: grade || cd?.gradeNumber || "10",
      gradingCompany: grader || cd?.gradingCompany || "PSA",
      autograph: null,
    };
    return json(await inspectPricingData(env, tsFilter, budget.child(30)));
  }

  // Resolve the schema shape once. Letting each cert do it meant five parallel
  // discoveries on a cold cache, which is how a batch blew the subrequest cap.
  // Discovery gets a sub-budget: searching the schema must never consume what
  // the cert lookups themselves need, or the answer is a budget error instead
  // of a card.
  const shape = wantHistory ? await altHistoryShape(env, fresh, budget.child(24), deep) : null;

  // Real sales, when asked for. Discovered once and cached like the series.
  let salesShape = null;
  if (wantSales) {
    // Resolve one card first: choosing the filter means checking which one
    // actually returns sales, which needs a real asset to ask about.
    const seedRes = await altGraphql("Cert", ALT_QUERIES.Cert, { certNumber: certs[0] }, env, budget);
    const seedCert = seedRes.body?.data?.cert;
    const seed = {
      gradeNumber: grade || seedCert?.gradeNumber || "10",
      gradingCompany: grader || seedCert?.gradingCompany || "PSA",
      autograph: null,
    };
    salesShape = await altSalesShape(env, seed, fresh, budget.child(26), seedCert?.asset?.id ?? null);
  }

  if (!wantHistory && !wantSales) {
    return json({ error: "nothing to return: history=0 needs sales=1" }, 400);
  }

  if (certs.length === 1 && !workerUrl.searchParams.get("certs")) {
    const { body, cached } = await altHistoryOne(certs[0], grade, grader, env, fresh, budget, shape, salesShape);
    if (wantSales && !salesShape?.priceField) body.salesNote = salesShape?.error ?? "sales unavailable";
    return new Response(JSON.stringify(body, null, 1), {
      status: body.error === "cert not found on ALT" ? 404 : 200,
      headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": cached ? "hit" : "miss" },
    });
  }

  // Five at a time: enough to keep a page of cards quick without hammering ALT.
  const results = [];
  for (let i = 0; i < certs.length; i += 5) {
    const batch = await Promise.all(
      certs.slice(i, i + 5).map(c =>
        altHistoryOne(c, grade, grader, env, fresh, budget, shape, salesShape)
          .then(r => r.body)
          .catch(e => ({ cert: c, history: null, error: String(e?.message ?? e) }))),
    );
    results.push(...batch);
  }
  const incomplete = results.filter(r => !r.history && /budget/i.test(r.error ?? "")).length;
  const salesProblem = wantSales && !salesShape?.priceField ? salesShape?.error : null;
  return json({
    count: results.length,
    withHistory: results.filter(r => r.history?.length).length,
    ...(incomplete ? { note: `${incomplete} cert(s) hit this request's upstream call limit — ask for them in a second request; answered certs are now cached` } : {}),
    ...(salesProblem ? { salesNote: salesProblem } : {}),
    results,
  });
}

async function altHistoryOne(cert, gradeOverride, graderOverride, env, fresh = false, budget = null, sharedShape = null, salesShape = null) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://alt-cache.internal/history?cert=${encodeURIComponent(cert)}`
    + `&grade=${encodeURIComponent(gradeOverride ?? "")}&grader=${encodeURIComponent(graderOverride ?? "")}`
    + `&sales=${salesShape?.priceField ? 1 : 0}&hist=${sharedShape ? 1 : 0}`
  );
  if (!fresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try { return { body: JSON.parse(await cached.text()), cached: true }; } catch {}
    }
  }

  // 1. cert → asset, grade and grader (the filter selects which grade's series)
  const certRes = await altGraphql("Cert", ALT_QUERIES.Cert, { certNumber: cert }, env, budget);
  if (certRes.budgetExhausted) {
    return { body: { cert, history: null,
                     error: "upstream call budget for this request was exhausted",
                     discovery: sharedShape?.listField ? undefined : sharedShape }, cached: false };
  }
  const certData = certRes.body?.data?.cert;
  if (!certData?.asset?.id) {
    return { body: { cert, history: null, error: "cert not found on ALT",
                     details: certRes.body?.errors?.map(e => e.message).slice(0, 2) }, cached: false };
  }
  const tsFilter = {
    gradeNumber: gradeOverride || certData.gradeNumber,
    gradingCompany: graderOverride || certData.gradingCompany,
    autograph: null,
  };

  // 2. what is the series called?
  // No series shape and a sales shape present means the caller asked for sales
  // only; otherwise resolve the series as usual.
  const wantHistory = !!sharedShape || !salesShape;
  const wantSales = !!salesShape?.priceField;
  const shape = sharedShape ?? (wantHistory ? await altHistoryShape(env, fresh, budget) : null);
  if (!wantHistory && !wantSales) {
    return { body: { cert, assetId: certData.asset.id, subject: certData.asset.subject,
                     error: "nothing to return" }, cached: false };
  }
  const usable = !wantHistory || (shape.listField && shape.valueField
    && (shape.dateField || shape.mode === "parallel"));
  if (!usable) {
    return { body: { cert, assetId: certData.asset.id, subject: certData.asset.subject,
                     history: null, discovery: shape,
                     note: "ALT exposes no value series we could identify; the current value is still available via /alt/AssetDetails" },
             cached: false };
  }

  // 3. fetch it
  // The series may sit several levels inside a container, and the outermost
  // field may take arguments, so build from the discovered call and path.
  const path = wantHistory ? (shape.path ?? [shape.listField]) : [];
  const parts = wantHistory ? [shape.call ?? path[0], ...path.slice(1)] : [];
  // Sales live under the same pricingData call as the series, so select both in
  // one go rather than paying for the call twice.
  const salesInner = wantSales
    ? `marketTransactions { ${[salesShape.dateField, salesShape.priceField, ...(salesShape.extras ?? [])].join(" ")} }`
    : "";

  const leaf = !wantHistory ? "" : shape.mode === "parallel"
    ? [...new Set([shape.valueField, shape.dateField, shape.anchors?.start, shape.anchors?.end]
        .filter(Boolean))].join(" ")
    : `${shape.dateField} ${shape.valueField}`;
  const sameCall = wantHistory && wantSales && shape.scope === "asset" && parts[0] === salesShape.call;
  const seriesInner = parts.slice(1).reduceRight((acc, f) => `${f} { ${acc} }`, leaf);
  const series = !wantHistory
    ? `${salesShape.call} { ${salesInner} }`
    : sameCall
    ? `${parts[0]} { ${seriesInner} ${salesInner} }`
    : parts.reduceRight((acc, f) => `${f} { ${acc} }`, leaf)
      + (wantSales ? ` ${salesShape.call} { ${salesInner} }` : "");
  const needsMtf = !!(shape?.args?.mtf || salesShape?.args?.mtf);
  const query = `query AssetHistory($id: ID!, $tsFilter: TimeSeriesFilter!${needsMtf ? ", $mtf: MarketTransactionFilter!" : ""}) {
    asset(id: $id) {
      id subject
      ${!wantHistory || shape.scope === "asset" ? series : ""}
      altValueInfo(tsFilter: $tsFilter) {
        currentAltValue
        ${!wantHistory || shape.scope === "asset" ? "" : series}
      }
    }
  }`;
  // Ask for the widest window the filter allows, not just its default.
  const variables = { id: certData.asset.id,
                      tsFilter: { ...tsFilter, ...(shape?.windowExtra ?? {}) } };
  // Both selections share one marketTransactionFilter. The series ignores it —
  // it filters on tsFilter — while the sales only return rows for the filter
  // discovery settled on, so that one wins whenever sales are being fetched.
  if (needsMtf) variables.mtf = salesShape?.args?.mtf ?? shape?.args?.mtf ?? {};
  const res = await altGraphql("AssetHistory", query, variables, env, budget);
  const asset = res.body?.data?.asset;
  const info = !wantHistory || shape.scope === "asset" ? asset : asset?.altValueInfo;
  if (!info) {
    return { body: { cert, assetId: certData.asset.id, history: null, discovery: shape,
                     errors: res.body?.errors?.map(e => e.message).slice(0, 3) }, cached: false };
  }
  const node = path.reduce((n, f) => (n == null ? null : n[f]), info);
  let points = [];
  let undated = false;
  if (!wantHistory) {
    points = null;
  } else if (shape.mode === "parallel") {
    // Values in one array. Dates arrive one of three ways: a matching array, a
    // start and end to spread evenly across the points, or a start alone, where
    // the spacing is taken as daily.
    const values = Array.isArray(node?.[shape.valueField]) ? node[shape.valueField] : [];
    const dateArray = shape.dateField && Array.isArray(node?.[shape.dateField])
      ? node[shape.dateField] : null;
    // A "date field" that came back as a scalar is an anchor, not a series.
    const scalarDate = !dateArray && shape.dateField ? node?.[shape.dateField] : null;
    const startRaw = node?.[shape.anchors?.start] ?? scalarDate ?? null;
    const endRaw = node?.[shape.anchors?.end] ?? null;
    const asTime = v => {
      if (v == null) return null;
      const n = typeof v === "number" ? v : Number(v);
      if (isFinite(n) && String(v).length >= 10) return n < 1e12 ? n * 1000 : n;  // epoch s or ms
      const t = Date.parse(v);
      return isFinite(t) ? t : null;
    };
    const start = asTime(startRaw);
    const end = asTime(endRaw);
    const DAY = 86400000;
    const step = (start != null && end != null && values.length > 1)
      ? (end - start) / (values.length - 1)
      : DAY;
    const dateAt = i => {
      if (dateArray) return dateArray[i] ?? null;
      if (start == null) return i;
      return new Date(start + i * step).toISOString().slice(0, 10);
    };
    undated = !dateArray && start == null;
    points = values.map((v, i) => ({ date: dateAt(i), value: v }))
                   .filter(pt => pt.value != null);
  } else {
    points = (Array.isArray(node) ? node : []).map(pt => ({
      date: pt[shape.dateField] ?? null,
      value: pt[shape.valueField] ?? null,
    })).filter(pt => pt.date != null && pt.value != null);
  }

  let sales = null;
  if (wantSales) {
    const node = asset?.pricingData ?? asset;
    const rows = Array.isArray(node?.marketTransactions) ? node.marketTransactions : [];
    // ALT returns the price as a string ("40000.00"); consumers want to chart,
    // sort and compare it, so hand back a number.
    sales = rows.map(row => {
      const raw = row[salesShape.priceField];
      const price = raw == null || raw === "" ? null : Number(raw);
      const out = { date: row[salesShape.dateField] ?? null,
                    price: Number.isFinite(price) ? price : null };
      for (const k of salesShape.extras ?? []) if (row[k] != null) out[k] = row[k];
      return out;
    }).filter(sale => sale.price != null);
  }

  const body = {
    cert,
    assetId: certData.asset.id,
    subject: certData.asset.subject,
    grade: tsFilter.gradeNumber,
    grader: tsFilter.gradingCompany,
    currentValue: asset?.altValueInfo?.currentAltValue ?? null,
    ...(wantHistory ? { points: points.length, history: points } : {}),
    ...(wantHistory ? {
      fields: { path, date: shape.dateField, value: shape.valueField,
                scope: shape.scope ?? "value", mode: shape.mode ?? "objects" },
      window: shape.windowHow ?? "ALT's default window",
    } : {}),
    ...(sales ? { salesCount: sales.length, sales,
                  salesFilter: salesShape.args?.mtf ?? {},
                  ...(sales.length ? {} : { salesNote: `no transactions returned; filters tried: ${(salesShape.filterTried ?? []).join(" | ")}` }) } : {}),
    ...(undated ? { note: "ALT returns the values without dates; positions are indices, oldest first" } : {}),
  };
  if (points?.length || (!wantHistory && sales?.length)) {
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${ALT_HISTORY_TTL}` },
      }));
    } catch {}
  }
  return { body, cached: false };
}

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

// Courtyard's marketplace runs on Algolia. The application id and search key
// below are the ones their own site ships in its frontend bundle: Algolia
// search-only keys are public by design and read-only. Proxying rather than
// calling from the browser lets us send a Referer, since search keys can carry
// referer restrictions.
const ALGOLIA_APP_ID = "Y8TL3M06QA";
const ALGOLIA_SEARCH_KEY = "3b3ed18284ca0baee9a496aea5f093d6";

async function courtyardSearch(request) {
  const body = await request.text();
  const target = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`
    + `?x-algolia-application-id=${ALGOLIA_APP_ID}`
    + `&x-algolia-api-key=${ALGOLIA_SEARCH_KEY}`;
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": "https://courtyard.io",
      "Referer": "https://courtyard.io/",
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

// Phygitals' marketplace listing response carries no grading cert, so a card's
// detail procedure has to supply it. Only their marketplace oRPC namespace is
// forwarded, and only well-formed procedure paths, so this cannot be used as a
// general-purpose proxy. A card's identity doesn't change, so responses are
// edge-cached for the same 12h as Collector Crypt's detail calls.
const PHYGITALS_ORPC_TTL = 43200;

async function phygitalsOrpc(procedure, workerUrl) {
  if (!/^marketplace\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,3}$/.test(procedure)) {
    return new Response(JSON.stringify({ error: "unsupported procedure" }), {
      status: 403,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  return cachedJson(
    `https://phygitals-orpc.internal/${procedure}${workerUrl.search}`,
    d => (d && !d.__error ? PHYGITALS_ORPC_TTL : 0),
    async () => {
      try {
        const upstream = await fetch(
          `https://api.phygitals.com/api/orpc/${procedure}${workerUrl.search}`,
          {
            headers: {
              "Accept": "application/json, text/plain, */*",
              "Origin": "https://www.phygitals.com",
              "Referer": "https://www.phygitals.com/",
            },
            signal: AbortSignal.timeout(8000),
          },
        );
        const text = await upstream.text();
        if (!upstream.ok) {
          return JSON.stringify({ __error: `HTTP ${upstream.status}`, body: text.slice(0, 300) });
        }
        try { JSON.parse(text); } catch { return JSON.stringify({ __error: "not JSON" }); }
        return text;
      } catch (e) {
        return JSON.stringify({ __error: String(e?.message ?? e) });
      }
    },
  );
}

// Diagnostic. The listing API exposes no cert and the card detail procedure's
// name is unknown, so this fetches the card page itself — server-side, where
// there is no CORS to fight — and reports what it references: the oRPC paths
// its bundle calls, any text around the word "cert", and cert-shaped numbers.
// Enough to identify where the grading cert lives, or to establish that the
// site never publishes it.
async function phygitalsProbe(workerUrl) {
  const address = workerUrl.searchParams.get("address") || "";
  if (!/^[A-Za-z0-9]{32,50}$/.test(address)) {
    return new Response(JSON.stringify({ error: "pass ?address=<solana address>" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const page = await fetch(`https://www.phygitals.com/card/${address}`, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await page.text();
    const uniq = (re, cap) => [...new Set(html.match(re) || [])].slice(0, cap);
    const certContexts = [];
    const re = /.{0,100}cert.{0,140}/gi;
    let m;
    while ((m = re.exec(html)) !== null && certContexts.length < 8) certContexts.push(m[0]);
    return new Response(JSON.stringify({
      status: page.status,
      htmlLength: html.length,
      orpcPaths: uniq(/\/api\/orpc\/[A-Za-z0-9_/.-]+/g, 40),
      apiPaths: uniq(/\/api\/(?!orpc)[A-Za-z0-9_/.-]+/g, 20),
      certContexts,
      digitRuns: uniq(/\b\d{7,12}\b/g, 30),
      hasNextData: html.includes("__NEXT_DATA__"),
    }, null, 1), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}

// Diagnostic. Courtyard's Algolia index went empty, so the one we query has
// been retired and the replacement's name has to be found. Their marketplace
// page and its bundles name it, so fetch them server-side and pull out the
// Algolia identifiers: index names, application id and the public search key.
const CY_INDEX_RE = /["'`]([a-z][a-z0-9_]{5,60})["'`]/g;
const CY_INDEX_HINT = /(marketplace|listed|listing|asset|prod)/i;

async function courtyardProbe() {
  const grab = async url => {
    try {
      const res = await fetch(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/javascript,*/*",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(12000),
      });
      return res.ok ? await res.text() : "";
    } catch { return ""; }
  };

  const page = await grab("https://courtyard.io/marketplace");
  if (!page) {
    return new Response(JSON.stringify({ error: "could not fetch courtyard.io/marketplace" }), {
      status: 502, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Their index name lives in the bundle more often than the HTML, so follow a
  // few of the scripts the page loads.
  const scripts = [...new Set(page.match(/(?:src=["'])([^"']+\.js[^"']*)/g) || [])]
    .map(m => m.replace(/^src=["']/, ""))
    .map(u => (u.startsWith("http") ? u : `https://courtyard.io${u.startsWith("/") ? "" : "/"}${u}`))
    .slice(0, 8);
  const bundles = await Promise.all(scripts.map(grab));
  const all = [page, ...bundles].join("\n");

  const indexes = new Set();
  let m;
  while ((m = CY_INDEX_RE.exec(all)) !== null && indexes.size < 40) {
    if (CY_INDEX_HINT.test(m[1])) indexes.add(m[1]);
  }
  const uniq = (re, cap) => [...new Set(all.match(re) || [])].slice(0, cap);

  // An Algolia application id is 10 uppercase alphanumerics containing at least
  // one letter — without that last condition the match is every 10-digit
  // analytics container id on the page.
  const appIds = uniq(/\b(?![0-9]{10}\b)[A-Z0-9]{10}\b/g, 10);
  const keys = uniq(/\b[a-f0-9]{32}\b/g, 6);

  // Context around the wiring, which pairs an app id with its key.
  const contexts = [];
  const ctxRe = /.{0,90}(?:algolia|indexName|searchClient|appId).{0,120}/gi;
  let c;
  while ((c = ctxRe.exec(all)) !== null && contexts.length < 6) contexts.push(c[0]);

  // The decisive part: actually run a count-only query for each plausible
  // application id and key pair. Algolia's error messages distinguish a bad
  // key from a missing index, so one of these answers says what changed.
  const indexNames = [...indexes].filter(i => /marketplace|listing|asset/i.test(i));
  if (!indexNames.length) indexNames.push("marketplace_prod_recently_listed");
  const apps = [...new Set(["Y8TL3M06QA", ...appIds])].slice(0, 4);
  const tries = [];
  outer:
  for (const app of apps) {
    for (const key of keys.slice(0, 3)) {
      for (const index of indexNames.slice(0, 3)) {
        if (tries.length >= 9) break outer;
        let outcome;
        try {
          const res = await fetch(
            `https://${app}-dsn.algolia.net/1/indexes/*/queries?x-algolia-application-id=${app}&x-algolia-api-key=${key}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requests: [{ indexName: index, params: "hitsPerPage=0&page=0&query=" }] }),
              signal: AbortSignal.timeout(8000),
            },
          );
          const body = await res.json().catch(() => null);
          outcome = res.ok
            ? { nbHits: body?.results?.[0]?.nbHits ?? null }
            : { status: res.status, message: String(body?.message ?? "").slice(0, 120) };
        } catch (e) {
          outcome = { error: String(e?.message ?? e).slice(0, 80) };
        }
        tries.push({ app, key: `${key.slice(0, 8)}…`, index, ...outcome });
      }
    }
  }

  return new Response(JSON.stringify({
    scriptsScanned: scripts.length,
    indexCandidates: [...indexes],
    algoliaAppIds: appIds,
    algoliaHosts: uniq(/[A-Za-z0-9]+-dsn\.algolia\.net/g, 5),
    searchKeys: keys,
    apiPaths: uniq(/https:\/\/api\.courtyard\.io\/[A-Za-z0-9_/-]{2,60}/g, 12),
    contexts,
    liveQueries: tries,
  }, null, 1), { headers: { ...CORS, "Content-Type": "application/json" } });
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

// Per-card detail (/cards/publicNft/{nftAddress}) carries the card's identity
// and its GemRate population block. Identity never changes and the population
// figures are refreshed on a slow cycle, so these responses are edge-cached;
// listing traffic stays uncached because new listings are the point.
const CC_DETAIL_TTL = 12 * 3600;

async function proxyCC(path, url) {
  const cacheable = path.startsWith("/cards/");
  const cache = caches.default;
  const cacheKey = cacheable
    ? new Request(`https://cc-cache.internal${path}${url.search}`)
    : null;
  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(await hit.text(), {
        headers: { ...CORS, "Content-Type": "application/json", "X-Edge-Cache": "hit" },
      });
    }
  }

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
  if (cacheKey && upstream.ok) {
    try {
      await cache.put(cacheKey, new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CC_DETAIL_TTL}` },
      }));
    } catch {}
  }
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      ...(cacheKey ? { "X-Edge-Cache": "miss" } : {}),
    },
  });
}
