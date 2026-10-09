/**
 * DataDost legal pages — the ONE serverless function that serves all five documents.
 * Path: /api/legal.js
 *
 *   /terms           -> /api/legal.js?doc=terms            (rewrite in vercel.json)
 *   /privacy         -> /api/legal.js?doc=privacy
 *   /refund          -> /api/legal.js?doc=refund
 *   /data-retention  -> /api/legal.js?doc=data-retention
 *   /consent         -> /api/legal.js?doc=consent
 *
 * Why one function instead of four: Vercel's free (Hobby) plan allows at most 12
 * serverless functions per deployment. DataDost already has 9, so five more would
 * make 14 and could block deployments. The wording of each document sits in the
 * underscore-prefixed files (_legal-*.js), which Vercel does NOT count as functions.
 */
import { renderLegalPage } from './_legalPage.js';
import terms from './_legal-terms.js';
import privacy from './_legal-privacy.js';
import refund from './_legal-refund.js';
import dataRetention from './_legal-data-retention.js';
import consent from './_legal-consent.js';

const DOCS = {
  terms,
  privacy,
  refund,
  'data-retention': dataRetention,
  consent,
};

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Only the five known keys are accepted; anything else is a 404 (nothing is read from disk by name).
  const key = String((req.query && req.query.doc) || '');
  const doc = Object.prototype.hasOwnProperty.call(DOCS, key) ? DOCS[key] : null;
  if (!doc) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(404).send('Not found');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(renderLegalPage(doc));
}
