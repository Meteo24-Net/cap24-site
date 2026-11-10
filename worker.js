// cap24.org Worker
// Serves the static site from this repository. One API route:
//   /api/outages?range=7d|28d  →  Cloudflare Radar internet-outage annotations
// The Radar API token stays here (Worker secret RADAR_TOKEN), never in the browser.
// Cause fields (outageCause, description, linkedUrl, eventType) are removed here, so the
// public page cannot show causes even by mistake (CAP24 resilience spec, "Public website").
// Radar data licence: CC BY-NC 4.0 (attribution, non-commercial).

const RADAR = 'https://api.cloudflare.com/client/v4/radar/annotations/outages';
const RANGES = ['7d', '28d'];
const KEEP_SECONDS = 600;   // one Radar call per range every 10 minutes at most

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/outages') return outages(url, env, ctx);
    if (url.pathname === '/api/probe-ioda') return probeIoda();   // TEMPORARY: inspect IODA's response format, remove after
    if (url.pathname === '/api/probe-config') return json({ radarToken: !!env.RADAR_TOKEN }, 200, 0);   // TEMPORARY: is the secret visible (never its value)
    return env.ASSETS.fetch(request);
  }
};

async function outages(url, env, ctx) {
  const asked = url.searchParams.get('range');
  const range = RANGES.includes(asked) ? asked : '7d';
  const cacheKey = new Request(`${url.origin}/api/outages?range=${range}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.RADAR_TOKEN) return json({ error: 'not-configured' }, 503, 60);
  let upstream;
  try {
    upstream = await fetch(`${RADAR}?dateRange=${range}&limit=300&format=json`, {
      headers: { Authorization: `Bearer ${env.RADAR_TOKEN}` }
    });
  } catch (e) {
    return json({ error: 'upstream-unreachable' }, 502, 60);
  }
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502, 60);
  const data = await upstream.json();
  const list = ((data.result && data.result.annotations) || []).map((a, i) => ({
    id: a.id != null ? String(a.id) : `${a.startDate || ''}-${(a.locations || []).join('')}-${i}`,
    start: a.startDate || null,
    end: a.endDate || null,
    locations: Array.isArray(a.locations) ? a.locations : [],
    scope: typeof a.scope === 'string' ? a.scope : null,
    type: a.outage && typeof a.outage.outageType === 'string' ? a.outage.outageType : null,
    asns: Array.isArray(a.asns) ? a.asns : [],
    networks: Array.isArray(a.asnsDetails) ? a.asnsDetails.map(n => n && (n.name || (n.asn ? `AS${n.asn}` : null))).filter(Boolean) : []
  }));
  const res = json({
    source: 'Cloudflare Radar',
    licence: 'CC BY-NC 4.0',
    range,
    fetched: new Date().toISOString(),
    outages: list
  }, 200, KEEP_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// TEMPORARY probe: fixed IODA URLs only (not an open proxy); returns status and the start of each body
async function probeIoda() {
  const now = Math.floor(Date.now() / 1000), from = now - 7 * 86400;
  const urls = [
    `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?from=${from}&until=${now}&entityType=country&limit=5`,
    `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?from=${from}&until=${now}&entityType=country&limit=5`
  ];
  const out = [];
  for (const u of urls) {
    try { const r = await fetch(u); out.push({ url: u, status: r.status, type: r.headers.get('content-type'), body: (await r.text()).slice(0, 4000) }); }
    catch (e) { out.push({ url: u, error: String(e) }); }
  }
  return json(out, 200, 0);
}

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'x-robots-tag': 'noindex, nofollow'
    }
  });
}
