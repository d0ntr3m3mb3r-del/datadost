// api/referral.js — Referral system for DataDost free tier
// Two operations via the 'action' field in the request body:
//
//   'init'     — called once after signup/login to ensure the user has a
//                user_plans row with a referral code. Idempotent — safe to
//                call on every login, creates only if missing.
//
//   'complete' — called when a referred user uploads their first document.
//                Marks the referral as completed, grants bonus questions to
//                the referrer (5 per referral, max 2 referrals = 10 total),
//                and also grants 5 bonus questions to the referred user.
//                Idempotent — safe if called more than once; bonus_granted
//                flag prevents double-crediting.

import { verifyUser } from './_rateLimit.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
// This function legitimately needs to read and write OTHER users' rows — looking up a
// referrer by their ref_code, and later crediting bonus questions onto the referrer's own
// account — neither of which the referred user's own login token can do under Row Level
// Security (a user's own token can only touch their own row, by design, for privacy).
// A real, confirmed bug: every referral silently failed because these calls were using
// the calling user's own token, so the referrer lookup always returned zero rows and the
// referrals table never got a single entry, across every account ever tested. The fix is
// the service_role key, which is Supabase's standard, intended mechanism for trusted
// backend code — already gated here by verifyUser(req) at the top of every request — to
// perform exactly this kind of narrow, pre-validated cross-user operation. This key must
// NEVER be used in any client-side code; it only ever belongs in serverless functions like
// this one.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BONUS_PER_REFERRAL = 5;
const MAX_REFERRALS = 2;

// Generates a short readable code: first 3 letters of email username
// uppercased + 4 random alphanumeric chars. e.g. SAN7K2A9.
// Collision probability across 500 users is negligible.
function generateRefCode(email) {
  var prefix = (email || '').split('@')[0].replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'USR';
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1 to avoid confusion
  var suffix = '';
  for (var i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return prefix + suffix;
}

async function supabaseGet(path) {
  var resp = await fetch(SUPABASE_URL + path, {
    headers: { Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, apikey: SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!resp.ok) throw new Error('Supabase GET ' + path + ' returned ' + resp.status);
  return resp.json();
}

async function supabasePost(path, body) {
  var resp = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Supabase POST ' + path + ' returned ' + resp.status + ': ' + err);
  }
  return resp.json();
}

async function supabasePatch(path, body) {
  var resp = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Supabase PATCH ' + path + ' returned ' + resp.status + ': ' + err);
  }
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Fail loudly and immediately if the required env var isn't set, rather than letting
  // every downstream Supabase call fail with a generic 401 that's hard to trace back to
  // this specific missing piece of config.
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[DataDost] SUPABASE_SERVICE_ROLE_KEY is not set — referral system cannot function.');
    return res.status(500).json({ error: 'Referral system not configured on server.' });
  }

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });

  const { action, refCode, email } = req.body || {};

  // ── ACTION: init ─────────────────────────────────────────────────────────
  // Ensure this user has a user_plans row. Called on every login — idempotent.
  if (action === 'init') {
    try {
      var existing = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + user.id + '&select=user_id,ref_code,plan,bonus_questions_earned,bonus_questions_used,waitlisted'
      );
      if (existing && existing.length > 0) {
        return res.status(200).json({ plan: existing[0] });
      }

      // New user — generate a unique ref code (retry once on collision)
      var code = generateRefCode(email || user.id);
      var inserted;
      try {
        inserted = await supabasePost('/rest/v1/user_plans', {
          user_id: user.id,
          plan: 'free',
          ref_code: code,
          bonus_questions_earned: 0,
          bonus_questions_used: 0,
          waitlisted: false
        });
      } catch (e) {
        // Collision on ref_code unique constraint — retry with a different code
        if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
          code = generateRefCode((email || user.id) + Date.now());
          inserted = await supabasePost('/rest/v1/user_plans', {
            user_id: user.id,
            plan: 'free',
            ref_code: code,
            bonus_questions_earned: 0,
            bonus_questions_used: 0,
            waitlisted: false
          });
        } else throw e;
      }

      // If this user arrived via a referral link, record the relationship
      if (refCode) {
        try {
          var referrerRows = await supabaseGet(
            '/rest/v1/user_plans?ref_code=eq.' + encodeURIComponent(refCode) + '&select=user_id'
          );
          if (referrerRows && referrerRows.length > 0) {
            var referrerId = referrerRows[0].user_id;
            if (referrerId !== user.id) {
              await supabasePost('/rest/v1/referrals', {
                referrer_id: referrerId,
                referred_id: user.id,
                referred_email: email || null,
                status: 'pending',
                bonus_granted: false
              });
              // Record who referred this user on their own plan row
              await supabasePatch(
                '/rest/v1/user_plans?user_id=eq.' + user.id,
                { referred_by: referrerId }
              );
            }
          }
        } catch (refErr) {
          // Referral recording failure must never block the user's own init
          console.error('[DataDost] Referral record error during init:', refErr.message);
        }
      }

      return res.status(200).json({ plan: inserted && inserted[0] ? inserted[0] : { user_id: user.id, ref_code: code, plan: 'free' } });
    } catch (err) {
      console.error('[DataDost] referral init error:', err.message);
      return res.status(500).json({ error: 'Could not initialise plan.' });
    }
  }

  // ── ACTION: complete ──────────────────────────────────────────────────────
  // Called when a referred user uploads their first document.
  // Grants bonus to referrer (if under max) and to the referred user.
  if (action === 'complete') {
    try {
      // Find a pending referral where this user is the referred party
      var pendingRefs = await supabaseGet(
        '/rest/v1/referrals?referred_id=eq.' + user.id + '&status=eq.pending&bonus_granted=eq.false&select=id,referrer_id'
      );
      if (!pendingRefs || pendingRefs.length === 0) {
        return res.status(200).json({ ok: true, message: 'No pending referral to complete.' });
      }

      var ref = pendingRefs[0];
      var referrerId = ref.referrer_id;

      // Check referrer hasn't already hit the max referral cap
      var referrerPlan = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + referrerId + '&select=bonus_questions_earned'
      );
      var referrerBonus = (referrerPlan && referrerPlan[0]) ? referrerPlan[0].bonus_questions_earned : 0;
      var referrerCanReceive = referrerBonus < (MAX_REFERRALS * BONUS_PER_REFERRAL);

      if (referrerCanReceive) {
        await supabasePatch(
          '/rest/v1/user_plans?user_id=eq.' + referrerId,
          { bonus_questions_earned: referrerBonus + BONUS_PER_REFERRAL }
        );
      }

      // Referred user also gets bonus questions — double-sided referral
      var referredPlan = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + user.id + '&select=bonus_questions_earned'
      );
      var referredBonus = (referredPlan && referredPlan[0]) ? referredPlan[0].bonus_questions_earned : 0;
      await supabasePatch(
        '/rest/v1/user_plans?user_id=eq.' + user.id,
        { bonus_questions_earned: referredBonus + BONUS_PER_REFERRAL }
      );

      // Mark referral as completed
      await supabasePatch(
        '/rest/v1/referrals?id=eq.' + ref.id,
        { status: 'completed', bonus_granted: true, completed_at: new Date().toISOString() }
      );

      console.log('[DataDost] Referral completed:', ref.id, '— referrer', referrerId, 'gets', BONUS_PER_REFERRAL, 'bonus Qs');
      return res.status(200).json({ ok: true, bonusGrantedToReferrer: referrerCanReceive });
    } catch (err) {
      console.error('[DataDost] referral complete error:', err.message);
      return res.status(500).json({ error: 'Could not complete referral.' });
    }
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
