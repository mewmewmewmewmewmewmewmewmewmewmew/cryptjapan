const ALLOWED_PATHS = ["/marketplace", "/cart"];
const CC_BASE = "https://api.collectorcrypt.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (!ALLOWED_PATHS.some((p) => path.startsWith(p))) {
      return new Response("Not found", { status: 404, headers: CORS });
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
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
