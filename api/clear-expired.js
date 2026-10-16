// api/clear-expired.js — 30-day clearing job (Data Retention Policy).
//
// Triggered once a day by Vercel Cron (see vercel.json). Protected by CRON_SECRET —
// identical pattern to send-nudges.js and sync-ticker.js.
//
// WHAT IT DOES
//   The Data Retention Policy says the user's query history and answers (messages) are kept for
//   30 days and then cleared, and that the user is told at least 48 hours before erasure. The
//   dashboard history rows (financial_snapshots) are KEPT while the account is open, as disclosed
//   in the Data Retention Policy, unless CLEAR_SNAPSHOTS === 'true' (then they are cleared the
//   same way as messages). Timing, as advised by the lawyer on 16 Oct 2026: notice at day 25,
//   erasure at day 30. Per user:
//     1. NOTICE  — if the user has rows that are 25+ days old which no earlier notice covers
//                  (rows created after the last notice), email them and stamp
//                  user_plans.clear_notice_sent_at. A notice covers every row that existed when
//                  it was sent, so an active user is emailed roughly once every 25 days, not daily.
//     2. CLEAR   — delete rows that are 30+ days old AND existed when the last notice was sent,
//                  once that notice is at least 48 hours old. Nothing is ever deleted before
//                  day 30, and never without a notice.
//     3. QUOTA   — before the free-plan counts can reset, the number of cleared questions and
//                  uploads is added to user_plans.questions_cleared / uploads_cleared. The app
//                  adds those to the live counts, so clearing never hands back free questions
//                  or upload slots.
//
// SAFE BY DEFAULT: unless CLEAR_EXPIRED_ENABLED === 'true' the job is a DRY RUN. It only counts
// and reports what it would do — it sends no email and deletes nothing.
//
// NOT TOUCHED: user_plans, referrals, feedback, waitlist, news_ticker, auth users. Only the two
// tables named in the retention policy are cleared.
//
// REQUIRES the SQL in clear-expired-setup.sql to have been run first (three new user_plans
// columns). Without it this job refuses to run, and _rateLimit.js / index.html / send-nudges.js
// must not be deployed either.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ENABLED = process.env.CLEAR_EXPIRED_ENABLED === 'true';

const LOGO_URL = 'https://datadost.in/assets/logo-icon.png';
const APP_URL = 'https://datadost.in';
const FROM_ADDRESS = 'DataDost <hello@datadost.in>';

const RETENTION_DAYS = 30;       // policy: cleared 30 days after processing
const NOTICE_LEAD_DAYS = 2;      // policy: at least 48 hours' notice before erasure
const NOTICE_WINDOW_DAYS = 25;   // lawyer (16 Oct 2026): notice at day 25, erasure at day 30 (5 days' buffer)
// Dashboard history (financial_snapshots) stays unless this switch is on. Messages are always cleared.
const CLEAR_SNAPSHOTS = process.env.CLEAR_SNAPSHOTS === 'true';
const TABLES = CLEAR_SNAPSHOTS ? ['messages', 'financial_snapshots'] : ['messages'];
const PAGE_SIZE = 1000;          // PostgREST default max rows per request
const MAX_USERS_PER_RUN = 500;   // safety cap per run

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Supabase helpers (service role, no user session) ─────────────────────────

function sbHeaders(extra) {
  return Object.assign(
    { Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY },
    extra || {}
  );
}

async function sbGet(path) {
  const resp = await fetch(SUPABASE_URL + path, { headers: sbHeaders() });
  if (!resp.ok) throw new Error('Supabase GET ' + path + ' → ' + resp.status + ': ' + (await resp.text()));
  return resp.json();
}

async function sbPatch(path, body) {
  const resp = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('Supabase PATCH ' + path + ' → ' + resp.status + ': ' + (await resp.text()));
}

