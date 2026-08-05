/**
 * cleanup-lore-characters.mjs
 * ---------------------------------------------------------------
 * One-off script to remove rows from lore_characters that were written
 * BEFORE the lore.js fix (episode cross-check + filterOutRealWorldPages).
 * The fix stops NEW pollution on future runs, but it can't retroactively
 * clean rows that were already upserted — this does that, for one wiki at
 * a time.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node cleanup-lore-characters.mjs "Charmed"
 *
 * By default this only PRINTS what it would delete (dry run). Add --confirm
 * to actually delete:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node cleanup-lore-characters.mjs "Charmed" --confirm
 *
 * What it removes, in two passes (same logic as the two backstops added to
 * lore.js's character discovery — see that file's header comment):
 *
 *   1. EPISODE OVERLAP: any lore_characters row whose title also exists as a
 *      lore_episodes row for the same wiki_id. A title can never
 *      legitimately be both, so this is a pure DB join — no network calls,
 *      no judgment calls, 100% mechanical.
 *
 *   2. REAL-WORLD CAST/CREW: any remaining lore_characters row whose Fandom
 *      page is categorized as an actor/actress/crew bio rather than an
 *      in-universe character (see NON_CHARACTER_CATEGORY_PATTERN below —
 *      same pattern list as lore.js's filterOutRealWorldPages). This one
 *      DOES call the Fandom API (batched, 50 titles per request) to read
 *      each remaining title's own categories, so it's the slower pass.
 *
 * Requires: npm install @supabase/supabase-js
 * Requires Node 18+ (for global fetch).
 */
import { createClient } from '@supabase/supabase-js';

const FANDOM_USER_AGENT = 'TypingMind-LoreFetch-Cleanup/1.0 (+https://typingmind-backend.vercel.app)';
const CATEGORY_CHECK_BATCH = 50;

// Kept identical to lore.js's NON_CHARACTER_CATEGORY_PATTERN — if you widen
// or narrow that list there, update it here too so a re-run of this script
// matches whatever the live endpoint would now filter out going forward.
const NON_CHARACTER_CATEGORY_PATTERN = /\b(performers?|actors?|actresses?|real[\s-]?world|crew|cast\s*(?:and|&)?\s*crew|behind[\s-]?the[\s-]?scenes|production\s*(?:staff|team)?|directors?|writers?|producers?|creators?)\b/i;

const fandomArg = process.argv[2];
const confirm = process.argv.includes('--confirm');

if (!fandomArg) {
  console.error('Usage: node cleanup-lore-characters.mjs "<fandom name>" [--confirm]');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function apiRequest(url) {
  const res = await fetch(`${url}&origin=*`, { headers: { 'User-Agent': FANDOM_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error.info || data.error.code || 'API error');
  return data;
}

// Same batching/normalization/redirect-mapping logic as lore.js's
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

async function main() {
  const { data: wikiRow, error: wikiErr } = await supabase.from('lore_wikis').select('*').ilike('fandom', fandomArg).maybeSingle();
  if (wikiErr) throw new Error(`Wiki lookup failed: ${wikiErr.message}`);
  if (!wikiRow) {
    console.error(`No lore_wikis row found for fandom "${fandomArg}". Check the exact fandom string you originally called lore.js with.`);
    process.exit(1);
  }
  console.log(`Wiki: ${wikiRow.fandom} (${wikiRow.subdomain}.fandom.com), wiki_id=${wikiRow.id}`);

  const { data: characterRows, error: charErr } = await supabase.from('lore_characters').select('title').eq('wiki_id', wikiRow.id);
  if (charErr) throw new Error(`lore_characters lookup failed: ${charErr.message}`);
  const { data: episodeRows, error: epErr } = await supabase.from('lore_episodes').select('title').eq('wiki_id', wikiRow.id);
  if (epErr) throw new Error(`lore_episodes lookup failed: ${epErr.message}`);

  const episodeTitleSet = new Set((episodeRows || []).map((r) => r.title));
  const allCharacterTitles = (characterRows || []).map((r) => r.title);
  console.log(`lore_characters currently has ${allCharacterTitles.length} row(s); lore_episodes has ${episodeTitleSet.size}.`);

  // Pass 1: episode overlap — pure DB comparison, no network.
  const episodeOverlap = allCharacterTitles.filter((t) => episodeTitleSet.has(t));
  const remaining = allCharacterTitles.filter((t) => !episodeTitleSet.has(t));

  console.log(`\nPass 1 — rows that are actually episodes (title also in lore_episodes): ${episodeOverlap.length}`);
  for (const t of episodeOverlap) console.log(`  - ${t}`);

  // Pass 2: real-world cast/crew, via each remaining title's own categories.
  console.log(`\nPass 2 — checking ${remaining.length} remaining title(s) against Fandom categories...`);
  let realWorld = [];
  if (remaining.length) {
    const byTitle = await fetchCategoriesForTitles(wikiRow.subdomain, remaining);
    realWorld = remaining.filter((t) => {
      const cats = byTitle[t];
      return !!cats && cats.some((c) => NON_CHARACTER_CATEGORY_PATTERN.test(c));
    });
  }
  console.log(`Pass 2 — rows that are real-world cast/crew pages: ${realWorld.length}`);
  for (const t of realWorld) console.log(`  - ${t}`);

  const toDelete = [...new Set([...episodeOverlap, ...realWorld])];
  console.log(`\nTotal rows to remove from lore_characters: ${toDelete.length} of ${allCharacterTitles.length}`);

  if (!toDelete.length) {
    console.log('Nothing to clean up.');
    return;
  }
  if (!confirm) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete the rows listed above.');
    return;
  }

  // Deleted individually (not one big .in() call) for the same reason
  // lore.js's own cache lookups avoid .in() — titles can contain commas,
  // parens, etc. that PostgREST's in.() filter treats as list syntax, which
  // can mis-parse a legitimate title into the wrong delete target. One
  // .eq('title', ...) call per row sidesteps that entirely.
  let deleted = 0;
  for (const title of toDelete) {
    const { error } = await supabase.from('lore_characters').delete().eq('wiki_id', wikiRow.id).eq('title', title);
    if (error) {
      console.error(`  FAILED to delete "${title}": ${error.message}`);
    } else {
      deleted += 1;
    }
  }
  console.log(`\nDeleted ${deleted}/${toDelete.length} row(s) from lore_characters.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
