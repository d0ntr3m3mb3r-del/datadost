// api/send-nudges.js — Monthly re-engagement email sender.
//
// Triggered by Vercel Cron on the 1st of every month at 1:30 AM UTC (~7:00 AM IST).
// Protected by CRON_SECRET — identical pattern to sync-ticker.js.
//
// TWO SEGMENTS (resolved at query time, no manual list needed):
//   Segment 1 — signed up, never uploaded a document (upload_count = 0)
//   Segment 2 — uploaded at least once, then went quiet (last_active_at > 20 days ago)
//
// DEDUP GUARD: checks last_nudge_sent_at per user — anyone who already received a
// nudge in the current calendar month is skipped. This means if the cron fires
// twice for any reason (Vercel retry, manual test), nobody gets a duplicate.
//
// UNSUBSCRIBE: generates a signed HMAC-SHA256 token per user (same secret as
// unsubscribe.js uses to verify). Link format:
//   https://datadost.in/api/unsubscribe?uid=<user_id>&token=<hmac>
//
// RESEND: uses the Resend REST API directly (not SMTP) — one API call per email,
// batched sequentially with a 100ms pause between sends. We are well inside Resend's
// free tier (100 emails/day) for a beta product of this size.
//
// NEWS CONTENT: reads the most recent active news_ticker row. If the latest item
// is older than 12 days, the news section is omitted from Segment-2 emails rather
// than showing stale content.
//
// Uses SUPABASE_SERVICE_ROLE_KEY for all DB reads/writes — same as referral.js,
// unsubscribe.js, and sync-ticker.js. No user session exists in a cron context.
//
// IMPORTANT — transactional email scope: this function ONLY sends nudge/marketing
// email. It MUST check unsubscribed_from_nudges and skip those users. It must NEVER
// gate or affect signup, password-reset, or other transactional email — those are
// handled entirely by Supabase auth and are never touched here.

import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// The real hosted logo — confirmed live as of 12 Aug 2026 session.
const LOGO_URL = 'https://datadost.in/assets/logo-icon.png';
const APP_URL = 'https://datadost.in';
const FROM_ADDRESS = 'DataDost <noreply@datadost.in>';

// Inactivity threshold — users active within this many days are skipped.
const INACTIVITY_DAYS = 20;

// News content staleness threshold — if the most recent ticker item is older
// than this, we omit the news section rather than show stale content.
// 12 days: sync-ticker runs weekly, so ≥12 days without fresh content would
// genuinely mean a missed run or a week with zero qualifying articles.
const NEWS_STALE_DAYS = 12;

// ── Supabase helpers (service-role, no user session) ─────────────────────────

async function supabaseGet(path) {
  const resp = await fetch(SUPABASE_URL + path, {
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!resp.ok) {
    throw new Error('Supabase GET ' + path + ' → ' + resp.status + ': ' + await resp.text());
  }
  return resp.json();
}

async function supabasePatch(path, body) {
  const resp = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error('Supabase PATCH ' + path + ' → ' + resp.status + ': ' + await resp.text());
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

// Must produce the same token that unsubscribe.js verifies — do not change this
// without also updating computeToken() in unsubscribe.js.
function computeUnsubToken(userId) {
  return createHmac('sha256', UNSUBSCRIBE_SECRET).update(userId).digest('hex');
}

function buildUnsubLink(userId) {
  return `${APP_URL}/api/unsubscribe?uid=${encodeURIComponent(userId)}&token=${computeUnsubToken(userId)}`;
}

// ── Dedup guard ───────────────────────────────────────────────────────────────

// Returns true if the user has already been nudged in the current calendar month.
function alreadyNudgedThisMonth(lastNudgeSentAt) {
  if (!lastNudgeSentAt) return false;
  const last = new Date(lastNudgeSentAt);
  const now = new Date();
  return last.getUTCFullYear() === now.getUTCFullYear() &&
         last.getUTCMonth() === now.getUTCMonth();
}

// ── News freshness check ──────────────────────────────────────────────────────

function isNewsStale(publishedAt) {
  if (!publishedAt) return true;
  const age = (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24);
  return age > NEWS_STALE_DAYS;
}

// ── Resend send helper ────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Resend send to ' + to + ' failed ' + resp.status + ': ' + err);
  }
  return resp.json();
}

