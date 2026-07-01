import { verifyUser } from './_rateLimit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require a valid DataDost session — feedback must come from a real logged-in user,
  // not an anonymous scraper or a script hitting the endpoint directly.
  const user = await verifyUser(req);
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

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[DataDost] RESEND_API_KEY not configured');
    return res.status(500).json({ error: 'Email service not configured on server.' });
  }

  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Dubai', dateStyle: 'full', timeStyle: 'short' });

  const emailBody = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <div style="background:#E86832;padding:16px 24px;border-radius:12px 12px 0 0">
    <h2 style="color:#fff;margin:0;font-size:18px">DataDost Beta Feedback</h2>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:24px">
    <p style="font-size:15px;line-height:1.7;margin:0 0 20px;white-space:pre-wrap">${message.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
    <table style="font-size:12px;color:#6b7280;width:100%">
      <tr><td style="padding:3px 0"><b>From:</b></td><td>${user.email}</td></tr>
      <tr><td style="padding:3px 0"><b>Screen:</b></td><td>${screen || 'Not reported'}</td></tr>
      <tr><td style="padding:3px 0"><b>Time:</b></td><td>${timestamp}</td></tr>
      <tr><td style="padding:3px 0"><b>Device:</b></td><td>${(userAgent || 'Unknown').slice(0, 120)}</td></tr>
    </table>
  </div>
</div>
  `.trim();

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'DataDost Feedback <feedback@datadost.in>',
        to: ['support@datadost.in'],
        reply_to: user.email,
        subject: `Beta Feedback from ${user.email}`,
        html: emailBody
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[DataDost] Resend error:', err);
      return res.status(500).json({ error: 'Could not send feedback — please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[DataDost] Feedback send error:', err);
    return res.status(500).json({ error: 'Could not send feedback — please try again.' });
  }
}
