# CAP24 live demonstration site

One-page demonstration of how official CAP alerts can appear on screen. Not a warning service.

- `index.html` — globe of current official CAP alerts, alert list, alert panel (verbatim text, original language)
- `a.html` — phone view: one alert, verbatim, opened from the TV QR code (`a.html?id=<CAP identifier>`)
- `netlify.toml` — static publish settings; asks search engines not to index the site

Data: Alert-Hub.org and the alerting authorities, through the public "CAP Alerts Feed" layer hosted by Esri. Only sources marked official in the Alert-Hub source catalogue are shown. AI never creates, translates or changes alert content.

Spec: GMF-WEB-001 (CAP24 Live Demo Site — Step 1 Specification).
