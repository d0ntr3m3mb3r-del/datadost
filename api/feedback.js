// Saves beta feedback to the Supabase feedback table.
// Auth: verifies the caller is a real logged-in DataDost user by checking their
// session token against Supabase auth — exactly the same pattern as verifyUser()
// in _rateLimit.js, but also extracts the user's email from the response so
// feedback is always traceable without asking the user to type it manually.
// Logged-out visitors are rejected: feedback without a real identity is noise.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function getUserFromToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (!user || !user.id) return null;
    // Return both the id and the verified email — this is the source of truth,
    // not anything the client sent us, so it can't be spoofed in the request body.
    return { id: user.id, email: user.email, token };
  } catch (err) {
    console.error('[DataDost] Feedback auth check failed:', err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify the session and get the real email from Supabase — not from the request body.
  // A logged-out visitor or bot with no valid token is rejected here.
  const user = await getUserFromToken(req);
  if (!user) {
    return res.status(401).json({ error: 'Please log in to send feedback.' });
  }

  const { message, screen, userAgent } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Feedback message is required.' });
  }
  if (message.trim().length > 2000) {
    return res.status(400).json({ error: 'Feedback too long — please keep it under 2000 characters.' });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${user.token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        sender_email: user.email,   // verified from Supabase, not from request body
        message: message.trim(),
        screen: screen || 'Unknown',
        user_agent: (userAgent || '').slice(0, 300)
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[DataDost] Supabase feedback insert error:', response.status, err);
      return res.status(500).json({ error: 'Could not save feedback — please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[DataDost] Feedback error:', err);
    return res.status(500).json({ error: 'Could not save feedback — please try again.' });
  }
}