// DELETE that returns the deleted rows, so we can count exactly what was removed.
async function sbDeleteReturning(path) {
  const resp = await fetch(SUPABASE_URL + path, {
    method: 'DELETE',
    headers: sbHeaders({ Prefer: 'return=representation' }),
  });
  if (!resp.ok) throw new Error('Supabase DELETE ' + path + ' → ' + resp.status + ': ' + (await resp.text()));
  return resp.json();
}

const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());

// Distinct user_ids that have at least one row older than `beforeMs` in `table`.
// Keyset-paged on user_id so a user with thousands of rows does not hide later users.
async function usersWithRowsOlderThan(table, beforeMs) {
  const found = new Set();
  let last = '';
  for (let page = 0; page < 50; page++) {
    const after = last ? '&user_id=gt.' + encodeURIComponent(last) : '';
    const rows = await sbGet(
      `/rest/v1/${table}?created_at=lt.${iso(beforeMs)}${after}&select=user_id&order=user_id.asc&limit=${PAGE_SIZE}`
    );
    if (!rows || rows.length === 0) break;
    for (const r of rows) if (r.user_id) found.add(r.user_id);
    last = rows[rows.length - 1].user_id;
    if (rows.length < PAGE_SIZE) break;
  }
  return found;
}

// True if the user has any row in `table` with fromMs <= created_at < toMs.
async function hasRowsBetween(table, userId, fromMs, toMs) {
  const lower = fromMs == null ? '' : `&created_at=gte.${iso(fromMs)}`;
  const rows = await sbGet(
    `/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}&created_at=lt.${iso(toMs)}${lower}&select=user_id&limit=1`
  );
  return rows && rows.length > 0;
}

// ── User lookup + email ──────────────────────────────────────────────────────

async function getAuthUser(userId) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: sbHeaders(),
  });
  if (!resp.ok) return null;
  const u = await resp.json();
  if (!u || !u.email) return null;
  const meta = u.user_metadata || u.raw_user_meta_data || {};
  const fullName = meta.first_name || meta.full_name || meta.name || '';
  return { email: u.email, firstName: (fullName.trim().split(/\s+/)[0]) || '' };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

// Service notice required by the Data Retention Policy — NOT marketing. It is sent whether or
// not the user unsubscribed from nudges, and carries no promotional content.
function buildNoticeEmail({ firstName, clearFromMs }) {
  const hello = firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,';
  const subject = 'Your older DataDost data will be cleared soon';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F5F2;font-family:Arial,Helvetica,sans-serif;color:#1A1A2E;">
<div style="display:none;max-height:0;overflow:hidden;">We clear data after 30 days. Here is what that means for you.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5F2;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:14px;padding:28px 26px;">
<tr><td style="padding-bottom:14px;"><img src="${LOGO_URL}" alt="DataDost" width="32" height="32" style="vertical-align:middle;border-radius:7px;"> <span style="font-size:18px;font-weight:700;vertical-align:middle;">Data<span style="color:#FF6B1A;">Dost</span></span></td></tr>
<tr><td style="font-size:15px;line-height:1.6;">
<p style="margin:0 0 12px;">${hello}</p>
<p style="margin:0 0 12px;">As set out in our Data Retention Policy, DataDost keeps the text read from your documents and your past questions and answers for ${RETENTION_DAYS} days, then clears them.</p>
<p style="margin:0 0 12px;">This is a service notice about your data, not a marketing email.</p>
<p style="margin:0 0 12px;">Some of your older data is about to reach that point. It will be cleared on or after <strong>${esc(formatDate(clearFromMs))}</strong>. If there is anything you want to keep, please save it before then.</p>
<p style="margin:0 0 12px;">Your account stays open. You can upload a document again at any time.</p>
<p style="margin:0 0 18px;"><a href="${APP_URL}/data-retention" style="color:#FF6B1A;">Read the Data Retention Policy</a></p>
<p style="margin:0;color:#6B6B80;font-size:13px;">We never store your PAN or Aadhaar. Questions? Write to privacy@datadost.in.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, html };
}

