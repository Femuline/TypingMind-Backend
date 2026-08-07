/**
 * typingmind-extension.js
 * ---------------------------------------------------------------
 * Install this as a TypingMind extension (Preferences → Extensions →
 * add script URL, per https://docs.typingmind.com/typingmind-extensions).
 * Host this file wherever, as long as it's served over HTTPS with a
 * JS mime type.
 *
 * What it does:
 *   1. Watches the URL hash (#chat=...) to detect when you open/switch
 *      to a chat.
 *   2. Reads that chat's linked agent and its `instruction` text from
 *      TypingMind's IndexedDB (database "keyval-store", store "keyval").
 *   3. Parses out {arcs, year, media, fandom} from instructions shaped
 *      like: "Portray canon characters in season 5 of the 1998 show
 *      Charmed." `arcs` is always an array — MULTIPLE arcs can be named in
 *      one instruction, either as a number list in the arc clause itself
 *      ("Portray canon characters in arcs 1, 2, 3, 5 and 7 of the Webtoon
 *      Lookism.", "arcs 1-5, 7-8" also works) or by repeating the whole
 *      sentence once per arc ("Portray canon characters in arc 1 of the
 *      Webtoon Lookism. Portray canon characters in arc 2 of the Webtoon
 *      Lookism. ...") — see parseSystemPrompt for why the latter needed a
 *      fix to actually work (it used to silently only read the first
 *      sentence). Also scans those same instructions for any number of
 *      standalone "Also fetch the character <Name>." / "Also fetch the
 *      episode <Title>." sentences, for pages that lore.js's automatic
 *      category discovery might not find on its own (see extraCharacters/
 *      extraEpisodes in lore.js's own header comment for why that gap
 *      exists).
 *   4. Calls YOUR OWN lore API (see LORE_API_BASE below — a Vercel
 *      function backed by Supabase, api/lore.js in this same delivery)
 *      to get the full episode Plot text + character personality/
 *      history/powers/trivia bullets for that fandom+arc. lore.js itself
 *      only ever scopes one call to a single arc (see its own file
 *      header), so when `arcs` has more than one entry,
 *      fetchLoreCorpusForArcs calls it once per arc, sequentially, and
 *      merges the results into one corpus — expect roughly N times the
 *      wait for N arcs, since each arc's episodes/characters are fetched
 *      from Fandom as if from scratch. The API does the actual Fandom
 *      fetching and permanent storage; this script never talks to Fandom
 *      directly anymore.
 *   5. Continuously rescans the chat's own messages for character/
 *      episode mentions, and writes matching lore into that chat's
 *      chatParams.systemMessage — so the bot gets the canon it needs
 *      as the conversation moves, not everything at once. Matches are
 *      split into two tiers (see classifyMatches): anyone matched in
 *      the last ACTIVE_SCAN_MESSAGES messages gets a full profile;
 *      anyone matched only further back (within the wider
 *      CHAT_TEXT_SCAN_MESSAGES window) — i.e. mentioned in passing,
 *      not currently active — gets a single-line stub instead. This is
 *      a recency heuristic, not real scene tracking: it can't tell
 *      "present in the scene" from "name-dropped in the latest
 *      message," but it fixes stale mentions from many turns back
 *      staying tagged as full matches. Only PERSONALITY and HISTORY are
 *      still capped — MAX_BULLETS_PER_CATEGORY bullets, each truncated to
 *      MAX_BULLET_CHARS — applied once, when the corpus is indexed
 *      (buildEntityIndex), so it bounds what the extension keeps for EVERY
 *      character, not just the ones that end up matching a chat. POWERS,
 *      TRIVIA, and EPISODE PLOT TEXT ARE ALL DELIBERATELY UNCAPPED — full
 *      bullets/text, every time, matching classifyMatches's "active" tier
 *      in full. There is also no ceiling on the injected block's overall
 *      size — nothing is ever dropped to save space. This means a chat
 *      that matches several characters/episodes at once can push a large
 *      block into chatParams.systemMessage; that trade-off is intentional
 *      here.
 *
 * DEBUGGING:
 * After any fetch (successful or not), the exact text that was/would be
 * injected is on `window.LoreFetchLastContext`, and that run's warnings
 * on `window.LoreFetchLastWarnings` — check these directly rather than
 * hunting through console output.
 * Run `window.LoreFetchDebug = true` in the console for a step-by-step
 * trace (persists across reloads).
 * Run `window.LoreFetchInspectMessages(chatId)` to print the raw chat
 * record — use this if entity matching never seems to fire, since the
 * chat-message field this script reads (see extractMessageText below) is
 * a best-effort guess, not confirmed against TypingMind's storage the way
 * the agent-record shape below was.
 * Run `window.LoreFetchRefresh()` to force a full re-check of the CURRENT
 * chat's lore that bypasses lore.js's 14-day Supabase cache (forceRefresh).
 * Use this if the badge is green/amber but you suspect a wrong or empty
 * category got cached — a code fix alone won't change what's already
 * cached, so this (or manually clearing the relevant lore_categories /
 * lore_episodes rows) is required to actually pick up the fix.
 * Run `window.LoreFetchCheckMissing()` for a READ-ONLY check of what's
 * actually sitting in Supabase for the current chat's fandom/arc(s) right
 * now — no Fandom fetches, no writes, so it can't show you a false positive
 * the way the badge theoretically could. Runs once PER requested arc (since
 * lore.js only ever checks one arc per call) and prints a per-title table
 * for each; the full set is on `window.LoreFetchLastCheck` as an array of
 * `{ arc, result }`, one entry per arc (a single entry with `arc: null`
 * when the instruction named no arc at all). If the badge claims N
 * episodes loaded but this says otherwise, the disagreement is happening
 * below this script — most likely the deployed lore.js is pointed at a
 * different Supabase project than whatever you're checking by hand, or a
 * query against lore_episodes is filtering on `arc` with different casing
 * than what got written (parseSystemPrompt below always title-cases it,
 * e.g. "Season 5").
 * A badge showing amber with "Lore — incomplete" (not the green "Lore
 * fetched") means at least one requested arc had 0 episodes resolved, or
 * came back unscoped — check `partialReason` (also shown in the badge) for
 * which arc(s) specifically. Click the badge (or check
 * window.LoreFetchLastWarnings) to see which category lookup failed.
 *
 * IMPORTANT CAVEAT:
 * The systemMessage write is a raw write into TypingMind's own storage. If
 * the app has already loaded this chat into its in-memory state before our
 * write lands, a later autosave from the app could overwrite what we wrote.
 * Watch the console for the "[LoreFetch] Injected" message before you start
 * typing, and try it on a throwaway chat first before trusting it for real use.
 */
