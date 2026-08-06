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
 * Every response (done:true OR done:false) now also includes arc/
 * arcResolvedTitle/arcIndexPage (see ARC INDEX RESOLUTION below —
 * arcResolvedTitle/arcIndexPage are null unless a numbered `arc` actually
 * got resolved to a real title via the wiki's own index page) AND
 * episodesRequested/episodeCategory/episodeCategoryArcScoped/episodeSource AND
 * charactersRequested/characterCategory/characterCategoryArcScoped/
 * characterSource — for each: how many titles were actually resolved (0 is
 * a valid but meaningful number: it means no matching source was ever
 * found/matched, NOT that the arc has no episodes/characters), which Fandom
 * category (or, for episodes/characters, arc/season page — see episodeSource/
 * characterSource) won, and whether that source was scoped to the requested
 * `arc` or is a wiki-wide fallback covering every season. done:true no longer means
 * "found everything" by itself — it only means "nothing is left in
 * `missing`," which is trivially true if episodesRequested/
 * charactersRequested came back 0. Check the *Requested fields to tell
 * those apart.
 *
 * ARC INDEX RESOLUTION: before any of the scoping below runs, a numbered
 * `arc` (e.g. "Arc 2") is checked against a wiki-wide INDEX page, if the
 * wiki has one — see resolveArcTitleFromIndex/buildArcIndexPageGuesses/
 * parseArcIndexWikitext. This exists for wikis that name their arcs/seasons/
 * volumes with real titles instead of numbers (Lookism is the motivating
 * example: https://lookism.fandom.com/wiki/Arc_Guide numbers its arcs, but
 * arc 2 is actually titled "Breakaway" — no page or category on that wiki is
 * ever literally called "Arc 2"). Every "<Label> N"-shaped guess below
 * (episode category, character category, season page) is built from the
 * literal `arc` text, so on a wiki like that none of them can ever match
 * anything — episode scoping in particular then falls all the way through
 * to the wiki-wide catch-all category, silently returning the WHOLE series
 * instead of just the one arc that was asked for. Resolving "Arc 2" to
 * "Breakaway" first, and using THAT for guess-building, fixes it at the
 * source rather than patching each guess-builder separately. The resolved
 * title is surfaced as `arcResolvedTitle` in every response shape (null
 * when nothing needed resolving); the index page it came from is
 * `arcIndexPage`. The literal `arc` text is still what's used for the
 * NUMBER-based episode fallback filter (filterTitlesToArc, which needs an
 * actual digit) and for everything echoed back to the caller.
 *
 * FIX (2026-08): the above only actually worked on wikis whose index page is
 * an ORDERED ("#") wikitext list. Lookism's own "Arc Guide" — the motivating
 * example this feature was built for — turned out to render as an
 * UNORDERED ("*") list instead (confirmed by fetching the live page: no
 * numbering is visible anywhere on it), which parseArcIndexWikitext's old
 * "#"-only regex silently parsed as zero entries. That's not a "page not
 * found" — resolveArcTitleFromIndex found the page fine, got nothing usable
 * out of it, and quietly fell through to "no index page found," so "Arc 2"
 * was NEVER actually resolved to "Breakaway" on the one wiki this whole
 * mechanism exists for. parseArcIndexWikitext now matches "#" OR "*"
 * top-level list lines, and a found-but-unparseable index page now pushes
 * its own distinct warning (previously indistinguishable from "no such
 * page" from the outside). See parseArcIndexWikitext's own comment for the
 * full explanation.
 *
 * ARC SCOPING — EPISODES: when `arc` is passed, episode category guessing
 * tries arc-scoped category names first (e.g. "Charmed Season 1 Episodes",
 * "Season 1 Episodes", and — FIX (2026-08) — the "/" subcategory form some
 * wikis use instead, e.g. "Episodes/Season 1" on Stranger Things Wiki; see
 * buildEpisodeCategoryGuesses) before ever falling back to a wiki-wide
 * "Episodes" catch-all. If an arc-scoped category is found, its members are
 * used as-is: that's a real, exact scope to the requested season/arc, not a
 * heuristic (episodeSource: 'category').
 * If NO arc-scoped category exists, this — FIX (2026-08) — now tries reading
 * the episode list straight off the arc/season's own PAGE next
 * (findArcPageEpisodes, using the same page guesses as
 * findSeasonPageCharacters — see buildSeasonPageGuesses), the same way
 * characters already did (see ARC SCOPING — CHARACTERS below). This is what
 * fixes wikis like Lookism, which has no per-arc episode category at all —
 * only a per-arc PAGE ("Breakaway", "Cheonliang Arc", ...) whose own
 * Synopsis section links each of its own chapters (episodeSource:
 * 'arc-page-section' / 'arc-page-whole'). ONLY if that also finds nothing do
 * episodes fall back to a best-effort NUMBER filter on the wiki-wide
 * category list (see filterTitlesToArc; episodeSource: 'category' with
 * episodeCategoryArcScoped: false — check that combination, not just
 * episodeCategory being non-null, to know whether the result is actually
 * scoped). That NUMBER filter is a silent no-op on any wiki whose
 * episode/chapter titles don't literally encode a season/arc number in the
 * title itself (confirmed on Stranger Things, whose episode pages are titled
 * things like "The Vanishing of Will Byers" — no number at all — and would
 * have kept silently returning the whole series if buildEpisodeCategoryGuesses'
 * "/" guess above hadn't fixed the category match directly instead).
 *
 * ARC SCOPING — CHARACTERS: characters are scoped differently, in two
 * stages (see findSeasonPageCharacters / buildCharacterCategoryGuesses,
 * called in that order from the handler). Stage 1 itself has two tiers:
 *   1. SEASON PAGE (primary): fetch the season's own Fandom page (e.g.
 *      "Season 6", "<Fandom>/<Arc>" for wikis that subpage it instead, e.g.
 *      "Stranger Things/Season 1", or — FIX (2026-08) — "<Fandom>: <Arc>"
 *      for wikis that colon-join it instead, e.g. "Saved by the Bell:
 *      Season 1" on Saved By The Bell Wiki; see buildSeasonPageGuesses) and
 *      read the character links off of it. This
 *      is tried first because real single-show wikis commonly give a season
 *      a proper cast listing on its own page without ALSO filing those same
 *      characters under a matching per-season CATEGORY — which is exactly
 *      what made stage 2 below so often land on the wiki's entire cast
 *      instead of just this arc's.
 *        a. Section tier (precise): if the page has a Cast/Characters-shaped
 *           heading (see SEASON_CHARACTER_SECTION_NAMES), read the links out
 *           of just that section.
 *        b. Whole-page tier (broad fallback): if the page exists but tier
 *           (a) found nothing — no matching heading, or that section's links
 *           didn't survive filtering — read every internal link on the page
 *           instead, filtered through looksLikeNonCharacterTitle. This
 *           covers wikis that put a season's cast in an infobox field or
 *           under a heading not in the guess list. Noisier than (a), but
 *           still THIS season's own page rather than a wiki-wide fallback.
 *   2. CATEGORY guessing (fallback, only if stage 1 found nothing at all —
 *      neither tier, on any page guess): tries arc-scoped category names
 *      first (e.g. "Charmed Season 1 Characters", "Season 1 Characters")
 *      before ever falling back to a wiki-wide "Characters" catch-all.
 *      Characters do NOT get a NUMBER-filter fallback the way episodes do
 *      (see filterTitlesToArc), because character-page titles essentially
 *      never encode a season number the way some episode titles do — a
 *      title-based filter there would almost always be a silent no-op
 *      masquerading as scoping.
 * If NEITHER stage finds an arc-scoped source, the response's
 * characterCategoryArcScoped is false and a warning explicitly says the
 * character list is the whole-series cast, not scoped to `arc` — check
 * warnings/characterCategoryArcScoped rather than assuming a returned
 * character list is automatically limited to the arc you asked for.
 * characterSource ('season-page-section' | 'season-page-whole' | 'category' |
 * 'none') says which stage actually produced the list, for debugging —
 * '-section' means a Cast/Characters-shaped heading was found and used;
 * '-whole' means the season page existed but had no such heading (or that
 * heading's own links didn't survive filtering), so every link on the page
 * was used instead, filtered for obvious non-character titles (see
 * findSeasonPageCharacters and looksLikeNonCharacterTitle) — noisier, but
 * still scoped to this season's own page rather than the wiki-wide fallback.
 *
 * NON-CHARACTER PAGE FILTERING (both stages above): neither ARC SCOPING
 * mechanism above actually verifies that a discovered link points at a
 * character page — a season page's Cast/Characters section is written
 * "Actor as Character," so the actor's own bio page rides along right next
 * to every real character link, and a recurring/minor character's entry can
 * cite their debut episode by name. Both are shaped exactly like a valid
 * character title, so looksLikeNonCharacterTitle's title-shape filter can't
 * catch either one — confirmed on Charmed itself: actor bios like "Holly
 * Marie Combs" sit right next to character links in a season's own Cast and
 * Characters section, and every Charmed episode page has a "Notes and
 * Trivia" section, so an episode title that slipped into characterTitles
 * would still pass fetchCharacterBullets's "found nothing" check (Trivia
 * alone counts as content) and get upserted into lore_characters right
 * alongside real characters. Two backstops in the handler run on
 * characterTitles before any page in it gets fetched/cached, regardless of
 * which stage produced the list: an episode cross-check (drops anything
 * already in this same call's episodeTitles — a title can never
 * legitimately be both) and filterOutRealWorldPages (drops titles whose OWN
 * Fandom categories mark them as real-world cast/crew rather than an
 * in-universe character — e.g. "Category:Performers" on charmed.fandom.com).
 * Both run BEFORE extraCharacters is merged in, since that's a manual,
 * exact-title override meant to bypass discovery entirely and shouldn't be
 * second-guessed by either check. The category check makes its own Fandom
 * API calls, so — unlike the free, in-memory episode cross-check — it's
 * skipped under dryRun (see dryRun below); the real fetch/cache path always
 * runs it before writing anything to lore_characters.
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
  personality: ['Personality', 'Personality and Traits', 'Personality Traits'],
  history: ['History', 'Biography', 'Background'],
  powers: ['Powers and Abilities', 'Powers', 'Abilities'],
  trivia: ['Trivia', 'Notes and Trivia', 'Notes'],
};

// Some wikis put a given field on its own dedicated SUBPAGE off the
// character's main title instead of (or in addition to) a same-page
// heading — confirmed on Lookism: lookism.fandom.com/wiki/<Character>/
// Relationships is a separate page, linked from a button/tab on the
// character's own page rather than appearing as prose there. This is the
// character-side equivalent of PLOT_SUBPAGE_SUFFIXES for episodes. Checked
// FIRST (see fetchCharacterBullets) for any key listed here, since a
// dedicated subpage is a more deliberate, complete source than a same-page
// heading would be; falls through to the same-page CHARACTER_SECTION_GROUPS
// heading search if no subpage exists under any suffix. Nothing currently
// in CHARACTER_SECTION_GROUPS uses this tier (relationships did, until that
// field was dropped) — left in place and empty so a future field can opt in
// without re-deriving this mechanism.
const CHARACTER_SUBPAGE_SUFFIXES = {};

// Section names tried (in order — see findSectionIndex) on a SEASON page
// itself (not a character page) to find its cast listing. "Cast and
// Characters" is first because it's the actual heading Fandom's own TV-show
// wikis commonly use (confirmed on Charmed's "Season 6" page); the rest are
// looser fallbacks for wikis that phrase it differently. findSectionIndex's
// startsWith pass means a bare "Cast" or "Characters" candidate will also
// match a longer heading like "Cast and Characters" or "Characters and Cast"
// on its own, so this list doesn't need to be exhaustive.
const SEASON_CHARACTER_SECTION_NAMES = ['Cast and Characters', 'Characters', 'Cast', 'Main Cast', 'Starring Cast', 'Series Regulars'];

// Category-name patterns that mean "this page is about the real-world
// person/team who made the show, not an in-universe character" — used by
// filterOutRealWorldPages to catch actor/crew bio pages that
// looksLikeNonCharacterTitle's title-shape check can't (a real person's name
// is shaped exactly like a character's). Deliberately broad/exclusion-based,
// same philosophy as looksLikeNonCharacterTitle's own comment: positively
// proving "this is a fictional character" is far more error-prone across
// different fandoms than excluding the handful of ways wikis label real
// people. Confirmed against charmed.fandom.com, where actor bios (e.g.
// "Holly Marie Combs") are filed under "Category:Performers".
const NON_CHARACTER_CATEGORY_PATTERN = /\b(performers?|actors?|actresses?|real[\s-]?world|crew|cast\s*(?:and|&)?\s*crew|behind[\s-]?the[\s-]?scenes|production\s*(?:staff|team)?|directors?|writers?|producers?|creators?)\b/i;

// MediaWiki's prop=categories accepts multiple pipe-separated titles per
// request, capped at 50 for anonymous/non-bot callers (500 needs
// apihighlimits, which this script's plain fetch() calls don't have) — see
// fetchCategoriesForTitles.
const CATEGORY_CHECK_BATCH = 50;

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
    // FIX (2026-08): some wikis subcategorize with a literal "/" instead of
    // any word-order qualifier — e.g. Stranger Things Wiki files Season 1's
    // episodes under "Category:Episodes/Season 1", not "Category:Stranger
    // Things Season 1 Episodes" or "Category:Season 1 Episodes" (confirmed;
    // that wiki does the identical "/" thing for Category:Characters/Season 1
    // and its season pages too — see buildCharacterCategoryGuesses/
    // buildSeasonPageGuesses). No word-order guess above or below this ever
    // matched that shape, so a wiki like that fell straight through to the
    // wiki-wide catch-all category further down, and filterTitlesToArc
    // couldn't rescue it either (Stranger Things' own episode titles, e.g.
    // "The Vanishing of Will Byers", don't encode a season number at all) —
    // hence every season silently returning the whole series. Tried ahead of
    // the looser `${arc} ${primary}`/bare-`${arc}` guesses below since it's a
    // confirmed real convention, not a loose guess.
    for (const word of withCasings(primary)) arcScopedGuesses.push({ name: `${word}/${arc}`, arcScoped: true });
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
// filterTitlesToArc as a fallback here. Episode titles occasionally encode
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
  if (arc) {
    // Same "/" subcategory convention as buildEpisodeCategoryGuesses (see its
    // comment) — confirmed on Stranger Things Wiki as Category:Characters/
    // Season 1. This is the fallback path here (findSeasonPageCharacters is
    // tried first — see the handler), but kept in sync anyway so a wiki
    // where the season PAGE approach also fails still has a chance via this
    // category.
    for (const word of withCasings('Characters')) arcScopedGuesses.push({ name: `${word}/${arc}`, arcScoped: true });
  }
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
  // FIX (2026-08): some multi-version wikis join the show name and the
  // season with a literal COLON instead of a space — confirmed as the
  // ACTUAL page titles on Saved By The Bell Wiki: "Saved by the Bell:
  // Season 1" (https://savedbythebell.fandom.com/wiki/Saved_by_the_Bell:_Season_1),
  // and the same convention on that wiki's own reboot/spinoff, "Saved by
  // the Bell (2020): Season 1" — NOT "Saved by the Bell Season 1" (space,
  // no colon), which doesn't exist there as a page or a redirect. This is
  // exactly the kind of wiki this file's season-page-first strategy exists
  // for (see findSeasonPageCharacters/findArcPageEpisodes): it organizes by
  // season PAGE rather than by a per-season CATEGORY, so without this guess
  // BOTH functions found nothing under any other guess here and fell all
  // the way through to the wiki-wide category + best-effort number-filter
  // fallback in the handler — a silent no-op on a wiki whose episode titles
  // don't encode a season number (e.g. "Dancing to the Max"), so it
  // silently handed back every episode from every season instead of just
  // the one that was actually requested. Tried right after the space-joined
  // year-qualified guess, for the same disambiguation-first reasoning as
  // the rest of this list.
  if (year) guesses.push(`${fandom} (${year}): ${arc}`);
  guesses.push(`${fandom} ${arc}`);
  guesses.push(`${fandom}: ${arc}`);
  // Same "/" subpage convention noted in buildEpisodeCategoryGuesses —
  // confirmed as the ACTUAL page title on Stranger Things Wiki:
  // "Stranger Things/Season 1", not "Stranger Things Season 1" (which
  // doesn't exist as a page there at all, so without this guess
  // findSeasonPageCharacters/findArcPageEpisodes never found that wiki's
  // season page and always fell through to a wiki-wide fallback).
  guesses.push(`${fandom}/${arc}`);
  guesses.push(arc);
  // Confirmed on Lookism's own Category:Story_Arcs: arc page titles are NOT
  // consistently bare — "Breakaway" and "Cult" sit right alongside
  // disambiguated titles like "Cheonliang Arc" and "James Lee (Arc)" (needed
  // because "James Lee" and "Daniel Park" are ALSO character page titles on
  // the same wiki). resolveArcTitleFromIndex normally sidesteps this by
  // reading the real page title straight off the guide's own wikilink TARGET
  // (see parseArcIndexWikitext) — but an entry with no link at all yet (a
  // recent, not-yet-wikified arc) falls back to plain display text, which
  // won't include a suffix it doesn't display. Trying both suffixed forms
  // here, after the bare guess, is a cheap fallback for exactly that case.
  guesses.push(`${arc} Arc`);
  guesses.push(`${arc} (Arc)`);
  return [...new Set(guesses.filter(Boolean))];
}

