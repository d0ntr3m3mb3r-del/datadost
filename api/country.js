// /api/country.js
// Returns the visitor's ISO country code from Cloudflare's CF-IPCountry header.
// This header is injected by Cloudflare on every request — zero cost, zero latency,
// no third-party API, no IP address ever leaves Cloudflare's infrastructure.
// Falls back to "IN" (India) if the header is absent (local dev, non-CF traffic).

export default function handler(req, res) {
  const country = req.headers["cf-ipcountry"] || "IN";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ country });
}
