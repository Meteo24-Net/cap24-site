// cap24.org Worker
// Serves the static site from this repository. Two API routes:
//   /api/outages?range=7d|28d  →  Cloudflare Radar internet-outage annotations (reviewed)
//   /api/ioda?range=7d|28d     →  IODA (Georgia Tech) country outage events (automatic),
//                                 routing (BGP) and active-probing signals only
//   /api/ddos?range=7d|28d     →  Cloudflare Radar: share of mitigated DDoS attacks by TARGET country,
//                                 network layer (L3/4) and websites (L7). Origins are never requested.
// The Radar API token stays here (Worker secret RADAR_TOKEN), never in the browser.
// Cause fields (outageCause, description, linkedUrl, eventType) are removed here, so the
// public page cannot show causes even by mistake (CAP24 resilience spec, "Public website").
// Radar data licence: CC BY-NC 4.0 (attribution, non-commercial).

const RADAR = 'https://api.cloudflare.com/client/v4/radar/annotations/outages';
const RANGES = ['7d', '28d'];
const KEEP_SECONDS = 600;   // one upstream call per range every 10 minutes at most
const CACHE_VERSION = 3;    // raise when the output format changes, so cached answers from an older version are not served

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/outages') return outages(url, env, ctx);
    if (url.pathname === '/api/ioda') return ioda(url, ctx);
    if (url.pathname === '/api/ddos') return ddos(url, env, ctx);
    if (url.pathname === '/api/openaq-probe') return openaqProbe(env);   // TEMPORARY: learn OpenAQ v3 shapes, then remove
    return env.ASSETS.fetch(request);
  }
};

