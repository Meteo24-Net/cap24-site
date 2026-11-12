// cap24.org Worker
// Serves the static site from this repository. Two API routes:
//   /api/outages?range=7d|28d  →  Cloudflare Radar internet-outage annotations (reviewed)
//   /api/ioda?range=7d|28d     →  IODA (Georgia Tech) country outage events (automatic),
//                                 routing (BGP) and active-probing signals only
//   /api/ddos?range=7d|28d     →  Cloudflare Radar: share of mitigated DDoS attacks by TARGET country,
//                                 network layer (L3/4) and websites (L7). Origins are never requested.
//   /api/air?page=N            →  OpenAQ: latest PM2.5 readings from the last 3 hours, one page of 1,000 sensors
//   /api/air/location?id=N     →  OpenAQ: one station's details (name, type, provider, licences)
//   /api/fires                 →  NASA FIRMS: VIIRS active-fire detections worldwide, last 24 hours
// Secrets: RADAR_TOKEN (Cloudflare Radar read), OPENAQ_KEY (OpenAQ API key), FIRMS_KEY (NASA FIRMS MAP_KEY).
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
    if (url.pathname === '/api/air') return airPage(url, env, ctx);
    if (url.pathname === '/api/air/location') return airLocation(url, env, ctx);
    if (url.pathname === '/api/fires') return fires(url, env, ctx);
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

// Air quality (OpenAQ). Readings are measurements, not warnings.
// Every page in the same 30-minute window uses the same query, so pages fit together.
const OPENAQ = 'https://api.openaq.org/v3';
const AIR_WINDOW = 1800;          // seconds per cache window
const AIR_RECENT_HOURS = 3;       // older readings are left out
const AIR_MAX_PAGES = 30;

