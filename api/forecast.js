export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { snapshots } = req.body;

  if (!snapshots || !Array.isArray(snapshots)) {
    return res.status(400).json({ error: 'snapshots array is required' });
  }

  // Best-effort parser for "MMM YYYY" style month labels (e.g. "Jun 2026"), used only
  // for chronological sorting below. Falls back to treating unparseable labels as
  // "oldest" rather than crashing — a sort glitch on one label shouldn't break forecasting.
  function parseMonthLabel(label) {
    const parts = String(label || '').trim().split(' ');
    if (parts.length !== 2) return 0;
    const t = Date.parse(parts[0] + ' 1, ' + parts[1]);
    return isNaN(t) ? 0 : t;
  }

  // A single document can cover several real months (e.g. one statement spanning
  // Apr–Jun) — each recurring candidate already carries its OWN month tag from
  // extraction time, so we count real distinct calendar months here, never the
  // number of documents uploaded. Never trust the frontend's gate alone.
  const monthSet = {};
  snapshots.forEach((s) => {
    (s.months_covered || []).forEach((m) => { if (m) monthSet[m] = true; });
  });
  const distinctMonths = Object.keys(monthSet).sort((a, b) => parseMonthLabel(a) - parseMonthLabel(b));

  if (distinctMonths.length < 3) {
    return res.status(400).json({ error: `At least 3 distinct months are required to compute a forecast — found ${distinctMonths.length}` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  // DataDost never converts between currencies — a user's data is assumed to be in
  // whichever real currency their own statements actually use. The most recent
  // upload is the most reliable signal of "their" currency right now.
  const userCurrency = snapshots[snapshots.length - 1]?.currency || 'INR';

  // Flatten every candidate from every snapshot, then group by its OWN real month tag
  // rather than by which document it came from — this is what makes one 3-month
  // statement behave identically to 3 separate single-month uploads.
  const byMonth = {};
  snapshots.forEach((s) => {
    (s.recurring_candidates || []).forEach((it) => {
      const m = it.month || 'unknown';
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(it);
    });
  });

  const mostRecentMonth = distinctMonths[distinctMonths.length - 1];

  // Same 3-month privacy and structure principle as before — this is structured data
  // already extracted at upload time, never the raw document. Most recent month
  // listed LAST so Claude can clearly see which one represents "this cycle". Amounts
  // are labelled with the user's real currency code, never assumed to be rupees.
  const monthsText = distinctMonths.map((monthLabel) => {
    const items = byMonth[monthLabel] || [];
    const itemsText = items.length > 0
      ? items.map((it) => `${it.name} | ${it.amount} ${userCurrency} | day ~${it.approxDay || '?'} | ${it.type}`).join('\n')
      : '(none detected this month)';
    const tag = monthLabel === mostRecentMonth ? 'MOST RECENT MONTH' : 'earlier month';
    return `--- ${monthLabel} (${tag}) ---\n${itemsText}`;
  }).join('\n\n');

  const prompt = `Here are recurring-transaction candidates extracted independently across ${distinctMonths.length} distinct real calendar months of a single person's financial documents, oldest first:\n\n${monthsText}\n\nYour task: cross-reference these candidates by name and amount (the same obligation may be worded slightly differently each month, e.g. "HDFC Home Loan EMI" vs "Home Loan EMI HDFC0001" — use judgement to match these as the same item) and decide which represent a GENUINE recurring pattern, not coincidence.\n\nRules:\n- An item appearing in 3 or more of the months listed = "high" confidence. Appearing in exactly 2 = "medium" confidence. Appearing in only 1 month = exclude it entirely, do not include it in your output — one occurrence proves nothing.\n- The AMOUNT can vary somewhat between months and still be the same recurring obligation — e.g. school/university fees, or an EMI with a step-up — judge by whether the payee or purpose is clearly the same each time, not by requiring an exact amount match.\n- For each confirmed item, set "status" by checking whether a matching entry (same payee/purpose) appears in the MOST RECENT MONTH's list above: if yes, status is "paid" (for PAYMENT type) or "received" (for RECEIVABLE type). If it does NOT appear in the most recent month, status is "pending" (PAYMENT) or "awaited" (RECEIVABLE) — meaning it's expected this cycle but hasn't shown up yet.\n- Use the most recent month's amount and approxDay for each confirmed item (most representative of the current cycle), or the average if amounts vary slightly.\n- Merge duplicates — never list the same real-world obligation twice under slightly different names, even if it appeared under different wording in different months.\n\nReply with ONLY valid JSON, no markdown code fences, no explanation, in exactly this shape:\n{"items":[{"name":"string","amount":number,"type":"PAYMENT or RECEIVABLE","approxDay":number,"status":"paid or pending or received or awaited","confidence":"high or medium"}]}\n\nIf nothing qualifies, reply with {"items":[]}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        // Sonnet, not Haiku — this is a one-off, infrequent call (cached client-side,
        // only recomputed when a new document is uploaded) doing harder cross-document
        // reasoning than everyday chat, so the small extra cost per call is worth it.
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: 'You are DataDost\'s forecast engine. Reply with ONLY the JSON object requested — no preamble, no markdown formatting, no code fences.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Claude API error',
      });
    }

    const rawText = data.content?.[0]?.text || '{"items":[]}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('DataDost forecast — could not parse model JSON:', cleaned);
      return res.status(502).json({ error: 'Forecast response was not valid JSON' });
    }

    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(502).json({ error: 'Forecast response was missing the items array' });
    }

    return res.status(200).json({ items: parsed.items, currency: userCurrency, computedAt: new Date().toISOString() });

  } catch (err) {
    console.error('DataDost forecast API error:', err);
    return res.status(500).json({ error: 'Server error — please try again' });
  }
}