// Small pause between sends — avoids burst rate-limit issues.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Email templates ───────────────────────────────────────────────────────────
// These are minimal inline-style table-based HTML — Outlook/legacy compatible,
// matching the same dark-theme pattern as nudge_never_uploaded.html and
// nudge_went_quiet.html produced during the 12 Aug 2026 session.
// NOTE: If you later want to use those pre-built HTML files, load them from disk
// and do a string-replace for the merge variables — they are the richer version.
// This inline approach is kept here so the function is self-contained.

function templateBase({ preheader, bodyContent, firstName, unsubLink }) {
  const displayName = firstName || 'there';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DataDost</title>
</head>
<body style="margin:0;padding:0;background-color:#0B0B0F;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;&nbsp;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0B0B0F;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#131318;border-radius:16px;overflow:hidden;">

        <!-- HEADER -->
        <tr>
          <td style="padding:28px 32px 20px;border-bottom:1px solid #1F1F27;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px;vertical-align:middle;">
                  <img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;border-radius:6px;">
                </td>
                <td style="vertical-align:middle;">
                  <span style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;">
                    <span style="color:#ffffff;">Data</span><span style="color:#E86832;">Dost</span>
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="padding:28px 32px 8px;">
            ${bodyContent(displayName)}
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #1F1F27;margin-top:8px;">
            <p style="margin:0;font-size:11px;color:#5A5A6A;line-height:1.6;">
              You're receiving this because you signed up at <a href="${APP_URL}" style="color:#E86832;text-decoration:none;">datadost.in</a>.
              This is not a transactional email — your account emails (sign-in, password reset) are always sent regardless of this preference.<br><br>
              <a href="${unsubLink}" style="color:#5A5A6A;text-decoration:underline;">Unsubscribe from these monthly emails</a>
              &nbsp;·&nbsp;
              <a href="mailto:feedback@datadost.in" style="color:#5A5A6A;text-decoration:underline;">feedback@datadost.in</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Segment 1 — signed up, never uploaded.
function buildNeverUploadedEmail({ firstName, unsubLink, dashboardUrl }) {
  const subject = 'Your financial picture is one upload away';
  const preheader = 'Take 30 seconds — drop in a bank statement or salary slip and ask DataDost anything.';

  function bodyContent(displayName) {
    return `
      <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#ffffff;line-height:1.4;">Hi ${displayName},</p>
      <p style="margin:0 0 16px;font-size:14px;color:#C7C7CC;line-height:1.7;">You signed up for DataDost — great first step. But you haven't uploaded a document yet, so DataDost hasn't been able to do anything for you.</p>
      <p style="margin:0 0 24px;font-size:14px;color:#C7C7CC;line-height:1.7;">It takes under 30 seconds. Drop in a bank statement, salary slip, or credit card statement — then ask anything: <em>Where is my money going? How much should I save this month? Am I spending too much on food delivery?</em></p>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
        <tr>
          <td style="background-color:#E86832;border-radius:999px;padding:13px 28px;">
            <a href="${dashboardUrl}" style="color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;display:block;">Upload your first document →</a>
          </td>
        </tr>
      </table>

      <!-- Feature pills -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
        <tr>
          <td style="padding:12px;background-color:#1A1A22;border-radius:10px;text-align:center;width:30%;">
            <div style="font-size:18px;margin-bottom:4px;">📄</div>
            <div style="font-size:11px;color:#C7C7CC;font-weight:600;">Upload</div>
            <div style="font-size:10px;color:#5A5A6A;">PDF or image</div>
          </td>
          <td width="8"></td>
          <td style="padding:12px;background-color:#1A1A22;border-radius:10px;text-align:center;width:30%;">
            <div style="font-size:18px;margin-bottom:4px;">🔍</div>
            <div style="font-size:11px;color:#C7C7CC;font-weight:600;">Understand</div>
            <div style="font-size:10px;color:#5A5A6A;">AI reads it</div>
          </td>
          <td width="8"></td>
          <td style="padding:12px;background-color:#1A1A22;border-radius:10px;text-align:center;width:30%;">
            <div style="font-size:18px;margin-bottom:4px;">💬</div>
            <div style="font-size:11px;color:#C7C7CC;font-weight:600;">Ask</div>
            <div style="font-size:10px;color:#5A5A6A;">Plain English</div>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#5A5A6A;line-height:1.5;">No bank account linking. No sharing passwords. Your document stays on your device — only the numbers are read.</p>
    `;
  }

  return { subject, html: templateBase({ preheader, bodyContent, firstName, unsubLink }) };
}

// Segment 2 — uploaded before, went quiet. Optionally includes a news item.
function buildWentQuietEmail({ firstName, unsubLink, dashboardUrl, questionsRemaining, newsItem }) {
  const subject = 'Your finances didn\'t take a break — have you?';
  const preheader = 'New month, fresh statements. Ask DataDost what changed.';

  function bodyContent(displayName) {
    const qBadge = (typeof questionsRemaining === 'number' && questionsRemaining > 0)
      ? `<p style="margin:0 0 16px;font-size:13px;color:#0F6E56;font-weight:600;">You still have ${questionsRemaining} free question${questionsRemaining === 1 ? '' : 's'} remaining.</p>`
      : '';

    const newsSection = (newsItem && !isNewsStale(newsItem.published_at))
      ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background-color:#1A1A22;border-radius:10px;overflow:hidden;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#E86832;text-transform:uppercase;margin-bottom:6px;">What's new for working Indians</div>
              <div style="font-size:13px;font-weight:700;color:#ffffff;line-height:1.4;margin-bottom:6px;">${newsItem.headline}</div>
              <div style="font-size:12px;color:#8A8A9A;line-height:1.6;">${newsItem.blurb}</div>
              ${newsItem.ask_prompt
                ? `<p style="margin:10px 0 0;font-size:11px;color:#5A5A6A;font-style:italic;">Try asking DataDost: "${newsItem.ask_prompt}"</p>`
                : ''}
            </td>
          </tr>
        </table>`
      : '';

    return `
      <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#ffffff;line-height:1.4;">Hi ${displayName},</p>
      <p style="margin:0 0 16px;font-size:14px;color:#C7C7CC;line-height:1.7;">It's been a while. A new month means new salary credits, new bills, and new patterns worth looking at.</p>
      <p style="margin:0 0 16px;font-size:14px;color:#C7C7CC;line-height:1.7;">Drop in last month's statement and ask DataDost what changed — takes under 2 minutes.</p>
      ${qBadge}
      ${newsSection}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
        <tr>
          <td style="background-color:#E86832;border-radius:999px;padding:13px 28px;">
            <a href="${dashboardUrl}" style="color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;display:block;">Open DataDost →</a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:12px;color:#5A5A6A;line-height:1.5;">No bank account linking. No sharing passwords. Your documents stay private.</p>
    `;
  }

  return { subject, html: templateBase({ preheader, bodyContent, firstName, unsubLink }) };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Cron-only — same CRON_SECRET pattern as sync-ticker.js.
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Config guard — fail loudly before touching anything.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[DataDost] send-nudges: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    return res.status(500).json({ error: 'Server not configured.' });
  }
  if (!UNSUBSCRIBE_SECRET) {
    console.error('[DataDost] send-nudges: missing UNSUBSCRIBE_SECRET — cannot generate unsubscribe links.');
    return res.status(500).json({ error: 'Server not configured.' });
  }
  if (!RESEND_API_KEY) {
    console.error('[DataDost] send-nudges: missing RESEND_API_KEY — cannot send emails.');
    return res.status(500).json({ error: 'Email not configured.' });
  }

  try {
    // ── 1. Fetch latest active news ticker item for Segment-2 emails ──────
    let newsItem = null;
    try {
      const tickerRows = await supabaseGet(
        '/rest/v1/news_ticker?active=eq.true&order=published_at.desc&limit=1&select=headline,blurb,ask_prompt,published_at'
      );
      if (tickerRows && tickerRows.length > 0) {
        newsItem = tickerRows[0];
      }
    } catch (e) {
      // Non-fatal — Segment-2 emails will just omit the news section.
      console.warn('[DataDost] send-nudges: could not fetch news_ticker:', e.message);
    }

    // ── 2. Fetch candidates from user_plans ───────────────────────────────
    // upload_count is NOT a column on user_plans — it is derived at runtime by
    // counting distinct doc_key rows in financial_snapshots (matching index.html).
    // We fetch user_plans for plan/bonus/nudge data, then separately fetch
    // financial_snapshots to determine whether each user has ever uploaded.

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - INACTIVITY_DAYS);
    const cutoffIso = cutoffDate.toISOString();

    // Fetch ALL non-unsubscribed users.
    // Columns confirmed present on user_plans: user_id, plan, ref_code,
    // bonus_questions_earned, bonus_questions_used, waitlisted, referred_by,
    // unsubscribed_from_nudges, last_nudge_sent_at.
    // NOTE: upload_count and last_active_at do NOT exist as columns — both are
    // derived at runtime from financial_snapshots and messages respectively.
    const planRows = await supabaseGet(
      '/rest/v1/user_plans?unsubscribed_from_nudges=neq.true&select=user_id,last_nudge_sent_at,bonus_questions_earned,bonus_questions_used&order=user_id.asc&limit=1000'
    );

    if (!planRows || planRows.length === 0) {
      console.log('[DataDost] send-nudges: no users found.');
      return res.status(200).json({ ok: true, sent: 0, skipped: 0 });
    }

    // ── 2b. Fetch upload counts from financial_snapshots ──────────────────
    // Count distinct doc_key per user_id — mirrors index.html's sessionUploadCount.
    const snapRows = await supabaseGet(
      '/rest/v1/financial_snapshots?select=user_id,doc_key'
    );
    const uploadCountMap = {};
    if (snapRows && snapRows.length > 0) {
      for (const snap of snapRows) {
        if (!snap.user_id || !snap.doc_key) continue;
        if (!uploadCountMap[snap.user_id]) uploadCountMap[snap.user_id] = new Set();
        uploadCountMap[snap.user_id].add(snap.doc_key);
      }
    }
    for (const uid of Object.keys(uploadCountMap)) {
      uploadCountMap[uid] = uploadCountMap[uid].size;
    }

    // ── 2c. Fetch last activity from messages table ───────────────────────
    // last_active_at does NOT exist on user_plans. Instead we derive it from
    // the most recent user-role message per user_id — same source index.html
    // uses for sessionQuestionCount. We fetch created_at for all user messages
    // and keep only the latest timestamp per user.
    const msgRows = await supabaseGet(
      '/rest/v1/messages?role=eq.user&select=user_id,created_at&order=created_at.desc&limit=5000'
    );
    const lastActiveMap = {}; // user_id → most recent message created_at (ISO string)
    if (msgRows && msgRows.length > 0) {
      for (const msg of msgRows) {
        if (!msg.user_id || !msg.created_at) continue;
        // Since results are ordered desc, first occurrence per user = most recent
        if (!lastActiveMap[msg.user_id]) {
          lastActiveMap[msg.user_id] = msg.created_at;
        }
      }
    }

    // ── 3. Fetch user emails from Supabase Auth admin API ─────────────────
    // We need first_name (from user_metadata) and email. Supabase Admin API
    // supports listing users in pages — fetch all pages sequentially.
    const userMap = {}; // user_id → { email, first_name }
    let page = 1;
    const perPage = 200; // Supabase admin API max per page
    while (true) {
      const authResp = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
        {
          headers: {
            Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
          },
        }
      );
      if (!authResp.ok) {
        throw new Error('Auth admin users fetch failed: ' + authResp.status + ' ' + await authResp.text());
      }
      const authData = await authResp.json();
      // Supabase returns { users: [...], total: N } or just an array depending on version.
      const users = Array.isArray(authData) ? authData : (authData.users || []);
      for (const u of users) {
        if (u.id && u.email) {
          const meta = u.user_metadata || u.raw_user_meta_data || {};
          // first_name may be stored as full_name, name, or first_name depending on
          // the signup form — check all three and take the first word of whatever we find.
          const fullName = meta.first_name || meta.full_name || meta.name || '';
          const firstName = fullName.trim().split(/\s+/)[0] || '';
          userMap[u.id] = { email: u.email, firstName };
        }
      }
      if (users.length < perPage) break; // last page
      page++;
    }

    // ── 4. Segment and filter ─────────────────────────────────────────────
    const seg1 = []; // never uploaded
    const seg2 = []; // uploaded, gone quiet

    for (const row of planRows) {
      const uid = row.user_id;
      const userInfo = userMap[uid];
      if (!userInfo || !userInfo.email) continue; // no email found — skip

      // Dedup: skip if already nudged this calendar month.
      if (alreadyNudgedThisMonth(row.last_nudge_sent_at)) continue;

      const uploadCount = uploadCountMap[uid] || 0;
      const lastActive = lastActiveMap[uid] || null;

      if (uploadCount === 0) {
        // Segment 1: signed up, never uploaded.
        seg1.push({ uid, ...userInfo, row });
      } else {
        // Segment 2: uploaded at least once.
        // Only nudge if last_active_at is null (very old account) OR older than cutoff.
        const isQuiet = !lastActive || new Date(lastActive) < new Date(cutoffIso);
        if (isQuiet) {
          seg2.push({ uid, ...userInfo, row });
        }
      }
    }

    console.log(`[DataDost] send-nudges: seg1=${seg1.length}, seg2=${seg2.length}`);

    // ── 5. Send emails ────────────────────────────────────────────────────
    let sent = 0;
    let errors = 0;
    const now = new Date().toISOString();

    // Helper: stamp last_nudge_sent_at after a successful send.
    async function stampSent(userId) {
      try {
        await supabasePatch(`/rest/v1/user_plans?user_id=eq.${userId}`, { last_nudge_sent_at: now });
      } catch (e) {
        // Non-fatal but should be investigated — the email went out but the dedup
        // stamp failed, meaning this user COULD get a duplicate on a retry.
        console.error('[DataDost] send-nudges: failed to stamp last_nudge_sent_at for', userId, e.message);
      }
    }

    // Segment 1
    for (const user of seg1) {
      try {
        const unsubLink = buildUnsubLink(user.uid);
        const dashboardUrl = `${APP_URL}?utm_source=email&utm_medium=nudge&utm_campaign=never_uploaded`;
        const { subject, html } = buildNeverUploadedEmail({
          firstName: user.firstName,
          unsubLink,
          dashboardUrl,
        });
        await sendEmail({ to: user.email, subject, html });
        await stampSent(user.uid);
        sent++;
        console.log('[DataDost] send-nudges [seg1] sent to', user.email);
      } catch (e) {
        errors++;
        console.error('[DataDost] send-nudges [seg1] error for', user.email, ':', e.message);
        // Continue — one failed send must not abort the rest of the batch.
      }
      await sleep(120); // 120ms between sends
    }

    // Segment 2
    for (const user of seg2) {
      try {
        const unsubLink = buildUnsubLink(user.uid);
        const dashboardUrl = `${APP_URL}?utm_source=email&utm_medium=nudge&utm_campaign=went_quiet`;
        const questionsRemaining = Math.max(
          0,
          (20 + (user.row.bonus_questions_earned || 0)) -
          (user.row.bonus_questions_used || 0)
          // Note: total allowed is 20 base + bonus earned; bonus_questions_used tracks
          // how many bonus questions have been consumed. This is a best-effort display
          // figure in the email — the authoritative gate is always enforced server-side.
        );
        const { subject, html } = buildWentQuietEmail({
          firstName: user.firstName,
          unsubLink,
          dashboardUrl,
          questionsRemaining,
          newsItem,
        });
        await sendEmail({ to: user.email, subject, html });
        await stampSent(user.uid);
        sent++;
        console.log('[DataDost] send-nudges [seg2] sent to', user.email);
      } catch (e) {
        errors++;
        console.error('[DataDost] send-nudges [seg2] error for', user.email, ':', e.message);
      }
      await sleep(120);
    }

    const summary = { ok: true, sent, errors, seg1: seg1.length, seg2: seg2.length };
    console.log('[DataDost] send-nudges complete:', summary);
    return res.status(200).json(summary);

  } catch (err) {
    console.error('[DataDost] send-nudges fatal error:', err.message);
    return res.status(500).json({ error: 'Nudge send failed.', detail: err.message });
  }
}