// Candidate page titles for a wiki-wide arc/season INDEX page — a single
// page listing every arc/season in order (the motivating example is
// Lookism's own "Arc Guide": https://lookism.fandom.com/wiki/Arc_Guide).
// This is a DIFFERENT thing from buildSeasonPageGuesses above: that guesses
// at ONE season's own page (e.g. "Season 6"); this guesses at the single
// page that lists ALL of them, for wikis where individual arcs/seasons
// aren't numbered at all — they just have real names ("Breakaway", not
// "Arc 2") — so no guess built from the literal "<Label> N" text could ever
// match anything on such a wiki. Only tried by resolveArcTitleFromIndex,
// which uses whichever of these hits to translate "Arc 2" into "Breakaway"
// before any of the OTHER guess-builders in this file ever run.
function buildArcIndexPageGuesses(fandom, year, arcLabel) {
  if (!arcLabel) return [];
  const cap = arcLabel.charAt(0).toUpperCase() + arcLabel.slice(1).toLowerCase();
  const guesses = [];
  if (year) guesses.push(`${fandom} (${year}) ${cap} Guide`);
  guesses.push(`${fandom} ${cap} Guide`);
  guesses.push(`${cap} Guide`);
  guesses.push(`List of ${cap}s`);
  guesses.push(`${cap}s`);
  return [...new Set(guesses.filter(Boolean))];
}

