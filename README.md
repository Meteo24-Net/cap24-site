# CAP24 live demonstration site

One-page demonstration of how official CAP alerts can appear on screen. Not a warning service.

- `index.html` — one globe, six views: `/` all official CAP alerts, `/category/met` CAP category Met; context data that is not CAP under `/context/`: `/context/seismic` earthquakes from USGS and EMSC, each labelled, not matched (data, not CAP), `/context/internet` internet outages (Cloudflare Radar, IODA) and DDoS targets (Cloudflare Radar), measurements, not CAP, no causes; `/context/air` PM2.5 from OpenAQ against the WHO guideline (sensor data, not CAP); `/context/space` NOAA SWPC scales, alerts/warnings/watches verbatim and OVATION aurora forecast (not CAP)
- `/tv` — TV + phone demonstration ("Open on phone" opens the alert on screen in the phone view; `?alert=` resumes at an alert): current official alerts one after another as the full-screen TV overlay, rechecked every two minutes; `?country=EE` for one country, `?sec=20` seconds per alert; watermarked, not for broadcast
- `/social` (`social.html`) — social + phone demonstration (spec GMF-WEB-SOC-001 draft): one live official alert drawn as a social post, feed 4:5 or vertical 9:16, with the message states As sent, Cancelled (simulated, labelled) and Expired (preview, labelled); tapping the real link location opens the alert in the phone view (`a.html`) on the same phone. `?alert=` one alert, `?country=EE` one country, `?pf=facebook|instagram|linkedin|igstories|tiktok` platform (format, where the link goes: post text, profile or link sticker), `?state=cancelled|expired`. Platform icons: official files in `assets/platforms/` (see the README there); without them the buttons show names only. The level and colour rules are copied from `index.html` and `a.html`: change all three together. MP4 export is planned, not built
- `a.html` — phone view: one alert, verbatim, opened from the TV QR code (`a.html?id=<CAP identifier>`)
- `_redirects` — serves `/category/met` and `/context/*` from `index.html`; the old addresses `/weather`, `/seismic`, `/internet`, `/air` forward to them (301)
- `worker.js` — Cloudflare Worker: `/api/outages`, `/api/ioda`, `/api/ddos` (Radar key in the secret `RADAR_TOKEN`; causes and attack origins never passed on); everything else is static
- `_headers` — asks search engines not to index the site
- `wrangler.jsonc`, `.assetsignore` — Cloudflare Worker that serves the files as a static site (no build step)
- `netlify.toml` — legacy Netlify setting (no longer the host)

Workflow: test on a branch (each branch can get a Cloudflare preview address), merge to `main` once per review round.

Data: Alert-Hub.org and the alerting authorities, through the public "CAP Alerts Feed" layer hosted by Esri. Only sources marked official in the Alert-Hub source catalogue are shown. Earthquakes: U.S. Geological Survey real-time feeds (public domain). AI never creates, translates or changes alert content.

Spec: GMF-WEB-001 (CAP24 Live Demo Site — Step 1 Specification).
