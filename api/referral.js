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
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
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

async function supabaseGet(path, token) {
  var resp = await fetch(SUPABASE_URL + path, {
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY }
  });
  if (!resp.ok) throw new Error('Supabase GET ' + path + ' returned ' + resp.status);
  return resp.json();
}

async function supabasePost(path, body, token) {
  var resp = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      apikey: SUPABASE_ANON_KEY,
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

async function supabasePatch(path, body, token) {
  var resp = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      apikey: SUPABASE_ANON_KEY,
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

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });

  const { action, refCode, email } = req.body || {};

  // ── ACTION: init ─────────────────────────────────────────────────────────
  // Ensure this user has a user_plans row. Called on every login — idempotent.
  if (action === 'init') {
    try {
      var existing = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + user.id + '&select=user_id,ref_code,plan,bonus_questions_earned,bonus_questions_used,waitlisted',
        user.token
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
        }, user.token);
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
          }, user.token);
        } else throw e;
      }

      // If this user arrived via a referral link, record the relationship
      if (refCode) {
        try {
          var referrerRows = await supabaseGet(
            '/rest/v1/user_plans?ref_code=eq.' + encodeURIComponent(refCode) + '&select=user_id',
            user.token
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
              }, user.token);
              // Record who referred this user on their own plan row
              await supabasePatch(
                '/rest/v1/user_plans?user_id=eq.' + user.id,
                { referred_by: referrerId },
                user.token
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
        '/rest/v1/referrals?referred_id=eq.' + user.id + '&status=eq.pending&bonus_granted=eq.false&select=id,referrer_id',
        user.token
      );
      if (!pendingRefs || pendingRefs.length === 0) {
        return res.status(200).json({ ok: true, message: 'No pending referral to complete.' });
      }

      var ref = pendingRefs[0];
      var referrerId = ref.referrer_id;

      // Check referrer hasn't already hit the max referral cap
      var referrerPlan = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + referrerId + '&select=bonus_questions_earned',
        user.token
      );
      var referrerBonus = (referrerPlan && referrerPlan[0]) ? referrerPlan[0].bonus_questions_earned : 0;
      var referrerCanReceive = referrerBonus < (MAX_REFERRALS * BONUS_PER_REFERRAL);

      if (referrerCanReceive) {
        await supabasePatch(
          '/rest/v1/user_plans?user_id=eq.' + referrerId,
          { bonus_questions_earned: referrerBonus + BONUS_PER_REFERRAL },
          user.token
        );
      }

      // Referred user also gets bonus questions — double-sided referral
      var referredPlan = await supabaseGet(
        '/rest/v1/user_plans?user_id=eq.' + user.id + '&select=bonus_questions_earned',
        user.token
      );
      var referredBonus = (referredPlan && referredPlan[0]) ? referredPlan[0].bonus_questions_earned : 0;
      await supabasePatch(
        '/rest/v1/user_plans?user_id=eq.' + user.id,
        { bonus_questions_earned: referredBonus + BONUS_PER_REFERRAL },
        user.token
      );

      // Mark referral as completed
      await supabasePatch(
        '/rest/v1/referrals?id=eq.' + ref.id,
        { status: 'completed', bonus_granted: true, completed_at: new Date().toISOString() },
        user.token
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
