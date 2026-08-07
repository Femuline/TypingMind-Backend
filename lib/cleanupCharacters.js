/**
 * lib/cleanupCharacters.js
 * ---------------------------------------------------------------
 * PLACE THIS FILE AT: lib/cleanupCharacters.js in your project (a
 * sibling of api/, not inside it — files under lib/ don't become
 * routes, only files under api/ do).
 *
 * The two-pass "is this actually a character?" sweep, factored out of
 * lore-clean.js so it has exactly one home instead of three
 * hand-synced copies (lore.js's write-time backstop, lore-clean.js's
 * cron sweep, and cleanup-lore-characters.mjs all used to carry their
 * own copy of NON_CHARACTER_CATEGORY_PATTERN — see lore-clean.js's old
 * header comment). Now:
 *
 *   - lore-clean.js imports this and loops it over every wiki on a
 *     daily cron (unchanged behavior, just no longer inlined).
 *   - lore.js imports this too and calls it for JUST the wiki that was
 *     searched, right when a search finishes (done:true) — see the
 *     waitUntil(...) call added near lore.js's `done: true` return.
 *
 * Same two passes as before:
 *   1. EPISODE OVERLAP — free, in-memory, no network call.
 *   2. REAL-WORLD CAST/CREW — Fandom category check, budget-limited via
 *      `maxCategoryChecks` so one call can't run unbounded.
 */
const FANDOM_USER_AGENT = 'TypingMind-LoreFetch-Cleanup/1.0 (+https://typingmind-backend.vercel.app)';
const CATEGORY_CHECK_BATCH = 50;

export const NON_CHARACTER_CATEGORY_PATTERN = /\b(performers?|actors?|actresses?|real[\s-]?world|crew|cast\s*(?:and|&)?\s*crew|behind[\s-]?the[\s-]?scenes|production\s*(?:staff|team)?|directors?|writers?|producers?|creators?)\b/i;

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

/**
 * Runs the two-pass sweep for ONE wiki and (unless dryRun) deletes
 * whatever it finds from lore_characters.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id: any, fandom?: string, subdomain: string }} wikiRow
 * @param {{ maxCategoryChecks?: number, dryRun?: boolean }} [options]
 *   maxCategoryChecks caps how many titles pass 2 sends to the Fandom
 *   API in THIS call (default 300 — ~6 Fandom API calls, the same
 *   per-run budget lore-clean.js used when it swept every wiki in one
 *   invocation). Anything past that comes back as deferredForNextRun
 *   instead of being checked, so a huge backlog can never blow a
 *   function's time budget in one shot.
 */
export async function cleanupWikiCharacters(supabase, wikiRow, options = {}) {
  const { maxCategoryChecks = 300, dryRun = false } = options;

  const { data: characterRows, error: charErr } = await supabase.from('lore_characters').select('title').eq('wiki_id', wikiRow.id);
  const { data: episodeRows, error: epErr } = await supabase.from('lore_episodes').select('title').eq('wiki_id', wikiRow.id);
  if (charErr || epErr) throw new Error((charErr || epErr).message);

  const episodeTitleSet = new Set((episodeRows || []).map((r) => r.title));
  const allCharacterTitles = (characterRows || []).map((r) => r.title);

  // Pass 1: episode overlap.
  const episodeOverlap = allCharacterTitles.filter((t) => episodeTitleSet.has(t));
  let remaining = allCharacterTitles.filter((t) => !episodeTitleSet.has(t));

  // Pass 2: real-world cast/crew, budget-limited.
  let realWorld = [];
  let deferredForNextRun = 0;
  let categoryChecksUsed = 0;
  let warning;

  if (remaining.length) {
    if (remaining.length > maxCategoryChecks) {
      deferredForNextRun = remaining.length - maxCategoryChecks;
      remaining = remaining.slice(0, maxCategoryChecks);
    }
    if (remaining.length) {
      categoryChecksUsed = remaining.length;
      try {
        const byTitle = await fetchCategoriesForTitles(wikiRow.subdomain, remaining);
        realWorld = remaining.filter((t) => {
          const cats = byTitle[t];
          return !!cats && cats.some((c) => NON_CHARACTER_CATEGORY_PATTERN.test(c));
        });
      } catch (err) {
        warning = `Category check failed, skipped this run: ${err.message}`;
      }
    }
  }

  const toDelete = [...new Set([...episodeOverlap, ...realWorld])];
  let deleted = 0;
  if (toDelete.length && !dryRun) {
    // One row at a time — titles can contain commas/parens that
    // PostgREST's .in() filter would mis-parse as list syntax.
    for (const title of toDelete) {
      const { error } = await supabase.from('lore_characters').delete().eq('wiki_id', wikiRow.id).eq('title', title);
      if (!error) deleted += 1;
    }
  }

  return {
    fandom: wikiRow.fandom,
    totalCharacterRows: allCharacterTitles.length,
    episodeOverlapFound: episodeOverlap.length,
    realWorldFound: realWorld.length,
    removedTitles: toDelete,
    deleted: dryRun ? 0 : deleted,
    dryRun,
    deferredForNextRun,
    categoryChecksUsed,
    warning,
  };
}
