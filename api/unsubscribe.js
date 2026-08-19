// api/unsubscribe.js — One-click unsubscribe from DataDost nudge/marketing emails.
//
// Deliberately unauthenticated by design (GET request, clicked straight from an
// email link, no login required) — this is standard, expected behaviour for
// unsubscribe links and is what regulators and every major ESP recommend, since
// forcing a login here is a real drop-off point and arguably worse for the user.
//
// Because there's no session, identity is proven with a signed token instead:
// token = HMAC-SHA256(user_id, UNSUBSCRIBE_SECRET), generated wherever nudge
// emails are built and embedded in the unsubscribe link. This endpoint recomputes
// the same HMAC from the user_id in the URL and only proceeds if it matches —
// so a link can't be forged or guessed, only ever generated server-side by us.
//
// IMPORTANT — scope of what this flag controls: unsubscribed_from_nudges ONLY
// ever gates the monthly re-engagement/nudge emails. It must never be checked
// anywhere that sends transactional email (signup confirmation, password reset,
// security notices) — those are not marketing email and must always be sent
// regardless of this flag. That distinction is a real compliance line, not a
// style preference — see DataDost's own Privacy Policy commitments.
//
// Uses the service_role key, same pattern as referral.js — this endpoint writes
// to a user's row with no session/bearer token available at all, so the anon
// key + per-user-token pattern used elsewhere in this codebase cannot apply here.

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;

// TODO once logo hosting (a separate, already-tracked task) is done: set this to
// the real hosted URL, e.g. 'https://datadost.in/assets/logo-icon.png'. Left blank
// on purpose for now — the confirmation page below renders correctly with just the
// text wordmark if this is empty, so nothing is blocked on logo hosting happening first.
const LOGO_URL = process.env.UNSUBSCRIBE_LOGO_URL || '';

function computeToken(userId) {
  return createHmac('sha256', UNSUBSCRIBE_SECRET).update(userId).digest('hex');
}

// Constant-time comparison — prevents a timing attack from being used to guess
// a valid token character-by-character. Never compare secrets with === or !==.
function tokensMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function renderPage({ success, message }) {
  const logoBlock = LOGO_URL
    ? `<img src="${LOGO_URL}" width="40" height="40" alt="" style="display:block;">`
    : '';
  const icon = success ? '&#10003;' : '&#33;';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DataDost</title>
</head>
<body style="margin:0;padding:0;background-color:#0B0B0F;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0B0B0F;">
  <tr>
    <td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr>
          <td style="padding:48px 32px;text-align:center;font-family:Arial,Helvetica,sans-serif;">

            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
              <tr>
                ${logoBlock ? `<td style="padding-right:12px;vertical-align:middle;">${logoBlock}</td>` : ''}
                <td style="vertical-align:middle;">
                  <div style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:19px;">
                    <span style="color:#ffffff;">Data</span><span style="color:#FF6B1A;">Dost</span>
                  </div>
                </td>
              </tr>
            </table>

            <div style="width:48px;height:48px;border-radius:50%;background-color:#1B1B1B;margin:0 auto 18px;line-height:48px;">
              <span style="color:#FF6B1A;font-size:22px;">${icon}</span>
            </div>

            <h1 style="color:#ffffff;font-size:16px;font-weight:600;margin:0 0 10px;">${success ? "You're unsubscribed" : 'That link is no longer valid'}</h1>
            <p style="color:#C7C7CC;font-size:13px;line-height:1.65;margin:0 0 24px;">${message}</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #2A2A2E;margin-top:28px;">
              <tr>
                <td style="padding-top:16px;">
                  <div style="color:#8A8A93;font-size:11px;">Questions? <a href="mailto:feedback@datadost.in" style="color:#ffffff;text-decoration:none;">feedback@datadost.in</a></div>
                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  if (!SUPABASE_SERVICE_ROLE_KEY || !UNSUBSCRIBE_SECRET) {
    console.error('[DataDost] Unsubscribe endpoint misconfigured — missing SUPABASE_SERVICE_ROLE_KEY or UNSUBSCRIBE_SECRET.');
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(renderPage({
      success: false,
      message: "Something went wrong on our end. Please email us at feedback@datadost.in and we'll take care of it directly.",
    }));
  }

  const { uid, token } = req.query || {};
  res.setHeader('Content-Type', 'text/html');

  if (!uid || !token || !tokensMatch(String(token), computeToken(String(uid)))) {
    // Deliberately generic — never reveal whether the uid was valid, the token was
    // malformed, or anything else. A vague message here is the correct, safe choice.
    return res.status(400).send(renderPage({
      success: false,
      message: 'This link has expired or is no longer valid. If you want to stop receiving these emails, log in and update your preferences, or write to us directly.',
    }));
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/user_plans?user_id=eq.${uid}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ unsubscribed_from_nudges: true }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[DataDost] Unsubscribe PATCH failed:', resp.status, err);
      return res.status(500).send(renderPage({
        success: false,
        message: "Something went wrong on our end. Please email us at feedback@datadost.in and we'll take care of it directly.",
      }));
    }

    return res.status(200).send(renderPage({
      success: true,
      message: "You won't get monthly nudge emails from DataDost anymore. You'll still receive account emails like sign-in confirmations, if you ever need one.",
    }));
  } catch (err) {
    console.error('[DataDost] Unsubscribe error:', err.message);
    return res.status(500).send(renderPage({
      success: false,
      message: "Something went wrong on our end. Please email us at feedback@datadost.in and we'll take care of it directly.",
    }));
  }
}
