/**
 * lore-cleanup-cron.js
 * ---------------------------------------------------------------
 * PLACE THIS FILE AT: api/lore-cleanup-cron.js in your project (same
 * folder as your existing api/lore.js), so Vercel serves it at
 * /api/lore-cleanup-cron.
 *
 * Automated replacement for manually running cleanup-lore-characters.mjs.
 * Runs on a Vercel Cron schedule (see the vercel.json snippet below) and
 * sweeps EVERY wiki in lore_wikis — not just one fandom at a time — using
 * the exact same two-pass logic as the two backstops already built into
 * lore.js's own character discovery:
 *
 *   1. EPISODE OVERLAP: a lore_characters row whose title also exists as a
 *      lore_episodes row for the same wiki_id. Free, in-memory, no network
 *      call.
 *   2. REAL-WORLD CAST/CREW: a remaining row whose Fandom page is itself
 *      categorized as an actor/crew bio (Category:Performers etc. — see
 *      NON_CHARACTER_CATEGORY_PATTERN). Calls the Fandom API in batches of
 *      50 titles per request.
 *
 * This is a SAFETY NET, not a replacement for lore.js's own backstops —
 * those are what stop new pollution at write time. This just automatically
 * sweeps up anything that accumulated before they existed, or that slips
 * through some future edge case, so nobody has to remember to run a script
 * or click delete in Supabase ever again.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────
 * Only Vercel's own Cron scheduler (or someone who has your CRON_SECRET)
 * can trigger this. Vercel auto-provisions CRON_SECRET as an env var on
 * your project and sends it as `Authorization: Bearer <value>` on every
 * scheduled invocation. Hitting this URL without that header returns 401.
 * You don't need to set CRON_SECRET yourself — Vercel does it the moment
 * you add a `crons` entry to vercel.json and deploy.
 *
 * ── TIME BUDGET ──────────────────────────────────────────────────────
 * Vercel Hobby caps a function at 10 seconds. Pass 1 is free. Pass 2 calls
 * the Fandom API, so MAX_CATEGORY_CHECKS_PER_RUN caps how many titles get
 * checked in ONE invocation across ALL wikis combined (300 titles ≈ 6
 * Fandom API calls — comfortably inside 10s). Anything past that budget is
 * simply left for tomorrow's run rather than risking a timeout — see
 * `deferredForNextRun` in the response. For a normal day-to-day trickle
 * this will never matter; it only kicks in on the very first run if you
 * have a large existing backlog (in which case it'll just take a couple of
 * days to fully clear, cleaning a bit more each night).
 *
 * ── MANUAL / IMMEDIATE RUN ───────────────────────────────────────────
 * Don't want to wait for tonight's scheduled run? Trigger it yourself:
 *
 *   curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
 *     https://<your-deployment>.vercel.app/api/lore-cleanup-cron
 *
 * Get YOUR_CRON_SECRET from Vercel → your project → Settings →
 * Environment Variables (it appears there automatically once a crons
 * entry exists and you've deployed). Add ?dryRun=1 to the URL to preview
 * without deleting anything.
 *
 * ── vercel.json ──────────────────────────────────────────────────────
 * Merge this into your EXISTING vercel.json (don't overwrite the whole
 * file if you already have one — just add/merge the "crons" array):
 *
 *   {
 *     "crons": [
 *       { "path": "/api/lore-cleanup-cron", "schedule": "0 4 * * *" }
 *     ]
 *   }
 *
 * That runs once a day, sometime in the 4am UTC hour (Hobby plan only
 * guarantees "within the hour," not to the minute).
 *
 * NON_CHARACTER_CATEGORY_PATTERN below MUST stay identical to the copy in
 * lore.js and in cleanup-lore-characters.mjs — if you ever widen or narrow
 * it in one place, update it in all three.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FANDOM_USER_AGENT = 'TypingMind-LoreFetch-Cleanup/1.0 (+https://typingmind-backend.vercel.app)';
const CATEGORY_CHECK_BATCH = 50;
const MAX_CATEGORY_CHECKS_PER_RUN = 300; // ~6 Fandom API calls — safely inside the 10s Hobby cap

const NON_CHARACTER_CATEGORY_PATTERN = /\b(performers?|actors?|actresses?|real[\s-]?world|crew|cast\s*(?:and|&)?\s*crew|behind[\s-]?the[\s-]?scenes|production\s*(?:staff|team)?|directors?|writers?|producers?|creators?)\b/i;

async function apiRequest(url) {
  const res = await fetch(`${url}&origin=*`, { headers: { 'User-Agent': FANDOM_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error.info || data.error.code || 'API error');
  return data;
}

// Same batching/normalization/redirect-mapping as lore.js's own
// fetchCategoriesForTitles — see that function's comment for why the
// normalized/redirects handling is needed.
async function fetchCategoriesForTitles(subdomain, titles) {
  const byTitle = {};
  for (let i = 0; i < titles.length; i += CATEGORY_CHECK_BATCH) {
    const chunk = titles.slice(i, i + CATEGORY_CHECK_BATCH);
    const url = `https://${subdomain}.fandom.com/api.php?action=query&prop=categories&clshow=!hidden&cllimit=max&redirects=1&titles=${encodeURIComponent(chunk.join('|'))}&format=json`;
    const data = await apiRequest(url);
    const query = (data && data.query) || {};
    const pages = query.pages || {};

    const canonical = {};
    for (const t of chunk) canonical[t] = t;
    for (const n of query.normalized || []) {
      if (canonical[n.from] !== undefined) canonical[n.from] = n.to;
    }
    for (const r of query.redirects || []) {
      for (const t of chunk) {
        if (canonical[t] === r.from) canonical[t] = r.to;
      }
    }

    const categoriesByResolvedTitle = {};
    for (const page of Object.values(pages)) {
      if (!page || !page.title) continue;
      categoriesByResolvedTitle[page.title] = (page.categories || []).map((c) => c.title.replace(/^Category:/, ''));
    }
    for (const t of chunk) {
      const cats = categoriesByResolvedTitle[canonical[t]];
      if (cats) byTitle[t] = cats;
    }
  }
  return byTitle;
}

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
      const { data: characterRows, error: charErr } = await supabase.from('lore_characters').select('title').eq('wiki_id', wikiRow.id);
      const { data: episodeRows, error: epErr } = await supabase.from('lore_episodes').select('title').eq('wiki_id', wikiRow.id);
      if (charErr || epErr) {
        results.push({ fandom: wikiRow.fandom, error: (charErr || epErr).message });
        continue;
      }

      const episodeTitleSet = new Set((episodeRows || []).map((r) => r.title));
      const allCharacterTitles = (characterRows || []).map((r) => r.title);

      // Pass 1: episode overlap.
      const episodeOverlap = allCharacterTitles.filter((t) => episodeTitleSet.has(t));
      let remaining = allCharacterTitles.filter((t) => !episodeTitleSet.has(t));

      // Pass 2: real-world cast/crew, budget-limited across the WHOLE run
      // (all wikis combined), so one huge backlog on one wiki can't starve
      // every other wiki's turn or blow the 10s timeout.
      let realWorld = [];
      let deferredForNextRun = 0;
      if (remaining.length) {
        const budgetLeft = MAX_CATEGORY_CHECKS_PER_RUN - categoryChecksUsed;
        if (budgetLeft <= 0) {
          deferredForNextRun = remaining.length;
          remaining = [];
        } else if (remaining.length > budgetLeft) {
          deferredForNextRun = remaining.length - budgetLeft;
          remaining = remaining.slice(0, budgetLeft);
        }
        if (remaining.length) {
          categoryChecksUsed += remaining.length;
          try {
            const byTitle = await fetchCategoriesForTitles(wikiRow.subdomain, remaining);
            realWorld = remaining.filter((t) => {
              const cats = byTitle[t];
              return !!cats && cats.some((c) => NON_CHARACTER_CATEGORY_PATTERN.test(c));
            });
          } catch (err) {
            results.push({ fandom: wikiRow.fandom, warning: `Category check failed, skipped this run: ${err.message}` });
          }
        }
      }

      const toDelete = [...new Set([...episodeOverlap, ...realWorld])];
      let deleted = 0;
      if (toDelete.length && !dryRun) {
        // One row at a time — same reasoning as cleanup-lore-characters.mjs:
        // titles can contain commas/parens that PostgREST's .in() filter
        // would mis-parse as list syntax.
        for (const title of toDelete) {
          const { error } = await supabase.from('lore_characters').delete().eq('wiki_id', wikiRow.id).eq('title', title);
          if (!error) deleted += 1;
        }
      }

      results.push({
        fandom: wikiRow.fandom,
        totalCharacterRows: allCharacterTitles.length,
        episodeOverlapFound: episodeOverlap.length,
        realWorldFound: realWorld.length,
        removedTitles: toDelete,
        deleted: dryRun ? 0 : deleted,
        dryRun,
        deferredForNextRun,
      });
    }

    console.log('[lore-cleanup-cron]', JSON.stringify(results));
    return res.status(200).json({ ranAt: new Date().toISOString(), dryRun, results });
  } catch (err) {
    console.error('[lore-cleanup-cron] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