async function airPage(url, env, ctx) {
  const page = Math.max(1, Math.min(AIR_MAX_PAGES, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const bucket = Math.floor(Date.now() / 1000 / AIR_WINDOW) * AIR_WINDOW;
  const cacheKey = new Request(`${url.origin}/api/air?page=${page}&w=${bucket}&v=${CACHE_VERSION}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!env.OPENAQ_KEY) return json({ error: 'not-configured' }, 503, 60);

  const since = new Date((bucket - AIR_RECENT_HOURS * 3600) * 1000).toISOString();
  let r;
  try {
    r = await fetch(`${OPENAQ}/parameters/2/latest?limit=1000&page=${page}&datetime_min=${encodeURIComponent(since)}`, { headers: { 'X-API-Key': env.OPENAQ_KEY, accept: 'application/json' } });
  } catch (e) { return json({ error: 'upstream-unreachable' }, 502, 60); }
  if (r.status === 404) return json({ page, found: null, window: bucket, readings: [] }, 200, AIR_WINDOW);   // past the last page
  if (!r.ok) return json({ error: 'upstream', status: r.status }, 502, 60);
  const j = await r.json();
  let dropped = 0;
  // Compact rows: [longitude, latitude, µg/m³, location id, reading time (unix seconds)]
  const readings = [];
  for (const x of (j.results || [])) {
    const v = x.value, c = x.coordinates || {}, t = Date.parse(x.datetime && x.datetime.utc);
    if (typeof v !== 'number' || !isFinite(c.latitude) || !isFinite(c.longitude) || !t) continue;
    if (v < 0 || v > 1000) { dropped++; continue; }   // outside any plausible ambient value: sensor error
    readings.push([Math.round(c.longitude * 1e4) / 1e4, Math.round(c.latitude * 1e4) / 1e4, Math.round(v * 10) / 10, x.locationsId, Math.round(t / 1000)]);
  }
  const found = j.meta && typeof j.meta.found === 'number' ? j.meta.found : null;
  const res = json({ page, found, window: bucket, since, dropped, readings }, 200, AIR_WINDOW);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function airLocation(url, env, ctx) {
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!(id > 0)) return json({ error: 'bad-id' }, 400, 60);
  const cacheKey = new Request(`${url.origin}/api/air/location?id=${id}&v=${CACHE_VERSION}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!env.OPENAQ_KEY) return json({ error: 'not-configured' }, 503, 60);
  let r;
  try {
    r = await fetch(`${OPENAQ}/locations/${id}`, { headers: { 'X-API-Key': env.OPENAQ_KEY, accept: 'application/json' } });
  } catch (e) { return json({ error: 'upstream-unreachable' }, 502, 60); }
  if (!r.ok) return json({ error: 'upstream', status: r.status }, r.status === 404 ? 404 : 502, 60);
  const j = await r.json();
  const L = (j.results || [])[0];
  if (!L) return json({ error: 'not-found' }, 404, 300);
  const nm = o => (o && typeof o.name === 'string' ? o.name : null);
  const res = json({
    id: L.id,
    name: L.name || null,
    locality: L.locality || null,
    country: L.country ? { code: L.country.code || null, name: L.country.name || null } : null,
    owner: nm(L.owner),
    provider: nm(L.provider),
    isMonitor: L.isMonitor === true,
    isMobile: L.isMobile === true,
    instruments: (L.instruments || []).map(nm).filter(Boolean),
    licenses: (L.licenses || []).map(x => ({
      name: x.name || null,
      attribution: x.attribution ? { name: x.attribution.name || null, url: x.attribution.url || null } : null
    }))
  }, 200, 86400);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// NASA FIRMS: satellite detections of heat sources (active fires), VIIRS 375 m, whole world, last 24 hours.
// Shown as FIRMS publishes them: FIRMS's own confidence classes (low, nominal, high), no CAP24 thresholds.
// One upstream request per satellite every 30 minutes at most, to stay well inside the MAP_KEY transaction limit.
const FIRMS = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_SOURCES = { VIIRS_NOAA20_NRT: 'NOAA-20', VIIRS_NOAA21_NRT: 'NOAA-21' };
const FIRMS_WINDOW = 1800;
const FIRMS_CONF = { l: 'low', n: 'nominal', h: 'high' };
// FIRMS counts days by UTC date, so DAY_RANGE=1 is only today: just after midnight UTC it is almost empty.
// Ask for two days and keep the last 24 hours by detection time.
const FIRMS_DAYS = 2, FIRMS_HOURS = 24;

async function fires(url, env, ctx) {
  const bucket = Math.floor(Date.now() / 1000 / FIRMS_WINDOW) * FIRMS_WINDOW;
  const cacheKey = new Request(`${url.origin}/api/fires?w=${bucket}&d=${FIRMS_DAYS}&u=1&v=${CACHE_VERSION}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!env.FIRMS_KEY) return json({ error: 'not-configured' }, 503, 60);

  const rows = [], sources = [], failed = [];
  let skipped = 0;
  const oldest = bucket - FIRMS_HOURS * 3600;
  const seen = new Set();
  let duplicates = 0;
  for (const [src, sat] of Object.entries(FIRMS_SOURCES)) {
    let text;
    try {
      const r = await fetch(`${FIRMS}/${encodeURIComponent(env.FIRMS_KEY)}/${src}/world/${FIRMS_DAYS}`);
      if (!r.ok) { failed.push(sat); continue; }
      text = await r.text();
    } catch (e) { failed.push(sat); continue; }
    const lines = text.split(/\r?\n/);
    const head = (lines.shift() || '').split(',');
    const col = n => head.indexOf(n);
    const iLat = col('latitude'), iLon = col('longitude'), iFrp = col('frp'), iConf = col('confidence'), iDate = col('acq_date'), iTime = col('acq_time'), iDn = col('daynight');
    if (iLat < 0 || iLon < 0 || iDate < 0) { failed.push(sat); continue; }   // not CSV: an error message or a changed format
    sources.push(sat);
    for (const line of lines) {
      if (!line) continue;
      const c = line.split(',');
      const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
      const hhmm = String(c[iTime] || '').padStart(4, '0');
      const t = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
      if (!isFinite(lat) || !isFinite(lon) || !t) { skipped++; continue; }
      if (t / 1000 < oldest) continue;   // older than 24 hours
      const key = `${c[iLat]}|${c[iLon]}|${c[iDate]}|${hhmm}|${sat}`;
      if (seen.has(key)) { duplicates++; continue; }   // the same detection listed twice by FIRMS
      seen.add(key);
      const frp = parseFloat(c[iFrp]);
      // Compact rows: [longitude, latitude, fire radiative power (MW) or null, confidence l|n|h, time (unix seconds), D|N, satellite]
      rows.push([Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4, isFinite(frp) ? frp : null, FIRMS_CONF[c[iConf]] ? c[iConf] : null, Math.round(t / 1000), c[iDn] === 'N' ? 'N' : 'D', sat]);
    }
  }
  if (!sources.length) return json({ error: 'upstream', failed }, 502, 60);
  const res = json({ source: 'NASA FIRMS', product: 'VIIRS 375 m active fire, near real time', hours: FIRMS_HOURS, window: bucket, fetched: new Date().toISOString(), satellites: sources, failed, skipped, duplicates, detections: rows }, 200, FIRMS_WINDOW);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
