/**
 * lore.js
 * ---------------------------------------------------------------
 * POST { fandom, media?, year?, arc?, forceRefresh?, dryRun?, extraCharacters?, extraEpisodes? }
 *
 * forceRefresh: true bypasses the 14-day category/episode/character cache
 * for this call, forcing every page and category to be re-resolved against
 * Fandom instead of reusing whatever's in Supabase. Use this after a code
 * change to the category-guessing logic (or any time you suspect a wiki's
 * category structure was resolved wrong the first time) — otherwise the
 * old, possibly-wrong result just keeps getting served for up to 14 days.
 *
 * dryRun: true does a READ-ONLY check of Supabase and returns immediately —
 * no Fandom page fetches, no upserts. It still resolves (and may fetch/
 * cache) the episode/character CATEGORY listing, since that's needed to
 * know which titles *should* exist, but it never touches individual episode/
 * character pages. Returns { episodeStatus, missingEpisodes, characterStatus,
 * missingCharacters, ... } where each status is one of:
 *   'ok'           — row exists, has real content, within the freshness window
 *   'stale'        — row exists with real content, but older than 14 days
 *   'cached-empty' — row exists but is the failure placeholder (empty plot /
 *                    no bullets) written when a page fetch failed
 *   'missing'      — no row at all for this title under this wiki_id
 * Use this to answer "does Supabase actually have what the client thinks it
 * has" directly, since it can't be misled by anything upstream of the DB
 * itself (wrong Supabase project in this deployment's env vars, a filter
 * that doesn't match what upsertEpisode actually wrote, etc.) the way a
 * live badge or a manual dashboard query might be.
 *
 * Every response (done:true OR done:false) now also includes
 * episodesRequested/episodeCategory/episodeCategoryArcScoped AND
 * charactersRequested/characterCategory/characterCategoryArcScoped/
 * characterSource — for each: how many titles were actually resolved (0 is
 * a valid but meaningful number: it means no matching source was ever
 * found/matched, NOT that the arc has no episodes/characters), which
 * Fandom category (or, for characters, season page — see characterSource)
 * won, and whether that source was scoped to the requested `arc` or is a
 * wiki-wide fallback covering every season. done:true no longer means
 * "found everything" by itself — it only means "nothing is left in
 * `missing`," which is trivially true if episodesRequested/
 * charactersRequested came back 0. Check the *Requested fields to tell
 * those apart.
 *
 * ARC SCOPING — EPISODES: when `arc` is passed, episode category guessing
 * tries arc-scoped category names first (e.g. "Charmed Season 1 Episodes",
 * "Season 1 Episodes") before ever falling back to a wiki-wide "Episodes"
 * catch-all — see buildEpisodeCategoryGuesses. If an arc-scoped category is
 * found, its members are used as-is: that's a real, exact scope to the
 * requested season/arc, not a heuristic. If NO arc-scoped category exists,
 * episodes fall back to a best-effort NUMBER filter on the wiki-wide list
 * (see filterTitlesUpToArc).
 *
 * ARC SCOPING — CHARACTERS: characters are scoped differently, in two
 * stages (see findSeasonPageCharacters / buildCharacterCategoryGuesses,
 * called in that order from the handler):
 *   1. SEASON PAGE (primary): fetch the season's own Fandom page (e.g.
 *      "Season 6" — see buildSeasonPageGuesses) and read the character
 *      links out of its Cast/Characters section. This is tried first
 *      because real single-show wikis commonly give a season a proper cast
 *      listing on its own page without ALSO filing those same characters
 *      under a matching per-season CATEGORY — which is exactly what made
 *      stage 2 below so often land on the wiki's entire cast instead of
 *      just this arc's.
 *   2. CATEGORY guessing (fallback, only if stage 1 found nothing): tries
 *      arc-scoped category names first (e.g. "Charmed Season 1 Characters",
 *      "Season 1 Characters") before ever falling back to a wiki-wide
 *      "Characters" catch-all. Characters do NOT get a NUMBER-filter
 *      fallback the way episodes do (see filterTitlesUpToArc), because
 *      character-page titles essentially never encode a season number the
 *      way some episode titles do — a title-based filter there would almost
 *      always be a silent no-op masquerading as scoping.
 * If NEITHER stage finds an arc-scoped source, the response's
 * characterCategoryArcScoped is false and a warning explicitly says the
 * character list is the whole-series cast, not scoped to `arc` — check
 * warnings/characterCategoryArcScoped rather than assuming a returned
 * character list is automatically limited to the arc you asked for.
 * characterSource ('season-page' | 'category' | 'none') says which stage
 * actually produced the list, for debugging.
 *
 * Resolves the Fandom wiki for `fandom`, figures out which episode/character
 * pages belong to `arc` (e.g. "Season 6"), and makes sure each one is cached
 * in Supabase (lore_wikis / lore_characters / lore_episodes / lore_categories).
 *
 * extraCharacters / extraEpisodes: optional arrays of exact Fandom page
 * titles to fetch and cache NO MATTER what the automatic category discovery
 * above finds (or fails to find). Even with arc-aware character discovery
 * (above), category discovery only ever looks at whichever category name it
 * guessed and got right — a character filed under something the guess list
 * doesn't try at all (e.g. "Villains", "Demons", with no "Characters"-style
 * category tagging her at all) can still be silently missed, with nothing
 * to do with `arc`. These two arrays sidestep discovery entirely for the
 * titles listed: each one is merged into episodeTitles/characterTitles
 * right after discovery runs (see `normalizeExtraTitles` below) and then
 * goes through the exact same cache-check → fetch → upsert path as every
 * automatically-discovered title — same lore_episodes/lore_characters
 * tables, same 14-day freshness, same forceRefresh behavior — it's just
 * never at risk of being left out by category-matching. Titles must be the
 * EXACT Fandom page title (what's after /wiki/ in the page's own URL,
 * spaces instead of underscores); a near-miss doesn't match an existing
 * row, it just looks like a brand-new page that then fails to fetch.
 * extraEpisodes entries get tagged with whichever `arc` was passed on that
 * same call (or null), same as a normally-discovered episode would be.
 *
 * IMPORTANT — this only ever does a small BATCH_SIZE of page fetches per
 * call, then returns { done: false, fetched, remaining, total } so the
 * client can call again for the next batch. A full season (20+ episodes,
 * dozens of characters, several Fandom API calls per page) does NOT fit in
 * one invocation on Vercel's Hobby plan (10s hard cap) and may not even fit
 * in Pro's default 60s — batching sidesteps that entirely instead of
 * depending on a generous timeout. Once nothing is missing, it returns
 * { done: true, wiki, arc, episodes, characters, warnings }.
 *
 * PLOT vs SUMMARY — some wikis (Charmed, Buffy, Angel, ...) don't put the
 * full plot in a section on the episode page at all; they put a one-
 * paragraph teaser there and link out to a separate subpage, e.g.
 * "Episode Name/Plot". fetchEpisodePlot() below tries that subpage FIRST,
 * then a same-page Plot/Synopsis/Summary section, and only falls back to
 * the page's short intro extract (genuinely a summary) as a last resort —
 * flagged in warnings when that happens, since it's not what was asked for.
 *
 * DISAMBIGUATING SHOW VERSIONS — `media` and `year` are used for more than
 * picking the wiki subdomain now. A lot of Fandom wikis cover a whole
 * franchise (original + reboots + spinoffs) under ONE subdomain with a
 * generic "Characters"/"Episodes" category that mixes every version
 * together, alongside separately-named categories for each specific show
 * (e.g. "Saved by the Bell Characters" for the 1989 original vs.
 * "Saved by the Bell (2020) Characters" for the reboot, both siblings under
 * one wiki). buildEpisodeCategoryGuesses/buildCharacterCategoryGuesses try
 * those fandom-name-qualified (and year-qualified) category names FIRST,
 * before ever falling back to a generic catch-all — that's what keeps a
 * request for the 1989 show from pulling in reboot episodes/characters that
 * happen to live in the same "Episodes"/"Characters" category on the same
 * wiki. `media` also picks the right synonym set for what "episodes" are
 * called for that kind of thing (Issues for a comic, Chapters for a
 * webtoon, etc).
 *
 * Requires a `lore_categories` table in addition to
 * lore_wikis/lore_characters/lore_episodes (see supabase-schema.sql) —
 * caches which pages belong to a resolved
 * Fandom category (e.g. "Season 6 Episodes") so that lookup isn't repeated
 * on every batch call. Columns: wiki_id (fk -> lore_wikis.id), category_name
 * (text), members (jsonb), fetched_at (timestamptz); unique on
 * (wiki_id, category_name).
 *
 * Env vars required (Vercel project settings → Environment Variables):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role, NOT the anon key — this
 *                                 function writes to the DB and must run
 *                                 server-side only, which it does here)
 *
 * npm install @supabase/supabase-js
 *
 * Works as-is under /api (plain Vercel Functions or Next.js Pages Router).
 * On the Next.js App Router, this needs the route-handler export shape
 * instead (`export async function POST(request) {...}` returning a
 * Response) — say the word if that's your setup and I'll adapt it.
 *
 * CORS — this endpoint is called directly from the browser (the TypingMind
 * extension runs as page JS on typingmind.com, not from a server), so it
 * must send Access-Control-Allow-Origin itself or every request gets
 * blocked client-side before this code's response is ever read. Only the
 * origins in ALLOWED_ORIGINS below are allowed to call this function.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = 6; // pages fetched from Fandom per invocation
const REQUEST_DELAY_MS = 200; // be polite to Fandom's servers between page fetches
const REQUEST_TIMEOUT_MS = 8000;
const FRESHNESS_MS = 14 * 24 * 60 * 60 * 1000; // re-fetch a page from Fandom at most every 14 days

const MEDIA_TYPES = ['show', 'movie', 'game', 'comic', 'webtoon'];
// What the "episode" equivalent is called for each media type, used to build
// category-name guesses (see buildEpisodeCategoryGuesses). First entry in
// each list is also what gets suffixed with "Episodes"-style qualifiers
// (e.g. "<fandom> Issues"), so put the most likely one first.
const MEDIA_EPISODE_SYNONYMS = {
  show: ['Episodes', 'Episode Guide'],
  movie: ['Movies', 'Films'],
  game: ['Missions', 'Levels', 'Chapters'],
  comic: ['Issues', 'Chapters'],
  webtoon: ['Chapters', 'Episodes'],
};
// Fandom/Fastly has been known to quietly block requests with a generic or
// missing User-Agent (returning a 403 or an HTML challenge page instead of
// JSON) as basic bot protection. Sending a descriptive one avoids that.
const FANDOM_USER_AGENT = 'TypingMind-LoreFetch/1.0 (+https://typingmind-backend.vercel.app)';
const PLOT_SECTION_NAMES = ['Plot', 'Synopsis', 'Summary'];
const PLOT_SUBPAGE_SUFFIXES = ['Plot', 'Synopsis'];
const CHARACTER_SECTION_GROUPS = {
  history: ['History', 'Biography', 'Background'],
  powers: ['Powers and Abilities', 'Powers', 'Abilities'],
  relationships: ['Relationships'],
  trivia: ['Trivia', 'Notes and Trivia', 'Notes'],
};
// Section names tried (in order — see findSectionIndex) on a SEASON page
// itself (not a character page) to find its cast listing. "Cast and
// Characters" is first because it's the actual heading Fandom's own TV-show
// wikis commonly use (confirmed on Charmed's "Season 6" page); the rest are
// looser fallbacks for wikis that phrase it differently. findSectionIndex's
// startsWith pass means a bare "Cast" or "Characters" candidate will also
// match a longer heading like "Cast and Characters" or "Characters and Cast"
// on its own, so this list doesn't need to be exhaustive.
const SEASON_CHARACTER_SECTION_NAMES = ['Cast and Characters', 'Characters', 'Cast', 'Main Cast', 'Starring Cast', 'Series Regulars'];

const ALLOWED_ORIGINS = ['https://www.typingmind.com'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Trims, drops empties, and dedupes a client-supplied list of exact page
// titles (extraCharacters/extraEpisodes). Anything that isn't a string is
// silently dropped rather than thrown on, since this only ever adds titles
// to a list — a malformed entry should just be a no-op, not a 500.
function normalizeExtraTitles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const title = typeof raw === 'string' ? raw.trim() : '';
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ================= Fandom wiki fetching =================
const MAX_429_RETRIES = 3;

async function apiRequest(url, retriesLeft = MAX_429_RETRIES) {
  const separator = url.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${url}${separator}origin=*`, {
      signal: controller.signal,
      headers: { 'User-Agent': FANDOM_USER_AGENT, Accept: 'application/json' },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('request timed out');
    throw new Error(`network error (${err.message})`);
  } finally {
    clearTimeout(timeoutId);
  }
  if (res.status === 429 && retriesLeft > 0) {
    const retryAfterHeader = res.headers.get('retry-after');
    const parsedRetryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : NaN;
    const waitMs = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : 800 * (MAX_429_RETRIES - retriesLeft + 1);
    await delay(waitMs);
    return apiRequest(url, retriesLeft - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error.info || data.error.code || 'API error');
  return data;
}

function slugCandidates(term, year) {
  const cleaned = term.trim().toLowerCase();
  const noArticle = cleaned.replace(/^(the|a|an)\s+/, '');
  const toSlug = (s) => s.replace(/[^a-z0-9]/g, '');
  const bare = toSlug(noArticle);
  const withArticle = toSlug(cleaned);
  const candidates = [];
  if (year) candidates.push(`${bare}${String(year).trim()}`);
  candidates.push(bare);
  if (withArticle !== bare) candidates.push(withArticle);
  return [...new Set(candidates.filter(Boolean))];
}

async function wikiExists(subdomain) {
  const data = await apiRequest(`https://${subdomain}.fandom.com/api.php?action=query&meta=siteinfo&siprop=general&format=json`);
  const general = data && data.query && data.query.general;
  if (!general || !general.sitename) throw new Error('no sitename in response');
  return { sitename: general.sitename, url: general.base || `https://${subdomain}.fandom.com/`, subdomain };
}

async function resolveWiki(fandom, year) {
  const attempts = [];
  for (const subdomain of slugCandidates(fandom, year)) {
    try {
      return { wiki: await wikiExists(subdomain), attempts };
    } catch (err) {
      attempts.push(`${subdomain}.fandom.com: ${err.message}`);
    }
  }
  return { wiki: null, attempts };
}

async function getCachedCategoryMembers(wikiId, categoryName, freshnessMs = FRESHNESS_MS) {
  const { data, error } = await supabase
    .from('lore_categories')
    .select('*')
    .eq('wiki_id', wikiId)
    .eq('category_name', categoryName)
    .maybeSingle();
  if (error) throw new Error(`Supabase category cache lookup failed: ${error.message}`);
  if (!data) return null;
  if (Date.now() - new Date(data.fetched_at).getTime() >= freshnessMs) return null;
  return Array.isArray(data.members) ? data.members : [];
}

async function cacheCategoryMembers(wikiId, categoryName, members) {
  const { error } = await supabase
    .from('lore_categories')
    .upsert(
      { wiki_id: wikiId, category_name: categoryName, members, fetched_at: new Date().toISOString() },
      { onConflict: 'wiki_id,category_name' }
    );
  if (error) throw new Error(`Supabase category cache write failed: ${error.message}`);
}

async function fetchCategoryMembers(subdomain, wikiId, categoryName, limit, freshnessMs = FRESHNESS_MS) {
  const cached = await getCachedCategoryMembers(wikiId, categoryName, freshnessMs);
  if (cached !== null) return cached;
  const url = `https://${subdomain}.fandom.com/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent('Category:' + categoryName)}&cmlimit=${limit}&format=json`;
  const data = await apiRequest(url);
  const members = (data && data.query && data.query.categorymembers) || [];
  const titles = members.filter((m) => m.ns === 0).map((m) => m.title);
  await cacheCategoryMembers(wikiId, categoryName, titles);
  return titles;
}

async function findFirstNonEmptyCategory(subdomain, wikiId, candidates, limit, freshnessMs = FRESHNESS_MS) {
  const attempts = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const name = typeof candidate === 'string' ? candidate : candidate.name;
    const arcScoped = typeof candidate === 'string' ? false : !!candidate.arcScoped;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      const members = await fetchCategoryMembers(subdomain, wikiId, name, limit, freshnessMs);
      if (members.length > 0) return { found: { name, arcScoped, members }, attempts };
    } catch (err) {
      attempts.push(`"${name}": ${err.message}`);
    }
  }
  return { found: null, attempts };
}

function withCasings(word) {
  return [...new Set([word, word.charAt(0).toLowerCase() + word.slice(1)])];
}

// FIX (2026-08): previously this interleaved generic, non-arc-scoped guesses
// ("<fandom> (<year>) Episodes", "<fandom> Episodes") ahead of the bare arc
// name ("Season 5"). findFirstNonEmptyCategory() below stops at the FIRST
// candidate with any members at all, regardless of whether it's arc-scoped —
// so on any wiki where the generic category happens to resolve (even if it's
// the wrong, wiki-wide one) before the plain "Season 5"-style category is
// ever tried, the arc-specific category never gets a chance, even though
// it's later in a "more specific first" ordering conceptually. Concretely:
// on wikis whose category names don't repeat the fandom's own name (single-
// show wikis rarely call their episodes category "<Show> Episodes" — it's
// usually just "Episodes", with per-season episodes filed under a bare
// "Season N"), the old order let a wiki-wide, all-seasons category outrank
// the correct per-season one.
// Fix: collect every arc-scoped guess FIRST (regardless of fandom/year
// qualification), exhaust all of those, and only fall back to non-arc-scoped
// guesses if none of them hit. An arc-scoped match — even a "worse" naming
// guess — is always more correct than a non-arc-scoped one when an arc was
// actually requested.
function buildEpisodeCategoryGuesses(fandom, media, year, arc) {
  const synonyms = MEDIA_EPISODE_SYNONYMS[media] || MEDIA_EPISODE_SYNONYMS.show;
  const primary = synonyms[0];
  const arcScopedGuesses = [];
  const genericGuesses = [];
  const addQualified = (list, prefix, arcScoped) => {
    for (const word of withCasings(primary)) list.push({ name: `${prefix} ${word}`, arcScoped });
  };
  if (arc && year) addQualified(arcScopedGuesses, `${fandom} (${year}) ${arc}`, true);
  if (arc) addQualified(arcScopedGuesses, `${fandom} ${arc}`, true);
  if (arc) {
    arcScopedGuesses.push({ name: `${arc} ${primary}`, arcScoped: true });
    arcScopedGuesses.push({ name: arc, arcScoped: true });
  }
  if (year) addQualified(genericGuesses, `${fandom} (${year})`, false);
  addQualified(genericGuesses, fandom, false);
  for (const s of synonyms) genericGuesses.push({ name: s, arcScoped: false });
  return [...arcScopedGuesses, ...genericGuesses];
}

// Character-category counterpart to buildEpisodeCategoryGuesses above — same
// "collect every arc-scoped guess first, exhaust those, THEN fall back to
// generic" ordering, for the same reason: a wiki-wide "Characters" category
// resolving before a real "Season 1 Characters" one would otherwise win by
// accident and silently hand back the whole-series cast for an arc-specific
// request.
// NOTE: this is now the FALLBACK for character discovery, used only when
// findSeasonPageCharacters (which reads the season's own page instead of
// guessing at a category) finds nothing — see the handler and the ARC
// SCOPING — CHARACTERS note in the file header.
// One-way difference from episodes: there's no equivalent of
// filterTitlesUpToArc as a fallback here. Episode titles occasionally encode
// a season/part number ("Season 5, Episode 3"); character-page titles
// essentially never do (a character's title is just their name) — inventing
// a number-based filter for characters would almost always be a no-op that
// silently claims to have scoped something it didn't. So: if no arc-scoped
// character category exists on this wiki, the caller gets the wiki-wide cast
// back, WITH a warning that it's unscoped, rather than a fake-precise filter.
function buildCharacterCategoryGuesses(fandom, year, arc) {
  const arcScopedGuesses = [];
  const genericGuesses = [];
  const addQualified = (list, prefix, arcScoped) => {
    for (const word of withCasings('Characters')) list.push({ name: `${prefix} ${word}`, arcScoped });
  };
  if (arc && year) addQualified(arcScopedGuesses, `${fandom} (${year}) ${arc}`, true);
  if (arc) addQualified(arcScopedGuesses, `${fandom} ${arc}`, true);
  if (arc) addQualified(arcScopedGuesses, arc, true);
  if (year) addQualified(genericGuesses, `${fandom} (${year})`, false);
  addQualified(genericGuesses, fandom, false);
  genericGuesses.push({ name: 'Main Characters', arcScoped: false }, { name: 'Characters', arcScoped: false }, { name: 'Character', arcScoped: false });
  return [...arcScopedGuesses, ...genericGuesses];
}

// Candidate Fandom PAGE titles (not category names) for the season/arc
// itself, tried in order by findSeasonPageCharacters. On a real single-show
// wiki the season page is usually just the bare arc name — e.g. Charmed's
// wiki titles it plain "Season 6" (https://charmed.fandom.com/wiki/Season_6),
// NOT "Charmed (season 6)" (that's Wikipedia's convention, not Fandom's) and
// NOT "Charmed Season 6" either. The fandom/year-qualified guesses exist for
// multi-show wikis where a bare "Season 1" could belong to more than one
// series hosted on the same wiki (see the DISAMBIGUATING SHOW VERSIONS note
// in the file header) — those are tried first so a qualified page wins over
// an ambiguous bare one when both exist.
function buildSeasonPageGuesses(fandom, year, arc) {
  if (!arc) return [];
  const guesses = [];
  if (year) guesses.push(`${fandom} (${year}) ${arc}`);
  guesses.push(`${fandom} ${arc}`);
  guesses.push(arc);
  return [...new Set(guesses.filter(Boolean))];
}

function extractArcNumber(arc) {
  if (!arc) return null;
  const m = String(arc).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function filterTitlesUpToArc(titles, arc) {
  const num = extractArcNumber(arc);
  if (num == null) return titles;
  return titles.filter((title) => {
    const m = title.match(/(?:season|s|arc|part|book)\s*0*(\d+)/i);
    if (!m) return true;
    return parseInt(m[1], 10) <= num;
  });
}

function cleanExtract(text) {
  return text
    .replace(/\[\d+\]/g, '')
    .replace(/Community content is available under[^\n]*\n?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanWikitext(wikitext) {
  let text = wikitext;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<ref[^/]*\/>/gi, '');
  let prevLength;
  do {
    prevLength = text.length;
    text = text.replace(/\{\{[^{}]*\}\}/g, '');
  } while (text.length !== prevLength);
  text = text.replace(/\{\|[\s\S]*?\|\}/g, '');
  text = text.replace(/\[\[(File|Image):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[Category:[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]*)\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\s\]]+\]/g, '');
  text = text.replace(/'''''(.*?)'''''/g, '$1');
  text = text.replace(/'''(.*?)'''/g, '$1');
  text = text.replace(/''(.*?)''/g, '$1');
  text = text.replace(/^={2,6}\s*(.*?)\s*={2,6}$/gm, '$1');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

async function fetchPageSections(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=sections&redirects=1&format=json`;
  const data = await apiRequest(url);
  const sections = (data && data.parse && data.parse.sections) || [];
  return sections.map((s) => ({ index: s.index, line: s.line }));
}

function findSectionIndex(sections, candidateNames) {
  const normalized = candidateNames.map((n) => n.toLowerCase());
  for (const name of normalized) {
    const hit = sections.find((s) => s.line && s.line.toLowerCase() === name);
    if (hit) return hit.index;
  }
  for (const name of normalized) {
    const hit = sections.find((s) => s.line && s.line.toLowerCase().startsWith(name));
    if (hit) return hit.index;
  }
  return null;
}

async function fetchSectionWikitext(subdomain, title, sectionIndex) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=${sectionIndex}&redirects=1&format=json`;
  const data = await apiRequest(url);
  const field = data && data.parse && data.parse.wikitext;
  const wikitext = typeof field === 'string' ? field : field && field['*'];
  return wikitext ? cleanWikitext(wikitext) : '';
}

// Like fetchSectionWikitext, but returns the internal (same-wiki) page links
// found within one section instead of that section's raw text. Used to read
// a season page's Cast/Characters section as a list of character-page
// titles, without us having to hand-roll a [[...]] regex over wikitext
// (which would also have to duplicate cleanWikitext's template/ref
// stripping to avoid false hits inside {{...}} navboxes).
async function fetchSectionLinks(subdomain, title, sectionIndex) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=links&section=${sectionIndex}&redirects=1&format=json`;
  const data = await apiRequest(url);
  const links = (data && data.parse && data.parse.links) || [];
  return links
    .filter((l) => l.ns === 0) // main namespace only — drops Category:/File:/Template:/User: links etc.
    .map((l) => (typeof l['*'] === 'string' ? l['*'] : l.title)) // handles both formatversion=1 ('*') and =2 (title) shapes, same pattern as fetchSectionWikitext/fetchFullPageWikitext above
    .filter(Boolean);
}

// A season page's Cast/Characters section can carry a small number of
// wikilinks that aren't character pages even though they sit right next to
// ones that are — most commonly a self-link back to the season page itself
// (from a "see also"-style note) or a "List of ..." index page. Filtered out
// up front so they're never even attempted as character-page fetches, rather
// than relying solely on fetchCharacterBullets's after-the-fact "found
// nothing" warning (see the emptyBulletTitles filtering in the handler,
// which is the backstop for anything that slips past this — e.g. an actor's
// own bio page linked from the same section, which this name-shape check
// can't catch).
function looksLikeNonCharacterTitle(title, seasonPageTitle) {
  if (title === seasonPageTitle) return true;
  return /^(list of|category:|season\s*\d|episode\s*\d)/i.test(title);
}

// PRIMARY character-discovery strategy when an arc/season is requested: go
// straight to the season's own Fandom page (see buildSeasonPageGuesses) and
// read the character links out of its Cast/Characters section, instead of
// guessing at a separate "<arc> Characters" CATEGORY page the way
// buildCharacterCategoryGuesses does. Real single-show wikis commonly give a
// season its own page with a proper cast listing but do NOT also file
// characters under a matching per-season CATEGORY — that gap is exactly why
// the category approach so often falls through to a wiki-wide, unscoped
// "Characters" category (see buildCharacterCategoryGuesses's own comment).
// Reading the season page's own cast listing sidesteps that gap: it's
// exactly the character list a human reading that page would see, scoped to
// that season by construction rather than by a category-name guess.
// Category-based discovery (buildCharacterCategoryGuesses) is the FALLBACK
// for this now, used only when every page guess here comes back empty — see
// the handler.
async function findSeasonPageCharacters(subdomain, pageGuesses, warnings) {
  for (const pageTitle of pageGuesses) {
    let sections;
    try {
      sections = await fetchPageSections(subdomain, pageTitle);
    } catch (err) {
      continue; // no page by this exact title on the wiki — try the next guess
    }
    if (!sections.length) continue;
    const idx = findSectionIndex(sections, SEASON_CHARACTER_SECTION_NAMES);
    if (idx == null) continue; // page exists but has nothing Cast/Characters-shaped — try the next guess
    let links;
    try {
      links = await fetchSectionLinks(subdomain, pageTitle, idx);
    } catch (err) {
      warnings.push(`Found season page "${pageTitle}" with a Cast/Characters section, but couldn't read its links: ${err.message}`);
      continue;
    }
    const titles = [...new Set(links)].filter((t) => !looksLikeNonCharacterTitle(t, pageTitle));
    if (titles.length) return { pageTitle, titles };
  }
  return { pageTitle: null, titles: [] };
}

async function fetchIntroExtract(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const data = await apiRequest(url);
  const pages = data && data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  return page && page.extract ? cleanExtract(page.extract) : '';
}

async function fetchFullPageWikitext(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&redirects=1&format=json`;
  const data = await apiRequest(url);
  const field = data && data.parse && data.parse.wikitext;
  const wikitext = typeof field === 'string' ? field : field && field['*'];
  return wikitext ? cleanWikitext(wikitext) : '';
}

async function fetchEpisodePlot(subdomain, title, warnings) {
  for (const suffix of PLOT_SUBPAGE_SUFFIXES) {
    try {
      const text = await fetchFullPageWikitext(subdomain, `${title}/${suffix}`);
      if (text) return text;
    } catch (err) {
      // No "<title>/<suffix>" page on this wiki — try the next suffix, then
      // fall through to the same-page-section approach below.
    }
  }

  const sections = await fetchPageSections(subdomain, title);
  const idx = findSectionIndex(sections, PLOT_SECTION_NAMES);
  if (idx != null) {
    const text = await fetchSectionWikitext(subdomain, title, idx);
    if (text) return text;
  }

  warnings.push(`"${title}": no Plot/Synopsis subpage or same-page section found — used the page intro instead (this is a short summary, not the full plot).`);
  return fetchIntroExtract(subdomain, title);
}

function paragraphsToBullets(text) {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function linesToBullets(text) {
  const lines = text.split('\n').map((l) => l.replace(/^\*+\s*/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : paragraphsToBullets(text);
}

