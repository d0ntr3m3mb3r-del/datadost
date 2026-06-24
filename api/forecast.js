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

  if (!snapshots || !Array.isArray(snapshots) || snapshots.length < 3) {
    // Same 3-month rule enforced server-side too — never trust the frontend gate alone.
    return res.status(400).json({ error: 'At least 3 monthly snapshots are required to compute a forecast' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  // Build a compact, plain-text view of each month's recurring candidates — this is
  // structured data already extracted at upload time (Section: RECURRING1-4 lines),
  // never the raw document, consistent with DataDost's "never re-send the original
  // file" privacy principle. Most recent month listed LAST so Claude can clearly see
  // which one represents "this cycle" when deciding paid/pending status.
  const monthsText = snapshots.map((s, idx) => {
    const items = Array.isArray(s.recurring_candidates) ? s.recurring_candidates : [];
    const itemsText = items.length > 0
      ? items.map((it) => `${it.name} | ₹${it.amount} | day ~${it.approxDay || '?'} | ${it.type}`).join('\n')
      : '(none detected this month)';
    const label = idx === snapshots.length - 1 ? 'MOST RECENT MONTH' : `month ${idx + 1} of ${snapshots.length}`;
    return `--- ${label} (${s.doc_name || s.doc_type || 'document'}) ---\n${itemsText}`;
  }).join('\n\n');

  const prompt = `Here are recurring-transaction candidates extracted independently from ${snapshots.length} months of a single person's financial documents, oldest first:\n\n${monthsText}\n\nYour task: cross-reference these candidates by name and amount (the same obligation may be worded slightly differently each month, e.g. "HDFC Home Loan EMI" vs "Home Loan EMI HDFC0001" — use judgement to match these as the same item) and decide which represent a GENUINE recurring pattern, not coincidence.\n\nRules:\n- An item appearing in 3 or more of the months provided = "high" confidence. Appearing in exactly 2 = "medium" confidence. Appearing in only 1 month = exclude it entirely, do not include it in your output — one occurrence proves nothing.\n- For each confirmed item, set "status" by checking whether a matching entry (same name/amount) appears in the MOST RECENT MONTH's list above: if yes, status is "paid" (for PAYMENT type) or "received" (for RECEIVABLE type). If it does NOT appear in the most recent month, status is "pending" (PAYMENT) or "awaited" (RECEIVABLE) — meaning it's expected this cycle but hasn't shown up yet.\n- Use the most recent month's amount and approxDay for each confirmed item (most representative of the current cycle), or the average if amounts vary slightly.\n- Merge duplicates — never list the same real-world obligation twice under slightly different names.\n\nReply with ONLY valid JSON, no markdown code fences, no explanation, in exactly this shape:\n{"items":[{"name":"string","amount":number,"type":"PAYMENT or RECEIVABLE","approxDay":number,"status":"paid or pending or received or awaited","confidence":"high or medium"}]}\n\nIf nothing qualifies, reply with {"items":[]}`;

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

    return res.status(200).json({ items: parsed.items, computedAt: new Date().toISOString() });

  } catch (err) {
    console.error('DataDost forecast API error:', err);
    return res.status(500).json({ error: 'Server error — please try again' });
  }
}
