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
 *   3. Parses out {arc, year, media, fandom} from instructions shaped
 *      like: "Portray canon characters in season 5 of the 1998 show
 *      Charmed."
 *   4. Calls YOUR OWN lore API (see LORE_API_BASE below — a Vercel
 *      function backed by Supabase, api/lore.js in this same delivery)
 *      to get the full episode Plot text + character bio/powers/
 *      relationships/trivia bullets for that fandom+arc. The API does
 *      the actual Fandom fetching and permanent storage; this script
 *      never talks to Fandom directly anymore.
 *   5. Continuously rescans the chat's own messages for character/
 *      episode mentions, and writes ONLY the matching lore into that
 *      chat's chatParams.systemMessage — so the bot gets the exact
 *      canon it needs as the conversation moves, not everything at
 *      once and not a size-capped chunk of it.
 *
 * DEBUGGING:
 * Start with `await window.LoreFetchDiagnose()`. It asks the server what it
 * thinks should exist versus what's actually in Supabase for the current
 * chat's fandom/arc, and prints the gaps: every episode-category guess and
 * its member count (not just the first one that won), which lore_wikis row
 * is in use, whether OTHER lore_wikis rows also match this fandom, which
 * resolved titles have no row, which rows have an empty plot, and what
 * `arc` values are actually stored. Read that before reaching for
 * LoreFetchRefresh() — it tells you whether the problem is category
 * resolution, page fetching, or where you're looking in the table.
 * Reading the output, in order:
 *   - arcValuesInDb is {"(null)": N} or a different season → the rows are
 *     there; your query's arc filter is what's wrong.
 *   - wikiCandidates lists more than one row with episodes → duplicate
 *     lore_wikis rows; the badge and your query are reading different
 *     wiki_ids.
 *   - episodeCategoryWinner.arcScoped is false and arcFilterApplied says
 *     "no-op" → you have the whole series, not the requested arc, and the
 *     titles aren't the ones you expect.
 *   - missingFromDb is non-empty → a genuine fetch/cache failure; that's
 *     what LoreFetchRefresh() is for.
 *   - everything looks right but totalEpisodeRowsForWiki is 0 → the
 *     deployment is pointed at a different Supabase project than the
 *     dashboard you're looking at.
 * After any fetch (successful or not), the exact text that was/would be
 * injected is on `window.LoreFetchLastContext`, that run's warnings on
 * `window.LoreFetchLastWarnings`, and the last diagnosis on
 * `window.LoreFetchLastDiagnosis`.
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
 * A badge showing amber with "Lore — incomplete" (not the green "Lore
 * fetched") means an arc was requested but 0 episodes were resolved for
 * it — only character info made it into context. Click the badge (or
 * check window.LoreFetchLastWarnings) to see which category lookup failed.
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

  // Only needed if you set LORE_DIAGNOSE_TOKEN on the server to gate
  // mode:'diagnose' (see the SECURITY note in lore.js's header). Leave null
  // if you didn't. Sent as the x-lore-token header on diagnose calls only.
  const LORE_DIAGNOSE_TOKEN = null;

  // ---------- Tunables ----------
  const REQUEST_TIMEOUT_MS = 25000; // a single batch call to /api/lore, including its own Fandom fetches server-side
  // Diagnose probes EVERY category guess instead of stopping at the first
  // hit (~10 Fandom calls on a cold cache), so it needs more headroom than
  // a normal batch call before we call it dead.
  const DIAGNOSE_TIMEOUT_MS = 45000;
  const RECHECK_INTERVAL_MS = 3000; // how often to poll while waiting for chat/agent data (or the next fetch batch)
  const RECHECK_DURATION_MS = 30000; // how long to keep polling for chat/agent data before giving up
  const ENTITY_RESCAN_MS = 5000; // once lore is loaded, how often to re-scan the chat for mentions and refresh the injection
  const CHAT_TEXT_SCAN_MESSAGES = 40; // how many of the most recent messages to scan for character/episode mentions
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
  const MEDIA_TYPES = ['show', 'movie', 'game', 'comic', 'webtoon'];

  const PROMPT_PATTERN = new RegExp(
    `portray canon characters in\\s+(?:(season|arc|chapter|book|part)\\s+(\\d+)\\s+of\\s+)?(?:the\\s+)?(?:(\\d{4})\\s+)?(${MEDIA_TYPES.join('|')})\\s+(.+?)\\.`,
    'i'
  );

  function parseSystemPrompt(instruction) {
    if (!instruction) return null;
    const m = instruction.match(PROMPT_PATTERN);
    if (!m) return null;
    const [, arcLabel, arcNumber, year, media, fandom] = m;
    const arc = arcLabel ? `${arcLabel[0].toUpperCase()}${arcLabel.slice(1)} ${arcNumber}` : null;
    const trimmedFandom = fandom.trim();
    if (!trimmedFandom) return null;
    return { arc, year: year || null, media: media.toLowerCase(), fandom: trimmedFandom };
  }

  // ================= Lore API (fetching/parsing/storage now all live server-side) =================
  // Calls your api/lore.js. That endpoint only does a small batch of Fandom
  // page fetches per call (see its own comment header for why), so this
  // loops until it reports done:true, surfacing progress via onProgress.
  async function callLoreApiOnce(params, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (opts && opts.token) headers['x-lore-token'] = opts.token;
    try {
      const res = await fetch(`${LORE_API_BASE}/api/lore`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      // Don't throw on a non-2xx before reading the body — lore.js returns
      // its own {error} JSON with a 401/500, and that message is far more
      // useful than a bare status code.
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error((data && data.error) || `lore API HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`lore API request timed out after ${Math.round(timeoutMs / 1000)}s`);
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
            `stuck at ${progressCount}/${result.total} for ${STALL_ROUNDS} rounds straight — one or more pages are failing every attempt, including the fallback that's supposed to cache the failure so it can be skipped.${stuckOn} Recent warnings: ${summarizeWarnings(allWarnings)} — run await window.LoreFetchDiagnose() for a full picture.`
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

  // ================= Entity index + chat-aware matching =================
  // Turns the corpus into one lookup-able block per episode/character, then
  // matches those against whatever's actually been said in the chat, so we
  // only ever inject lore that's relevant right now.
  function buildEntityIndex(corpus) {
    const entities = [];
    for (const ep of corpus.episodes || []) {
      if (!ep.plot) continue;
      entities.push({ type: 'episode', names: [ep.title], block: `### ${ep.title}\n${ep.plot}` });
    }
    for (const ch of corpus.characters || []) {
      const parts = [];
      if (ch.history && ch.history.length) parts.push(`**History**\n${ch.history.map((b) => `- ${b}`).join('\n')}`);
      if (ch.powers && ch.powers.length) parts.push(`**Powers/Abilities**\n${ch.powers.map((b) => `- ${b}`).join('\n')}`);
      if (ch.relationships && ch.relationships.length) parts.push(`**Relationships**\n${ch.relationships.map((b) => `- ${b}`).join('\n')}`);
      if (ch.trivia && ch.trivia.length) parts.push(`**Trivia**\n${ch.trivia.map((b) => `- ${b}`).join('\n')}`);
      if (!parts.length) continue;
      // A character's own page title is usually their full name ("Piper
      // Halliwell"); add the bare first word too (mostly first name) so a
      // chat that just says "Piper" still matches.
      const firstWord = ch.name.split(' ')[0];
      const names = firstWord && firstWord !== ch.name ? [ch.name, firstWord] : [ch.name];
      entities.push({ type: 'character', names, block: `### ${ch.name}\n${parts.join('\n')}` });
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

  function composeInjection(matched, wiki, arc) {
    if (!matched.length) return '';
    let text = `Canon reference: ${wiki.sitename}\nSource: ${wiki.url}\n`;
    if (arc) text += `Scoped to: ${arc}\n`;
    text += `\n${matched.map((e) => e.block).join('\n\n')}`;
    return text.trim();
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

  function extractRecentChatText(chat, limit) {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    return messages.slice(-limit).map(extractMessageText).join('\n');
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

  // ================= Chat -> agent -> lore params =================
  // Walks chat record -> linked agent -> parsed {arc, year, media, fandom}.
  // Shared by the normal load path and LoreFetchDiagnose so the diagnostic
  // is guaranteed to be asking about the exact same params a real fetch
  // would use — a separately-written copy of this chain could drift and
  // then "diagnose" something the fetcher never actually requested.
  // Status values match what loadCorpusForChat reports to the badge:
  // 'no-chat' | 'no-agent' | 'skipped' | 'ok'.
  async function getChatLoreParams(chatId) {
    const chatEntry = await resolveStorageKey(chatId);
    if (!chatEntry) return { status: 'no-chat' };

    const agentId = chatEntry.value.character && chatEntry.value.character.id;
    if (!agentId) return { status: 'no-agent' };

    const agent = await resolveAgentRecord(agentId);
    if (!agent || !agent.instruction) return { status: 'no-agent' };

    const parsed = parseSystemPrompt(agent.instruction);
    if (!parsed || !parsed.fandom) return { status: 'skipped' };

    return { status: 'ok', chatEntry, agentId, parsed };
  }

  // ================= Diagnostics =================
  // Asks the server what it thinks should exist versus what's actually in
  // Supabase for the CURRENT chat's fandom/arc, then prints the gaps.
  // Purely read-only on the episode/character tables — safe to run any
  // time, including mid-fetch. See this file's header for how to read the
  // output. Returns the raw report (also parked on
  // window.LoreFetchLastDiagnosis) so you can poke at it yourself.
  window.LoreFetchDiagnose = async function (chatId) {
    const resolved = await getChatLoreParams(chatId || getCurrentChatId());
    if (resolved.status !== 'ok') {
      const why = {
        'no-chat': "no chat record yet — a brand-new chat isn't stored until you send a message",
        'no-agent': "this chat isn't linked to an agent with instructions",
        skipped: "this agent's instructions don't match the fandom template",
      };
      console.warn(`[LoreFetch] can't diagnose: ${why[resolved.status] || resolved.status}`);
      return null;
    }

    console.log('%c[LoreFetch] diagnosing…', 'color:#f0b429;font-weight:bold', resolved.parsed);
    let report;
    try {
      report = await callLoreApiOnce(
        { ...resolved.parsed, mode: 'diagnose' },
        { timeoutMs: DIAGNOSE_TIMEOUT_MS, token: LORE_DIAGNOSE_TOKEN }
      );
    } catch (err) {
      console.error('[LoreFetch] diagnose request failed:', (err && err.message) || err);
      return null;
    }
    window.LoreFetchLastDiagnosis = report;

    if (report.error) {
      console.error('[LoreFetch] diagnose failed:', report.error);
      if (report.wikiResolveAttempts) console.error('[LoreFetch] wiki resolve attempts:', report.wikiResolveAttempts);
      return report;
    }

    console.log('%c[LoreFetch] request', 'font-weight:bold', report.request);
    console.log('%c[LoreFetch] wiki used', 'font-weight:bold', report.wikiUsed);
    if ((report.wikiCandidates || []).length > 1) {
      console.warn('[LoreFetch] MULTIPLE lore_wikis rows match this fandom — episodes may be split across them:');
      console.table(report.wikiCandidates);
    }

    console.log('%c[LoreFetch] episode category guesses (in the order they are tried)', 'font-weight:bold');
    console.table(report.episodeCategoryProbes);
    console.log(
      `%c[LoreFetch] winner: ${report.episodeCategoryWinner ? report.episodeCategoryWinner.name : 'NONE'} ` +
        `(arcScoped=${report.episodeCategoryWinner ? report.episodeCategoryWinner.arcScoped : 'n/a'}) ` +
        `-> ${report.resolvedEpisodeCount} titles, arcFilter=${report.arcFilterApplied}`,
      'font-weight:bold'
    );
    if (report.episodeCategoryWinner && report.episodeCategoryWinner.arcScoped === false && report.request.arc) {
      console.warn(
        `[LoreFetch] the winning category is NOT scoped to "${report.request.arc}" — these titles are probably the whole series.`
      );
    }

    console.log('%c[LoreFetch] resolved episode titles vs. what is in the DB', 'font-weight:bold');
    console.table(report.episodes);

    console.log('%c[LoreFetch] arc values as actually stored in lore_episodes', 'font-weight:bold', report.arcValuesInDb);
    console.log(`[LoreFetch] ${report.totalEpisodeRowsForWiki} total episode rows exist for wiki_id ${report.wikiUsed.id}`);
    console.log(
      '%c[LoreFetch] character category winner', 'font-weight:bold',
      report.characterCategoryWinner || 'NONE'
    );

    if ((report.missingFromDb || []).length) {
      console.warn('[LoreFetch] resolved but NOT in the DB (real fetch/cache failure — LoreFetchRefresh() is for this):', report.missingFromDb);
    }
    if ((report.inDbButEmptyPlot || []).length) {
      console.warn('[LoreFetch] in the DB but the plot column is empty (placeholder from a failed fetch):', report.inDbButEmptyPlot);
    }
    if ((report.orphanRowsSample || []).length) {
      console.info('[LoreFetch] rows for this wiki that the current arc request does NOT ask for:', report.orphanRowsSample);
    }
    if (!(report.missingFromDb || []).length && !(report.inDbButEmptyPlot || []).length && report.resolvedEpisodeCount > 0) {
      console.log(
        '%c[LoreFetch] every resolved episode has a row with plot text. If you cannot find them in the table, check wiki_id and the arc values printed above (or whether this deployment points at the Supabase project you are browsing).',
        'color:#45c97a'
      );
    }
    return report;
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
  // Fandom) for a full season. Run LoreFetchDiagnose() first — it's
  // read-only and usually identifies the problem without the re-fetch.
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
        'and window.LoreFetchLastWarnings, run await window.LoreFetchDiagnose(), or set ' +
        'window.LoreFetchDebug = true for a full trace. If you can, right-click the Sync icon in your ' +
        'sidebar, Inspect it, and share the outer HTML so the selector can be corrected.'
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
    document.body.appendCh
