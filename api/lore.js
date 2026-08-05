/**
 * lore.js
 * ---------------------------------------------------------------
 * POST { fandom, media?, year?, arc?, forceRefresh?, dryRun? }
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
 * episodesRequested (how many episode titles were actually resolved for
 * this arc — 0 is a valid but meaningful number: it means the episode
 * category was never found/matched, NOT that the arc has no episodes) and
 * episodeCategory/episodeCategoryArcScoped (which Fandom category won, and
 * whether it was scoped to the requested arc or a wiki-wide fallback).
 * done:true no longer means "found everything" by itself — it only means
 * "nothing is left in `missing`," which is trivially true if episodesRequested
 * came back 0. Check episodesRequested to tell those apart.
 *
 * Resolves the Fandom wiki for `fandom`, figures out which episode/character
 * pages belong to `arc` (e.g. "Season 6"), and makes sure each one is cached
 * in Supabase (lore_wikis / lore_characters / lore_episodes / lore_categories).
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

const ALLOWED_ORIGINS = ['https://www.typingmind.com'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildCharacterCategoryGuesses(fandom, year) {
  const guesses = [];
  const addQualified = (prefix) => {
    for (const word of withCasings('Characters')) guesses.push(`${prefix} ${word}`);
  };
  if (year) addQualified(`${fandom} (${year})`);
  addQualified(fandom);
  guesses.push('Main Characters', 'Characters', 'Character');
  return guesses;
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
  const { fandom, media, year, arc, forceRefresh, dryRun } = req.body || {};
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

    const characterCategoryGuesses = buildCharacterCategoryGuesses(fandom, year);
    const characterCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, characterCategoryGuesses, 500, freshnessMs);
    const characterTitles = characterCategoryResult.found ? characterCategoryResult.found.members : [];
    if (!characterCategoryResult.found) {
      if (characterCategoryResult.attempts.length) {
        warnings.push(`Couldn't check character categories: ${characterCategoryResult.attempts.join(' | ')}`);
      } else {
        warnings.push('No character category found on this wiki.');
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
    const characters = characterTitles.map((title) => {
      const row = cachedCharacters[title];
      return {
        name: title,
        history: (row && row.history) || [],
        powers: (row && row.powers) || [],
        relationships: (row && row.relationships) || [],
        trivia: (row && row.trivia) || [],
      };
    });

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
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
