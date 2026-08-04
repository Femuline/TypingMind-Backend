/**
 * lore.js
 * ---------------------------------------------------------------
 * POST { fandom, media?, year?, arc? }
 *
 * Resolves the Fandom wiki for `fandom`, figures out which episode/character
 * pages belong to `arc` (e.g. "Season 6"), and makes sure each one is cached
 * in Supabase (lore_wikis / lore_characters / lore_episodes — see
 * supabase-schema.sql).
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
// TODO: swap in a real contact URL/email if you want to be extra safe here.
const FANDOM_USER_AGENT = 'TypingMind-LoreFetch/1.0 (+https://typingmind-backend.vercel.app)';
const PLOT_SECTION_NAMES = ['Plot', 'Synopsis', 'Summary']; // tried in this order; some wikis really do call it "Summary"
// Some wikis put the full plot on a dedicated SUBPAGE instead of a section
// on the main episode article (e.g. charmed.fandom.com/wiki/X/Plot) — see
// fetchEpisodePlot. Tried in this order, before same-page sections.
const PLOT_SUBPAGE_SUFFIXES = ['Plot', 'Synopsis'];
const CHARACTER_SECTION_GROUPS = {
  history: ['History', 'Biography', 'Background'],
  powers: ['Powers and Abilities', 'Powers', 'Abilities'],
  relationships: ['Relationships'],
  trivia: ['Trivia', 'Notes and Trivia', 'Notes'],
};

// TODO: add any other origins TypingMind serves the extension from (a
// custom domain, chat.typingmind.com, etc). Each response can only carry
// ONE origin value, so this is checked per-request rather than joined.
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
  // Rate-limited — back off and retry rather than treating it as "not
  // found." Respects Retry-After when Fandom sends one, otherwise a short
  // increasing wait. Keeps retries small so this can't blow past Vercel's
  // invocation time limit.
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
  // Year-suffixed first: if a franchise has a dedicated wiki for this
  // specific version (e.g. a reboot with its own subdomain), that's a more
  // precise match than the bare/shared name and should win when it exists.
  // wikiExists() just throws on a 404, so trying this first costs nothing
  // when no such wiki exists — resolveWiki() falls through to the next
  // candidate. This does NOT solve the more common case of one wiki
  // covering every version of a franchise under a single bare subdomain
  // (that's handled downstream by the fandom/year-qualified CATEGORY
  // guesses in buildEpisodeCategoryGuesses/buildCharacterCategoryGuesses).
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

// Category membership (e.g. "which pages are in Category:Season 6 Episodes")
// used to be re-fetched from Fandom's live API on every single invocation —
// unlike page content, it had no cache at all. Since the client calls this
// endpoint once per BATCH_SIZE pages until the whole corpus is done, a
// content-heavy wiki needing many batches was re-resolving every episode/
// character category candidate (up to 8 live requests) on every one of
// those batches for an answer that hadn't changed. That's what was
// compounding into 429s on bigger shows. Cached the same way lore_episodes/
// lore_characters cache page content — see getCachedCategoryMembers/
// cacheCategoryMembers below, backed by a new `lore_categories` table
// (wiki_id, category_name, members, fetched_at; unique on
// wiki_id+category_name).
async function getCachedCategoryMembers(wikiId, categoryName) {
  const { data, error } = await supabase
    .from('lore_categories')
    .select('*')
    .eq('wiki_id', wikiId)
    .eq('category_name', categoryName)
    .maybeSingle();
  if (error) throw new Error(`Supabase category cache lookup failed: ${error.message}`);
  if (!data) return null;
  if (Date.now() - new Date(data.fetched_at).getTime() >= FRESHNESS_MS) return null; // stale — treat as a miss
  return Array.isArray(data.members) ? data.members : [];
}

async function cacheCategoryMembers(wikiId, categoryName, members) {
  await supabase
    .from('lore_categories')
    .upsert(
      { wiki_id: wikiId, category_name: categoryName, members, fetched_at: new Date().toISOString() },
      { onConflict: 'wiki_id,category_name' }
    );
}

async function fetchCategoryMembers(subdomain, wikiId, categoryName, limit) {
  const cached = await getCachedCategoryMembers(wikiId, categoryName);
  if (cached !== null) return cached; // includes the empty-array case — a category that's confirmed empty/nonexistent doesn't need re-checking either
  const url = `https://${subdomain}.fandom.com/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent('Category:' + categoryName)}&cmlimit=${limit}&format=json`;
  const data = await apiRequest(url);
  const members = (data && data.query && data.query.categorymembers) || [];
  const titles = members.filter((m) => m.ns === 0).map((m) => m.title);
  await cacheCategoryMembers(wikiId, categoryName, titles);
  return titles;
}

// candidates may be plain strings or { name, arcScoped } objects — arcScoped
// marks a candidate whose name already encodes a specific arc/season (e.g.
// "Season 6 Episodes"), meaning its members don't need re-filtering by arc
// number afterward. Plain strings are treated as arcScoped: false.
async function findFirstNonEmptyCategory(subdomain, wikiId, candidates, limit) {
  const attempts = [];
  const seen = new Set(); // guess lists can contain duplicate names when fandom === arc, etc.
  for (const candidate of candidates) {
    const name = typeof candidate === 'string' ? candidate : candidate.name;
    const arcScoped = typeof candidate === 'string' ? false : !!candidate.arcScoped;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      const members = await fetchCategoryMembers(subdomain, wikiId, name, limit);
      if (members.length > 0) return { found: { name, arcScoped, members }, attempts };
    } catch (err) {
      attempts.push(`"${name}": ${err.message}`);
    }
  }
  return { found: null, attempts };
}

// Most-specific-first category name guesses for episodes. A wiki that hosts
// one show has an unqualified "Episodes" category and these fandom/year-
// qualified guesses simply won't exist — they fail fast (empty/404) and fall
// through harmlessly. A wiki that hosts a whole franchise under one
// subdomain is exactly the case these guesses are FOR: they let a request
// for "Saved by the Bell" + year 1989 hit "Saved by the Bell episodes"
// instead of a catch-all "Episodes" category that also contains the 2020
// reboot's episodes.
// MediaWiki only force-capitalizes the FIRST character of a page title —
// every word after that is case-sensitive, and Fandom communities are
// inconsistent about it (confirmed on a real wiki: "Category:X episodes"
// lowercase right alongside "Category:X Characters" capitalized). Trying
// only one casing of the synonym word would make these guesses miss on a
// wiki that happens to use the other convention, so both are tried.
function withCasings(word) {
  return [...new Set([word, word.charAt(0).toLowerCase() + word.slice(1)])];
}

function buildEpisodeCategoryGuesses(fandom, media, year, arc) {
  const synonyms = MEDIA_EPISODE_SYNONYMS[media] || MEDIA_EPISODE_SYNONYMS.show;
  const primary = synonyms[0];
  const guesses = [];
  const addQualified = (prefix, arcScoped) => {
    for (const word of withCasings(primary)) guesses.push({ name: `${prefix} ${word}`, arcScoped });
  };
  if (arc && year) addQualified(`${fandom} (${year}) ${arc}`, true);
  if (arc) addQualified(`${fandom} ${arc}`, true);
  if (year) addQualified(`${fandom} (${year})`, false);
  addQualified(fandom, false);
  if (arc) {
    guesses.push({ name: `${arc} ${primary}`, arcScoped: true });
    guesses.push({ name: arc, arcScoped: true });
  }
  for (const s of synonyms) guesses.push({ name: s, arcScoped: false });
  return guesses;
}

// Same idea for characters. There's no arc-scoping concept for characters
// (a character isn't "in" a season the way an episode is), so plain names
// are enough here.
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

// ---- section-targeted extraction (this is the actual fix for "I'm getting
// the summary blurb, not the plot") ----
async function fetchPageSections(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=sections&format=json`;
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
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=${sectionIndex}&format=json`;
  const data = await apiRequest(url);
  const field = data && data.parse && data.parse.wikitext;
  const wikitext = typeof field === 'string' ? field : field && field['*'];
  return wikitext ? cleanWikitext(wikitext) : '';
}

async function fetchIntroExtract(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=query&prop=extracts&explaintext=1&exintro=1&titles=${encodeURIComponent(title)}&format=json`;
  const data = await apiRequest(url);
  const pages = data && data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  return page && page.extract ? cleanExtract(page.extract) : '';
}

// Whole-page wikitext (no &section=), for subpages like "Episode/Plot" that
// generally aren't broken into named sections at all — they're just the
// narrative, start to finish. Throws (via apiRequest) if the page doesn't
// exist, e.g. MediaWiki's "missingtitle" error — callers use that to know
// this particular subpage naming isn't what this wiki uses, not that
// anything went wrong.
async function fetchFullPageWikitext(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
  const data = await apiRequest(url);
  const field = data && data.parse && data.parse.wikitext;
  const wikitext = typeof field === 'string' ? field : field && field['*'];
  return wikitext ? cleanWikitext(wikitext) : '';
}

// Three tiers, most-complete-first:
//   1. A dedicated "Episode Name/Plot" (or /Synopsis) subpage — this is
//      where the FULL plot lives on wikis like Charmed's, where the main
//      episode page only has a one-paragraph teaser and a "read the full
//      plot here" link. This is the fix for "I'm only getting summaries."
//   2. A same-page Plot/Synopsis/Summary section, for wikis that keep the
//      whole thing on one article.
//   3. The page's short lead/intro paragraph — this genuinely IS a summary,
//      not the plot, so it's flagged in warnings rather than handed back
//      looking equivalent to tier 1/2 content.
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
  // Trivia is usually already a wiki bullet list (lines starting with *);
  // prose sections (history/powers/relationships) get split by paragraph instead.
  const lines = text.split('\n').map((l) => l.replace(/^\*+\s*/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : paragraphsToBullets(text);
}

