export default async function handler(req, res) {
  // Allow CORS from any origin (our DataDost frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, systemPrompt, fileData, fileMediaType, fileDataMulti } = req.body;

  // Validate input
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request — messages array required' });
  }

  // Get API key from Vercel environment variable (never exposed to browser)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    // Attach file(s) to the LAST (most recent) user message in this request.
    // We send file(s) with every API call (not just the first message of the
    // conversation) so Claude always has the actual document(s) in front of it,
    // never relying on "remembering" them from many turns ago.
    //
    // Two modes:
    //  - fileDataMulti: an array of {fileData, fileMediaType, label} — used for
    //    cross-document comparison, attaches ALL of them to the same message.
    //  - fileData/fileMediaType: a single document — the original, simpler mode.
    const apiMessages = messages.slice(-10).map((m, idx, arr) => {
      const isLastUserMsg = m.role === 'user' && idx === arr.length - 1 && arr[arr.length - 1].role === 'user';

      if (isLastUserMsg && Array.isArray(fileDataMulti) && fileDataMulti.length > 0) {
        const fileBlocks = fileDataMulti.map((f) => {
          const isPdf = f.fileMediaType === 'application/pdf';
          return {
            type: isPdf ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: f.fileMediaType,
              data: f.fileData,
            },
          };
        });
        return {
          role: 'user',
          content: [...fileBlocks, { type: 'text', text: m.content }],
        };
      }

      if (isLastUserMsg && fileData && fileMediaType) {
        // Attach a single document/image alongside the text question
        const isPdf = fileMediaType === 'application/pdf';
        return {
          role: 'user',
          content: [
            {
              type: isPdf ? 'document' : 'image',
              source: {
                type: 'base64',
                media_type: fileMediaType,
                data: fileData,
              },
            },
            { type: 'text', text: m.content },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: systemPrompt || 'You are DataDost, a friendly AI financial companion for Indian families.',
        messages: apiMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Claude API error',
        type: data.error?.type || 'api_error'
      });
    }

    return res.status(200).json({
      reply: data.content?.[0]?.text || '',
      usage: data.usage,
    });

  } catch (err) {
    console.error('DataDost API error:', err);
    return res.status(500).json({ error: 'Server error — please try again' });
  }
}