async function fetchCharacterBullets(subdomain, title, warnings) {
  const sections = await fetchPageSections(subdomain, title);
  const result = {};
  for (const [key, candidates] of Object.entries(CHARACTER_SECTION_GROUPS)) {
    const idx = findSectionIndex(sections, candidates);
    if (idx == null) continue;
    const text = await fetchSectionWikitext(subdomain, title, idx);
    if (!text) continue;
    result[key] = key === 'trivia' ? linesToBullets(text) : paragraphsToBullets(text);
  }
  if (!result.history && !result.powers && !result.relationships && !result.trivia) {
    warnings.push(`"${title}": none of History/Powers/Relationships/Trivia were found on this page.`);
  }
  return result;
}

// ================= Supabase cache =================
async function getOrCreateWiki(fandom, year) {
  const { data: cachedByFandom, error: cacheLookupError } = await supabase
    .from('lore_wikis')
    .select('*')
    .ilike('fandom', fandom)
    .maybeSingle();
  if (cacheLookupError) {
    throw new Error(`Supabase cache lookup failed: ${cacheLookupError.message}`);
  }
  if (cachedByFandom) return { wikiRow: cachedByFandom, attempts: [] };

  const { wiki, attempts } = await resolveWiki(fandom, year);
  if (!wiki) return { wikiRow: null, attempts };
  const { data: existing, error: existingErr } = await supabase.from('lore_wikis').select('*').eq('subdomain', wiki.subdomain).maybeSingle();
  if (existingErr) throw new Error(`Supabase wiki lookup failed: ${existingErr.message}`);
  if (existing) return { wikiRow: existing, attempts };
  const { data: inserted, error } = await supabase
    .from('lore_wikis')
    .insert({ fandom, subdomain: wiki.subdomain, sitename: wiki.sitename, base_url: wiki.url })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { wikiRow: inserted, attempts };
}

