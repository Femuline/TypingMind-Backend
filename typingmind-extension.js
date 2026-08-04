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
  const CHAT_TEXT_SCAN_MESSAGES = 40; // how many of the most recent messages to scan for character/episode mentions
  const MARKER_PREFIX = '<!-- lorefetch:'; // marks our injected block so we can find/replace it
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

  async function fetchLoreCorpus(params, onProgress) {
    // Each /api/lore call is a separate serverless invocation with its own
    // fresh `warnings` array — lore.js doesn't (and can't, statelessly)
    // persist warnings from one batch to the next. If we only kept the
    // final done:true call's warnings, everything flagged during the
    // batches leading up to it (e.g. "no Plot subpage/section found — used
    // the page intro instead") would just vanish, even though that's
    // exactly the kind of thing worth surfacing.
    const allWarnings = [];
    for (;;) {
      const result = await callLoreApiOnce(params);
      if (result.error) throw new Error(result.error);
      if (Array.isArray(result.warnings) && result.warnings.length) allWarnings.push(...result.warnings);
      if (result.done) return { ...result, warnings: allWarnings };
      debugLog(`batch progress: ${result.fetched} fetched this call, ${result.remaining} left of ${result.total}`);
      if (onProgress) onProgress(result);
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

  const BADGE_COLORS = { idle: '#9ca3af', working: '#f0b429', success: '#45c97a', skipped: '#9ca3af', error: '#f04545' };
  const BADGE_TOOLTIPS = { idle: 'Lore', working: 'Fetching lore…', success: 'Lore fetched', skipped: 'Lore — not applicable', error: 'Lore — error' };

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
  async function loadCorpusForChat(chatId) {
    const chatEntry = await resolveStorageKey(chatId);
    if (!chatEntry) return { status: 'no-chat' };
    const chat = chatEntry.value;

    const agentId = chat.character && chat.character.id;
    if (!agentId) return { status: 'no-agent' };

    const agent = await resolveAgentRecord(agentId);
    if (!agent || !agent.instruction) return { status: 'no-agent' };

    const parsed = parseSystemPrompt(agent.instruction);
    if (!parsed || !parsed.fandom) return { status: 'skipped' };

    try {
      const corpus = await fetchLoreCorpus(parsed, (progress) => {
        setBadgeState('working', `Fetching lore\u2026 ${progress.total - progress.remaining}/${progress.total} pages`);
      });
      if (corpus.warnings && corpus.warnings.length) console.log('[LoreFetch] notes:', corpus.warnings);
      const entityIndex = buildEntityIndex(corpus);
      window.LoreFetchLastWarnings = corpus.warnings || [];
      if (!entityIndex.length) {
        return { status: 'error', warnings: corpus.warnings, fandom: parsed.fandom, arc: parsed.arc };
      }
      return { status: 'ready', chatKey: chatEntry.key, agentId, parsed, corpus, entityIndex, lastMatchedKey: null };
    } catch (err) {
      return { status: 'error', warnings: [err.message], fandom: parsed.fandom, arc: parsed.arc };
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
    const chatText = extractRecentChatText(chat, CHAT_TEXT_SCAN_MESSAGES);
    const matched = matchEntities(state.entityIndex, chatText);
    const matchedKey = matched.map((m) => `${m.type}:${m.names[0]}`).sort().join('|');
    if (matchedKey === state.lastMatchedKey) return;

    const marker = `${MARKER_PREFIX}${state.agentId}:${state.parsed.fandom}:${state.parsed.arc || ''} -->`;
    const injected = composeInjection(matched, state.corpus.wiki, state.parsed.arc);
    const text = injected ? `${marker}\n${injected}` : `${marker}\n(No characters or episodes from this fandom have come up in the chat yet.)`;
    window.LoreFetchLastContext = text;

    const existing = (chat.chatParams && chat.chatParams.systemMessage) || '';
    const base = stripPreviousInjection(existing);
    chat.chatParams = chat.chatParams || {};
    chat.chatParams.systemMessage = base ? `${base}\n\n${text}` : text;
    await kvPut(chatEntry.key, chat);
    state.lastMatchedKey = matchedKey;

    debugLog(`rescan: ${matched.length}/${state.entityIndex.length} entities matched ->`, matched.map((m) => m.names[0]));
    console.log(`%c[LoreFetch] Injected ${matched.length} matching entit${matched.length === 1 ? 'y' : 'ies'}.`, 'color:#45f0a0;font-weight:bold');
    setBadgeState(
      'success',
      `<strong>${state.parsed.fandom}</strong>${state.parsed.arc ? ' — ' + state.parsed.arc : ''}<br>${matched.length} entit${matched.length === 1 ? 'y' : 'ies'} currently in context`
    );
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

  function onChatOpened(chatId) {
    stopRechecking();
    const myGeneration = ++activeGeneration;
    setBadgeState('working', 'Reading this chat\u2019s agent\u2026');

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
      loadCorpusForChat(chatId)
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
            setBadgeState('error', `<strong>${result.fandom || ''}</strong><br>${detail}`);
            stopRechecking();
          } else if (result.status === 'ready') {
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
