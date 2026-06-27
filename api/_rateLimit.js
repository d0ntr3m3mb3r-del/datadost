// Shared by chat.js and forecast.js. Not a route itself (leading underscore — Vercel
// only treats files directly under /api/ without this convention as routes).
//
// Two jobs, both previously missing entirely from both endpoints:
//   1. verifyUser()     — confirms the caller is a real, currently logged-in DataDost
//                          user, by checking their Supabase session token directly
//                          against Supabase's own auth server. Without this, anyone who
//                          found either endpoint's URL could call it directly — fully
//                          bypassing the app and login — and run up real Anthropic costs
//                          with zero accountability for who was doing it.
//   2. checkRateLimit() — once we know WHO is calling, caps how often. A short "burst"
//                          window catches runaway loops or quick scripted abuse; a daily
//                          cap catches sustained abuse that stays just under the burst
//                          threshold. Both are tracked in a small Supabase table
//                          (api_rate_limits — see the accompanying SQL migration),
//                          governed by the same Row-Level-Security pattern as every other
//                          table in this app, using the CALLER's own verified token —
//                          no service-role key, no new secret to configure.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export async function verifyUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!resp.ok) return null; // expired, malformed, or forged token — Supabase itself says no
    const user = await resp.json();
    if (!user || !user.id) return null;
    return { id: user.id, token };
  } catch (err) {
    console.error('[DataDost] Auth verification request failed:', err);
    return null; // a verification failure must never be treated as "verified" — fail closed here
  }
}

// One query (not two) — fetch every timestamp for this user+endpoint within the last 24h,
// then derive both the burst-window count and the daily count from the same small result
// set in memory. Payload is trivial even near the daily cap (just timestamps).
export async function checkRateLimit({ user, endpoint, burstLimit, burstWindowSeconds, dailyLimit }) {
  const now = Date.now();
  const daySinceIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const burstSinceMs = now - burstWindowSeconds * 1000;

  try {
    const url = `${SUPABASE_URL}/rest/v1/api_rate_limits?user_id=eq.${user.id}&endpoint=eq.${endpoint}&created_at=gte.${encodeURIComponent(daySinceIso)}&select=created_at`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${user.token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!resp.ok) throw new Error('rate limit lookup returned ' + resp.status);
    const rows = await resp.json();

    const dayCount = rows.length;
    const burstCount = rows.filter((r) => new Date(r.created_at).getTime() >= burstSinceMs).length;

    if (burstCount >= burstLimit) {
      return { allowed: false, status: 429, error: 'Too many requests in a short window — please wait a moment and try again.' };
    }
    if (dayCount >= dailyLimit) {
      return { allowed: false, status: 429, error: "You've reached today's usage limit for this. It resets in 24 hours." };
    }

    // Record this request so it counts toward the NEXT check — awaited, since a race
    // between two near-simultaneous requests both reading the count before either
    // writes would otherwise let a burst slip through uncounted.
    await fetch(`${SUPABASE_URL}/rest/v1/api_rate_limits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_id: user.id, endpoint }),
    });

    // Best-effort, fire-and-forget cleanup of this user's own rows older than the longest
    // window we ever check — keeps the table from growing forever without needing a
    // separate cron job. Never awaited; a failure here should never affect the real request.
    const cutoff = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    fetch(`${SUPABASE_URL}/rest/v1/api_rate_limits?user_id=eq.${user.id}&created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}`, apikey: SUPABASE_ANON_KEY, Prefer: 'return=minimal' },
    }).catch(() => {});

    return { allowed: true };
  } catch (err) {
    // An infrastructure hiccup (Supabase momentarily unreachable, etc.) should never be
    // the reason a legitimate user can't chat — fail OPEN here. This only protects
    // against abuse; it should never become the cause of a real outage.
    console.error('[DataDost] Rate limit check failed — failing open:', err);
    return { allowed: true };
  }
}