async function getCachedEpisodes(wikiId, titles, freshnessMs = FRESHNESS_MS) {
  if (!titles.length) return {};
  // Deliberately NOT using .in('title', titles) here. PostgREST's `in.()`
  // filter is a comma-delimited list, and treats comma/period/colon/parens
  // as reserved syntax within it — a title containing any of those (e.g.
  // the Charmed wiki's actual page titles "A Witch's Tail, Part 1" / "...
  // Part 2") can get mis-parsed as multiple/garbled list entries instead of
  // one value, so it silently never matches the row. The upsert that WRITES
  // the row is unaffected (a single scalar value, not a list), so the page
  // gets "successfully" fetched and cached every round with no error and no
  // warning, yet never registers as cached on the next round's read — a
  // silent, permanent stall for any title with a reserved character in it.
  // Fetching this wiki's rows and matching titles in JS sidesteps the whole
  // class of reserved-character bugs instead of trying to escape every one.
  const { data, error } = await supabase.from('lore_episodes').select('*').eq('wiki_id', wikiId);
  if (error) throw new Error(`Supabase episode cache lookup failed: ${error.message}`);
  const wanted = new Set(titles);
  const byTitle = {};
  const now = Date.now();
  for (const row of data || []) {
    if (!wanted.has(row.title)) continue;
    if (now - new Date(row.fetched_at).getTime() < freshnessMs) byTitle[row.title] = row;
  }
  return byTitle;
}

