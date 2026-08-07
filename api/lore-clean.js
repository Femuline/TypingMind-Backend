/**
 * lore-clean.js
 * ---------------------------------------------------------------
 * PLACE THIS FILE AT: api/lore-clean.js in your project.
 * ALSO ADD: lib/cleanupCharacters.js (a sibling of api/, not inside
 * it) — this file now delegates the actual sweep logic to it, since
 * lore.js needs to run the same logic in-process right after a search
 * finishes, instead of only once a day on cron. See that file's own
 * header for the two-pass logic itself (episode overlap + real-world
 * cast/crew check).
 *
 * This file is now just the CRON/MANUAL entrypoint: it loops over
 * EVERY wiki in lore_wikis and enforces the cross-wiki Fandom-API
 * budget for one invocation (MAX_CATEGORY_CHECKS_PER_RUN, shared
 * across all wikis so one wiki's backlog can't starve the others or
 * blow the function's time budget). This remains useful even now that
 * lore.js also triggers a cleanup after every completed search:
 *   - It catches wikis nobody has searched in a while.
 *   - It's the fallback if a search's own waitUntil-triggered cleanup
 *     never completes (waitUntil doesn't retry on failure — see the
 *     note in lore.js next to where it's called).
 *
 * ── SECURITY ─────────────────────────────────────────────────────────
 * Only Vercel's own Cron scheduler (or someone who has your CRON_SECRET)
 * can trigger this. See lore.js's header for env var setup.
 *
 * ── MANUAL / IMMEDIATE RUN ───────────────────────────────────────────
 *   curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
 *     https://<your-deployment>.vercel.app/api/lore-clean
 * Add ?dryRun=1 to preview without deleting anything.
 *
 * ── vercel.json ──────────────────────────────────────────────────────
 *   {
 *     "crons": [
 *       { "path": "/api/lore-clean", "schedule": "0 4 * * *" }
 *     ]
 *   }
 */
import { createClient } from '@supabase/supabase-js';
import { cleanupWikiCharacters } from '../lib/cleanupCharacters.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAX_CATEGORY_CHECKS_PER_RUN = 300; // ~6 Fandom API calls total, across ALL wikis this run touches

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // fail closed if it's somehow not set
  return (req.headers.authorization || '') === `Bearer ${expected}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized — missing or incorrect CRON_SECRET bearer token.' });
  }

  const dryRun = !!(req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true'));

  try {
    const { data: wikis, error: wikiErr } = await supabase.from('lore_wikis').select('*');
    if (wikiErr) throw new Error(`Wiki lookup failed: ${wikiErr.message}`);

    let categoryChecksUsed = 0;
    const results = [];

    for (const wikiRow of wikis || []) {
      try {
        const result = await cleanupWikiCharacters(supabase, wikiRow, {
          maxCategoryChecks: Math.max(0, MAX_CATEGORY_CHECKS_PER_RUN - categoryChecksUsed),
          dryRun,
        });
        categoryChecksUsed += result.categoryChecksUsed;
        if (result.warning) results.push({ fandom: wikiRow.fandom, warning: result.warning });
        results.push(result);
      } catch (err) {
        results.push({ fandom: wikiRow.fandom, error: err.message });
      }
    }

    console.log('[lore-clean]', JSON.stringify(results));
    return res.status(200).json({ ranAt: new Date().toISOString(), dryRun, results });
  } catch (err) {
    console.error('[lore-clean] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