async function outages(url, env, ctx) {
  const asked = url.searchParams.get('range');
  const range = RANGES.includes(asked) ? asked : '7d';
  const cacheKey = new Request(`${url.origin}/api/outages?range=${range}&v=${CACHE_VERSION}`);
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

// IODA: country-level outage events from the routing (BGP) and active-probing signals only.
// Google-traffic and telescope signals are left out: they lag or reflect traffic, not connectivity.
// Overlapping events for the same country are merged into one outage that lists its signals.
const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';
const IODA_SIGNALS = { 'bgp': 'Routing (BGP)', 'ping-slash24': 'Active probing' };
// A detection that starts in the same minute, on the same signal, in this many countries or more
// is a gap in IODA's measurement, not an outage (seen: 63 countries at once on 9 Nov 2026). Left out and counted.
const IODA_GAP_COUNTRIES = 20;

async function ioda(url, ctx) {
  const asked = url.searchParams.get('range');
  const range = RANGES.includes(asked) ? asked : '7d';
  const cacheKey = new Request(`${url.origin}/api/ioda?range=${range}&v=${CACHE_VERSION}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const until = Math.floor(Date.now() / 1000);
  const from = until - (range === '28d' ? 28 : 7) * 86400;
  let data;
  try {
    const r = await fetch(`${IODA}?entityType=country&from=${from}&until=${until}&limit=5000&format=codf`, { headers: { accept: 'application/json' } });
    if (!r.ok) return json({ error: 'upstream', status: r.status }, 502, 60);
    data = await r.json();
  } catch (e) {
    return json({ error: 'upstream-unreachable' }, 502, 60);
  }
  const events = (data.data || [])
    .filter(e => IODA_SIGNALS[e.datasource] && typeof e.location === 'string' && e.location.startsWith('country/') && e.start)
    .map(e => ({ cc: e.location.slice(8).toUpperCase(), start: e.start, end: e.start + (e.duration || 0), signal: IODA_SIGNALS[e.datasource] }))
    .filter(e => e.end >= from);
  const perMinute = new Map();
  for (const e of events) {
    const k = `${e.signal}|${Math.floor(e.start / 60)}`;
    if (!perMinute.has(k)) perMinute.set(k, new Set());
    perMinute.get(k).add(e.cc);
  }
  const isGap = e => perMinute.get(`${e.signal}|${Math.floor(e.start / 60)}`).size >= IODA_GAP_COUNTRIES;
  const gapCount = events.filter(isGap).length;
  const kept = events.filter(e => !isGap(e))
    .sort((a, b) => (a.cc < b.cc ? -1 : a.cc > b.cc ? 1 : a.start - b.start));
  const merged = [];
  for (const e of kept) {
    const last = merged[merged.length - 1];
    if (last && last.cc === e.cc && e.start <= last.end + 3600) {
      last.end = Math.max(last.end, e.end);
      if (!last.signals.includes(e.signal)) last.signals.push(e.signal);
    } else merged.push({ cc: e.cc, start: e.start, end: e.end, signals: [e.signal] });
  }
  const list = merged.map(m => ({
    id: `ioda-${m.cc}-${m.start}`,
    start: new Date(m.start * 1000).toISOString(),
    end: m.end >= until - 3600 ? null : new Date(m.end * 1000).toISOString(),   // still detected in the last hour: ongoing
    locations: [m.cc],
    signals: m.signals
  }));
  const res = json({ source: 'IODA', range, fetched: new Date().toISOString(), measurementGapsLeftOut: gapCount, outages: list }, 200, KEEP_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// DDoS: Cloudflare Radar top TARGET locations of mitigated attacks, as shares (percent) of the total.
// Target locations only: attack origins are unreliable (hijacked devices, faked addresses) and read as accusations.
const DDOS = {
  l3: 'https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/target',
  l7: 'https://api.cloudflare.com/client/v4/radar/attacks/layer7/top/locations/target'
};

async function ddos(url, env, ctx) {
  const asked = url.searchParams.get('range');
  const range = RANGES.includes(asked) ? asked : '7d';
  const cacheKey = new Request(`${url.origin}/api/ddos?range=${range}&v=${CACHE_VERSION}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!env.RADAR_TOKEN) return json({ error: 'not-configured' }, 503, 60);

  const out = { source: 'Cloudflare Radar', licence: 'CC BY-NC 4.0', range, fetched: new Date().toISOString(), l3: null, l7: null, errors: {} };
  for (const kind of Object.keys(DDOS)) {
    try {
      const r = await fetch(`${DDOS[kind]}?dateRange=${range}&limit=30&format=json`, { headers: { Authorization: `Bearer ${env.RADAR_TOKEN}` } });
      if (!r.ok) { out.errors[kind] = `HTTP ${r.status}`; continue; }
      const j = await r.json();
      const result = j.result || {};
      const series = Object.entries(result).find(([k, v]) => k !== 'meta' && Array.isArray(v));
      out[kind] = (series ? series[1] : [])
        .map(x => ({ cc: String(x.targetCountryAlpha2 || '').toUpperCase(), name: x.targetCountryName || null, share: parseFloat(x.value) }))
        .filter(x => /^[A-Z]{2}$/.test(x.cc) && isFinite(x.share));
    } catch (e) { out.errors[kind] = 'unreachable'; }
  }
  if (!out.l3 && !out.l7) return json({ error: 'upstream', detail: out.errors }, 502, 60);
  const res = json(out, 200, KEEP_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// TEMPORARY probe: fixed OpenAQ URLs only (no caller input); key stays server-side; first 2500 characters of each answer
async function openaqProbe(env) {
  if (!env.OPENAQ_KEY) return json({ error: 'not-configured' }, 503, 0);
  const since = new Date(Date.now() - 3 * 3600e3).toISOString();
  const asks = [
    `https://api.openaq.org/v3/parameters/2/latest?limit=1000&page=1&datetime_min=${since}&monitor=true`,
    `https://api.openaq.org/v3/parameters/2/latest?limit=1000&page=1&datetime_min=${since}&monitor=false`,
    `https://api.openaq.org/v3/parameters/2/latest?limit=5&page=1&datetime_min=${since}&iso=GE`
  ];
  const out = [];
  for (const u of asks) {
    try {
      const r = await fetch(u, { headers: { 'X-API-Key': env.OPENAQ_KEY, accept: 'application/json' } });
      const h = {}; for (const k of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) h[k] = r.headers.get(k);
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      const res = j && Array.isArray(j.results) ? j.results : [];
      const times = res.map(x => x.datetime && x.datetime.utc).filter(Boolean).sort();
      out.push({ url: u, status: r.status, headers: h, found: j && j.meta && j.meta.found, n: res.length, oldest: times[0], newest: times[times.length - 1],
        monitors: res.filter(x => x.isMonitor === true).length, sample: t.slice(0, 900) });
    } catch (e) { out.push({ url: u, error: String(e) }); }
  }
  return json(out, 200, 0);
}