// Only pulls History/Powers/Relationships/Trivia — deliberately never touches
// "Behind the Scenes"/"Casting"/"Appearances"/etc, so actor info never shows up.
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
  // Cache-first: if we've already resolved this fandom before, use that —
  // don't hit Fandom's live API again. Previously this always called
  // resolveWiki() first regardless of cache state, so every refresh/rescan
  // re-hit Fandom even for a fandom that had already succeeded, which is
  // what was compounding into 429s.
  const { data: cachedByFandom, error: cacheLookupError } = await supabase
    .from('lore_wikis')
    .select('*')
    .ilike('fandom', fandom)
    .maybeSingle();
  if (cacheLookupError) {
    // Don't silently fall through to a live Fandom call on a DB problem —
    // that would masquerade as "rate limited" or "wiki not found" and send
    // debugging in the wrong direction entirely.
    throw new Error(`Supabase cache lookup failed: ${cacheLookupError.message}`);
  }
  if (cachedByFandom) return { wikiRow: cachedByFandom, attempts: [] };

  const { wiki, attempts } = await resolveWiki(fandom, year);
  if (!wiki) return { wikiRow: null, attempts };
  const { data: existing } = await supabase.from('lore_wikis').select('*').eq('subdomain', wiki.subdomain).maybeSingle();
  if (existing) return { wikiRow: existing, attempts };
  const { data: inserted, error } = await supabase
    .from('lore_wikis')
    .insert({ fandom, subdomain: wiki.subdomain, sitename: wiki.sitename, base_url: wiki.url })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { wikiRow: inserted, attempts };
}