(function () {
  'use strict';

  // ---------- Config ----------
  // TODO: point this at your deployed Vercel app (the one with api/lore.js).
  // NOTE: no trailing slash here — callLoreApiOnce() builds the request URL
  // as `${LORE_API_BASE}/api/lore`, so a trailing slash here produces a
  // double slash ("...vercel.app//api/lore"). Vercel redirects that to the
  // single-slash path, and browsers refuse to follow a redirect during a
  // CORS preflight (OPTIONS) request — it surfaces as a CORS error even
  // though the real cause is the extra slash.
  const LORE_API_BASE = 'https://typingmind-backend.vercel.app';

  // ---------- Tunables ----------
  const REQUEST_TIMEOUT_MS = 25000; // a single batch call to /api/lore, including its own Fandom fetches server-side
  const RECHECK_INTERVAL_MS = 3000; // how often to poll while waiting for chat/agent data (or the next fetch batch)
  const RECHECK_DURATION_MS = 30000; // how long to keep polling for chat/agent data before giving up
  const ENTITY_RESCAN_MS = 5000; // once lore is loaded, how often to re-scan the chat for mentions and refresh the injection
  const CHAT_TEXT_SCAN_MESSAGES = 40; // outer window: anyone mentioned anywhere in this many recent messages is eligible for a lore entry
  // Inner window: only entities matched within this many MOST RECENT messages
  // get the full profile block. Anyone matched only in the outer band above
  // (i.e. mentioned earlier but not in these last few messages) is treated as
  // "brought up, not on-screen" and gets a one-line stub instead — see
  // classifyMatches/composeInjection. This can't perfectly detect "in the
  // scene" (a character can be name-dropped in the very last message without
  // being present), but it fixes the common case of a passing mention 20+
  // turns back staying tagged as a full match for the rest of the window.
  const ACTIVE_SCAN_MESSAGES = 4;
  // Per-profile size caps. These are COPY-time caps, not injection-time:
  // they're applied once, when the corpus is indexed (see buildEntityIndex),
  // to every character in the corpus — so a bullet beyond the cap is simply
  // never kept in the entity index at all, regardless of whether that
  // character ends up matching a chat later.
  //
  // Episode plot text and the overall injected block are DELIBERATELY left
  // uncapped (no MAX_PLOT_CHARS, no MAX_INJECTION_CHARS): the plot is meant
  // to always go in whole, and nothing should ever get silently dropped to
  // stay under a size budget. Powers and trivia are ALSO uncapped — full
  // bullets, any number, any length. ONLY personality and history are still
  // capped: MAX_BULLETS_PER_CATEGORY limits how many bullets are kept, and
  // MAX_BULLET_CHARS truncates any one of those bullets that's still too
  // long — both applied only to personality/history, nowhere else.
  const MAX_BULLETS_PER_CATEGORY = 4; // personality/history only — long prose sections worth summarizing down
  const MAX_BULLET_CHARS = 220; // personality/history only — safety net for a single freak long bullet
  const MARKER_PREFIX = '<!-- lorefetch:'; // marks our injected block so we can find/replace it
  // Backstop against an infinite fetch loop: if the server keeps returning
  // done:false round after round (e.g. because the same page fails every
  // single batch and never gets cached), this caps how many times we'll
  // call /api/lore for one corpus load before giving up and surfacing an
  // error, instead of polling forever in the background. BATCH_SIZE on the
  // server is 6, so 200 rounds is room for ~1200 pages — comfortably above
  // any real fandom's page count.
  const MAX_LORE_BATCHES = 200;
  // A tighter, faster-firing backstop than MAX_LORE_BATCHES: if the "fetched
  // so far" count (total - remaining) reports the exact same number this
  // many rounds in a row, something is permanently stuck rather than just
  // slow — normal progress always shrinks `missing` by at least one item
  // within a round or two. Bailing out after 5 rounds instead of waiting for
  // the full 200-batch cap turns a many-minute silent hang into a
  // several-second, specific error.
  const STALL_ROUNDS = 5;
  const HASH_POLL_MS = 500; // fallback: catch chat switches that don't fire hashchange/popstate at all

  // ---------- Debug ----------
  (function initDebugFlag() {
    let enabled = false;
    try {
      enabled = localStorage.getItem('lorefetch-debug') === '1';
    } catch (err) {
      // localStorage unavailable (privacy mode, etc.) — just default off
    }
    Object.defineProperty(window, 'LoreFetchDebug', {
      get() {
        return enabled;
      },
      set(v) {
        enabled = !!v;
        try {
          localStorage.setItem('lorefetch-debug', enabled ? '1' : '0');
        } catch (err) {
          // ignore — flag still works for this page load even if it can't persist
        }
      },
    });
  })();
  function debugLog(...args) {
    if (window.LoreFetchDebug) console.log('%c[LoreFetch:debug]', 'color:#7dd3fc', ...args);
  }

  // ================= TypingMind's keyval IndexedDB store =================
  function openKeyvalDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvGet(key) {
    const db = await openKeyvalDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keyval', 'readonly');
        const store = tx.objectStore('keyval');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function kvGetAllKeys() {
    const db = await openKeyvalDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keyval', 'readonly');
        const req = tx.objectStore('keyval').getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  // TypingMind's keyval store uses explicit, prefixed, out-of-line keys —
  // e.g. a chat's record isn't stored under its own .id, it's stored under
  // "CHAT_<id>" (confirmed by inspecting the store directly). Rather than
  // hardcode that prefix (and guess whatever prefix other record types use),
  // this tries the bare id first, then falls back to scanning for whichever
  // key actually ends with it. Returns {key, value} using the REAL key, so a
  // caller that later wants to write back can target the exact same record
  // instead of accidentally creating an orphaned copy under the bare id.
  async function resolveStorageKey(id) {
    if (!id) return null;
    const direct = await kvGet(id);
    if (direct !== undefined) return { key: id, value: direct };

    const keys = await kvGetAllKeys();
    const match = keys.find((k) => typeof k === 'string' && k !== id && k.endsWith(id));
    if (!match) return null;
    const value = await kvGet(match);
    return value === undefined ? null : { key: match, value };
  }

  // Agent/character records are NOT stored under their own key the way chats
  // are (there's no "CHARACTER_<id>" entry). They live as elements of a
  // single array under the fixed key "TM_useUserCharacters", matched by
  // `.id` — confirmed by inspecting the store directly. The only key that
  // *ends with* a bare agent id is "CHARACTER_VERSIONS_<id>", which is edit
  // history (an array of {id, createdAt, data:{...}} snapshots), not the
  // live record — so resolveStorageKey's generic suffix-match fallback
  // must NOT be used here, or it silently returns that history array
  // instead (whose top-level shape has no `.instruction`, making a
  // correctly-linked agent look unlinked).
  async function resolveAgentRecord(agentId) {
    if (!agentId) return null;
    const list = await kvGet('TM_useUserCharacters');
    if (!Array.isArray(list)) return null;
    return list.find((c) => c && c.id === agentId) || null;
  }

  async function kvPut(key, value) {
    const db = await openKeyvalDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('keyval', 'readwrite');
        const store = tx.objectStore('keyval');
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  // ---------- Self-healing systemMessage write ----------
  // See the file-header CAVEAT: a write here can lose a race against
  // TypingMind's own autosave. If the app already has this chat loaded in
  // memory, its autosave doesn't know we just edited the stored record — it
  // just re-saves whatever it currently holds in memory, right on top of
  // our write, silently. There's no documented hook to avoid this at the
  // source (TypingMind's own extension docs only say "test carefully" for
  // write operations: https://docs.typingmind.com/typingmind-extensions —
  // there's no safe-merge API, no before-send hook, no documented schema to
  // watch for).
  //
  // What we CAN do is detect it: write, wait a moment, read back what's
  // actually stored, and if it no longer matches what we wrote, something
  // clobbered it in between — so rewrite immediately and check again, up to
  // MAX_WRITE_RETRIES times. This doesn't close the race at the exact
  // instant of a send (that would need TypingMind to expose a real hook),
  // but it turns "silently wrong until the next scheduled rescan" (up to
  // ENTITY_RESCAN_MS later) into "usually corrected within about a
  // second," and it surfaces a console warning when it happens so a clobber
  // is at least visible instead of invisible.
  const WRITE_VERIFY_DELAY_MS = 800; // how long to wait before checking whether our write survived
  const MAX_WRITE_RETRIES = 3; // give up re-asserting after this many clobber-and-rewrite cycles

  // `buildMessage(existingSystemMessage)` returns the new systemMessage to
  // write; it's re-invoked against a FRESH read on every retry (not the
  // stale `existing` from the first attempt), so a retry correctly builds
  // on top of whatever TypingMind's autosave actually left behind, rather
  // than blindly re-applying the first attempt's now-outdated base text.
  async function writeSystemMessageWithVerify(storageKey, buildMessage, attempt = 1) {
    const current = await kvGet(storageKey);
    if (current === undefined) return false; // record vanished entirely — nothing to write onto
    const chat = current;
    chat.chatParams = chat.chatParams || {};
    chat.chatParams.systemMessage = buildMessage(chat.chatParams.systemMessage || '');
    const expected = chat.chatParams.systemMessage;
    await kvPut(storageKey, chat);

    await new Promise((resolve) => setTimeout(resolve, WRITE_VERIFY_DELAY_MS));

    const after = await kvGet(storageKey);
    const actual = after && after.chatParams && after.chatParams.systemMessage;
    if (actual === expected) return true; // write held — nothing overwrote it in the meantime

    console.warn(
      '%c[LoreFetch] systemMessage was overwritten right after we wrote it (likely TypingMind\u2019s own autosave \u2014 see file header CAVEAT). Re-asserting the injected lore (attempt %d/%d).',
      'color:#f59e0b', attempt, MAX_WRITE_RETRIES
    );
    if (attempt >= MAX_WRITE_RETRIES) {
      console.error('[LoreFetch] Gave up re-asserting the injected lore after repeated clobbers \u2014 it may be missing from the model\u2019s next request. The next scheduled rescan will try again.');
      return false;
    }
    return writeSystemMessageWithVerify(storageKey, buildMessage, attempt + 1);
  }

  function getCurrentChatId() {
    const m = window.location.hash.match(/chat=([^&]+)/);
    return m ? m[1] : null;
  }

  // ================= System prompt parsing =================
  // Prompts always follow one fixed shape:
  //   "Portray canon characters in <season/arc/chapter/etc.> of the <year> <media> <fandom>."
  // The arc clause and year are optional and can be dropped; media and
  // fandom are always both present, in that order, right before the
  // trailing period. Media is always one of these five words.
  //
  // MULTIPLE ARCS: lore.js only ever scopes to ONE arc per /api/lore call
  // (see its own file header) — there's no server-side concept of "give me
  // several arcs at once." Two client-side things build on top of that
  // single-arc primitive so an instruction can still name several:
  //
  //   1. The arc-number slot below accepts a NUMBER LIST, not just a single
  //      digit: commas, "and", and hyphenated ranges all work — "arcs 1, 2,
  //      3, 5 and 7", "arcs 1-5, 7-8", "arc 6" all parse correctly. See
  //      parseNumberList.
  //   2. parseSystemPrompt itself now scans the WHOLE instruction with a
  //      global regex (matchAll-style, via the loop below) instead of
  //      `.match()`-ing just the first sentence, and unions the arc numbers
  //      found across every "Portray canon characters in ... ." sentence it
  //      sees. That means the old habit of repeating the whole sentence
  //      once per arc — "Portray canon characters in arc 1 of the Webtoon
  //      Lookism. Portray canon characters in arc 2 of the Webtoon
  //      Lookism. ..." — now works too, and can be freely mixed with the
  //      list syntax above.
  //
  //   BEFORE THIS CHANGE: `.match()` without the `g` flag only ever returns
  //   the leftmost match in the whole string, so every sentence after the
  //   first one in a chained instruction was invisible to parseSystemPrompt
  //   — its arc number, and everything else in it, was silently discarded.
  //   That's why "arc 6" alone worked but 7 chained "arc N" sentences did
  //   not: it's not that the request "crashed" — the extension only ever
  //   read the FIRST sentence (arc 1) and, on top of that, one specific
  //   Fandom quirk made even that single arc come back unscoped in
  //   practice for some wikis (see episodeCategoryArcScoped downstream);
  //   for a genuinely unscoped result the badge would have shown "partial"
  //   rather than silently returning the whole series — worth checking if
  //   this still happens after upgrading.
  //
  // `parsed.arcs` is always an array (possibly empty, meaning "no arc
  // requested — whole series"). `parsed.arc` is kept around set to
  // `arcs[0]` only when there's exactly one arc, purely so any code that
  // still only cares about the single-arc case doesn't need to change.
  const MEDIA_TYPES = ['show', 'movie', 'game', 'comic', 'webtoon'];
  const ARC_LABELS = ['season', 'arc', 'chapter', 'book', 'part', 'volume'];

  // The arc-number capture here is deliberately permissive
  // ([\d][\d,\s-]*?(?:and\s+\d+)?) — it just needs to grab everything
  // between the label and "of" without eating "of" itself; parseNumberList
  // below does the real parsing/validation, so a malformed list here just
  // yields fewer numbers rather than a broken match.
  const PROMPT_PATTERN_SOURCE = `portray canon characters in\\s+(?:(${ARC_LABELS.join(
    '|'
  )})s?\\s+([\\d][\\d,\\s-]*?(?:and\\s+\\d+)?)\\s+of\\s+)?(?:the\\s+)?(?:(\\d{4})\\s+)?(${MEDIA_TYPES.join('|')})\\s+(.+?)\\.`;

  // Turns "1, 2, 3, 5 and 7" / "1-5, 7-8" / "6" into a deduped, sorted
  // array of integers. Silently drops anything it can't parse (rather than
  // erroring) since a stray typo in one clause shouldn't take down arc
  // numbers that DID parse cleanly elsewhere in the same sentence.
  function parseNumberList(raw) {
    if (!raw) return [];
    const nums = new Set();
    for (const part of raw.replace(/\band\b/gi, ',').split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        let [a, b] = [parseInt(range[1], 10), parseInt(range[2], 10)];
        if (a > b) [a, b] = [b, a];
        for (let n = a; n <= b; n++) nums.add(n);
      } else if (/^\d+$/.test(trimmed)) {
        nums.add(parseInt(trimmed, 10));
      }
    }
    return [...nums].sort((a, b) => a - b);
  }

  function parseSystemPrompt(instruction) {
    if (!instruction) return null;
    const re = new RegExp(PROMPT_PATTERN_SOURCE, 'gi');
    let fandom = null;
    let media = null;
    let year = null;
    const arcSet = new Set(); // dedupe e.g. "Arc 2" named in more than one sentence
    let matchedAny = false;
    let m;
    while ((m = re.exec(instruction))) {
      matchedAny = true;
      const [, arcLabel, arcNumbers, matchYear, matchMedia, matchFandom] = m;
      // Media/fandom/year are taken from the FIRST sentence that has them;
      // an instruction is expected to name one fandom throughout, so later
      // sentences only ever contribute additional arc numbers.
      if (fandom === null) {
        fandom = matchFandom.trim();
        media = matchMedia.toLowerCase();
        year = matchYear || null;
      }
      if (arcLabel && arcNumbers) {
        const label = `${arcLabel[0].toUpperCase()}${arcLabel.slice(1).toLowerCase()}`;
        for (const n of parseNumberList(arcNumbers)) arcSet.add(`${label} ${n}`);
      }
    }
    if (!matchedAny || !fandom) return null;
    const arcs = [...arcSet];
    const { extraCharacters, extraEpisodes } = parseExtraEntries(instruction);
    return {
      arcs,
      arc: arcs.length === 1 ? arcs[0] : null,
      year,
      media,
      fandom,
      extraCharacters,
      extraEpisodes,
    };
  }

  // ================= Manual entry overrides =================
  // lore.js's category discovery only ever returns the DIRECT members of
  // whichever "Characters"/"Episodes"-style category name resolves first on
  // the wiki — it has no way to know a page exists if that page isn't filed
  // under one of the guessed category names (Fandom's categorymembers API
  // doesn't recurse into subcategories). A character like Hecate, filed
  // under something like "Villains" or a per-season category instead of a
  // wiki-wide "Charmed Characters"/"Characters" catch-all, can fall through
  // that gap with nothing to do with arc/season filtering as such. Rather
  // than trying to make the category-guess list exhaustive for every wiki's
  // own tagging quirks, this lets you name an exact page and have it pulled
  // in no matter what. One sentence per extra title, repeated as many times
  // as needed, anywhere in the instructions text — order doesn't matter and
  // it works fine with or without an arc clause in the main sentence:
  //   "Also fetch the character Hecate."
  //   "Also fetch the episode Morality Bites."
  // The title must be the EXACT Fandom page title (what's after /wiki/ in
  // the page's own URL, with spaces instead of underscores) — lore.js
  // matches/caches by exact title, so a near-miss doesn't land on the page
  // you meant, it just looks like a new page that then fails to fetch.
  const EXTRA_ENTRY_PATTERN = /also fetch the (character|episode)\s+(.+?)\./gi;

  function parseExtraEntries(instruction) {
    const extraCharacters = [];
    const extraEpisodes = [];
    if (!instruction) return { extraCharacters, extraEpisodes };
    const re = new RegExp(EXTRA_ENTRY_PATTERN.source, 'gi');
    let m;
    while ((m = re.exec(instruction))) {
      const title = m[2].trim();
      if (!title) continue;
      if (m[1].toLowerCase() === 'character') extraCharacters.push(title);
      else extraEpisodes.push(title);
    }
    return { extraCharacters, extraEpisodes };
  }

  // ================= Lore API (fetching/parsing/storage now all live server-side) =================
  // Calls your api/lore.js. That endpoint only does a small batch of Fandom
  // page fetches per call (see its own comment header for why), so this
  // loops until it reports done:true, surfacing progress via onProgress.
  async function callLoreApiOnce(params) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${LORE_API_BASE}/api/lore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`lore API HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('lore API request timed out');
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // `isStale`, when provided, is a zero-arg function that returns true once
  // this load is no longer wanted (i.e. the user switched to a different
  // chat). Checked both before each network call and right after it, so a
  // chat you've navigated away from stops making further /api/lore calls
  // and — critically — stops invoking onProgress, instead of looping in the
  // background indefinitely and repainting the badge for whatever chat is
  // now actually open. Without this, switching chats never actually
  // cancelled the old fetch loop; it just kept running (and kept hitting
  // Fandom's API with no client-side cooldown between batches), which is
  // also a likely contributor to unrelated wikis getting rate-limited.
  function cancelledError() {
    const err = new Error('cancelled: chat switched');
    err.cancelled = true;
    return err;
  }

  // Most-recent-first, deduped — used to put the actually-useful warnings
  // (which title, which error) at the front of an error message/badge
  // instead of them getting buried under dozens of repeats of the same
  // "no Plot subpage" note from earlier, unrelated pages.
  function summarizeWarnings(warnings) {
    if (!warnings.length) return 'none';
    return [...new Set(warnings)].slice(-8).reverse().join(' | ');
  }

  async function fetchLoreCorpus(params, onProgress, isStale) {
    // Each /api/lore call is a separate serverless invocation with its own
    // fresh `warnings` array — lore.js doesn't (and can't, statelessly)
    // persist warnings from one batch to the next. If we only kept the
    // final done:true call's warnings, everything flagged during the
    // batches leading up to it (e.g. "no Plot subpage/section found — used
    // the page intro instead") would just vanish, even though that's
    // exactly the kind of thing worth surfacing.
    const allWarnings = [];
    let batches = 0;
    // Tracks "total - remaining" (pages actually resolved so far, success or
    // cached-failure) round to round. THE BUG THIS CATCHES: if a page's real
    // fetch fails AND the fallback placeholder-cache write in lore.js *also*
    // fails (now surfaced properly now that every Supabase call there checks
    // `error` and throws instead of failing silently), that title can never
    // leave the server's `missing` set. Once `missing` is down to BATCH_SIZE
    // or fewer, every remaining call fully drains it into one batch, so
    // `remaining` reports 0 every round from then on — which is exactly the
    // "stuck at total/total" badge, forever, even though `done` never flips
    // true. A healthy corpus always advances this count within a round or
    // two; one that doesn't move for STALL_ROUNDS straight rounds is that
    // scenario, not a slow one.
    let lastProgressCount = -1;
    let stalledRounds = 0;
    // What the last few rounds actually attempted. A page that's stuck
    // because its fetch+cache both "succeed" (no thrown error — see the
    // comment on getCachedEpisodes in lore.js) produces zero warnings, so
    // warnings alone can't identify it. Remembering `attempted` lets a
    // stall name the repeat-offending title(s) directly instead of just
    // reporting an empty warnings list.
    let lastAttempted = [];
    for (;;) {
      if (isStale && isStale()) throw cancelledError();
      if (++batches > MAX_LORE_BATCHES) {
        const err = new Error(`gave up after ${MAX_LORE_BATCHES} batches without finishing. Recent warnings: ${summarizeWarnings(allWarnings)}`);
        err.warnings = allWarnings;
        throw err;
      }
      const result = await callLoreApiOnce(params);
      if (isStale && isStale()) throw cancelledError(); // don't act on a response for a chat we've left
      if (result.error) throw new Error(result.error);
      if (Array.isArray(result.warnings) && result.warnings.length) {
        allWarnings.push(...result.warnings);
        debugLog('round warnings:', result.warnings);
      }
      if (Array.isArray(result.attempted)) lastAttempted = result.attempted;
      if (result.done) return { ...result, warnings: allWarnings };
      debugLog(`batch progress: ${result.fetched} fetched this call, ${result.remaining} left of ${result.total}`);
      if (onProgress) onProgress(result);

      const progressCount = result.total - result.remaining;
      if (progressCount === lastProgressCount) {
        stalledRounds += 1;
        if (stalledRounds >= STALL_ROUNDS) {
          const stuckOn = lastAttempted.length ? ` Stuck on: ${lastAttempted.join(' | ')}.` : '';
          const err = new Error(
            `stuck at ${progressCount}/${result.total} for ${STALL_ROUNDS} rounds straight — one or more pages are failing every attempt, including the fallback that's supposed to cache the failure so it can be skipped.${stuckOn} Recent warnings: ${summarizeWarnings(allWarnings)}`
          );
          err.warnings = allWarnings;
          throw err;
        }
      } else {
        stalledRounds = 0;
        lastProgressCount = progressCount;
      }
    }
  }

  // lore.js has no concept of "several arcs in one call" — it scopes to
  // exactly one `arc` string per POST (see its file header). This is the
  // client-side answer to that: run the existing single-arc fetchLoreCorpus
  // once per arc in `params.arcs` (sequentially, not in parallel, so we
  // don't hammer Fandom with N concurrent batch loops at once), and merge
  // the resulting episodes/characters/warnings into one corpus object.
  // Everything downstream (buildEntityIndex, composeInjection, the badge)
  // still only ever sees a single corpus shaped exactly like lore.js's own
  // done:true response — it has no idea multiple requests happened.
  //
  // `params.arcs` may be an empty array (no arc clause at all — the whole
  // series is requested) or have exactly one entry; both cases still route
  // through this same loop rather than special-casing "just call
  // fetchLoreCorpus directly," so there's only one code path to keep
  // correct instead of two that need to stay in sync.
  //
  // Expect this to take roughly N times as long as a single-arc fetch for
  // N arcs — lore.js's own batching/rate-limit delay against Fandom
  // (REQUEST_DELAY_MS server-side) applies fully to each arc's episodes
  // and characters, since from the server's point of view these are just
  // N separate, unrelated /api/lore conversations.
  async function fetchLoreCorpusForArcs(params, onProgress, isStale) {
    const { arcs, ...rest } = params;
    const arcList = arcs && arcs.length ? arcs : [null]; // null = no arc clause, whole series
    const merged = {
      wiki: null,
      episodes: [],
      characters: [],
      warnings: [],
      episodesRequested: 0,
      charactersRequested: 0,
      // Conservative AND across arcs: the merged corpus only counts as
      // arc-scoped overall if EVERY requested arc individually came back
      // arc-scoped. One unscoped arc mixed in with several scoped ones
      // means the corpus as a whole can't be trusted the way a single
      // cleanly-scoped arc could, so this can't just average out.
      episodeCategoryArcScoped: true,
      characterCategoryArcScoped: true,
      // Per-arc detail — not read by any single-arc code path, but lets
      // loadCorpusForChat build a "which specific arc(s) failed" message
      // instead of one blanket warning covering all of them.
      perArc: [],
    };
    const seenEpisodeTitles = new Set();
    const seenCharacterNames = new Set();

    for (let i = 0; i < arcList.length; i++) {
      if (isStale && isStale()) throw cancelledError();
      const arc = arcList[i];
      const result = await fetchLoreCorpus(
        { ...rest, arc },
        (progress) => {
          if (!onProgress) return;
          onProgress({ ...progress, arc, arcIndex: i + 1, arcCount: arcList.length });
        },
        isStale
      );
      if (!merged.wiki) merged.wiki = result.wiki;
      for (const ep of result.episodes || []) {
        if (seenEpisodeTitles.has(ep.title)) continue; // same episode surfaced under more than one arc guess
        seenEpisodeTitles.add(ep.title);
        merged.episodes.push(ep);
      }
      for (const ch of result.characters || []) {
        if (seenCharacterNames.has(ch.name)) continue; // recurring character across arcs — keep the first copy
        seenCharacterNames.add(ch.name);
        merged.characters.push(ch);
      }
      if (result.warnings && result.warnings.length) {
        const prefix = arc ? `[${arc}] ` : '';
        merged.warnings.push(...result.warnings.map((w) => `${prefix}${w}`));
      }
      merged.episodesRequested += result.episodesRequested || 0;
      merged.charactersRequested += result.charactersRequested || 0;
      if (result.episodeCategoryArcScoped !== true) merged.episodeCategoryArcScoped = false;
      if (result.characterCategoryArcScoped !== true) merged.characterCategoryArcScoped = false;
      merged.perArc.push({
        arc,
        arcResolvedTitle: result.arcResolvedTitle,
        episodesRequested: result.episodesRequested,
        episodeCategoryArcScoped: result.episodeCategoryArcScoped === true,
        charactersRequested: result.charactersRequested,
        characterCategoryArcScoped: result.characterCategoryArcScoped === true,
      });
    }
    return merged;
  }

  // ================= Entity index + chat-aware matching =================
  // Turns the corpus into one lookup-able block per episode/character, then
  // matches those against whatever's actually been said in the chat, so we
  // only ever inject lore that's relevant right now.
  function truncateText(s, maxChars) {
    if (!s) return s;
    return s.length > maxChars ? `${s.slice(0, maxChars).trim()}\u2026` : s;
  }

  function capBullets(list, max) {
    return (list || []).slice(0, max).map((b) => truncateText(b, MAX_BULLET_CHARS));
  }

  function buildEntityIndex(corpus) {
    const entities = [];
    for (const ep of corpus.episodes || []) {
      if (!ep.plot) continue;
      // Full plot text, injected whole — no truncation. Only the stub below
      // (used for the "mentioned, not active" tier) stays short, since that's
      // a deliberate brief reference, not a size cap on the plot itself.
      entities.push({
        type: 'episode',
        names: [ep.title],
        block: `### ${ep.title}\n${ep.plot}`,
        // Shown instead of the full block when this episode is only matched
        // in the outer "mentioned" window, not the recent "active" one.
        stub: `- **${ep.title}**: ${truncateText(ep.plot, 140)}`,
      });
    }
    for (const ch of corpus.characters || []) {
      const parts = [];
      const personality = capBullets(ch.personality, MAX_BULLETS_PER_CATEGORY);
      const history = capBullets(ch.history, MAX_BULLETS_PER_CATEGORY);
      // No cap at all — full text, every bullet, count and length unbounded.
      const powers = ch.powers || [];
      const trivia = ch.trivia || [];
      if (personality.length) parts.push(`**Personality**\n${personality.map((b) => `- ${b}`).join('\n')}`);
      if (history.length) parts.push(`**History**\n${history.map((b) => `- ${b}`).join('\n')}`);
      if (powers.length) parts.push(`**Powers/Abilities**\n${powers.map((b) => `- ${b}`).join('\n')}`);
      if (trivia.length) parts.push(`**Trivia**\n${trivia.map((b) => `- ${b}`).join('\n')}`);
      if (!parts.length) continue;
      // A character's own page title is usually their full name ("Piper
      // Halliwell"); add the bare first word too (mostly first name) so a
      // chat that just says "Piper" still matches.
      const firstWord = ch.name.split(' ')[0];
      const names = firstWord && firstWord !== ch.name ? [ch.name, firstWord] : [ch.name];
      // Stub for the "mentioned, not active" tier: whatever the single most
      // identity-defining line available is, so a passing reference to this
      // character still reminds the model who they are without paying for
      // the whole profile.
      const stubLine = personality[0] || history[0] || powers[0] || 'no summary available';
      entities.push({
        type: 'character',
        names,
        block: `### ${ch.name}\n${parts.join('\n')}`,
        stub: `- **${ch.name}**: ${stubLine}`,
      });
    }
    return entities;
  }

  function normalize(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function matchEntities(entityIndex, haystackText) {
    const hay = ` ${normalize(haystackText)} `;
    return entityIndex.filter((entity) => entity.names.some((name) => name && hay.includes(` ${normalize(name)} `)));
  }

  function entityKey(e) {
    return `${e.type}:${e.names[0]}`;
  }

  // Splits whatever matched in the full CHAT_TEXT_SCAN_MESSAGES window into
  // two tiers: `active` (also matched within the smaller, most-recent
  // ACTIVE_SCAN_MESSAGES window — gets the full profile) and `mentionedOnly`
  // (matched further back but not recently — gets a one-line stub instead).
  // This is a recency heuristic, not real scene understanding: a character
  // named once in the very latest message still counts as "active" even if
  // they're being talked ABOUT rather than being present. What it does fix
  // is the more common case — a name-drop from many turns ago staying tagged
  // as a full match for the rest of the 40-message window.
  function classifyMatches(entityIndex, allText, activeText) {
    const all = matchEntities(entityIndex, allText);
    const activeKeys = new Set(matchEntities(entityIndex, activeText).map(entityKey));
    const active = all.filter((e) => activeKeys.has(entityKey(e)));
    const mentionedOnly = all.filter((e) => !activeKeys.has(entityKey(e)));
    return { active, mentionedOnly };
  }

  // Assembles the injected text from active blocks (full episode plots +
  // character profiles) and mentioned-only stubs. There is no overall size
  // ceiling here — everything matched gets included, in full, every time.
  // If the corpus grows large this can produce a big injected block; that's
  // intentional (nothing should be silently dropped to stay under a budget),
  // but it does mean a chat that matches many episodes/characters at once
  // can push a lot of text into chatParams.systemMessage.
  //
  // The header (fandom + arc) is now ALWAYS included, even with zero
  // matches — previously this returned '' until something was actually
  // named in the chat, which meant the injected block carried no fandom/
  // season identification at all for however long a fresh chat went before
  // anyone got mentioned. Since chat.chatParams.systemMessage is written
  // unconditionally from the very first rescan onward (see rescanAndInject),
  // that gap meant the model's grounding in what it's portraying depended
  // entirely on TypingMind's own handling of the agent's `instruction` field
  // for that window. Always emitting the header removes that dependency.
  // `arc` here is just a display string — the caller passes
  // state.parsed.arcs.join(', ') now that an instruction can name several
  // arcs, so this can be "Arc 1, Arc 2, Arc 3" as easily as a single arc;
  // this function doesn't need to know or care how many there are.
  function composeInjection(active, mentionedOnly, wiki, arc) {
    let header = `Canon reference: ${wiki.sitename}\nSource: ${wiki.url}\n`;
    if (arc) header += `Scoped to: ${arc}\n`;

    const activeBlocks = active.map((e) => e.block);
    const stubLines = mentionedOnly.map((e) => e.stub);

    const assemble = () => {
      let text = header;
      if (activeBlocks.length) text += `\n${activeBlocks.join('\n\n')}`;
      if (stubLines.length) {
        text += `\n\n**Also mentioned recently** (not currently active in the scene \u2014 brief reference only):\n${stubLines.join('\n')}`;
      }
      if (!activeBlocks.length && !stubLines.length) {
        text += '\n(No characters or episodes from this fandom have come up in the chat yet.)';
      }
      return text.trim();
    };

    return assemble();
  }

  // ASSUMPTION, unverified: a chat's turns live at `chat.messages`, an array
  // of {role, content} where `content` is a plain string or a content-block
  // array like [{type:'text', text:'...'}] — this mirrors what TypingMind's
  // own export produces, but unlike resolveAgentRecord's shape above, it
  // hasn't been confirmed against the store directly. If matching never
  // fires, run `window.LoreFetchInspectMessages()` in the console on an
  // open chat and check the real field name/shape, then fix this function.
  function extractMessageText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join(' ');
    }
    return '';
  }

  function extractRecentChatTexts(chat, limit) {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    return messages.slice(-limit).map(extractMessageText);
  }

  window.LoreFetchInspectMessages = async function (chatId) {
    const entry = await resolveStorageKey(chatId || getCurrentChatId());
    if (!entry) {
      console.log('[LoreFetch] no chat record found');
      return null;
    }
    console.log('[LoreFetch] chat record:', entry.value);
    return entry.value;
  };

  // Forces a full re-check of the CURRENT chat's lore, bypassing lore.js's
  // 14-day Supabase cache for category resolution AND every episode/
  // character page (forceRefresh:true — see lore.js's file header). Use
  // this any time the badge is green/partial but you suspect the wrong
  // category or a stale page got cached — e.g. right after fixing/
  // redeploying lore.js's category-guess logic, since without this the old
  // (wrong) cached answer would otherwise keep being served until it
  // naturally expires. This re-fetches EVERY episode and character for the
  // arc from Fandom again, not just the ones that look missing, so expect
  // it to take a while (and to make a real batch of requests against
  // Fandom) for a full season.
  window.LoreFetchRefresh = function () {
    const chatId = getCurrentChatId();
    if (!chatId) {
      console.warn('[LoreFetch] No chat is currently open.');
      return;
    }
    console.log('%c[LoreFetch] Forcing a fresh recheck (bypassing the server cache) for chat', 'color:#f0b429;font-weight:bold', chatId);
    stopRechecking();
    currentChatId = chatId; // checkForChatChange() below is a no-op unless the id actually changes, so set it directly
    onChatOpened(chatId, { forceRefresh: true });
  };

  // Read-only Supabase check for the CURRENT chat's fandom/arc — does not
  // touch Fandom, does not write anything, does not affect the badge/rescan
  // loop at all. This exists specifically to settle "the extension says N
  // episodes are loaded, but I don't see them in the database" — since that
  // combination shouldn't be possible from lore.js's own logic (a done:true
  // response only ever reports rows it just read from Supabase), the most
  // likely explanations are things that live BETWEEN you and the database
  // rather than in the fetch/write path itself: this deployment's Vercel
  // env vars pointing at a different Supabase project than the one you're
  // looking at, or a manual query filtering `arc` with different casing
  // than parseSystemPrompt produces. This command reads the same rows
  // lore.js would, under this same deployment, so it can't be fooled by
  // either of those — if it also says "missing," the gap is real.
  // Checks every arc named in the instruction, one dryRun call each (lore.js
  // only ever scopes a single call to one arc — see its file header — so
  // there's no single query that covers several at once). Returns an array
  // of { arc, result } — even for a single-arc (or no-arc) instruction, so
  // the return shape doesn't change based on how many arcs were requested.
  window.LoreFetchCheckMissing = async function () {
    const chatId = getCurrentChatId();
    if (!chatId) {
      console.warn('[LoreFetch] No chat is currently open.');
      return null;
    }
    const chatEntry = await resolveStorageKey(chatId);
    if (!chatEntry) {
      console.warn('[LoreFetch] No chat record found yet for this chat — has it sent a message?');
      return null;
    }
    const agentId = chatEntry.value.character && chatEntry.value.character.id;
    const agent = agentId ? await resolveAgentRecord(agentId) : null;
    const parsed = agent && agent.instruction ? parseSystemPrompt(agent.instruction) : null;
    if (!parsed) {
      console.warn("[LoreFetch] This chat's agent instructions don't match the fandom template — nothing to check.");
      return null;
    }
    const { arcs, ...rest } = parsed;
    const arcList = arcs && arcs.length ? arcs : [null];
    const allResults = [];
    for (const arc of arcList) {
      console.log('%c[LoreFetch] Checking Supabase (read-only) for', 'color:#f0b429;font-weight:bold', { ...rest, arc });
      let result;
      try {
        result = await callLoreApiOnce({ ...rest, arc, dryRun: true });
      } catch (err) {
        console.error(`[LoreFetch] check request failed for "${arc || '(whole series)'}":`, err);
        allResults.push({ arc, result: null });
        continue;
      }
      if (result.error) {
        console.error(`[LoreFetch] check failed for "${arc || '(whole series)'}":`, result.error);
        allResults.push({ arc, result });
        continue;
      }
      const tag = arc ? `[${arc}] ` : '';
      console.log(
        `%c[LoreFetch] ${tag}Episode category: ${result.episodeCategory || '(none found)'}` +
          `${result.episodeCategory ? (result.episodeCategoryArcScoped ? ' — arc-scoped' : ' — NOT arc-scoped, likely whole-series') : ''}`,
        'color:#7dd3fc'
      );
      console.log(
        `%c[LoreFetch] ${tag}Character source: ${result.characterCategory || '(none found)'}` +
          `${result.characterCategory ? (result.characterCategoryArcScoped ? ' — arc-scoped' : ' — NOT arc-scoped, likely whole-series cast') : ''}` +
          // characterSource is new (see lore.js): 'season-page' means this list came
          // from reading the season's own Cast/Characters section (the accurate,
          // preferred path); 'category' means it fell back to guessing a separate
          // "<arc> Characters"-style category page instead — worth knowing which one
          // fired when checking whether a scoped result can be trusted.
          `${result.characterSource ? ` [source: ${result.characterSource}]` : ''}`,
        'color:#7dd3fc'
      );
      if (result.episodeStatus && result.episodeStatus.length) console.table(result.episodeStatus);
      if (result.characterStatus && result.characterStatus.length) console.table(result.characterStatus);
      if (result.missingEpisodes.length) {
        console.warn(
          `%c[LoreFetch] ${tag}${result.missingEpisodes.length}/${result.episodesRequested} episode title(s) are NOT usable in Supabase right now (missing, cached-empty, or stale):`,
          'color:#f04545;font-weight:bold',
          result.missingEpisodes
        );
      } else if (result.episodesRequested > 0) {
        console.log(
          `%c[LoreFetch] ${tag}Every requested episode title has a real row with plot text in Supabase — the DB agrees with the badge. If your own check still shows nothing, check that it is reading the SAME Supabase project this deployment uses, and that any \`arc\` filter matches the casing lore.js writes (e.g. "Season 5", not "season 5").`,
          'color:#45c97a'
        );
      } else {
        console.warn(`[LoreFetch] ${tag}episodesRequested is 0 — the episode category itself was never resolved, so there was nothing to check episode-by-episode. See warnings below.`);
      }
      if (result.missingCharacters.length) {
        console.warn(`[LoreFetch] ${tag}${result.missingCharacters.length}/${result.charactersRequested} character title(s) are NOT usable in Supabase right now:`, result.missingCharacters);
      }
      if (result.warnings && result.warnings.length) console.log(`[LoreFetch] ${tag}warnings:`, result.warnings);
      allResults.push({ arc, result });
    }
    window.LoreFetchLastCheck = allResults;
    return allResults;
  };

  // ================= Sidebar icon (matches TypingMind's own nav tabs) =================
  // Anchored off the built-in Sync tab so our button lands in the same list.
  // We CLONE this node rather than hand-building one from a copied class
  // string — that's what previously caused the spacing/centering to drift
  // from the real tabs, since a hand-typed class list can silently miss a
  // class the live version actually has.
  let loggedAnchorMiss = false;

  // Tries a few ways to find the Sync tab, in order of specificity, since
  // data-element-id values can differ across TypingMind versions/themes.
  function findSidebarAnchor() {
    let el = document.querySelector('[data-element-id="workspace-tab-cloudsync"]');
    if (el) return el;

    el = document.querySelector('[data-element-id^="workspace-tab-"]');
    if (el) return el; // any nav tab — we'll drop in right after the first one

    const candidates = document.querySelectorAll('button, a');
    for (const node of candidates) {
      const span = node.querySelector('span');
      if (span && span.textContent.trim() === 'Sync' && node.querySelector('svg')) return node;
    }

    if (!loggedAnchorMiss) {
      loggedAnchorMiss = true;
      console.warn(
        '[LoreFetch] Could not find the sidebar to anchor next to (looked for a "Sync" nav tab), ' +
        'so no status icon will show. Fetching/injection still runs — check window.LoreFetchLastContext ' +
        'and window.LoreFetchLastWarnings, or run window.LoreFetchDebug = true for a full trace. If you ' +
        'can, right-click the Sync icon in your sidebar, Inspect it, and share the outer HTML so the ' +
        'selector can be corrected.'
      );
    }
    return null;
  }

  // Dog-eared page — drawn in the same stroke style as TypingMind's own
  // sidebar icons (18x18 viewbox, 1.5 stroke, round caps/joins) so it sits
  // naturally next to Sync/Agents/Prompts/etc. The folded corner + text
  // lines read as "a page of notes," which is what this extension fetches.
  const LORE_ICON_SVG = `
    <svg class="w-4 h-4 flex-shrink-0" width="18px" height="18px" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4.5,2.5 L11,2.5 L14.5,6 L14.5,15 L4.5,15 Z"></path>
        <polyline points="11,2.5 11,6 14.5,6"></polyline>
        <line x1="6.5" y1="9.5" x2="11.5" y2="9.5"></line>
        <line x1="6.5" y1="12.5" x2="11.5" y2="12.5"></line>
      </g>
    </svg>`;

  function buildPopover() {
    let popover = document.getElementById('lorefetch-popover');
    if (popover) return popover;
    popover = document.createElement('div');
    popover.id = 'lorefetch-popover';
    popover.style.cssText = `
      position: fixed; z-index: 999999; max-width: 280px;
      background: #1f2430; color: #e5e7eb; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.4; display: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(popover);
    document.addEventListener('click', (e) => {
      const trigger = document.getElementById('lorefetch-tab');
      if (trigger && !trigger.contains(e.target) && !popover.contains(e.target)) {
        popover.style.display = 'none';
      }
    });
    return popover;
  }

  function togglePopoverNear(triggerEl) {
    const popover = buildPopover();
    if (popover.style.display === 'block') {
      popover.style.display = 'none';
      return;
    }
    // buildPopover() only ever creates an empty shell — refresh its content
    // here on every open, otherwise a popover built before any badge-state
    // detail existed yet would stay blank forever, even after later errors.
    popover.innerHTML = lastBadgeDetail || 'No details yet.';
    const rect = triggerEl.getBoundingClientRect();
    popover.style.left = `${Math.min(rect.right + 8, window.innerWidth - 296)}px`;
    popover.style.top = `${Math.max(rect.top, 8)}px`;
    popover.style.display = 'block';
  }

  // Confirmed (by comparing the real "Prompts" tab's markup in both sidebar
  // states) that collapsed vs. expanded aren't the same DOM with a label
  // toggled by CSS — they're two structurally different renders:
  //   collapsed: "...w-9 h-9 items-center justify-center...", carries
  //     data-tooltip-content="Prompts", no <span> at all.
  //   expanded:  "...flex-col justify-start items-center...gap-1.5...",
  //     no data-tooltip-content attribute, plus <span>Prompts</span>.
  // A one-time clone can never track that on its own, since it isn't part
  // of TypingMind's React render cycle — so instead we keep re-copying the
  // anchor's current chrome (classes, tooltip attribute, label span) onto
  // our clone every time the anchor itself changes. Only the icon and the
  // status dot are ours; everything else mirrors the anchor exactly.
  function directChildSpan(el) {
    for (const child of el.children) {
      if (child.tagName === 'SPAN') return child;
    }
    return null;
  }

  function applyAnchorChrome(btn, anchor) {
    btn.className = anchor.className;

    if (anchor.hasAttribute('data-tooltip-content')) {
      btn.setAttribute('data-tooltip-content', 'Lore');
    } else {
      btn.removeAttribute('data-tooltip-content');
    }

    const anchorLabel = directChildSpan(anchor);
    let ourLabel = directChildSpan(btn);
    if (anchorLabel) {
      if (!ourLabel) {
        ourLabel = document.createElement('span');
        btn.appendChild(ourLabel);
      }
      ourLabel.className = anchorLabel.className;
      const style = anchorLabel.getAttribute('style');
      if (style) ourLabel.setAttribute('style', style);
      ourLabel.textContent = 'Lore';
    } else if (ourLabel) {
      ourLabel.remove();
    }
  }

  function watchAnchorForLayoutChanges(btn, anchor) {
    const sync = () => requestAnimationFrame(() => applyAnchorChrome(btn, anchor));
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(sync).observe(anchor.parentNode || anchor);
    }
    new MutationObserver(sync).observe(anchor, {
      attributes: true,
      attributeFilter: ['class', 'data-tooltip-content'],
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', sync);
  }

  // Real sidebar tab, cloned from the anchor so it inherits its exact
  // spacing, sizing, and collapsed/expanded layout — then we only swap the
  // icon and label text, and keep re-syncing chrome from the anchor (see
  // applyAnchorChrome above) since the anchor's own markup changes shape
  // between collapsed and expanded sidebar states.
  function ensureSidebarButton() {
    let btn = document.getElementById('lorefetch-tab');
    if (btn) return btn;

    const anchor = findSidebarAnchor();
    if (!anchor || !anchor.parentNode) return null; // sidebar not mounted yet — caller will fall back/retry

    btn = anchor.cloneNode(true);
    btn.id = 'lorefetch-tab';
    btn.removeAttribute('onclick');
    btn.removeAttribute('href');
    btn.setAttribute('data-element-id', 'workspace-tab-lore');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-label', 'Lore');
    // Cloning copies id attributes too (e.g. a status dot) — duplicate ids
    // are invalid HTML and can confuse later querySelector('#...') calls,
    // so strip every id from inside the clone before we add our own.
    btn.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));

    const svgHolder = btn.querySelector('svg');
    if (svgHolder) {
      const iconWrap = svgHolder.parentElement;
      const tmp = document.createElement('div');
      tmp.innerHTML = LORE_ICON_SVG.trim();
      svgHolder.replaceWith(tmp.firstElementChild);
      if (iconWrap) {
        iconWrap.style.position = iconWrap.style.position || 'relative';
        const dot = document.createElement('div');
        dot.id = 'lorefetch-status-dot';
        dot.style.cssText = 'position:absolute; top:-2px; right:-2px; width:6px; height:6px; border-radius:50%; background:#9ca3af; display:block;';
        iconWrap.appendChild(dot);
      }
    }

    applyAnchorChrome(btn, anchor);

    anchor.insertAdjacentElement('afterend', btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopoverNear(btn);
    });
    watchAnchorForLayoutChanges(btn, anchor);
    return btn;
  }

  const BADGE_COLORS = { idle: '#9ca3af', working: '#f0b429', success: '#45c97a', partial: '#f0b429', skipped: '#9ca3af', error: '#f04545' };
  const BADGE_TOOLTIPS = {
    idle: 'Lore',
    working: 'Fetching lore…',
    success: 'Lore fetched',
    partial: 'Lore — incomplete (click for details)',
    skipped: 'Lore — not applicable',
    error: 'Lore — error',
  };

  // Remembered separately from the DOM so that whenever the real tab shows
  // up (see watchForSidebarMount below), it can be brought up to date
  // immediately instead of sitting on the default idle-gray dot until the
  // next chat/agent event happens to fire.
  let lastBadgeState = 'idle';
  let lastBadgeDetail = null;

  function applyBadgeState(indicator) {
    if (!indicator) return;
    const color = BADGE_COLORS[lastBadgeState] || BADGE_COLORS.idle;
    const dot = indicator.querySelector('#lorefetch-status-dot');
    if (dot) dot.style.background = color;
    indicator.title = BADGE_TOOLTIPS[lastBadgeState] || 'Lore';
    const popover = document.getElementById('lorefetch-popover');
    if (popover && lastBadgeDetail) popover.innerHTML = lastBadgeDetail;
  }

  function setBadgeState(state, detailHtml) {
    lastBadgeState = state;
    if (detailHtml) lastBadgeDetail = detailHtml;
    applyBadgeState(ensureSidebarButton()); // no-ops safely if the sidebar isn't mounted yet
  }

  // Creates the real tab the instant TypingMind's own sidebar shows up,
  // rather than waiting for the next chat/agent event to happen to trigger
  // setBadgeState (which could be up to RECHECK_INTERVAL_MS behind — the
  // beat of delay you were seeing right after a refresh). Watching the
  // whole document is broad, but this is a one-shot check that disconnects
  // itself the moment the tab exists, so the overhead is short-lived.
  function watchForSidebarMount() {
    if (ensureSidebarButton()) {
      applyBadgeState(document.getElementById('lorefetch-tab'));
      return;
    }
    const observer = new MutationObserver(() => {
      const btn = ensureSidebarButton();
      if (btn) {
        observer.disconnect();
        applyBadgeState(btn);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ================= Injection into the chat =================
  function stripPreviousInjection(text) {
    const idx = text.indexOf(MARKER_PREFIX);
    return idx === -1 ? text : text.slice(0, idx).trim();
  }

  // Loads (and caches on the in-memory `state`) the full lore corpus for a
  // chat's agent, then does one entity-match/write pass. Returns nothing —
  // all outcomes are communicated via setBadgeState, same as before.
  // `forceRefresh`, when true, is forwarded straight to /api/lore so it
  // bypasses the server's 14-day category/page cache — see window.LoreFetchRefresh().
  async function loadCorpusForChat(chatId, isStale, forceRefresh) {
    const chatEntry = await resolveStorageKey(chatId);
    if (!chatEntry) return { status: 'no-chat' };
    const chat = chatEntry.value;

    const agentId = chat.character && chat.character.id;
    if (!agentId) return { status: 'no-agent' };

    const agent = await resolveAgentRecord(agentId);
    if (!agent || !agent.instruction) return { status: 'no-agent' };

    const parsed = parseSystemPrompt(agent.instruction);
    if (!parsed || !parsed.fandom) return { status: 'skipped' };
    // Display label for badges/messages — "Arc 1, Arc 2, Arc 3" when
    // several were named, the single arc string when there's just one,
    // '' when none was requested at all (whole series).
    const arcsLabel = parsed.arcs.join(', ');

    try {
      const corpus = await fetchLoreCorpusForArcs(
        forceRefresh ? { ...parsed, forceRefresh: true } : parsed,
        (progress) => {
          if (isStale && isStale()) return; // this chat isn't the active one anymore — don't repaint its badge
          const arcTag = progress.arcCount > 1 ? `${progress.arc || 'whole series'} (${progress.arcIndex}/${progress.arcCount}) \u2014 ` : '';
          setBadgeState('working', `Fetching lore\u2026 ${arcTag}${progress.total - progress.remaining}/${progress.total} pages`);
        },
        isStale
      );
      if (corpus.warnings && corpus.warnings.length) console.log('[LoreFetch] notes:', corpus.warnings);
      const entityIndex = buildEntityIndex(corpus);
      window.LoreFetchLastWarnings = corpus.warnings || [];
      if (!entityIndex.length) {
        return { status: 'error', warnings: corpus.warnings, fandom: parsed.fandom, arc: arcsLabel || null };
      }
      // done:true only ever meant "nothing left in `missing`" — that's
      // trivially true if the episode category was never found, so treat
      // "arcs were requested but 0 episodes were resolved across ALL of
      // them" as its own status instead of letting it read as a plain,
      // unqualified success just because some characters happened to
      // match. See the episodesRequested doc comment in lore.js's file
      // header.
      const episodesRequested = typeof corpus.episodesRequested === 'number' ? corpus.episodesRequested : corpus.episodes.length;
      if (parsed.arcs.length && episodesRequested === 0) {
        return {
          status: 'partial',
          chatKey: chatEntry.key,
          agentId,
          parsed,
          corpus,
          entityIndex,
          lastMatchedKey: null,
          partialReason: `No episodes were found for "${arcsLabel}" — only character info is available. The episode category on ${corpus.wiki.sitename} likely wasn't matched (check the warnings below); run window.LoreFetchRefresh() after fixing/redeploying lore.js.`,
        };
      }
      // Same idea as the 0-episodes check above, but for whether the
      // resolved episode list is actually SCOPED to the arc(s) at all, not
      // just non-empty. episodeCategoryArcScoped is a conservative AND
      // across every requested arc (see fetchLoreCorpusForArcs) — it's only
      // true when EVERY arc individually found a real arc-scoped category
      // or arc page (see the ARC SCOPING — EPISODES note in lore.js's file
      // header). When it's false but episodesRequested > 0, at least one
      // arc's episode list came from a wiki-wide catch-all narrowed only by
      // a best-effort NUMBER filter (filterTitlesToArc) — a silent no-op on
      // any wiki whose episode titles don't encode a season number — so
      // corpus.episodes may silently contain episodes from arcs nobody
      // asked for. corpus.perArc (see below) names exactly which arc(s).
      const episodeCategoryArcScoped = corpus.episodeCategoryArcScoped === true;
      const unscopedEpisodeArcs = (corpus.perArc || [])
        .filter((a) => (a.episodesRequested || 0) > 0 && !a.episodeCategoryArcScoped)
        .map((a) => a.arc || '(whole series)');
      if (parsed.arcs.length && episodesRequested > 0 && !episodeCategoryArcScoped) {
        return {
          status: 'partial',
          chatKey: chatEntry.key,
          agentId,
          parsed,
          corpus,
          entityIndex,
          lastMatchedKey: null,
          partialReason: `Episodes aren't scoped correctly for: ${unscopedEpisodeArcs.join(', ') || arcsLabel} — no episode category or arc page specific to ${unscopedEpisodeArcs.length > 1 ? 'these arcs' : `"${unscopedEpisodeArcs[0] || arcsLabel}"`} was found on ${corpus.wiki.sitename}, so that arc's episode list came from a wiki-wide catch-all narrowed only by a best-effort guess at a season number in each title (check the warnings below — if it says the filter matched every title, none of them encode a season number and this is the WHOLE-SERIES episode list). Treat the episode corpus as possibly unscoped. Add "Also fetch the episode <Title>." lines to the instructions to hand-pick specific ones instead.`,
        };
      }

      // Same idea as the episode check above, but for characters: at least
      // one requested arc found neither an arc-scoped season page (see
      // characterSource/the ARC SCOPING — CHARACTERS note in lore.js's file
      // header) nor an arc-scoped category, so corpus.characters may
      // include this wiki's whole-series cast rather than just the
      // requested arc(s)'. Worth flagging on the badge, not just in the
      // console, since a full cast list can otherwise look identical to a
      // correctly-scoped one.
      const characterCategoryArcScoped = corpus.characterCategoryArcScoped === true;
      const unscopedCharacterArcs = (corpus.perArc || [])
        .filter((a) => !a.characterCategoryArcScoped)
        .map((a) => a.arc || '(whole series)');
      if (parsed.arcs.length && !characterCategoryArcScoped) {
        return {
          status: 'partial',
          chatKey: chatEntry.key,
          agentId,
          parsed,
          corpus,
          entityIndex,
          lastMatchedKey: null,
          partialReason: corpus.characterCategory
            ? `Characters aren't scoped correctly for: ${unscopedCharacterArcs.join(', ') || arcsLabel} — no season page (with a Cast/Characters section) or category specific to ${unscopedCharacterArcs.length > 1 ? 'these arcs' : `"${unscopedCharacterArcs[0] || arcsLabel}"`} was found, so this includes ${corpus.wiki.sitename}'s whole-series cast, not just the requested arc(s)'.${episodeCategoryArcScoped ? ' Episodes are still correctly scoped.' : ' Episodes are also unscoped (see above).'} Add "Also fetch the character <Name>." lines to the instructions to hand-pick specific ones instead.`
            : `No season page or character category was found on ${corpus.wiki.sitename} at all — no character info is available for this fandom. Check the warnings below.`,
        };
      }
      return { status: 'ready', chatKey: chatEntry.key, agentId, parsed, corpus, entityIndex, lastMatchedKey: null };
    } catch (err) {
      // fetchLoreCorpus's timeout/stall paths attach the specific per-title
      // warnings it collected (via err.warnings) — surface those in the
      // badge so you can see WHICH page and WHY without digging through the
      // console. Falls back to the bare message for anything else (network
      // errors, a genuine server-side { error } response, etc).
      const warnings = err && err.warnings && err.warnings.length ? [...new Set(err.warnings)].slice(-8) : [(err && err.message) || String(err)];
      return { status: 'error', warnings, fandom: parsed.fandom, arc: arcsLabel || null };
    }
  }

  // One rescan/write pass for a chat whose corpus is already loaded. Skips
  // the actual write when the matched entity set hasn't changed, both to
  // cut down on redundant IndexedDB writes and to reduce collision risk
  // with TypingMind's own autosave (see the file-header caveat).
  async function rescanAndInject(state) {
    const chatEntry = await resolveStorageKey(state.chatKey);
    if (!chatEntry) return;
    const chat = chatEntry.value;
    const allTexts = extractRecentChatTexts(chat, CHAT_TEXT_SCAN_MESSAGES);
    const activeTexts = allTexts.slice(-ACTIVE_SCAN_MESSAGES);
    const { active, mentionedOnly } = classifyMatches(state.entityIndex, allTexts.join('\n'), activeTexts.join('\n'));
    const matchedKey = [
      ...active.map((m) => `A:${entityKey(m)}`),
      ...mentionedOnly.map((m) => `M:${entityKey(m)}`),
    ].sort().join('|');
    if (matchedKey === state.lastMatchedKey) return;

    // Comma-joined display label — "Arc 1, Arc 2, Arc 3" when several arcs
    // were requested, a single arc string when there's just one, '' for
    // none (whole series). Used anywhere `arc` used to be shown/keyed on.
    const arcsLabel = state.parsed.arcs.join(', ');
    const marker = `${MARKER_PREFIX}${state.agentId}:${state.parsed.fandom}:${arcsLabel} -->`;
    const injected = composeInjection(active, mentionedOnly, state.corpus.wiki, arcsLabel);
    const text = `${marker}\n${injected}`;
    window.LoreFetchLastContext = text;

    const held = await writeSystemMessageWithVerify(chatEntry.key, (existing) => {
      const base = stripPreviousInjection(existing || '');
      return base ? `${base}\n\n${text}` : text;
    });
    state.lastMatchedKey = matchedKey;

    debugLog(
      `rescan: ${active.length} active + ${mentionedOnly.length} mentioned-only / ${state.entityIndex.length} total ->`,
      'active:', active.map((m) => m.names[0]),
      '| mentioned-only:', mentionedOnly.map((m) => m.names[0])
    );
    console.log(
      `%c[LoreFetch] Injected ${active.length} full profile${active.length === 1 ? '' : 's'} + ${mentionedOnly.length} stub${mentionedOnly.length === 1 ? '' : 's'} (${text.length} chars)${held ? '' : ' \u2014 WRITE DID NOT HOLD, see warning above'}.`,
      held ? 'color:#45f0a0;font-weight:bold' : 'color:#f59e0b;font-weight:bold'
    );

    // Always show the episode/character split, not just a combined count —
    // "0 entities" was never distinguishable from "0 episodes, 3 characters"
    // at a glance before, which is exactly how a missing-episodes bug hid
    // behind a green badge. Char count is here too now, since "it's injecting
    // way too much text" was previously only visible by manually measuring
    // window.LoreFetchLastContext.
    const episodeCount = (state.corpus.episodes || []).length;
    const characterCount = (state.corpus.characters || []).length;
    const counts = `${episodeCount} episode${episodeCount === 1 ? '' : 's'}, ${characterCount} character${characterCount === 1 ? '' : 's'} loaded \u2014 ${active.length} active, ${mentionedOnly.length} mentioned-only \u2014 ${text.length} chars in context`;

    if (state.status === 'partial') {
      setBadgeState(
        'partial',
        `<strong>${state.parsed.fandom}</strong>${arcsLabel ? ' — ' + arcsLabel : ''}<br>${counts}<br><span style="color:#f0b429">${state.partialReason || 'Incomplete: 0 episodes were resolved for one or more of these arcs.'}</span>`
      );
    } else {
      setBadgeState(
        'success',
        `<strong>${state.parsed.fandom}</strong>${arcsLabel ? ' — ' + arcsLabel : ''}<br>${counts}`
      );
    }
  }

  // ================= Detect chat switches =================
  let currentChatId = null;
  let recheckTimer = null;
  let rescanTimer = null;

  function stopRechecking() {
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = null;
    if (rescanTimer) clearInterval(rescanTimer);
    rescanTimer = null;
  }

  // Bumped on every real chat switch. In-flight async work captures the
  // value at the moment it started; if that no longer matches by the time
  // the work resolves, a *different* chat is now active and the result is
  // stale — discard it instead of writing it into the shared badge/timers.
  // Without this, an old chat's late-arriving success or error can paint
  // over whatever chat you've since switched to.
  let activeGeneration = 0;

  function onChatOpened(chatId, opts) {
    stopRechecking();
    const myGeneration = ++activeGeneration;
    setBadgeState('working', 'Reading this chat\u2019s agent\u2026');
    const wantsForceRefresh = !!(opts && opts.forceRefresh);
    let forceRefreshConsumed = false;

    let activeState = null;
    let announcedNewChat = false;
    // Re-entrancy guard: a single tick() can easily outlive
    // RECHECK_INTERVAL_MS (3s) — a content-heavy fandom paginated across
    // several categories, each batch capped at REQUEST_TIMEOUT_MS (25s),
    // can take well over a minute end to end. Without this flag the recheck
    // interval below fires another tick() on top of the one still running,
    // every 3s, indefinitely — stacking up concurrent duplicate fetches
    // against the same wiki, which is what trips Fandom's rate limit and
    // makes the badge flap between whichever attempt happens to resolve
    // last.
    let tickInFlight = false;
    const startedAt = Date.now();

    const tick = () => {
      if (tickInFlight) return;
      tickInFlight = true;
      // Only the very first tick of a load consumes the forceRefresh flag —
      // fetchLoreCorpus's own internal batch loop already reuses the same
      // (forceRefresh-tagged) params for every /api/lore call it makes
      // within this one load, so this only needs to fire once per load, not
      // once per RECHECK_INTERVAL_MS poll.
      const useForceRefresh = wantsForceRefresh && !forceRefreshConsumed;
      forceRefreshConsumed = true;
      loadCorpusForChat(chatId, () => myGeneration !== activeGeneration, useForceRefresh)
        .then((result) => {
          if (myGeneration !== activeGeneration) return; // stale — a different chat is active now
          if (result.status === 'no-chat') {
            setBadgeState('working', 'Waiting for this chat to finish loading\u2026');
          } else if (result.status === 'no-agent') {
            setBadgeState('skipped', "This chat isn't linked to an agent, so there's no lore to fetch.");
            stopRechecking();
          } else if (result.status === 'skipped') {
            setBadgeState('skipped', "This agent's instructions don't match the fandom template — nothing to fetch.");
            stopRechecking();
          } else if (result.status === 'error') {
            const detail = (result.warnings || []).join('<br>') || 'Could not find matching wiki content.';
            setBadgeState('error', `<strong>${result.fandom || ''}</strong>${result.arc ? ' — ' + result.arc : ''}<br>${detail}`);
            stopRechecking();
          } else if (result.status === 'ready' || result.status === 'partial') {
            activeState = result;
            clearInterval(recheckTimer);
            recheckTimer = null; // corpus is loaded — the rescan loop takes over from here
            rescanAndInject(activeState).catch((err) => console.error('[LoreFetch] rescan failed:', err));
            rescanTimer = setInterval(() => {
              if (myGeneration !== activeGeneration) {
                // Chat switched since this loop started; stop painting stale data
                // and free the interval (belt-and-suspenders — stopRechecking()
                // on the new chat should already have cleared it, but this
                // interval was only created because a stale generation slipped
                // past the check above once already; don't let it run forever).
                clearInterval(rescanTimer);
                return;
              }
              rescanAndInject(activeState).catch((err) => console.error('[LoreFetch] rescan failed:', err));
            }, ENTITY_RESCAN_MS);
          }
        })
        .catch((err) => {
          if (myGeneration !== activeGeneration) return; // stale — a different chat is active now
          if (err && err.cancelled) return; // we deliberately stopped this load; nothing to report
          console.error('[LoreFetch] load attempt failed:', err);
          setBadgeState('error', String((err && err.message) || err));
          stopRechecking();
        })
        .finally(() => {
          tickInFlight = false;
        });
    };

    tick();
    recheckTimer = setInterval(() => {
      if (myGeneration !== activeGeneration) {
        clearInterval(recheckTimer);
        return;
      }
      if (activeState) return; // corpus already loaded; rescanTimer owns updates now
      if (tickInFlight) return; // previous tick hasn't resolved yet — don't pile another one on top of it
      const timedOut = Date.now() - startedAt > RECHECK_DURATION_MS;
      if (timedOut) {
        // A brand-new, never-sent chat has no storage record at all yet —
        // that's not a failure, it's just not created until you send a
        // message. Keep quietly rechecking instead of erroring.
        if (!announcedNewChat) {
          announcedNewChat = true;
          setBadgeState('skipped', "New chat — I'll fetch lore once you send your first message.");
        }
        tick();
        return;
      }
      tick();
    }, RECHECK_INTERVAL_MS);
  }

  function checkForChatChange() {
    const chatId = getCurrentChatId();
    if (chatId && chatId !== currentChatId) {
      console.log(`[LoreFetch] chat switch detected: ${currentChatId} -> ${chatId}`);
      currentChatId = chatId;
      onChatOpened(chatId);
    }
  }

  // TypingMind is a single-page app. If it updates the address bar's #chat=
  // fragment via history.pushState()/replaceState() (the standard SPA way to
  // change the URL without a real navigation), the browser's native
  // 'hashchange' event never fires — per spec, pushState/replaceState never
  // trigger hashchange or popstate on their own, only real navigations
  // (typed URL, link click, back/forward) do. That would explain exactly the
  // "stuck on the previous chat" symptom: checkForChatChange() correctly
  // catches whatever chat is open at page load, but never runs again after
  // that, no matter how many chats you open afterward.
  //
  // So: patch both history methods to also run our check, listen for
  // popstate (back/forward), keep the hashchange listener too (cheap, and
  // covers the case where the hash *is* set directly), and poll on a short
  // interval as a last-resort safety net in case the hash changes through
  // some other mechanism entirely.
  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      checkForChatChange();
      return result;
    };
  }
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  watchForSidebarMount();
  window.addEventListener('hashchange', checkForChatChange);
  window.addEventListener('popstate', checkForChatChange);
  setInterval(checkForChatChange, HASH_POLL_MS);
  checkForChatChange(); // in case a chat is already open when this extension loads
})();
