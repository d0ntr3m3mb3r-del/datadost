const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export async function verifyUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (!user || !user.id) return null;
    return { id: user.id, token };
  } catch (err) {
    console.error('[DataDost] Auth verification request failed:', err);
    return null;
  }
}

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
    // Best-effort cleanup — never awaited, failure here must never block the real request
    const cutoff = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    fetch(`${SUPABASE_URL}/rest/v1/api_rate_limits?user_id=eq.${user.id}&created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}`, apikey: SUPABASE_ANON_KEY, Prefer: 'return=minimal' },
    }).catch(() => {});
    return { allowed: true };
  } catch (err) {
    console.error('[DataDost] Rate limit check failed — failing open:', err);
    return { allowed: true };
  }
}

// Free tier: 20 questions lifetime flat pool + referral bonuses. Plus/beta: unlimited.
const FREE_QUESTION_BASE = 20;
const FREE_UPLOAD_LIMIT  = 2;

export async function checkPlanLimits({ user, docKey }) {
  try {
    const planResp = await fetch(
      `${SUPABASE_URL}/rest/v1/user_plans?user_id=eq.${user.id}&select=plan,bonus_questions_earned,bonus_questions_used`,
      { headers: { Authorization: `Bearer ${user.token}`, apikey: SUPABASE_ANON_KEY } }
    );
    if (!planResp.ok) return { allowed: true };
    const planRows = await planResp.json();
    if (!planRows || planRows.length === 0) return { allowed: true };
    const plan = planRows[0];
    // Beta and paid users get unlimited access
    if (plan.plan && plan.plan !== 'free') return { allowed: true };
    // Count lifetime questions for free users
    const qResp = await fetch(
      `${SUPABASE_URL}/rest/v1/messages?user_id=eq.${user.id}&role=eq.user&select=id`,
      { headers: { Authorization: `Bearer ${user.token}`, apikey: SUPABASE_ANON_KEY } }
    );
    if (!qResp.ok) return { allowed: true };
    const qRows = await qResp.json();
    const questionCount = qRows ? qRows.length : 0;
    const bonusEarned  = plan.bonus_questions_earned || 0;
    const totalAllowed = FREE_QUESTION_BASE + bonusEarned;
    const remaining    = Math.max(0, totalAllowed - questionCount);
    if (questionCount >= totalAllowed) {
      return { allowed: false, limitType: 'questions', questionCount, totalAllowed, remaining: 0, bonusEarned };
    }
    return { allowed: true, remaining, questionCount, totalAllowed };
  } catch (err) {
    console.error('[DataDost] Plan limit check failed — failing open:', err);
    return { allowed: true };
  }
}

export { FREE_QUESTION_BASE, FREE_UPLOAD_LIMIT };
