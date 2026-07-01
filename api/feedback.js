// Saves beta feedback directly to a Supabase table — no email dependency,
// no domain verification, no Resend configuration needed. Santosh checks
// feedback anytime from the Supabase dashboard: Table Editor → feedback.
// SQL to create the table (run once in Supabase SQL editor):
//
//   create table public.feedback (
//     id uuid primary key default gen_random_uuid(),
//     sender_email text,
//     message text not null,
//     screen text,
//     user_agent text,
//     created_at timestamptz default now()
//   );
//   alter table public.feedback enable row level security;
//   create policy "service role only" on public.feedback
//     using (false) with check (false);
//   grant insert on public.feedback to anon, authenticated;

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
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[DataDost] Supabase env vars not configured for feedback');
    return res.status(500).json({ error: 'Feedback service not configured.' });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
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
      console.error('[DataDost] Supabase feedback insert error:', err);
      return res.status(500).json({ error: 'Could not save feedback — please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[DataDost] Feedback error:', err);
    return res.status(500).json({ error: 'Could not save feedback — please try again.' });
  }
}