async function sendEmail({ to, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!resp.ok) throw new Error('Resend send failed ' + resp.status + ': ' + (await resp.text()));
  return resp.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Clearing one user ────────────────────────────────────────────────────────

async function clearUser(userId, plan, cutoffMs) {
  const uid = encodeURIComponent(userId);
  const cut = iso(cutoffMs);

  // Delete both tables, getting back exactly what was removed.
  const delMsgs = await sbDeleteReturning(`/rest/v1/messages?user_id=eq.${uid}&created_at=lt.${cut}&select=role`);
  const delSnaps = CLEAR_SNAPSHOTS
    ? await sbDeleteReturning(`/rest/v1/financial_snapshots?user_id=eq.${uid}&created_at=lt.${cut}&select=doc_key`)
    : [];

  const questionsCleared = delMsgs.filter((m) => m.role === 'user').length;

  // Uploads cleared = distinct documents that no longer have ANY snapshot left. A document whose
  // doc_key still has newer rows is still counted by the app's live count, so do not count it twice.
  const deletedKeys = new Set(delSnaps.map((s) => s.doc_key).filter(Boolean));
  let uploadsCleared = 0;
  if (deletedKeys.size > 0) {
    const remaining = await sbGet(`/rest/v1/financial_snapshots?user_id=eq.${uid}&select=doc_key&limit=${PAGE_SIZE}`);
    const stillThere = new Set((remaining || []).map((r) => r.doc_key));
    for (const k of deletedKeys) if (!stillThere.has(k)) uploadsCleared++;
  }

  if (questionsCleared > 0 || uploadsCleared > 0) {
    try {
      await sbPatch(`/rest/v1/user_plans?user_id=eq.${uid}`, {
        questions_cleared: (plan.questions_cleared || 0) + questionsCleared,
        uploads_cleared: (plan.uploads_cleared || 0) + uploadsCleared,
      });
    } catch (e) {
      // The rows are already gone. Log loudly so the counters can be corrected by hand.
      console.error('[DataDost] clear-expired: ROWS DELETED BUT QUOTA OFFSET FAILED for', userId,
        { questionsCleared, uploadsCleared }, e.message);
      throw e;
    }
  }
  return { messages: delMsgs.length, snapshots: delSnaps.length, questionsCleared, uploadsCleared };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[DataDost] clear-expired: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    return res.status(500).json({ error: 'Server not configured.' });
  }
  if (ENABLED && !RESEND_API_KEY) {
    console.error('[DataDost] clear-expired: missing RESEND_API_KEY — cannot send notices, so nothing will be deleted.');
    return res.status(500).json({ error: 'Email not configured.' });
  }

  const now = Date.now();
  const summary = {
    mode: ENABLED ? 'live' : 'dry-run',
    usersConsidered: 0, noticesSent: 0, usersCleared: 0,
    messagesDeleted: 0, snapshotsDeleted: 0, skipped: 0, errors: 0,
  };

  try {
    // Refuse to run if the setup SQL has not been applied (clearer than a stream of 400s).
    try {
      await sbGet('/rest/v1/user_plans?select=user_id,questions_cleared,uploads_cleared,clear_notice_sent_at&limit=1');
    } catch (e) {
      console.error('[DataDost] clear-expired: user_plans is missing the new columns — run clear-expired-setup.sql first.', e.message);
      return res.status(500).json({ error: 'Database setup incomplete.' });
    }

    // Everyone with data at least NOTICE_WINDOW_DAYS (25 days) old, in the tables this job clears.
    const windowMs = now - NOTICE_WINDOW_DAYS * DAY_MS;
    const found = await Promise.all(TABLES.map((t) => usersWithRowsOlderThan(t, windowMs)));
    const userIds = Array.from(new Set(found.flatMap((f) => Array.from(f)))).slice(0, MAX_USERS_PER_RUN);
    summary.usersConsidered = userIds.length;

    for (const userId of userIds) {
      try {
        const rows = await sbGet(
          `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=user_id,questions_cleared,uploads_cleared,clear_notice_sent_at`
        );
        const plan = rows && rows[0];
        if (!plan) {
          // No plan row means nowhere to record the quota offset — never delete in that case.
          console.warn('[DataDost] clear-expired: no user_plans row for', userId, '— skipped.');
          summary.skipped++;
          continue;
        }

        const noticeMs = plan.clear_notice_sent_at ? new Date(plan.clear_notice_sent_at).getTime() : null;

        // ── 2. CLEAR — only rows that are at least 30 days old AND already existed when the last
        //    notice went out, and only once that notice is at least 48 hours old.
        let clearCutoffMs = null;
        if (noticeMs && noticeMs <= now - NOTICE_LEAD_DAYS * DAY_MS) {
          clearCutoffMs = Math.min(now - RETENTION_DAYS * DAY_MS, noticeMs);
        }
        if (clearCutoffMs) {
          let hasExpired = false;
          for (const t of TABLES) {
            if (await hasRowsBetween(t, userId, null, clearCutoffMs)) hasExpired = true;
          }
          if (hasExpired) {
            if (ENABLED) {
              const r = await clearUser(userId, plan, clearCutoffMs);
              summary.usersCleared++;
              summary.messagesDeleted += r.messages;
              summary.snapshotsDeleted += r.snapshots;
              console.log('[DataDost] clear-expired: cleared', userId, JSON.stringify(r));
            } else {
              summary.usersCleared++;
              console.log('[DRY RUN] clear-expired: would clear data older than',
                new Date(clearCutoffMs).toISOString(), 'for', userId);
            }
          }
        }

        // ── 1. NOTICE — rows that are 25+ days old but were created after the last notice, so no
        //    notice covers them yet.
        {
          const uncoveredFrom = noticeMs; // null = never noticed
          let hasUncovered = false;
          for (const t of TABLES) {
            if (await hasRowsBetween(t, userId, uncoveredFrom, windowMs)) hasUncovered = true;
          }
          if (hasUncovered) {
            if (!ENABLED) {
              summary.noticesSent++;
              console.log('[DRY RUN] clear-expired: would send notice to', userId);
            } else {
              const info = await getAuthUser(userId);
              if (!info) {
                console.warn('[DataDost] clear-expired: no email found for', userId, '— no notice sent, so no deletion either.');
                summary.skipped++;
              } else {
                // Date shown to the user: when the oldest not-yet-noticed row reaches 30 days
                // (never sooner than 48 hours from now).
                let oldestMs = null;
                for (const t of TABLES) {
                  const lower = uncoveredFrom == null ? '' : `&created_at=gte.${iso(uncoveredFrom)}`;
                  const r = await sbGet(`/rest/v1/${t}?user_id=eq.${encodeURIComponent(userId)}${lower}&select=created_at&order=created_at.asc&limit=1`);
                  if (r && r[0] && r[0].created_at) {
                    const ms = new Date(r[0].created_at).getTime();
                    if (oldestMs == null || ms < oldestMs) oldestMs = ms;
                  }
                }
                const clearFromMs = Math.max((oldestMs == null ? now : oldestMs) + RETENTION_DAYS * DAY_MS, now + NOTICE_LEAD_DAYS * DAY_MS);
                const { subject, html } = buildNoticeEmail({
                  firstName: info.firstName,
                  clearFromMs: clearFromMs,
                });
                await sendEmail({ to: info.email, subject, html });
                // Stamp only after the email was accepted — a failed send must never start the clock.
                await sbPatch(`/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}`, {
                  clear_notice_sent_at: new Date(now).toISOString(),
                });
                summary.noticesSent++;
                await sleep(120);
              }
            }
          }
        }
      } catch (e) {
        summary.errors++;
        console.error('[DataDost] clear-expired: error for user', userId, ':', e.message);
        // One user failing must not stop the rest.
      }
    }

    console.log('[DataDost] clear-expired:', JSON.stringify(summary));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[DataDost] clear-expired fatal:', e);
    return res.status(500).json({ error: 'Clearing job failed.' });
  }
}
