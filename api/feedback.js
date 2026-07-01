// Saves beta feedback directly to Supabase using the existing SUPABASE_ANON_KEY
// and SUPABASE_URL — no new env vars needed, both are already configured for chat/forecast.
// RLS INSERT policy on the feedback table allows anon + authenticated writes:
//   create policy "allow_feedback_insert" on public.feedback
//     for insert to anon, authenticated with check (true);
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, screen, userAgent, senderEmail } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Feedback message is required.' });
  }
  if (message.trim().length > 2000) {
    return res.status(400).json({ error: 'Feedback too long — please keep it under 2000 characters.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[DataDost] Supabase env vars missing in feedback.js');
    return res.status(500).json({ error: 'Feedback service not configured.' });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        sender_email: senderEmail || 'anonymous',
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