async function getCachedCharacters(wikiId, titles, freshnessMs = FRESHNESS_MS) {
  if (!titles.length) return {};
  // See the matching comment in getCachedEpisodes above — same reserved-
  // character .in() pitfall applies here (character titles/redirects can
  // contain commas, parens, etc. too), so this avoids it the same way.
  const { data, error } = await supabase.from('lore_characters').select('*').eq('wiki_id', wikiId);
  if (error) throw new Error(`Supabase character cache lookup failed: ${error.message}`);
  const wanted = new Set(titles);
  const byTitle = {};
  const now = Date.now();
  for (const row of data || []) {
    if (!wanted.has(row.title)) continue;
    if (now - new Date(row.fetched_at).getTime() < freshnessMs) byTitle[row.title] = row;
  }
  return byTitle;
}

async function upsertEpisode(wikiId, title, arc, plot) {
  const { error } = await supabase
    .from('lore_episodes')
    .upsert({ wiki_id: wikiId, title, arc, plot, fetched_at: new Date().toISOString() }, { onConflict: 'wiki_id,title' });
  if (error) throw new Error(`Supabase episode upsert failed: ${error.message}`);
}

async function upsertCharacter(wikiId, title, bullets) {
  const { error } = await supabase.from('lore_characters').upsert(
    {
      wiki_id: wikiId,
      title,
      history: bullets.history || [],
      powers: bullets.powers || [],
      relationships: bullets.relationships || [],
      trivia: bullets.trivia || [],
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'wiki_id,title' }
  );
  if (error) throw new Error(`Supabase character upsert failed: ${error.message}`);
}

