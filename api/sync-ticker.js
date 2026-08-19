// api/sync-ticker.js — Weekly automated sync: bfip_articles → news_ticker
//
// Pulls up to 5 qualifying, never-before-synced bfip articles into the
// news_ticker table that DataDost's in-app engagement panel (renderNewsTicker
// in index.html) already reads from, and that the re-engagement nudge emails
// will also read from. This replaces the previous fully-manual copy step.
//
// Qualifying = status is 'published', urgency is 'Upcoming' or 'Immediate'
// (Informational articles are intentionally excluded — see design discussion),
// and dd_exported is false (an article is eligible exactly once, ever — this
// column already existed on bfip_articles before this endpoint was built,
// suggesting it was anticipated for exactly this purpose).
//
// Triggered by Vercel Cron on a weekly schedule (see vercel.json). Protected
// by CRON_SECRET so this can't be triggered by anyone hitting the URL directly —
// only Vercel's own cron scheduler, which sends this header automatically once
// CRON_SECRET is set as an env var (see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
//
// Uses the service_role key, same pattern as referral.js and unsubscribe.js —
// this is a scheduled background job with no user session at all, and it needs
// to read/write across two tables neither of which belong to "a logged-in user's
// own row", so the anon key + per-user-token pattern used elsewhere cannot apply.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseGet(path) {
  const resp = await fetch(SUPABASE_URL + path, {
    headers: { Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!resp.ok) throw new Error('Supabase GET ' + path + ' returned ' + resp.status + ': ' + await resp.text());
  return resp.json();
}

async function supabasePost(path, body) {
  const resp = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('Supabase POST ' + path + ' returned ' + resp.status + ': ' + await resp.text());
  return resp.json();
}

async function supabasePatch(path, body) {
  const resp = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('Supabase PATCH ' + path + ' returned ' + resp.status + ': ' + await resp.text());
  return resp.json();
}

export default async function handler(req, res) {
  // Only Vercel's cron scheduler (or someone manually testing with the correct
  // secret) may trigger this — never a public, unauthenticated GET.
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[DataDost] sync-ticker misconfigured — missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    return res.status(500).json({ error: 'Server not configured.' });
  }

  try {
    // Find up to 5 qualifying, never-synced articles, most recent first.
    // ilike without wildcards is an exact, case-insensitive match — protects
    // against a casing mismatch (e.g. "upcoming" vs "Upcoming") silently
    // returning zero rows the way an earlier, unrelated bug did this session.
    const qs = new URLSearchParams({
      select: 'id,dd_headline,dd_source,dd_blurb,dd_ask_prompt,published_at',
      status: 'eq.published',
      dd_exported: 'eq.false',
      or: '(urgency.ilike.upcoming,urgency.ilike.immediate)',
      order: 'published_at.desc',
      limit: '5',
    });
    const candidates = await supabaseGet(`/rest/v1/bfip_articles?${qs.toString()}`);

    if (!candidates || candidates.length === 0) {
      console.log('[DataDost] sync-ticker: no qualifying new articles this run. Existing ticker left untouched.');
      return res.status(200).json({ ok: true, synced: 0, message: 'No qualifying new articles.' });
    }

    // Only now — having confirmed we have real replacements — retire the
    // previous batch. If there were zero candidates above, we return early
    // before this point, so a quiet week never wipes out a currently-live batch.
    await supabasePatch('/rest/v1/news_ticker?active=eq.true', { active: false });

    const newRows = candidates.map((a) => ({
      headline: a.dd_headline,
      source: a.dd_source,
      blurb: a.dd_blurb,
      ask_prompt: a.dd_ask_prompt,
      active: true,
      published_at: a.published_at,
    }));
    await supabasePost('/rest/v1/news_ticker', newRows);

    // Mark these articles as permanently used — never eligible again, matching
    // "sent out once, not repeated".
    const idList = candidates.map((a) => a.id).join(',');
    await supabasePatch(`/rest/v1/bfip_articles?id=in.(${idList})`, { dd_exported: true });

    console.log('[DataDost] sync-ticker: synced', candidates.length, 'articles into news_ticker.');
    return res.status(200).json({ ok: true, synced: candidates.length });
  } catch (err) {
    console.error('[DataDost] sync-ticker error:', err.message);
    return res.status(500).json({ error: 'Sync failed.' });
  }
}
