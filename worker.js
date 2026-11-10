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
