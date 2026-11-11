# CAP24 live demonstration site

One-page demonstration of how official CAP alerts can appear on screen. Not a warning service.

- `index.html` — one globe, five views: `/` all official CAP alerts, `/weather` CAP category Met, `/seismic` USGS earthquakes (data, not CAP), `/internet` internet outages (Cloudflare Radar, IODA) and DDoS targets (Cloudflare Radar), measurements, not CAP, no causes; `/air` PM2.5 from OpenAQ against the WHO guideline (sensor data, not CAP)
- `a.html` — phone view: one alert, verbatim, opened from the TV QR code (`a.html?id=<CAP identifier>`)
- `_redirects` — serves `/weather`, `/seismic`, `/internet` and `/air` from `index.html`
- `worker.js` — Cloudflare Worker: `/api/outages`, `/api/ioda`, `/api/ddos` (Radar key in the secret `RADAR_TOKEN`; causes and attack origins never passed on); everything else is static
- `_headers` — asks search engines not to index the site
- `wrangler.jsonc`, `.assetsignore` — Cloudflare Worker that serves the files as a static site (no build step)
- `netlify.toml` — legacy Netlify setting (no longer the host)

Workflow: test on a branch (each branch can get a Cloudflare preview address), merge to `main` once per review round.

Data: Alert-Hub.org and the alerting authorities, through the public "CAP Alerts Feed" layer hosted by Esri. Only sources marked official in the Alert-Hub source catalogue are shown. Earthquakes: U.S. Geological Survey real-time feeds (public domain). AI never creates, translates or changes alert content.

Spec: GMF-WEB-001 (CAP24 Live Demo Site — Step 1 Specification).