// Parses an arc/season INDEX page's raw wikitext (see buildArcIndexPageGuesses
// above) into an ordered array of resolved page titles — entries[0] is
// "arc 1", entries[1] is "arc 2", etc. — so resolveArcTitleFromIndex can pick
// out entry N by plain array index, the same way a human counting down a
// rendered numbered list would.
//
// Counts wikitext's OWN numbering: a run of consecutive top-level "# ..." OR
// "* ..." lines (MediaWiki's ordered- and unordered-list syntax respectively
// — whichever one renders as the page's actual list). Deliberately does NOT
// look for a number written inside the line's own text, because there
// usually isn't one (that's the whole problem this feature exists to solve)
// — the line's POSITION in the list is the only thing that reliably means
// "arc N". Nested/indented sub-bullets some wikis use for asides ("##",
// "#*", "*#", "**", "#:", "*:") are skipped so they can't throw off the
// count.
//
// FIX (2026-08): originally "#" only, on the assumption that an arc/season
// index page would be a numbered list. CONFIRMED WRONG on Lookism's own "Arc
// Guide" — https://lookism.fandom.com/wiki/Arc_Guide renders with no visible
// numbering at all (fetched and checked directly), which is what an
// unordered "*" list looks like, not an ordered "#" one. With "#" only, this
// function silently returned ZERO entries for the wiki this whole feature
// was built around: resolveArcTitleFromIndex would find the "Arc Guide"
// page, get nothing parseable from it, and fall through to "no index page
// found" — meaning "Arc 2" was NEVER actually resolved to "Breakaway", and
// every guess below it kept building from the literal, wiki-doesn't-use-that
// "Arc 2" text the whole time. Matching either marker fixes this without
// affecting wikis that genuinely do use "#" (Charmed's own season-numbering
// pattern, if such a wiki ever needed this path, keeps working identically).
// A page whose real arc list happens to sit right after an unrelated "*" or
// "#" list earlier on the same page (e.g. a stray bulleted note above the
// actual list) would still miscount — this is a flat scan of the whole
// page's top-level list lines, not a "first contiguous block only" parse —
// but that's a pre-existing limitation of the position-counting approach
// itself, not something this fix introduces.
//
// For each top-level line, prefers the wikilink's TARGET over its display
// text: on Lookism's own guide, an entry can display "Jay Hong" but actually
// link to the page "Jay Hong (Arc)" or similar — every OTHER guess-builder in
// this file needs that real page/category name, not the human-friendly label
// shown next to it. Falls back to the line's own plain text (with '' / '''
// bold-italic markup stripped) for an entry that has no link at all yet —
// e.g. a not-yet-written recent entry on Lookism's guide — since that's no
// less useful than refusing to resolve it at all.
function parseArcIndexWikitext(wikitext) {
  const entries = [];
  for (const rawLine of wikitext.split('\n')) {
    const m = rawLine.match(/^[#*](?![#*:])\s*(.*)$/);
    if (!m) continue;
    const line = m[1];
    const linkMatch = line.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    const title = (linkMatch ? linkMatch[1] : line.replace(/'{2,}/g, '')).trim();
    entries.push(title);
  }
  return entries;
}

function extractArcNumber(arc) {
  if (!arc) return null;
  const m = String(arc).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// FIX (2026-08): this used to keep every title whose encoded number was
// <= num ("up to" the requested arc) instead of === num (just the requested
// arc). That's a real bug, not a naming quirk: this is the fallback used
// when NO arc-scoped category exists (see the ARC SCOPING — EPISODES note
// in the file header) specifically to scope a wiki-wide episode list down
// to just the one season/arc that was asked for. With <=, requesting
// "Season 2" silently included Season 1's episodes too (and "Season 5"
// included 1-5) — on any wiki without a clean per-season episode category,
// e.g. Stranger Things and Saved by the Bell. Titles with NO detectable
// number still pass through (`if (!m) return true`) since those can't be
// judged one way or the other and dropping them would just as silently
// under-scope the corpus instead.
function filterTitlesToArc(titles, arc) {
  const num = extractArcNumber(arc);
  if (num == null) return titles;
  return titles.filter((title) => {
    const m = title.match(/(?:season|s|arc|part|book|volume)\s*0*(\d+)/i);
    if (!m) return true;
    return parseInt(m[1], 10) === num;
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

// Same idea as fetchSectionLinks, but for the whole page instead of one
// section — used by findSeasonPageCharacters as a broader fallback when a
// season page exists but doesn't have a Cast/Characters-shaped section
// findSectionIndex can identify (see SEASON_CHARACTER_SECTION_NAMES). Some
// wikis put a season's starring cast in the page's infobox instead of a
// prose section, or as a bare paragraph/table under a heading not in that
// list. Note this reads links from the PARSED (rendered) page, same as
// fetchSectionLinks — so, unlike the wikitext-based fetchFullPageWikitext
// used for episode plots, it correctly picks up infobox-embedded links
// (which live inside a {{...}} template call and would otherwise get
// stripped by cleanWikitext's template-removal pass), at the cost of also
// picking up footer nav-template links (e.g. "other seasons") that
// looksLikeNonCharacterTitle has to filter back out.
async function fetchAllPageLinks(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=links&redirects=1&format=json`;
  const data = await apiRequest(url);
  const links = (data && data.parse && data.parse.links) || [];
  return links
    .filter((l) => l.ns === 0)
    .map((l) => (typeof l['*'] === 'string' ? l['*'] : l.title))
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
//
// Also used (more heavily) by findSeasonPageCharacters' whole-page fallback
// tier below, where there's no section boundary doing any filtering for us —
// every internal link the page has, including footer nav templates ("other
// seasons", "other arcs"/"volumes" for franchises that use that word instead)
// and misc wiki-housekeeping pages, comes through. The extra patterns here
// (volume/book/arc/chapter/issue/part + number, and common non-character
// page types) target exactly that noise. Still allow-list by exclusion
// rather than inclusion — a real character named e.g. "Book" or "Part" is
// vanishingly unlikely, whereas trying to positively identify "this looks
// like a person's name" is far more error-prone across different fandoms.
function looksLikeNonCharacterTitle(title, seasonPageTitle) {
  if (title === seasonPageTitle) return true;
  return /^(list of|category:|season\s*\d|episode\s*\d|volume\s*\d|book\s*\d|arc\s*\d|chapter\s*\d|issue\s*\d|part\s*\d|main page|timeline|soundtrack|gallery|transcript|script|merchandise|novelization|dvd|home video|blu-ray|trivia)/i.test(title);
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

    // Tier 1 (precise): a Cast/Characters-shaped section, if this page has
    // one. Preferred whenever it's there, since it's scoped by the page's
    // own structure rather than by our noise filter.
    if (sections.length) {
      const idx = findSectionIndex(sections, SEASON_CHARACTER_SECTION_NAMES);
      if (idx != null) {
        try {
          const links = await fetchSectionLinks(subdomain, pageTitle, idx);
          const titles = [...new Set(links)].filter((t) => !looksLikeNonCharacterTitle(t, pageTitle));
          if (titles.length) return { pageTitle, titles, tier: 'section' };
        } catch (err) {
          warnings.push(`Found season page "${pageTitle}" with a Cast/Characters section, but couldn't read its links: ${err.message}`);
        }
      }
    }

    // Tier 2 (broad fallback): the page exists but tier 1 found nothing —
    // either no Cast/Characters-shaped heading at all (cast might be in the
    // infobox, or under a heading not in SEASON_CHARACTER_SECTION_NAMES), or
    // that section existed but its links didn't survive the noise filter.
    // Rather than give up on a page we know exists, grab every internal link
    // on it and filter out the obvious non-cast noise (see the widened
    // looksLikeNonCharacterTitle). This is what actually satisfies "grab the
    // characters from the links on the page" for wikis that don't structure
    // their season page the way tier 1 expects — it's noisier, but still a
    // real read of THIS season's page, not the wiki-wide fallback below.
    try {
      const allLinks = await fetchAllPageLinks(subdomain, pageTitle);
      const titles = [...new Set(allLinks)].filter((t) => !looksLikeNonCharacterTitle(t, pageTitle));
      if (titles.length) {
        warnings.push(`Season page "${pageTitle}" had no usable Cast/Characters section — used every link on the page instead (filtered for obvious non-character titles), so double-check the result for stragglers.`);
        return { pageTitle, titles, tier: 'whole-page' };
      }
    } catch (err) {
      warnings.push(`Found season page "${pageTitle}" but couldn't read its links: ${err.message}`);
    }
    // Neither tier produced anything usable for this page guess — try the
    // next guess (e.g. bare "Season 5" after "<Fandom> Season 5" came up
    // empty), and only fall through to wiki-wide category guessing once
    // every guess has been exhausted (see the handler).
  }
  return { pageTitle: null, titles: [], tier: null };
}

// Section names tried on an ARC/SEASON's own page (same page guesses as
// findSeasonPageCharacters — see buildSeasonPageGuesses) to find ITS OWN
// episode/chapter list — the episode-side counterpart to
// SEASON_CHARACTER_SECTION_NAMES. "Synopsis" first because it's the
// confirmed heading on wikis that give a whole arc ONE page instead of ever
// filing its episodes/chapters under a matching per-arc CATEGORY — Lookism is
// the motivating example: e.g. https://lookism.fandom.com/wiki/Cheonliang_Arc
// has a "3 Synopsis" section with one numbered sub-heading per chapter
// ("3.1 Episode 482", "3.2 Episode 483", ...) followed by an "In
// alphabetical order:" list linking each chapter's own page. On a wiki like
// that, buildEpisodeCategoryGuesses can never find anything arc-scoped,
// because no such category exists there AT ALL — only this per-arc page does.
const SEASON_EPISODE_SECTION_NAMES = ['Synopsis', 'Episodes', 'Chapters', 'Episode List', 'Chapter List', 'Plot'];

// Is `title` SHAPED like an episode/chapter page for this media type — e.g.
// "Episode 482", "Chapter 12"? Used as an ALLOW-list by findArcPageEpisodes
// below — the opposite bias from looksLikeNonCharacterTitle, which EXCLUDES
// this exact shape (that function filters stray episode links OUT of a
// character list; here we're reading an arc page specifically to find its
// episode links, so everything else on the page — character names, location
// names, the arc's own self-link — is the noise to drop instead). This only
// works on wikis whose episode/chapter titles actually encode a number in
// the page title itself (confirmed on Lookism: chapter pages are literally
// titled "Episode 482"); it correctly finds nothing on a wiki like Charmed or
// Stranger Things whose episode pages carry a proper name instead — that's
// fine, since findArcPageEpisodes only ever runs as a fallback on top of
// whatever buildEpisodeCategoryGuesses' category-based discovery already
// found for those wikis (see the handler).
function looksLikeEpisodeTitle(title, media) {
  const synonyms = MEDIA_EPISODE_SYNONYMS[media] || MEDIA_EPISODE_SYNONYMS.show;
  const words = [...new Set([...synonyms.map((s) => s.replace(/s$/i, '')), 'episode', 'chapter', 'issue', 'part', 'ep'])];
  const pattern = new RegExp(`^(?:${words.join('|')})\\.?\\s*0*\\d+`, 'i');
  return pattern.test(title);
}

// SECONDARY episode-discovery strategy, tried when episode-CATEGORY
// discovery (buildEpisodeCategoryGuesses) found no ARC-SCOPED category —
// mirrors findSeasonPageCharacters' role for characters, for the same
// reason: a wiki can give an arc/season its own page with a real episode
// listing on it without ALSO filing those same episodes under a matching
// per-arc CATEGORY. Unlike characters, this is NOT the PRIMARY episode
// strategy — most single-show wikis DO have a working per-season episode
// category (see the file header's ARC SCOPING — EPISODES note), and
// filterTitlesToArc's number filter is a reasonable best-effort on top of
// that when they don't. This exists specifically for wikis where NEITHER a
// category NOR a number-in-title filter can locate the arc's episodes —
// Lookism is the motivating example: its chapter page numbers (e.g. 482-501
// for the Cheonliang arc) are the chapter's absolute position in the WHOLE
// series, with no relationship to the arc's own index number, so no
// number-based filter could ever get this right even in principle.
async function findArcPageEpisodes(subdomain, pageGuesses, media, warnings) {
  for (const pageTitle of pageGuesses) {
    let sections;
    try {
      sections = await fetchPageSections(subdomain, pageTitle);
    } catch (err) {
      continue; // no page by this exact title on the wiki — try the next guess
    }

    if (sections.length) {
      const idx = findSectionIndex(sections, SEASON_EPISODE_SECTION_NAMES);
      if (idx != null) {
        try {
          const links = await fetchSectionLinks(subdomain, pageTitle, idx);
          const titles = [...new Set(links)].filter((t) => t !== pageTitle && looksLikeEpisodeTitle(t, media));
          if (titles.length) return { pageTitle, titles, tier: 'section' };
        } catch (err) {
          warnings.push(`Found arc page "${pageTitle}" with a Synopsis/Episodes-shaped section, but couldn't read its links: ${err.message}`);
        }
      }
    }

    // Broad fallback: the page exists but no section above yielded any
    // episode-shaped links — grab every internal link on the page and keep
    // only the ones shaped like an episode/chapter title. In practice this
    // rarely differs from the section tier, since looksLikeEpisodeTitle's
    // allow-list means it can only ever pick up things that actually look
    // like "Episode N"/"Chapter N" regardless of where on the page they sit.
    try {
      const allLinks = await fetchAllPageLinks(subdomain, pageTitle);
      const titles = [...new Set(allLinks)].filter((t) => t !== pageTitle && looksLikeEpisodeTitle(t, media));
      if (titles.length) {
        warnings.push(`Arc page "${pageTitle}" had no usable Synopsis/Episodes section — used every episode-shaped link on the page instead.`);
        return { pageTitle, titles, tier: 'whole-page' };
      }
    } catch (err) {
      warnings.push(`Found arc page "${pageTitle}" but couldn't read its links: ${err.message}`);
    }
  }
  return { pageTitle: null, titles: [], tier: null };
}

// Batched category lookup for a list of exact page titles — used by
// filterOutRealWorldPages below. MediaWiki's prop=categories accepts
// multiple pipe-separated titles in ONE request, so checking N candidate
// titles costs ceil(N/CATEGORY_CHECK_BATCH) requests total, not one per
// title — and this runs once at character-DISCOVERY time, not inside the
// per-page BATCH_SIZE fetch loop, so it doesn't compete with that budget.
// clshow=!hidden excludes hidden maintenance/tracking categories (added
// automatically by templates, not meaningful editorial categorization) so
// only categories an editor actually chose to file the page under come
// back.
async function fetchCategoriesForTitles(subdomain, titles) {
  const byTitle = {};
  for (let i = 0; i < titles.length; i += CATEGORY_CHECK_BATCH) {
    const chunk = titles.slice(i, i + CATEGORY_CHECK_BATCH);
    const url = `https://${subdomain}.fandom.com/api.php?action=query&prop=categories&clshow=!hidden&cllimit=max&redirects=1&titles=${encodeURIComponent(chunk.join('|'))}&format=json`;
    const data = await apiRequest(url);
    const query = (data && data.query) || {};
    const pages = query.pages || {};

    // A requested title can come back filed under a DIFFERENT title than
    // what was asked for, in two ways that can both apply to the same title
    // in sequence: `normalized` (case/underscore normalization — e.g.
    // Fandom always capitalizes the first letter) and `redirects` (the
    // title is itself a redirect to a different page entirely). Map each
    // requested title in `chunk` to whichever title its category data
    // actually landed under, so results below aren't silently dropped just
    // because the title round-tripped differently than it went in.
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

// Drops candidate character titles that are actually real-world cast/crew
// pages (an actor's own bio page, most commonly) by checking each page's
// OWN Fandom categories, rather than guessing from the shape of its title
// the way looksLikeNonCharacterTitle does. This is what catches the case
// that function's own comment flags as unfixable at that layer: "Holly
// Marie Combs" is shaped exactly like a character's name, so no title-shape
// check can rule her out — but her actual page IS filed under
// "Category:Performers" on charmed.fandom.com (confirmed), which this CAN
// see and looksLikeNonCharacterTitle can't.
//
// Titles that come back with NO categories at all (nonexistent page, a wiki
// that doesn't tag consistently, or the categories lookup itself failing)
// are passed through unchanged — this only ever REMOVES a title it can
// positively identify as real-world via a known pattern; it never requires
// positive proof that a title IS a character, the same allow-by-exclusion
// philosophy as looksLikeNonCharacterTitle.
async function filterOutRealWorldPages(subdomain, titles, warnings) {
  if (!titles.length) return titles;
  let byTitle;
  try {
    byTitle = await fetchCategoriesForTitles(subdomain, titles);
  } catch (err) {
    warnings.push(`Couldn't check page categories to filter actor/crew pages out of the character list: ${err.message} — the character list below may include some.`);
    return titles;
  }
  const dropped = [];
  const kept = titles.filter((title) => {
    const cats = byTitle[title];
    const isRealWorld = !!cats && cats.some((c) => NON_CHARACTER_CATEGORY_PATTERN.test(c));
    if (isRealWorld) dropped.push(title);
    return !isRealWorld;
  });
  if (dropped.length) {
    warnings.push(`${dropped.length} link(s) removed from the character list because their own page is categorized as real-world cast/crew, not an in-universe character: ${dropped.join(', ')}`);
  }
  return kept;
}

async function fetchIntroExtract(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const data = await apiRequest(url);
  const pages = data && data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  return page && page.extract ? cleanExtract(page.extract) : '';
}

// Raw (uncleaned) wikitext fetch. Used by fetchFullPageWikitext below (which
// cleans it for plot/bio text) and by resolveArcTitleFromIndex (which needs
// the raw [[Target|Display]] markup intact — cleanWikitext's link-flattening
// pass throws away the Target half, keeping only the human-readable Display
// half, which is exactly the half resolveArcTitleFromIndex can't use; see
// parseArcIndexWikitext's own comment).
async function fetchRawWikitext(subdomain, title) {
  const url = `https://${subdomain}.fandom.com/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&redirects=1&format=json`;
  const data = await apiRequest(url);
  const field = data && data.parse && data.parse.wikitext;
  return (typeof field === 'string' ? field : field && field['*']) || '';
}

async function fetchFullPageWikitext(subdomain, title) {
  const wikitext = await fetchRawWikitext(subdomain, title);
  return wikitext ? cleanWikitext(wikitext) : '';
}

// Resolves a bare "<Label> N" arc (e.g. "Arc 2") against a wiki-wide index
// page (see buildArcIndexPageGuesses/parseArcIndexWikitext above) to
// whatever that wiki actually calls entry N — e.g. "Breakaway" on Lookism's
// "Arc Guide". Returns { resolvedTitle, indexPage } on a hit, or null if no
// index page was found (or `arc` isn't a numbered "<Label> N" to begin
// with — nothing to resolve). Called ONCE per request, before any of the
// episode/character/season-page guess-building below, so a successful
// resolution here is what lets THOSE go looking for "Breakaway" instead of
// the literal, wiki-doesn't-actually-use-that "Arc 2".
//
// CACHING: the final resolution (hit OR miss) is cached under one synthetic
// lore_categories row per (wiki, label, number) — piggybacking on the
// existing category-members cache table (its `members` column is a plain
// jsonb array, so `[resolvedTitle, indexPage]` fits it fine) rather than
// adding a new table. This matters specifically because most wikis have NO
// arc index page at all: without caching, a multi-batch arc load would
// re-attempt every page guess in buildArcIndexPageGuesses (each a real,
// uncached Fandom 404) on EVERY batch call for the same arc, up to
// MAX_LORE_BATCHES times client-side — exactly the repeated-Fandom-call cost
// the lore_categories cache exists to avoid elsewhere in this file. Category
// name is prefixed distinctly ("Arc Index Resolution: ...") so it's obvious
// in the table that it isn't a real Fandom category.
//
// Failures here (Supabase cache read/write, or a Fandom fetch that errors
// for a reason OTHER than "no such page") are swallowed rather than thrown —
// same resilience pattern as findFirstNonEmptyCategory below: worst case,
// resolution just doesn't happen this round and guess-building falls back to
// the literal "<Label> N" text, exactly as it did before this feature
// existed. This is one arc-scoping guess among several, not something worth
// failing the whole request over.
async function resolveArcTitleFromIndex(subdomain, wikiId, fandom, year, arc, freshnessMs, warnings) {
  const num = extractArcNumber(arc);
  const label = arc ? String(arc).trim().split(/\s+/)[0] : null;
  if (num == null || !label) return null;

  const resolutionCacheKey = `Arc Index Resolution: ${label} ${num}`;
  try {
    const cached = await getCachedCategoryMembers(wikiId, resolutionCacheKey, freshnessMs);
    if (cached !== null) {
      if (!cached.length) return null; // cached "nothing resolved" — no index page, or entry out of range
      const [resolvedTitle, indexPage] = cached;
      warnings.push(`Resolved "${arc}" to "${resolvedTitle}" via the arc index page "${indexPage}" (entry #${num}) [cached].`);
      return { resolvedTitle, indexPage };
    }
  } catch (err) {
    warnings.push(`Arc index resolution cache lookup failed, trying Fandom directly: ${err.message}`);
  }

  const pageGuesses = buildArcIndexPageGuesses(fandom, year, label);
  for (const pageTitle of pageGuesses) {
    let wikitext;
    try {
      wikitext = await fetchRawWikitext(subdomain, pageTitle);
    } catch (err) {
      continue; // no page by this exact title on the wiki — try the next guess
    }
    const entries = parseArcIndexWikitext(wikitext);
    if (!entries.length) {
      // The page itself was found (fetchRawWikitext didn't throw), but no
      // top-level "#"/"*" list line was parseable from it — worth a warning
      // distinct from "no such page," since this is the specific failure
      // mode a wiki with, say, a template-generated list (no literal
      // wikitext list markup at all) would hit even after the marker fix
      // above. Without this, that case looked identical to "no index page
      // exists" from the outside, which made it hard to tell the two apart
      // from window.LoreFetchLastWarnings alone.
      warnings.push(`Found arc/season index page "${pageTitle}" but couldn't parse any top-level list entries from its wikitext (checked for "#" and "*" list lines) — trying the next guess.`);
      continue; // try the next guess
    }

    const resolvedTitle = entries[num - 1];
    if (!resolvedTitle) {
      warnings.push(`Found arc index page "${pageTitle}", but it only lists ${entries.length} entries — "${arc}" (entry #${num}) is out of range.`);
      try {
        await cacheCategoryMembers(wikiId, resolutionCacheKey, []);
      } catch (err) {
        // not fatal — worst case this same out-of-range guess repeats next call
      }
      return null;
    }
    warnings.push(
      `Resolved "${arc}" to "${resolvedTitle}" via the arc index page "${pageTitle}" (entry #${num}) — using "${resolvedTitle}" for episode/character/season-page scoping below instead of the literal "${arc}".`
    );
    try {
      await cacheCategoryMembers(wikiId, resolutionCacheKey, [resolvedTitle, pageTitle]);
    } catch (err) {
      // not fatal — worst case this same lookup repeats next call
    }
    return { resolvedTitle, indexPage: pageTitle };
  }

  try {
    await cacheCategoryMembers(wikiId, resolutionCacheKey, []); // no index page found under any guess — cache the miss too
  } catch (err) {
    // not fatal
  }
  return null;
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
    let text = '';

    // Subpage tier (e.g. "<title>/Relationships") — only checked for keys
    // listed in CHARACTER_SUBPAGE_SUFFIXES. fetchFullPageWikitext returns ''
    // (not a throw) for a subpage that doesn't exist, same as the episode
    // "/Plot" and "/Synopsis" subpage check in fetchEpisodePlot, so this loop
    // just falls through to the next suffix, then to the same-page tier
    // below, with no special-casing needed for the "no such page" case.
    const subpageSuffixes = CHARACTER_SUBPAGE_SUFFIXES[key];
    if (subpageSuffixes) {
      for (const suffix of subpageSuffixes) {
        try {
          text = await fetchFullPageWikitext(subdomain, `${title}/${suffix}`);
        } catch (err) {
          text = '';
        }
        if (text) break;
      }
    }

    // Same-page heading tier — tried when no subpage suffix is configured for
    // this key, or every configured suffix came back empty.
    if (!text) {
      const idx = findSectionIndex(sections, candidates);
      if (idx != null) text = await fetchSectionWikitext(subdomain, title, idx);
    }

    if (!text) continue;
    result[key] = key === 'trivia' ? linesToBullets(text) : paragraphsToBullets(text);
  }
  if (!characterHasContent(result)) {
    warnings.push(`"${title}": none of ${Object.keys(CHARACTER_SECTION_GROUPS).join('/')} were found on this page.`);
  }
  return result;
}

// Shared "does this character row/result actually have anything in it" check
// — used here, in the dryRun status classifier, and in the final corpus
// assembly. Centralized so adding a new CHARACTER_SECTION_GROUPS key (like
// 'personality') doesn't require updating a hardcoded field list in three
// separate places.
function characterHasContent(row) {
  return !!(row && Object.keys(CHARACTER_SECTION_GROUPS).some((key) => row[key] && row[key].length));
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

// Character upserts MERGE with whatever's already cached, field by field,
// instead of overwriting the whole row every time. Previously, a fetch that
// came back empty for a given field — because a heading got removed/renamed
// on the wiki, a subpage briefly failed to load, or the fetch attempt threw
// and fell into the handler's "cache an empty placeholder" catch block —
// would blank that field out immediately, permanently, with the old good
// content gone the moment the new (empty) upsert landed. That's exactly what
// a force-refresh after editing wiki headings would do, with no way back.
// Now: a field only gets replaced when the fresh fetch actually found
// content for it; an empty fetch result just leaves the existing cached
// value alone. Costs one extra read per character per upsert — negligible
// next to the Fandom fetch + REQUEST_DELAY_MS delay already happening around
// each one. Loops over CHARACTER_SECTION_GROUPS's keys rather than a
// hardcoded field list, same reasoning as characterHasContent above.
//
// Trade-off worth knowing: this means a force-refresh can no longer be used
// to deliberately CLEAR a field just by removing its heading from the wiki —
// the old value will keep winning forever until something writes over it. If
// that's ever actually wanted, clear the field directly in Supabase (e.g.
// `update lore_characters set powers = '[]'::jsonb where ...`) rather than
// relying on a re-fetch to do it.
async function upsertCharacter(wikiId, title, bullets) {
  const { data: existing, error: lookupError } = await supabase
    .from('lore_characters')
    .select('*')
    .eq('wiki_id', wikiId)
    .eq('title', title)
    .maybeSingle();
  if (lookupError) throw new Error(`Supabase character lookup (pre-upsert) failed: ${lookupError.message}`);

  const merged = { wiki_id: wikiId, title, fetched_at: new Date().toISOString() };
  for (const key of Object.keys(CHARACTER_SECTION_GROUPS)) {
    const fresh = bullets[key];
    if (fresh && fresh.length) {
      merged[key] = fresh; // this fetch found content — it wins
    } else if (existing && existing[key] && existing[key].length) {
      merged[key] = existing[key]; // fetch came back empty — keep what was already cached
    } else {
      merged[key] = []; // neither had anything — genuinely empty
    }
  }

  const { error } = await supabase.from('lore_characters').upsert(merged, { onConflict: 'wiki_id,title' });
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

    // ARC INDEX RESOLUTION: some wikis title their arcs/seasons/volumes with
    // real names instead of numbers (Lookism's "Breakaway" rather than
    // "Arc 2" — see resolveArcTitleFromIndex's own comment for the full
    // explanation and https://lookism.fandom.com/wiki/Arc_Guide for the
    // motivating example). For those wikis, every "<Label> N"-shaped guess
    // below (episode category, character category, season page) is built
    // from the literal `arc` text and can never match anything — which is
    // exactly what silently degrades those guesses into their wiki-wide,
    // unscoped fallback (e.g. episodeCategoryResult landing on a generic
    // "Chapters" category containing the WHOLE series instead of just this
    // arc). Resolving `arc` against the wiki's own index page FIRST, when
    // one exists, and using the resolved title for guess-building instead
    // fixes that at the source.
    //
    // `resolvedArc` is what every guess-builder below uses. The original
    // `arc` is deliberately still used for: filterTitlesToArc (the
    // NUMBER-based episode fallback, which needs an actual digit —
    // "Breakaway" has none), and everything echoed back to the caller (the
    // response's own `arc` field, `arcResolvedTitle` for debugging) so a
    // client can always see both what was asked for and what it resolved to.
    let resolvedArc = arc || null;
    let arcIndexPage = null;
    if (arc) {
      const arcResolution = await resolveArcTitleFromIndex(wiki.subdomain, wikiRow.id, fandom, year, arc, freshnessMs, warnings);
      if (arcResolution) {
        resolvedArc = arcResolution.resolvedTitle;
        arcIndexPage = arcResolution.indexPage;
      }
    }

    // Computed once, up front, since both episode and character discovery
    // below can each independently need to read the arc/season's own page
    // (findArcPageEpisodes / findSeasonPageCharacters) instead of guessing at
    // a separate CATEGORY — see each function's own comment for why.
    const seasonPageGuesses = buildSeasonPageGuesses(fandom, year, resolvedArc);

    const episodeCategoryGuesses = buildEpisodeCategoryGuesses(fandom, media, year, resolvedArc);
    const episodeCategoryResult = await findFirstNonEmptyCategory(wiki.subdomain, wikiRow.id, episodeCategoryGuesses, 500, freshnessMs);
    let episodeTitles = [];
    let episodeCategoryArcScoped = false;
    let episodeCategoryLabel = null;
    let episodeSource = 'none';
    if (episodeCategoryResult.found && episodeCategoryResult.found.arcScoped) {
      // A real arc-scoped CATEGORY exists — trust it as-is, no further
      // scoping needed.
      episodeCategoryArcScoped = true;
      episodeTitles = episodeCategoryResult.found.members;
      episodeCategoryLabel = episodeCategoryResult.found.name;
      episodeSource = 'category';
    } else if (arc) {
      // No arc-scoped episode CATEGORY was found (either no category at all,
      // or only a wiki-wide, unscoped one). Before falling back to a
      // best-effort NUMBER filter on that wiki-wide list — which is a silent
      // no-op on any wiki whose episode/chapter titles don't literally
      // encode a season/arc number, see filterTitlesToArc's own comment —
      // try reading the episode list directly off the arc's own page
      // instead. Lookism is the motivating example: it has no per-arc
      // episode category at all, but each arc's own page (e.g. "Breakaway",
      // "Cheonliang Arc") lists exactly its own chapters. See
      // findArcPageEpisodes' own comment for the full reasoning.
      const arcPageResult = await findArcPageEpisodes(wiki.subdomain, seasonPageGuesses, media, warnings);
      if (arcPageResult.titles.length) {
        episodeTitles = arcPageResult.titles;
        episodeCategoryArcScoped = true;
        episodeCategoryLabel = `Arc page: "${arcPageResult.pageTitle}"${arcPageResult.tier === 'whole-page' ? ' (whole-page links)' : ' (Synopsis/Episodes section)'}`;
        episodeSource = arcPageResult.tier === 'whole-page' ? 'arc-page-whole' : 'arc-page-section';
      } else if (episodeCategoryResult.found) {
        // Fall back to the wiki-wide category + best-effort number filter,
        // same as before this fix.
        episodeCategoryLabel = episodeCategoryResult.found.name;
        episodeSource = 'category';
        const beforeCount = episodeCategoryResult.found.members.length;
        episodeTitles = filterTitlesToArc(episodeCategoryResult.found.members, arc);
        warnings.push(
          `No category or arc page specific to "${resolvedArc}"${resolvedArc !== arc ? ` (resolved from "${arc}")` : ''} — filtered "${arc}" by number instead (best-effort).`
        );
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
      } else if (episodeCategoryResult.attempts.length) {
        warnings.push(`Couldn't check episode/chapter categories: ${episodeCategoryResult.attempts.join(' | ')}`);
      } else {
        warnings.push('No episode/chapter category found on this wiki, and no usable arc page either.');
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
      const seasonResult = await findSeasonPageCharacters(wiki.subdomain, seasonPageGuesses, warnings);
      if (seasonResult.titles.length) {
        characterTitles = seasonResult.titles;
        characterCategoryArcScoped = true;
        characterCategoryLabel = `Season page: "${seasonResult.pageTitle}"${seasonResult.tier === 'whole-page' ? ' (whole-page links)' : ' (Cast/Characters section)'}`;
        characterSource = seasonResult.tier === 'whole-page' ? 'season-page-whole' : 'season-page-section';
      } else {
        warnings.push(
          `No usable season page was found for "${resolvedArc}"${resolvedArc !== arc ? ` (resolved from "${arc}")` : ''} (tried: ${seasonPageGuesses.join(', ') || '(no guesses — no arc)'}) — falling back to character-category discovery.`
        );
      }
    }

    let characterCategoryResult = { found: null, attempts: [] };
    if (!characterTitles.length) {
      const characterCategoryGuesses = buildCharacterCategoryGuesses(fandom, year, resolvedArc);
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

    // Backstop 1: cross-check against episodeTitles (already fully resolved
    // above, including extraEpisodes — zero extra API cost, just a Set
    // lookup). A title can never legitimately be both an episode AND a
    // character, so any overlap here is an episode page that leaked into
    // the character list — see the NON-CHARACTER PAGE FILTERING note in
    // this file's header for how that happens on a wiki like Charmed's.
    // Catches the leak regardless of which discovery path (season-page
    // section, season-page whole-page, or category) produced it.
    if (characterTitles.length && episodeTitles.length) {
      const episodeTitleSet = new Set(episodeTitles);
      const before = characterTitles.length;
      characterTitles = characterTitles.filter((t) => !episodeTitleSet.has(t));
      if (characterTitles.length !== before) {
        warnings.push(
          `${before - characterTitles.length} title(s) removed from the character list because they're also in this call's episode list — they're episode pages, not character pages.`
        );
      }
    }
    // Backstop 2: filterOutRealWorldPages — drops actor/crew bio pages by
    // checking each remaining title's own Fandom categories (see that
    // function's comment). This makes its own Fandom API calls, so it's
    // skipped under dryRun, which promises not to touch individual pages
    // beyond the episode/character CATEGORY listing (see dryRun below) —
    // the real fetch/cache path a few lines down always runs it before
    // anything gets upserted into lore_characters, which is what actually
    // matters for keeping the table clean.
    if (characterTitles.length && !dryRun) {
      characterTitles = await filterOutRealWorldPages(wiki.subdomain, characterTitles, warnings);
    }
    // Both backstops run BEFORE extraCharacters is merged in below:
    // extraCharacters is a manual, exact-title override meant to bypass
    // discovery entirely (see that param's doc comment at the top of this
    // file), so neither check should second-guess a title the caller listed
    // explicitly.
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
        return { title, status: classify(row, characterHasContent(row)), fetchedAt: row ? row.fetched_at : null };
      });
      return res.status(200).json({
        dryRun: true,
        wiki,
        arc: arc || null,
        arcResolvedTitle: resolvedArc !== arc ? resolvedArc : null,
        arcIndexPage,
        wikiId: wikiRow.id,
        episodesRequested: episodeTitles.length,
        episodeCategory: episodeCategoryLabel,
        episodeCategoryArcScoped,
        episodeSource,
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
            await upsertEpisode(wikiRow.id, item.title, resolvedArc, plot);
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
              await upsertEpisode(wikiRow.id, item.title, resolvedArc, '');
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
        arc: arc || null,
        arcResolvedTitle: resolvedArc !== arc ? resolvedArc : null,
        arcIndexPage,
        episodesRequested: episodeTitles.length,
        episodeCategory: episodeCategoryLabel,
        episodeCategoryArcScoped,
        episodeSource,
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
    // front) will fetch successfully but come back with none of Personality/
    // History/Powers/Trivia, exactly like a genuinely-failed fetch
    // does. Dropping it here means a stray non-character link never
    // silently rides along in the corpus as a nameplate with no content.
    const emptyBulletTitles = [];
    const characters = [];
    for (const title of characterTitles) {
      const row = cachedCharacters[title];
      if (characterHasContent(row)) {
        characters.push({
          name: title,
          personality: row.personality || [],
          history: row.history || [],
          powers: row.powers || [],
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
      arcResolvedTitle: resolvedArc !== arc ? resolvedArc : null,
      arcIndexPage,
      episodes,
      characters,
      // Lets the client tell "this arc genuinely has this many episodes and
      // we got them all" apart from "we never found an episode category, so
      // there was nothing to fetch and done:true was trivially true." Same
      // shape as the done:false progress fields above, on purpose.
      episodesRequested: episodeTitles.length,
      episodeCategory: episodeCategoryLabel,
      episodeCategoryArcScoped,
      episodeSource,
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