async function getCachedEpisodes(wikiId, titles) {
  if (!titles.length) return {};
  const { data } = await supabase.from('lore_episodes').select('*').eq('wiki_id', wikiId).in('title', titles);
  const byTitle = {};
  const now = Date.now();
  for (const row of data || []) {
    if (now - new Date(row.fetched_at).getTime() < FRESHNESS_MS) byTitle[row.title] = row;
  }
  return byTitle;
}

async function getCachedCharacters(wikiId, titles) {
  if (!titles.length) return {};
  const { data } = await supabase.from('lore_characters').select('*').eq('wiki_id', wikiId).in('title', titles);
  const byTitle = {};
  const now = Date.now();
  for (const row of data || []) {
    if (now - new Date(row.fetched_at).getTime() < FRESHNESS_MS) byTitle[row.title] = row;
  }
  return byTitle;
}

async function upsertEpisode(wikiId, title, arc, plot) {
  await supabase
    .from('lore_episodes')
    .upsert({ wiki_id: wikiId, title, arc, plot, fetched_at: new Date().toISOString() }, { onConflict: 'wiki_id,title' });
}

async function upsertCharacter(wikiId, title, bullets) {
  // Write all four fields explicitly (defaulting missing ones to []) rather
  // than only the keys fetchCharacterBullets happened to find — otherwise a
  // re-fetch that finds fewer sections than last time would leave stale
  // bullets sitting in a column this pass didn't touch.
  await supabase.from('lore_characters').upsert(
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
}

// ================= Handler =================
export default async function handler(req, res) {
  // ---- CORS: must run before any other branching, so the OPTIONS
  // preflight TypingMind's browser sends ahead of the real POST gets a
  // clean 200 with the right headers instead of falling into the 405/400
  // branches below. ----
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  // ---- end CORS ----

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { fandom, media, year, arc } = req.body || {};
  if (!fandom) return res.status(400).json({ error: 'fandom is required' });

  const warnings = [];
  try {
    const { wikiRow, attempts } = await getOrCreateWiki(fandom, year);
    if (!wikiRow) {
      const detail = attempts && attempts.length ? ` Tried: ${attempts.join(' | ')}` : '';
      return res.status(200).json({ error: `Couldn't find a Fandom wiki matching "${fandom}"${year ? ` (${year})` : ''}.${detail}` });
    }
    const wiki = { subdomain: wikiRow.subdomain, sitename: wikiRow.sitename, url: wikiRow.base_url };

    const episodeCategoryGuesses = buildEpisodeCategoryGuesses(fandom, media, year, arc);
    const episodeCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, episodeCategoryGuesses, 60);
    let episodeTitles = [];
    if (episodeCategoryResult.found) {
      episodeTitles = episodeCategoryResult.found.members;
      if (arc && !episodeCategoryResult.found.arcScoped) {
        episodeTitles = filterTitlesUpToArc(episodeTitles, arc);
        warnings.push(`No category specific to "${arc}" — filtered by number instead (best-effort).`);
      }
    } else if (episodeCategoryResult.attempts.length) {
      warnings.push(`Couldn't check episode/chapter categories: ${episodeCategoryResult.attempts.join(' | ')}`);
    } else {
      warnings.push('No episode/chapter category found on this wiki.');
    }

    const characterCategoryGuesses = buildCharacterCategoryGuesses(fandom, year);
    const characterCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, characterCategoryGuesses, 60);
    const characterTitles = characterCategoryResult.found ? characterCategoryResult.found.members : [];
    if (!characterCategoryResult.found) {
      if (characterCategoryResult.attempts.length) {
        warnings.push(`Couldn't check character categories: ${characterCategoryResult.attempts.join(' | ')}`);
      } else {
        warnings.push('No character category found on this wiki.');
      }
    }

    const cachedEpisodes = await getCachedEpisodes(wikiRow.id, episodeTitles);
    const cachedCharacters = await getCachedCharacters(wikiRow.id, characterTitles);

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
          // IMPORTANT: without this, a page that fails every single time
          // (persistent 429, page doesn't exist, etc.) never leaves
          // `missing`, so the batch loop above re-attempts it forever and
          // `done` never flips true — the client just polls this endpoint
          // in an infinite loop (visible as progress stuck at "total/total"
          // since `remaining` can hit 0 while `missing` never does). Caching
          // an empty placeholder (still upserted, still stamped with
          // fetched_at) makes this title count as "handled" so the batch can
          // converge; it's filtered back out of the final corpus below the
          // same way a page with genuinely no matching sections already is.
          // Trade-off: a failure gets cached for the full FRESHNESS_MS (14
          // days) same as a success, so a transient failure (e.g. today's
          // 429) won't be retried until then either — acceptable here since
          // the alternative (never converging) is worse, but worth a shorter
          // TTL for empty rows specifically if that turns out to matter.
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
        warnings,
      });
    }

    // Everything's cached — return the full corpus.
    const episodes = episodeTitles.map((title) => ({ title, plot: (cachedEpisodes[title] && cachedEpisodes[title].plot) || '' })).filter((e) => e.plot);
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

    return res.status(200).json({ done: true, wiki, arc: arc || null, episodes, characters, warnings });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
