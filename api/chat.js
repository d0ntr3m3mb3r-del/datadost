import { verifyUser, checkRateLimit, checkPlanLimits } from './_rateLimit.js';

export default async function handler(req, res) {
  // Allow CORS from any origin (our DataDost frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // SECURITY: previously this endpoint had no idea who was calling it at all — anyone
  // who found this URL could call it directly, fully bypassing the app and login, and
  // every call cost real money via the Anthropic API below. This rejects outright,
  // before any further work happens, if the request doesn't carry a real, currently
  // valid DataDost session token.
  const user = await verifyUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please log in to use DataDost chat.' });
  }

  // Generous enough for genuine heavy use (even a power user asking 50+ questions a
  // month doesn't come close), tight enough to stop a runaway loop or basic scripted
  // abuse from running up real API cost unnoticed.
  const rateLimitResult = await checkRateLimit({
    user,
    endpoint: 'chat',
    burstLimit: 10,
    burstWindowSeconds: 60,
    dailyLimit: 200,
  });
  if (!rateLimitResult.allowed) {
    return res.status(rateLimitResult.status).json({ error: rateLimitResult.error });
  }

  // Free-tier plan enforcement — checked AFTER the API-level rate limit so we don't
  // waste a rate-limit slot on a request we're going to reject anyway. Returns a
  // specific error type ('PLAN_LIMIT') so the frontend can distinguish this from a
  // generic error and show the paywall UI rather than a generic error message.
  //
  // IMPORTANT: skip this check for document SCAN calls. Scans are the detection phase
  // in analyseRealDocument() — they extract figures from an uploaded file and are NOT
  // questions asked by the user. The reliable signal is that scan calls never include
  // dynamicContext (regular chat messages always do). Blocking scans with the question
  // limit would prevent free users from uploading documents at all, which is wrong —
  // the upload limit (FREE_UPLOAD_LIMIT = 2) is the correct gate for uploads, and it
  // is enforced client-side before the scan call even fires.
  const { docKey: reqDocKey } = req.body || {};
  const isScanCall = !req.body.dynamicContext;
  if (!isScanCall) {
    const planResult = await checkPlanLimits({ user, docKey: reqDocKey });
    if (!planResult.allowed) {
      return res.status(402).json({
        error: 'PLAN_LIMIT',
        limitType: planResult.limitType,
        questionCount: planResult.questionCount,
        totalAllowed: planResult.totalAllowed,
        remaining: planResult.remaining,
        bonusEarned: planResult.bonusEarned
      });
    }
  }

  const { messages, systemPrompt, dynamicContext, fileData, fileMediaType, fileDataMulti } = req.body;

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
        max_tokens: 2800,
        // Split into two cache breakpoints, not one. systemPrompt is now ONLY the
        // personality, coaching rules, and behaviour instructions — identical for
        // every user, every message, forever. dynamicContext (income type + the
        // current document's extracted content) is specific to one conversation.
        // Splitting them means the large, expensive static block gets cached ONCE
        // and reused by every conversation from every user, instead of being
        // re-written from scratch every time just because it was bundled together
        // with something that actually does change. dynamicContext gets its own
        // cache_control too, so repeat messages within the SAME conversation still
        // benefit exactly as before — this only adds a second, shared win on top,
        // it doesn't remove the per-conversation one that already existed.
        //
        // dynamicContext is absent on the short document-scanner call elsewhere in
        // this same file's caller — that call falls through to the single-block
        // form below, completely unchanged from before this split.
        system: dynamicContext
          ? [
              {
                type: 'text',
                text: systemPrompt || 'You are DataDost, a friendly AI financial companion for Indian families.',
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'text',
                text: dynamicContext,
                cache_control: { type: 'ephemeral' },
              },
            ]
          : [{
              type: 'text',
              text: systemPrompt || 'You are DataDost, a friendly AI financial companion for Indian families.',
              cache_control: { type: 'ephemeral' },
            }],
        messages: apiMessages,
      }),
    });

    const data = await response.json();

    // Visible in Vercel's function logs — the real way to confirm whether caching is
    // actually engaging, rather than guessing. cache_read_input_tokens > 0 means a hit
    // (90% cheaper); cache_creation_input_tokens > 0 on its own (first message of a
    // conversation) just means the cache was written, ready for the NEXT message to hit it.
    if (data.usage) {
      console.log('DataDost cache usage:', {
        cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
        input_tokens: data.usage.input_tokens || 0,
      });
    }

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