// ================= Handler =================
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { fandom, media, year, arc, forceRefresh, dryRun, extraCharacters, extraEpisodes } = req.body || {};
  if (!fandom) return res.status(400).json({ error: 'fandom is required' });

  // forceRefresh: true bypasses the 14-day lore_categories/lore_episodes/
  // lore_characters freshness cache for this call. This is the escape
  // hatch for "the category guess resolved to the wrong/empty thing once,
  // and that wrong answer is now cached for two weeks" — without this,
  // fixing buildEpisodeCategoryGuesses' ordering (see comment on that
  // function) wouldn't actually change anything for a wiki+arc that was
  // already resolved once, since every lookup below would just keep
  // serving the stale cached result until it expires on its own.
  const freshnessMs = forceRefresh ? 0 : FRESHNESS_MS;

  const warnings = [];
  try {
    const { wikiRow, attempts } = await getOrCreateWiki(fandom, year);
    if (!wikiRow) {
      const detail = attempts && attempts.length ? ` Tried: ${attempts.join(' | ')}` : '';
      return res.status(200).json({ error: `Couldn't find a Fandom wiki matching "${fandom}"${year ? ` (${year})` : ''}.${detail}` });
    }
    const wiki = { subdomain: wikiRow.subdomain, sitename: wikiRow.sitename, url: wikiRow.base_url };

    const episodeCategoryGuesses = buildEpisodeCategoryGuesses(fandom, media, year, arc);
    const episodeCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, episodeCategoryGuesses, 500, freshnessMs);
    let episodeTitles = [];
    let episodeCategoryArcScoped = false;
    if (episodeCategoryResult.found) {
      episodeCategoryArcScoped = episodeCategoryResult.found.arcScoped;
      episodeTitles = episodeCategoryResult.found.members;
      if (arc && !episodeCategoryResult.found.arcScoped) {
        const beforeCount = episodeTitles.length;
        episodeTitles = filterTitlesUpToArc(episodeTitles, arc);
        warnings.push(`No category specific to "${arc}" — filtered by number instead (best-effort).`);
        // If the number-filter didn't actually remove anything, it's very
        // likely because none of the titles in this wiki-wide category
        // encode a season/arc number at all (most TV episode titles don't)
        // — meaning the "filter" was a silent no-op and episodeTitles is
        // really just every episode from every arc, not just this one.
        if (episodeTitles.length === beforeCount) {
          warnings.push(
            `"${arc}" filter matched every title in "${episodeCategoryResult.found.name}" (${beforeCount} of ${beforeCount}) — none of them appear to encode a season/arc number, so this is almost certainly the WHOLE-SERIES episode list, not just "${arc}". Treat the resulting corpus as unscoped.`
          );
        }
      }
    } else if (episodeCategoryResult.attempts.length) {
      warnings.push(`Couldn't check episode/chapter categories: ${episodeCategoryResult.attempts.join(' | ')}`);
    } else {
      warnings.push('No episode/chapter category found on this wiki.');
    }
    if (arc && episodeTitles.length === 0) {
      warnings.push(`No episodes were resolved for "${arc}" specifically — the corpus for this arc will contain 0 episodes even though the request will still report done:true once characters are handled.`);
    }

    // Manual override: pages listed here are fetched/cached regardless of
    // what category discovery just did above, and regardless of the
    // arc-number filter applied to episodeTitles a few lines up — see the
    // extraCharacters/extraEpisodes doc block at the top of this file.
    const extraEpisodeTitles = normalizeExtraTitles(extraEpisodes);
    if (extraEpisodeTitles.length) {
      const have = new Set(episodeTitles);
      const added = extraEpisodeTitles.filter((title) => !have.has(title));
      episodeTitles.push(...added);
      if (added.length) {
        warnings.push(`${added.length} episode title(s) added manually via extraEpisodes (bypassing category discovery): ${added.join(', ')}`);
      }
    }

    // Character discovery: try the SEASON PAGE first (findSeasonPageCharacters
    // — reads the Cast/Characters section of the season's own page, e.g.
    // "Season 6"), and only fall back to CATEGORY guessing
    // (buildCharacterCategoryGuesses — a separate "<arc> Characters"-style
    // category page) if that comes back empty, because the category
    // approach so often lands on an unscoped, wiki-wide "Characters"
    // category instead (see that function's own comment for why). Both
    // paths feed the same characterTitles/characterCategoryArcScoped/
    // characterCategory response fields below, so a client reading the
    // response can't tell which path won just from the shape of the
    // response — characterSource says which one did, for debugging.
    let characterTitles = [];
    let characterCategoryArcScoped = false;
    let characterCategoryLabel = null;
    let characterSource = 'none';

    if (arc) {
      const seasonPageGuesses = buildSeasonPageGuesses(fandom, year, arc);
      const seasonResult = await findSeasonPageCharacters(wiki.subdomain, seasonPageGuesses, warnings);
      if (seasonResult.titles.length) {
        characterTitles = seasonResult.titles;
        characterCategoryArcScoped = true;
        characterCategoryLabel = `Season page: "${seasonResult.pageTitle}"`;
        characterSource = 'season-page';
      } else {
        warnings.push(`No season page with a Cast/Characters section was found for "${arc}" (tried: ${seasonPageGuesses.join(', ') || '(no guesses — no arc)'}) — falling back to character-category discovery.`);
      }
    }

    let characterCategoryResult = { found: null, attempts: [] };
    if (!characterTitles.length) {
      const characterCategoryGuesses = buildCharacterCategoryGuesses(fandom, year, arc);
      characterCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, characterCategoryGuesses, 500, freshnessMs);
      // Copy (don't reference) `.members` — that array may be the same
      // object returned from the category cache, and this function is
      // about to push extra titles onto characterTitles below.
      characterTitles = characterCategoryResult.found ? [...characterCategoryResult.found.members] : [];
      if (characterCategoryResult.found) {
        characterCategoryArcScoped = characterCategoryResult.found.arcScoped;
        characterCategoryLabel = characterCategoryResult.found.name;
        characterSource = 'category';
        if (arc && !characterCategoryArcScoped) {
          warnings.push(
            `No character category specific to "${arc}" was found either — falling back to this wiki's whole-series cast ("${characterCategoryResult.found.name}"), NOT just "${arc}". Character-page titles essentially never encode a season/arc number the way some episode titles do, so there's no reliable way to filter this list down automatically the way episodes get filtered above. Treat the character corpus as unscoped; use extraCharacters to hand-pick titles if you only want specific ones from this arc.`
          );
        }
      } else if (characterCategoryResult.attempts.length) {
        warnings.push(`Couldn't check character categories: ${characterCategoryResult.attempts.join(' | ')}`);
      } else {
        warnings.push('No character category found on this wiki.');
      }
    }

    const extraCharacterTitles = normalizeExtraTitles(extraCharacters);
    if (extraCharacterTitles.length) {
      const have = new Set(characterTitles);
      const added = extraCharacterTitles.filter((title) => !have.has(title));
      characterTitles.push(...added);
      if (added.length) {
        warnings.push(`${added.length} character title(s) added manually via extraCharacters (bypassing category discovery): ${added.join(', ')}`);
      }
    }

    // dryRun: true short-circuits BEFORE any Fandom page fetch or Supabase
    // write happens. It answers "of the titles this arc/category resolves
    // to, what does Supabase actually have right now?" — as a pure read, so
    // it can't be fooled by anything upstream of it. This exists because
    // done:true elsewhere in this file only ever reports what's in
    // lore_episodes/lore_characters at read time; if a client is showing a
    // populated corpus that the DB itself disagrees with, the disagreement
    // is happening somewhere other than this endpoint (different Supabase
    // project between environments, a case-sensitive `arc` filter that
    // doesn't match what upsertEpisode actually wrote, checking the wrong
    // table, etc.) — and this is the fastest way to prove that rather than
    // re-guessing it. Titles are checked with an infinite freshness window
    // (a row counts as "present" no matter how old) since the point here is
    // "does a row exist at all," not "is it fresh enough to skip a re-fetch."
    if (dryRun) {
      const rawEpisodes = await getCachedEpisodes(wikiRow.id, episodeTitles, Infinity);
      const rawCharacters = await getCachedCharacters(wikiRow.id, characterTitles, Infinity);
      const classify = (row, hasContent) => {
        if (!row) return 'missing'; // no row for this title at all, in this wiki_id
        if (!hasContent) return 'cached-empty'; // row exists, but it's the failure placeholder (empty plot / no bullets)
        const fresh = Date.now() - new Date(row.fetched_at).getTime() < freshnessMs;
        return fresh ? 'ok' : 'stale'; // row exists and has content, just older than the freshness window
      };
      const episodeStatus = episodeTitles.map((title) => {
        const row = rawEpisodes[title];
        return { title, status: classify(row, !!(row && row.plot)), fetchedAt: row ? row.fetched_at : null };
      });
      const characterStatus = characterTitles.map((title) => {
        const row = rawCharacters[title];
        const hasContent = !!(row && (row.history?.length || row.powers?.length || row.relationships?.length || row.trivia?.length));
        return { title, status: classify(row, hasContent), fetchedAt: row ? row.fetched_at : null };
      });
      return res.status(200).json({
        dryRun: true,
        wiki,
        arc: arc || null,
        wikiId: wikiRow.id,
        episodesRequested: episodeTitles.length,
        episodeCategory: episodeCategoryResult.found ? episodeCategoryResult.found.name : null,
        episodeCategoryArcScoped,
        episodeStatus,
        missingEpisodes: episodeStatus.filter((e) => e.status !== 'ok').map((e) => e.title),
        charactersRequested: characterTitles.length,
        characterCategory: characterCategoryLabel,
        characterCategoryArcScoped,
        characterSource,
        characterStatus,
        missingCharacters: characterStatus.filter((c) => c.status !== 'ok').map((c) => c.title),
        warnings,
      });
    }

    const cachedEpisodes = await getCachedEpisodes(wikiRow.id, episodeTitles, freshnessMs);
    const cachedCharacters = await getCachedCharacters(wikiRow.id, characterTitles, freshnessMs);

    const missing = [
      ...episodeTitles.filter((t) => !cachedEpisodes[t]).map((title) => ({ type: 'episode', title })),
      ...characterTitles.filter((t) => !cachedCharacters[t]).map((title) => ({ type: 'character', title })),
    ];

    if (missing.length > 0) {
      const batch = missing.slice(0, BATCH_SIZE);
      for (const item of batch) {
        try {
          if (item.type === 'episode') {
            const plot = await fetchEpisodePlot(wiki.subdomain, item.title, warnings);
            await upsertEpisode(wikiRow.id, item.title, arc || null, plot);
          } else {
            const bullets = await fetchCharacterBullets(wiki.subdomain, item.title, warnings);
            await upsertCharacter(wikiRow.id, item.title, bullets);
          }
        } catch (err) {
          warnings.push(`Couldn't fetch "${item.title}": ${err.message}`);
          // Cache an empty placeholder so this title counts as "handled"
          // and the batch converges — otherwise a page that fails every
          // time stays in `missing` forever and the client polls in an
          // infinite loop.
          try {
            if (item.type === 'episode') {
              await upsertEpisode(wikiRow.id, item.title, arc || null, '');
            } else {
              await upsertCharacter(wikiRow.id, item.title, {});
            }
          } catch (cacheErr) {
            warnings.push(`Also couldn't cache the failure for "${item.title}": ${cacheErr.message}`);
          }
        }
        await delay(REQUEST_DELAY_MS);
      }
      return res.status(200).json({
        done: false,
        fetched: batch.length,
        remaining: missing.length - batch.length,
        total: episodeTitles.length + characterTitles.length,
        // Titles this round actually attempted. A page that's silently
        // stuck (fetch+cache both "succeed" with no error, but the item
        // never registers as cached — see getCachedEpisodes) produces no
        // warnings at all, so warnings alone can't tell you which page is
        // the problem. Repeating this list is what lets the stall detector
        // name the culprit instead of just reporting "warnings: none".
        attempted: batch.map((item) => item.title),
        episodesRequested: episodeTitles.length,
        episodeCategory: episodeCategoryResult.found ? episodeCategoryResult.found.name : null,
        episodeCategoryArcScoped,
        charactersRequested: characterTitles.length,
        characterCategory: characterCategoryLabel,
        characterCategoryArcScoped,
        characterSource,
        warnings,
      });
    }

    // Everything's cached — return the full corpus.
    // Episodes cached with an empty plot (fetch failed and the fallback
    // placeholder is what's on record) can't be injected as lore, but
    // dropping them with .filter() and nothing else looks identical to
    // "never fetched" from the outside — surface which ones instead.
    const emptyPlotTitles = [];
    const episodes = [];
    for (const title of episodeTitles) {
      const plot = (cachedEpisodes[title] && cachedEpisodes[title].plot) || '';
      if (plot) episodes.push({ title, plot });
      else emptyPlotTitles.push(title);
    }
    if (emptyPlotTitles.length) {
      warnings.push(`${emptyPlotTitles.length} episode(s) are cached but have no usable plot text, so they're excluded from the corpus: ${emptyPlotTitles.join(', ')}`);
    }
    // Same "cached but unusable" filtering as emptyPlotTitles above, plus a
    // second job: a title picked up from a season page's Cast/Characters
    // section that turns out NOT to be an actual character page (an actor's
    // own bio page linked from that section, say — see the comment on
    // looksLikeNonCharacterTitle for why that check can't catch this case up
    // front) will fetch successfully but come back with none of History/
    // Powers/Relationships/Trivia, exactly like a genuinely-failed fetch
    // does. Dropping it here means a stray non-character link never
    // silently rides along in the corpus as a nameplate with no content.
    const emptyBulletTitles = [];
    const characters = [];
    for (const title of characterTitles) {
      const row = cachedCharacters[title];
      const hasContent = !!(row && (row.history?.length || row.powers?.length || row.relationships?.length || row.trivia?.length));
      if (hasContent) {
        characters.push({
          name: title,
          history: row.history || [],
          powers: row.powers || [],
          relationships: row.relationships || [],
          trivia: row.trivia || [],
        });
      } else {
        emptyBulletTitles.push(title);
      }
    }
    if (emptyBulletTitles.length) {
      warnings.push(`${emptyBulletTitles.length} character(s) are cached but have no usable bio content, so they're excluded from the corpus: ${emptyBulletTitles.join(', ')}`);
    }

    return res.status(200).json({
      done: true,
      wiki,
      arc: arc || null,
      episodes,
      characters,
      // Lets the client tell "this arc genuinely has this many episodes and
      // we got them all" apart from "we never found an episode category, so
      // there was nothing to fetch and done:true was trivially true." Same
      // shape as the done:false progress fields above, on purpose.
      episodesRequested: episodeTitles.length,
      episodeCategory: episodeCategoryResult.found ? episodeCategoryResult.found.name : null,
      episodeCategoryArcScoped,
      charactersRequested: characterTitles.length,
      characterCategory: characterCategoryLabel,
      characterCategoryArcScoped,
      characterSource,
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
