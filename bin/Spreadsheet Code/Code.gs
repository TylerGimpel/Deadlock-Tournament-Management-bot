// Bot version: 20261002.1
/**
 * =====================================================================
 * Deadlock Tournament Management Bot for Google Sheets
 * =====================================================================
 *
 * Pulls completed Deadlock draft + match results (picks, bans, match ID,
 * winner, game length) from Statlocker's REST Draft API directly into a
 * Google Sheet - no manual copying, no images, no formulas.
 *
 * This file (Code.gs) is the server-side half of the tool. It must be
 * paired with Sidebar.html in the same Apps Script project - the
 * sidebar is the entire UI, including its collapsible Settings panel.
 *
 * ---------------------------------------------------------------------
 * HOW FETCHING WORKS
 * ---------------------------------------------------------------------
 * Everything runs server-side in this file using UrlFetchApp, batched:
 *   - Every draft code found is grouped into batches of 25 and fetched
 *     with POST /api/public-draft/drafts (1 request per 25 drafts).
 *   - Every distinct matchId that comes back is grouped into batches
 *     and fetched from /api/public/matches (falling back to one
 *     GET /api/public/match/{id} per match if the batch call fails -
 *     see the note near MATCH_BATCH_SIZE below).
 * The sidebar just triggers a fetch and shows the summary it returns.
 * The API key never leaves the server - it's not sent to the browser.
 *
 * ---------------------------------------------------------------------
 * INSTALL
 * ---------------------------------------------------------------------
 * Steps 5-7 below (all the Script Properties, plus the Web App
 * deployment) can be done through Deadlock Tournament Management Bot > Setup Wizard once
 * steps 1-4 are done, instead of by hand - it walks through the same
 * values with inline validation and live "test connection" checks, and
 * lets you skip anything you don't have yet and come back later. The
 * manual steps below still work exactly the same if you'd rather not
 * use it, and are what the wizard is calling under the hood.
 *
 * 1. Open the Google Sheet you want to use this in.
 * 2. Extensions > Apps Script.
 * 3. Replace the default Code.gs with the contents of this file.
 * 4. Add a new HTML file (Files > + > HTML) named "Sidebar" (capital S,
 *    no .html extension needed) with Sidebar.html's contents.
 * 5. Project Settings (gear icon) > Script Properties > Add property.
 *    Name it STATLOCKER_API_KEY and paste in your Statlocker API key
 *    (looks like sk_ followed by 64 letters/numbers).
 * 6. If you're using "Create Match Threads" (see USE below), Discord
 *    calls are routed through a small relay you deploy yourself
 *    (discord-relay-worker.js, a free Cloudflare Worker) rather than
 *    calling discord.com directly - Apps Script's shared IPs are prone
 *    to being blocked by Discord's Cloudflare layer. Follow the setup
 *    steps at the top of discord-relay-worker.js, then add two Script
 *    Properties here: DISCORD_RELAY_URL (the worker's URL) and
 *    DISCORD_RELAY_SECRET (the shared secret you set on the worker).
 *    Skip this step if you only need the Statlocker side.
 * 7. If you want a team's side choice (see USE step 7) to swap Team 1/
 *    Team 2 in the sheet automatically, AND/OR you want a Statlocker
 *    draft auto-created on side selection to have its URL land in the
 *    sheet by itself (see USE step 8): Deploy > New deployment > type
 *    "Web app" > Execute as "Me" > Who has access "Anyone". Copy the
 *    resulting URL. Add a Script Property SHEET_WEBHOOK_SECRET with a
 *    secret string of your own choosing, then set that same URL and
 *    secret on the worker (SHEET_WEBHOOK_URL / SHEET_WEBHOOK_SECRET -
 *    see discord-relay-worker.js). Both behaviors share this one
 *    deployment/secret - there's nothing extra to configure to get
 *    both at once. IMPORTANT for future updates: if you edit this file
 *    later, use Deploy > Manage deployments > pencil icon > New version
 *    on this SAME deployment, not "New deployment" - that keeps the URL
 *    stable so you never have to update the worker's SHEET_WEBHOOK_URL
 *    again. Skip this step entirely if you don't need either behavior.
 * 8. Save everything, then reload the Google Sheet tab (not the script
 *    editor) so the menu below appears.
 *
 * ---------------------------------------------------------------------
 * USE
 * ---------------------------------------------------------------------
 * 1. Fill in Team 1, Team 2, and the Draft URL (or bare draft code)
 *    columns for each row, per the column layout in the sidebar's
 *    Settings panel (Deadlock Tournament Management Bot > Open Sidebar > ▼
 *    Settings). Team 1/Team 2 may be in the wrong order relative to
 *    the draft - that's fine, see step 3.
 * 2. Menu: Deadlock Tournament Management Bot > Open Sidebar, then click "Fetch
 *    Draft Data". No selection needed - every row is read straight
 *    from the configured Draft URL column (column H by default).
 * 3. For each row with a recognizable draft code:
 *      - Team 1/Team 2 names are filled in ONLY if currently blank.
 *      - The draft's actual team order is compared against whatever
 *        is already in your Team 1/Team 2 cells (case-insensitively).
 *        If they're reversed, picks/bans/winner are written to the
 *        CORRECT side automatically - your Team 1/Team 2 columns are
 *        never edited to "fix" the order, only the data around them
 *        is aligned to match.
 *      - Match ID, Winner (as your team's existing name/text), Match
 *        Length, and every pick/ban are written per the configured
 *        column layout.
 *      - If the script can't confidently tell which side is which
 *        (e.g. team names don't match at all), that row is written
 *        WITHOUT swapping and flagged in the summary so you can check
 *        it by hand.
 * 4. If a match hasn't finished yet, Winner and Match Length are just
 *    left blank - re-run "Fetch Draft Data" later (e.g. once results
 *    are in) and it'll pick up where it left off. Each row's two
 *    "halves" are skipped independently once they're already done, so
 *    re-running is cheap: a row whose picks/bans are already written
 *    won't be re-fetched for that part, and a row whose Match ID/
 *    Winner/Match Length are already all filled in won't trigger a
 *    match lookup either. A row that's fully done on both counts is
 *    skipped entirely, before any API call is made for it.
 * 5. The sidebar's Settings panel lets you change which columns
 *    everything reads/writes to (no code editing required) and toggle
 *    debug logging, which surfaces raw request/response text in a
 *    copyable field on the sidebar itself.
 * 6. "Create Match Threads" posts one forum thread per match into your
 *    configured Discord matches forum, tagging both teams' Discord
 *    roles (matched by exact name against Team 1/Team 2), and writes
 *    the placeholder text "waiting for draft" into that row's Draft
 *    URL column so the row is never double-processed. Needs the
 *    Discord Server ID, Matches Forum Channel ID, and a message
 *    template set in Settings first - see the MATCH THREAD CREATION
 *    section further down for exactly how rows are selected.
 *
 *    BEST-OF-X: if two or more SEQUENTIAL rows (adjacent row numbers,
 *    nothing skipped in between) have the exact same Team 1 and Team 2
 *    text, they're treated as one best-of-X series and get exactly ONE
 *    thread between them - no matter how long that thread gets as the
 *    series plays out. Each individual game still gets recorded on its
 *    own row (its own draft URL, picks/bans, winner, etc) - only the
 *    Discord thread is shared. A run of 3 such rows is a best-of-3, 5
 *    rows a best-of-5, and so on; a row with no matching neighbor is
 *    just an ordinary best-of-1. See buildMatchThreadEntries_ for the
 *    grouping rule and the MATCH THREAD CREATION section for how a
 *    series' rows are placeholder-stamped together.
 *
 *    SIDE SELECTION OVERRIDE: if, for a given row, exactly ONE of that
 *    row's Team 1/Team 2 cells is bold (bold on both, or neither, does
 *    nothing), that team gets automatic choice priority (choosing side
 *    or pick order first, as if they'd won the coinflip) for that game -
 *    no coinflip for game 1, and the losers-pick rule is skipped for
 *    later games in a series. This is checked per row/game, so a
 *    best-of-3 can have game 1 decided by coinflip, game 2 overridden
 *    by a bold cell, and game 3 back to the normal losers-pick rule.
 *    Bold is read once, at "Create Match Threads" time, for every row
 *    in the series (even games that haven't started yet) - see
 *    getSideSignalsForRow_ and buildMatchThreadEntries_.
 *
 *    UNDERLINE OVERRIDE (Hidden King lock): also checked at "Create
 *    Match Threads" time, alongside bold, but stronger - it decides
 *    the side outright, not just who chooses first:
 *      - Exactly ONE of a row's Team 1/Team 2 cells underlined -> that
 *        team is placed on Hidden King automatically for that game, no
 *        coinflip and no side choice; the Archmother team is asked to
 *        choose First/Second Pick, then the draft is created.
 *      - BOTH cells underlined, on game 2 or later of a series -> the
 *        two teams swap sides from the previous game (last game's
 *        Hidden King becomes Archmother, and vice versa), again with
 *        no coinflip/side choice - the new Archmother team chooses
 *        pick order.
 *      - BOTH cells underlined on game 1 of a series (nothing to swap
 *        from yet), one team underlined while the other is bold, or
 *        any single cell that's both bold AND underlined, are all
 *        treated as ambiguous - the row falls back to the standard
 *        coinflip/losers-pick rule as if neither bold nor underline
 *        were set at all. See getSideSignalsForRow_.
 * 7. Side and pick order are chosen separately in Discord: the team
 *    that wins the coinflip (or has a bold override, or lost the
 *    previous game in a series) chooses whether to pick their side
 *    (Hidden King/Archmother) or their pick order (First/Second Pick),
 *    makes that choice, and the other team makes the remaining one.
 *    Once both are chosen, whichever team has First Pick is swapped
 *    into the Team 1 cell if it isn't already there (Team 2 gets the
 *    other team) - so Team 1 always means "First Pick" from that point
 *    on - and the two cells are colored by side (SIDE_A_COLOR for
 *    Hidden King, SIDE_B_COLOR for Archmother). This happens
 *    automatically, pushed from the Worker straight into the sheet -
 *    see applySideAndPickOrder_ further down, and INSTALL step 7 for
 *    the one-time setup it needs.
 * 8. If the Worker also auto-creates a Statlocker draft once a side is
 *    chosen, that draft's URL is written into the row's Draft URL
 *    column automatically too - no need to paste it in by hand, and no
 *    separate setup beyond INSTALL step 7 above (same webhook as the
 *    side swap). See doPost/writeDraftUrl_ further down.
 * 9. Once a side is chosen and a Statlocker draft is created (step 8),
 *    the message announcing that carries a "Match Complete" button
 *    right under the draft URL. Pressing it removes the button (for
 *    good - it can't be clicked again) and runs Fetch Draft Data for
 *    just that row: if Statlocker already has a winner, it's reported
 *    right there; if not (e.g. the match hasn't linked yet), the bot
 *    posts two buttons - one per team - so a player can record the
 *    winner by hand instead. A manually-recorded winner is never
 *    overwritten by a later automatic one that disagrees - it's just
 *    left as whichever was recorded first. Uses the same relay/secret
 *    as steps 6-8 above - nothing extra to configure.
 * 10. If the row that just got a winner is part of a best-of-X series
 *    (step 6) and the series isn't decided yet, the bot automatically
 *    moves on to the next row in that same block: it gives choice
 *    priority (side or pick order first) to the team that just LOST
 *    the game (standard best-of-X practice), and once both choices are
 *    made, steps 7-9 repeat for that
 *    next row, all inside the SAME thread. This continues until one
 *    team reaches a majority of the series' rows (2 of 3, 3 of 5, ...),
 *    at which point the bot posts the series result and stops - no new
 *    thread is ever created partway through a series. Nothing extra to
 *    configure beyond step 6.
 * =====================================================================
 */

// Adds the "Deadlock Tournament Management Bot" menu to the Google Sheets UI when the sheet opens,
// and offers the Setup Wizard automatically (once ever) on a copy that
// doesn't look fully configured yet - see wizardLooksIncomplete_ and
// maybeAutoLaunchWizard_ further down.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Deadlock Tournament Management Bot')
    .addItem('Open Sidebar', 'showDraftSidebar')
    .addSeparator()
    .addItem('Setup Wizard', 'showSetupWizard')
    .addToUi();

  maybeAutoLaunchWizard_();
}

// Opens the Setup Wizard dialog (Deadlock Tournament Management Bot > Setup Wizard, or
// automatically once on an unconfigured copy - see maybeAutoLaunchWizard_).
function showSetupWizard() {
  var html = HtmlService.createHtmlOutputFromFile('SetupWizard')
    .setWidth(640)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Deadlock Tournament Management Bot Setup Wizard');
}

// Opens the sidebar panel where "Fetch Draft Data" lives.
function showDraftSidebar() {
  var candidates = ['Sidebar', 'sidebar', 'SideBar', 'SIDEBAR'];
  var html = null;
  var lastError = null;

  for (var i = 0; i < candidates.length; i++) {
    try {
      html = HtmlService.createHtmlOutputFromFile(candidates[i]);
      break;
    } catch (e) {
      lastError = e;
    }
  }

  if (!html) {
    throw new Error('Could not find the sidebar HTML file. Make sure it is named ' +
      '"Sidebar" (Files > + > HTML in the Apps Script editor). Original error: ' +
      (lastError ? lastError.message : 'unknown'));
  }

  html.setTitle('Deadlock Tournament Management Bot').setWidth(340);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Returns the Statlocker API key from this project's Script Properties.
 * Used only server-side (by callStatlockerApi_ below) - it is never
 * sent to the browser/sidebar.
 * @return {string} the Statlocker API key.
 */
function getStatlockerApiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('STATLOCKER_API_KEY');
  if (!key) {
    throw new Error('Script property "STATLOCKER_API_KEY" is not set. ' +
      'Go to Project Settings > Script Properties and add it.');
  }
  return key;
}

/**
 * Pulls a draft code out of a cell's text, whether it's a bare code
 * (e.g. "RN0YQ791") or a full Statlocker draft URL
 * (e.g. "https://statlocker.gg/draft/RN0YQ791").
 * @param {string} raw
 * @return {string} the draft code, or '' if none could be found.
 */
function extractDraftCode_(raw) {
  var urlMatch = raw.match(/statlocker\.gg\/draft\/([A-Za-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];

  // Not a recognizable URL - treat the whole trimmed value as the code,
  // as long as it looks like one (letters/numbers only).
  if (/^[A-Za-z0-9]+$/.test(raw)) return raw;

  return '';
}

/**
 * =====================================================================
 * STATLOCKER API CONFIG
 * =====================================================================
 */
var DRAFT_BASE = 'https://statlocker.gg/api/public-draft';
var MATCH_BASE = 'https://statlocker.gg/api/public';

// Max draft codes per POST .../drafts call - documented as 25 in the
// Draft API Guide (section 3.3).
var DRAFT_BATCH_SIZE = 25;

// The batch matches endpoint's exact request/response envelope is not
// confirmed against a real response - the per-match fields themselves
// (matchDurationSeconds, amberHandWon) are confirmed; see
// extractMatchDurationSeconds_ and winnerTeamNumberFromMatch_ below.
// The request body here mirrors the confirmed batch drafts endpoint's
// shape ({"matchIds": [...]}, up to 25). If the envelope doesn't match
// what the server actually expects/returns, the call fails and
// fetchMatchesByIds_ falls back to one GET /api/public/match/{id} per
// match, which uses the confirmed single-match shape.
var MATCH_BATCH_SIZE = 25;

/**
 * Calls the Statlocker API and returns parsed JSON. Throws with the
 * server's own error message on failure (see section 7 of the Draft
 * API Guide for the error shape). When DEBUG_MODE is on (see the
 * sidebar's Settings panel), the request and response are collected in
 * DEBUG_LOG_ENTRIES for fetchDraftData() to return to the sidebar as a
 * copyable field, and also written to Logger.log (View > Executions >
 * Logs in the Apps Script editor) as a backup.
 * @param {string} method 'get' or 'post'
 * @param {string} url full URL to call
 * @param {Object=} body request body for POST endpoints
 * @return {*} parsed JSON response
 */
function callStatlockerApi_(method, url, body) {
  var options = {
    method: method,
    headers: { 'X-API-Key': getStatlockerApiKey() },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  if (DEBUG_MODE) {
    var requestLine = '-> ' + method.toUpperCase() + ' ' + url +
      (body ? '\n   body: ' + JSON.stringify(body) : '');
    Logger.log('[Statlocker DEBUG] ' + requestLine);
    DEBUG_LOG_ENTRIES.push(requestLine);
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var rawText = response.getContentText();

  if (DEBUG_MODE) {
    var shownText = rawText.length > 2000 ? rawText.substring(0, 2000) + '...(truncated)' : rawText;
    var responseLine = '<- HTTP ' + code + '\n   ' + shownText;
    Logger.log('[Statlocker DEBUG] ' + responseLine);
    DEBUG_LOG_ENTRIES.push(responseLine);
  }

  var data = null;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    // leave data null - handled below
  }
  if (code >= 400) {
    var msg = (data && data.error) ? data.error : ('HTTP ' + code);
    throw new Error('Statlocker API ' + method.toUpperCase() + ' ' + url + ' failed: ' + msg);
  }
  return data;
}

/**
 * Fetches full draft detail for a list of draft codes, batching 25 at
 * a time via POST /api/public-draft/drafts (Draft API Guide 3.3).
 * @param {Array<string>} codes
 * @return {Object} map of draftCode -> draft detail object. Codes that
 *   don't exist or didn't come back are simply absent from the map.
 */
function fetchDraftsByCodes_(codes) {
  var byCode = {};
  for (var i = 0; i < codes.length; i += DRAFT_BATCH_SIZE) {
    var chunk = codes.slice(i, i + DRAFT_BATCH_SIZE);
    var data = callStatlockerApi_('post', DRAFT_BASE + '/drafts', { codes: chunk });
    var list = Array.isArray(data) ? data : ((data && data.drafts) || []);
    list.forEach(function (d) {
      if (d && d.draftCode) byCode[d.draftCode] = d;
    });
  }
  return byCode;
}

/**
 * Fetches match detail for a list of match IDs, batching via POST
 * /api/public/matches. The batch envelope isn't fully confirmed (see
 * the note above MATCH_BATCH_SIZE) - if the batch call fails for a
 * chunk, this falls back to one GET /api/public/match/{id} per match
 * in that chunk, so a shape mismatch degrades gracefully instead of
 * losing all match data.
 * @param {Array<number>} matchIds
 * @return {Object} map of matchId -> match detail object.
 */
function fetchMatchesByIds_(matchIds) {
  var byId = {};
  for (var i = 0; i < matchIds.length; i += MATCH_BATCH_SIZE) {
    var chunk = matchIds.slice(i, i + MATCH_BATCH_SIZE);
    try {
      var data = callStatlockerApi_('post', MATCH_BASE + '/matches', { matchIds: chunk });
      var list = Array.isArray(data) ? data : ((data && (data.matches || data.results)) || []);
      list.forEach(function (m) {
        var id = m && (m.matchId || m.id);
        if (id) byId[id] = m;
      });
    } catch (e) {
      // Batch endpoint unavailable or shape mismatch - fall back to
      // per-match GET calls for this chunk.
      chunk.forEach(function (id) {
        try {
          var single = callStatlockerApi_('get', MATCH_BASE + '/match/' + id);
          if (single) byId[id] = single;
        } catch (e2) {
          // leave this match missing - caller treats it as "no length data"
        }
      });
    }
  }
  return byId;
}

/**
 * Pulls a match length in seconds out of a match detail object.
 * Confirmed field: matchDurationSeconds.
 * @param {Object} match
 * @return {?number}
 */
function extractMatchDurationSeconds_(match) {
  if (!match) return null;
  var v = match.matchDurationSeconds;
  return (typeof v === 'number' && !isNaN(v)) ? v : null;
}

/**
 * Works out which DRAFT team number (1 or 2) won, from the match's
 * amberHandWon flag plus the draft's own teams array (which carries
 * isAmberTeam per team - see Draft API Guide 3.1/3.2).
 * Confirmed field: match.amberHandWon (true = Hidden King/Amber Hand
 * side won, false = Archmother side won).
 * @param {Object} match
 * @param {Array<Object>} draftTeams the draft's teams array
 * @return {?number} 1, 2, or null if it can't be determined (match
 *   missing/no amberHandWon field/teams don't carry isAmberTeam).
 */
function winnerTeamNumberFromMatch_(match, draftTeams) {
  if (!match || typeof match.amberHandWon !== 'boolean') return null;
  var winningTeam = (draftTeams || []).filter(function (t) {
    return typeof t.isAmberTeam === 'boolean' && t.isAmberTeam === match.amberHandWon;
  })[0];
  return winningTeam ? winningTeam.teamNumber : null;
}

/**
 * Formats a duration in seconds as HH:MM:SS (e.g. 1302 -> "00:21:42").
 * @param {number} seconds
 * @return {string}
 */
function formatDuration_(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

/**
 * =====================================================================
 * DISCORD API
 * =====================================================================
 * Used only by createMatchThreads() below - creates one forum thread
 * per match, tagging both teams' Discord roles. Entirely separate from
 * the Statlocker fetching above, and one-directional: this only ever
 * WRITES to Discord (creates threads); it never reads messages back.
 *
 * Requests do NOT go straight to discord.com. Apps Script's shared IP
 * ranges are frequently blocked by Discord's Cloudflare layer, which
 * returns a misleadingly generic {"message":"internal network error",
 * "code":40333} instead of ever reaching Discord's actual API - a User-
 * Agent header is not enough to reliably avoid this. Instead, requests
 * go to a small relay (Cloudflare Worker) you deploy yourself, which
 * holds the real bot token and forwards to Discord from Cloudflare's
 * own network. See discord-relay-worker.js for the worker's code and
 * setup steps.
 * =====================================================================
 */

// Written into a row's Draft URL cell the moment its thread is
// created, so that cell being non-blank is the one and only signal
// createMatchThreads() needs to know a row's thread already exists -
// see buildMatchThreadEntries_ below. Deliberately NOT a valid draft
// code/URL shape (it contains spaces), so extractDraftCode_ correctly
// ignores it and fetchDraftData() just skips the row until a real
// draft URL is pasted over top of it.
var MATCH_THREAD_PLACEHOLDER = 'waiting for draft';
// Swapped in for MATCH_THREAD_PLACEHOLDER (never anything else - see
// markRowsNotPlayed_) on a best-of-X row that will never get a game
// played in it because the series already clinched. Not used at
// thread-creation time; only once a series is actually decided early.
var MATCH_NOT_PLAYED_PLACEHOLDER = 'not played';

/**
 * Hex-encodes the byte array Utilities.computeHmacSha256Signature
 * returns (which uses signed bytes, -128..127, unlike the unsigned
 * 0..255 every other hex encoder expects).
 * @param {Array<number>} bytes
 * @return {string} lowercase hex
 */
function bytesToHex_(bytes) {
  return bytes.map(function (byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * HMAC-SHA256(secret, "message") as lowercase hex. Shared by both
 * relay-secret signing (this file, outbound to the Worker) and sheet-
 * webhook-secret signing (Code.gs's own doPost, inbound from the
 * Worker) - see computeRelaySignature_ and computeWebhookSignature_.
 * @param {string} secret
 * @param {string} message
 * @return {string}
 */
function hmacHex_(secret, message) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(message, secret));
}

// Apps Script has no built-in constant-time string compare - this walks
// the full length regardless of where a mismatch occurs, rather than
// short-circuiting on the first differing character the way `===` / a
// naive loop-with-early-return would. Mirrors worker.js's
// timingSafeEqual, which protects RELAY_SECRET the same way on that
// side.
function timingSafeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// How much clock skew + retry delay to tolerate between a request being
// signed and reaching its destination - generous relative to a normal
// request/retry cycle, tight enough that a captured request is useless
// to replay shortly after. Shared by both signature directions below.
var SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** HMAC-SHA256(secret, "timestamp:nonce") - must match worker.js's computeRelaySignature_. */
function computeRelaySignature_(secret, timestamp, nonce) {
  return hmacHex_(secret, timestamp + ':' + nonce);
}

/**
 * Builds the three headers every relay call (callDiscordApi_ and
 * testDiscordRelayConnection) sends: a timestamp, a random one-time
 * nonce, and an HMAC signature over both, so a captured request can't
 * be replayed - not past SIGNATURE_WINDOW_MS (the timestamp check),
 * and not even within that window, since the worker rejects a nonce
 * it's already seen. See worker.js's verifyRelayRequest_ for the
 * matching check.
 * @param {string} secret
 * @return {Object} headers to merge into a UrlFetchApp options object
 */
function buildRelayAuthHeaders_(secret) {
  var timestamp = Date.now();
  var nonce = Utilities.getUuid();
  return {
    'X-Relay-Timestamp': String(timestamp),
    'X-Relay-Nonce': nonce,
    'X-Relay-Signature': computeRelaySignature_(secret, timestamp, nonce)
  };
}

/**
 * Returns the Discord relay's base URL and shared secret from this
 * project's Script Properties. Neither value is sent to the browser/
 * sidebar - both are used only server-side.
 * @return {{url: string, secret: string}}
 */
function getDiscordRelayConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('DISCORD_RELAY_URL');
  var secret = props.getProperty('DISCORD_RELAY_SECRET');
  if (!url || !secret) {
    throw new Error('Script properties "DISCORD_RELAY_URL" and "DISCORD_RELAY_SECRET" ' +
      'must both be set. Go to Project Settings > Script Properties and add them - ' +
      'see discord-relay-worker.js for how to deploy the relay and get these values.');
  }
  return { url: url.replace(/\/$/, ''), secret: secret };
}

/**
 * Calls the Discord API (via the relay worker) and returns parsed
 * JSON. Retries once on a 429 (rate limited) response, waiting however
 * long Discord says to.
 * @param {string} method 'get' or 'post'
 * @param {string} path e.g. '/guilds/123/roles' (appended to the relay's base URL)
 * @param {Object=} body request body for POST endpoints
 * @return {*} parsed JSON response
 */
function callDiscordApi_(method, path, body) {
  var relay = getDiscordRelayConfig_();
  var url = relay.url + path;
  var options = {
    method: method,
    headers: buildRelayAuthHeaders_(relay.secret),
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  if (DEBUG_MODE) {
    DEBUG_LOG_ENTRIES.push('-> ' + method.toUpperCase() + ' ' + url +
      (body ? ' body=' + JSON.stringify(body) : ''));
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  if (code === 429) {
    var retryInfo = {};
    try { retryInfo = JSON.parse(response.getContentText() || '{}'); } catch (e) { /* ignore */ }
    Utilities.sleep(Math.ceil((retryInfo.retry_after || 1) * 1000));
    response = UrlFetchApp.fetch(url, options);
    code = response.getResponseCode();
  }

  var text = response.getContentText();
  var data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }

  if (DEBUG_MODE) {
    DEBUG_LOG_ENTRIES.push('<- HTTP ' + code + ' ' + (text || '').slice(0, 2000));
  }

  if (code >= 400) {
    var msg = (data && data.message) ? data.message : ('HTTP ' + code);
    throw new Error('Discord API ' + method.toUpperCase() + ' ' + path + ' failed: ' + msg);
  }
  return data;
}

/**
 * Fetches every role in the configured guild and returns a map of role
 * name (exact, trimmed) -> role ID. Meant to be called once per
 * createMatchThreads() run (not once per row) and reused for every
 * team looked up in that run.
 * @return {Object}
 */
function getGuildRolesByName_() {
  var roles = callDiscordApi_('get', '/guilds/' + DISCORD_GUILD_ID + '/roles');
  var byName = {};
  (roles || []).forEach(function (role) {
    byName[String(role.name || '').trim()] = role.id;
  });
  return byName;
}

/**
 * Creates a forum post (thread) in the configured matches forum
 * channel. Carries no buttons itself - the "Match Complete" button
 * appears later, on the message the relay worker posts once a side is
 * chosen and a Statlocker draft URL exists (see
 * discord-relay-worker.js's finishDraftCreation_), right under that
 * URL rather than at the very top of the thread.
 * @param {string} forumChannelId
 * @param {string} name the thread's title (plain text, no role mentions)
 * @param {string} content the opening message's text (role mentions etc.)
 * @return {Object} the created thread object (has an "id" field)
 */
function createForumThread_(forumChannelId, name, content) {
  return callDiscordApi_('post', '/channels/' + forumChannelId + '/threads', {
    name: name,
    message: {
      content: content,
      // 'users' is included (alongside 'roles') because this is the one
      // message whose content comes from the organizer's own editable
      // template (MATCH_THREAD_MESSAGE_TEMPLATE) - it's the only place a
      // raw user mention like <@123...> could legitimately appear, and it
      // should actually notify that person. Every other message the bot
      // sends is built entirely from role IDs the code generates itself,
      // so they intentionally stay role-only.
      allowed_mentions: { parse: ['roles', 'users'] }
    }
  });
}

/**
 * Hands the coinflip + side-selection step off to the relay worker.
 * The worker (not Apps Script) owns everything from here: it flips the
 * coin, posts the "you won the flip, pick a side" message with the two
 * side buttons, and later handles the actual button click - including
 * checking the clicker is really on the winning team - entirely via
 * Discord's Interactions webhook, independent of this Apps Script
 * project. See discord-relay-worker.js for that logic.
 *
 * Also captures *which sheet tab* this row lives on (sheetName) and
 * sends it along. This matters because the worker calls back into
 * doPost() later - possibly minutes or hours later, with no user
 * viewing the spreadsheet at all - and doPost() has no reliable way to
 * know which tab was intended if it just asks for "the active sheet":
 * that reflects whatever tab a human last happened to have open, not
 * necessarily this match's tab. Capturing the name now, while we're
 * running in a real interactive context (a human just clicked "Create
 * Match Threads" while looking at this tab), is the only point where
 * "active sheet" is actually guaranteed to mean the right thing.
 * @param {string} threadId the just-created match thread's ID
 * @param {number} row
 * @param {string} sheetName the sheet tab this row belongs to
 * @param {string} team1
 * @param {string} team2
 * @param {string} team1RoleId
 * @param {string} team2RoleId
 * @param {string} round
 * @param {?string} overrideTeam 'team1', 'team2', or null/undefined -
 *   the bold signal from getSideSignalsForRow_ for this row. When set,
 *   the worker skips the random coinflip entirely and gives that team
 *   automatic choice priority instead (they still choose side or pick
 *   order first via the buttons). See the SIDE SELECTION OVERRIDE note on
 *   createMatchThreads() above.
 * @param {?string} hiddenKingTeam 'team1', 'team2', or null/undefined -
 *   the underline signal from getSideSignalsForRow_ for this row (it
 *   can never be 'swap' for game 1, since "both underlined" on game 1
 *   is ambiguous and resolves to null instead - see
 *   getSideSignalsForRow_). When set, the worker skips both the
 *   coinflip AND the side choice, locking that team onto Hidden King
 *   and only asking the Archmother team for First/Second Pick. Takes priority
 *   over overrideTeam when both are somehow set, though
 *   getSideSignalsForRow_ never sets both at once for the same row.
 */
function startCoinflip_(threadId, row, sheetName, team1, team2, team1RoleId, team2RoleId, round, overrideTeam, hiddenKingTeam) {
  callDiscordApi_('post', '/internal/coinflip', {
    threadId: threadId,
    row: row,
    sheetName: sheetName,
    team1: team1,
    team2: team2,
    team1RoleId: team1RoleId,
    team2RoleId: team2RoleId,
    round: round,
    sideALabel: SIDE_A_LABEL,
    sideBLabel: SIDE_B_LABEL,
    overrideTeam: overrideTeam || null,
    hiddenKingTeam: hiddenKingTeam || null
  });
}

/**
 * Tells the relay worker which sheet rows/tab a just-created match
 * thread's SERIES belongs to, so the thread's persistent "Match
 * Complete" button (see createForumThread_) works from the moment it
 * appears - independent of the coinflip call, which can fail on its
 * own without taking Match Complete down with it (see the
 * coinflipFailures handling in createMatchThreads()). Stored in the
 * worker's KV under a long-lived key ("thread:" + threadId) separate
 * from the coinflip's own ("match:" + threadId) state, since this
 * needs to keep working long after the coinflip's short-lived state
 * would normally be relevant.
 *
 * rows is the FULL list of rows this series covers (one row per game -
 * see buildMatchThreadEntries_), in ascending order. The worker uses
 * rows.length to work out how many wins clinch the series, tracks
 * which row is the currently-active game as the series progresses, and
 * advances to the next row itself once each game's winner is recorded
 * - see discord-relay-worker.js's handleRegisterThread /
 * advanceSeriesAfterWin_ for the receiving side.
 * @param {string} threadId the just-created match thread's ID
 * @param {Array<number>} rows every row this series covers, ascending
 * @param {string} sheetName the sheet tab these rows belong to - same
 *   reasoning as startCoinflip_'s sheetName param.
 * @param {string} team1
 * @param {string} team2
 * @param {string} team1RoleId used to restrict who can press Match
 *   Complete / the winner buttons to players on either team.
 * @param {string} team2RoleId
 * @param {string} round
 * @param {Array<?string>} sideOverrides parallel to rows - each entry
 *   'team1', 'team2', or null - the bold signal from
 *   getSideSignalsForRow_ for that row. Lets the worker give a team
 *   automatic choice priority for game 2/3/etc (they still choose
 *   side or pick order first), skipping the losers-pick rule for that
 *   specific game - see
 *   advanceSeriesAfterWin_ in discord-relay-worker.js.
 * @param {Array<?string>} hiddenKingOverrides parallel to rows - each
 *   entry 'team1', 'team2', 'swap', or null - the underline signal
 *   from getSideSignalsForRow_ for that row. 'team1'/'team2' locks that
 *   team onto Hidden King directly (no coinflip, no side choice - the
 *   other team only picks First/Second Pick); 'swap'
 *   means both cells were underlined for a game 2+ row, so that game's
 *   sides swap from whatever the previous game's Hidden King/Archmother
 *   assignment turns out to be - resolved dynamically as the series
 *   plays out, since the previous game's actual result isn't known
 *   yet at "Create Match Threads" time. See advanceSeriesAfterWin_.
 * @param {boolean=} playAll from isRoundCellUnderlined_ - if true, the
 *   series plays out every row even after a side clinches early.
 */
function registerMatchSeries_(threadId, rows, sheetName, team1, team2, team1RoleId, team2RoleId, round, sideOverrides, hiddenKingOverrides, playAll) {
  callDiscordApi_('post', '/internal/register-thread', {
    threadId: threadId,
    rows: rows,
    sheetName: sheetName,
    team1: team1,
    team2: team2,
    team1RoleId: team1RoleId,
    team2RoleId: team2RoleId,
    round: round,
    sideALabel: SIDE_A_LABEL,
    sideBLabel: SIDE_B_LABEL,
    sideOverrides: sideOverrides || [],
    hiddenKingOverrides: hiddenKingOverrides || [],
    playAll: !!playAll
  });
}

/**
 * =====================================================================
 * SHEET LAYOUT CONFIG
 * =====================================================================
 * All columns are configurable from the sidebar's Settings panel (no
 * code editing needed) - see getConfig_, loadConfigIntoGlobals_, and
 * saveSidebarConfig below for how the settings there get read/saved.
 *
 * The values here are just fallback defaults (used until a config is
 * saved, or if the saved config is ever missing/corrupt), expressed as
 * a column count relative to the cell containing the draft code/URL
 * (positive = right, negative = left):
 *   Team 1 | Team 2 | Round | ID | Winner | Match Length | Draft URL | picks/bans...
 *     -6       -5      -4    -3     -2          -1           (0)         1, 2, 3...
 * Round (-4) has no Statlocker equivalent - it's filled in by hand, but
 * it IS read (not written) by createMatchThreads() below for the
 * {{round}} placeholder in a match thread's opening message. The Draft
 * URL column (offset 0, whichever column that is per DRAFT_URL_COLUMN/
 * the saved config - it's configurable and can differ between
 * spreadsheets) does double duty: createMatchThreads() writes a
 * "waiting for draft" placeholder into it the moment a thread is
 * created, purely so a blank-vs-non-blank check on THAT SAME cell is
 * all that's needed to know whether a row still needs a thread - see
 * MATCH_THREAD_PLACEHOLDER below. The placeholder later gets manually
 * overwritten with the real draft URL once one exists, which is also
 * what unblocks fetchDraftData() for that row.
 * =====================================================================
 */
var DRAFT_URL_COLUMN   = 8;  // column H
var TEAM1_NAME_OFFSET   = -6;
var TEAM2_NAME_OFFSET   = -5;
var ROUND_OFFSET        = -4;
var MATCH_ID_OFFSET     = -3;
var WINNER_OFFSET       = -2;
var MATCH_LENGTH_OFFSET = -1;
var PICKS_START_OFFSET  = 1; // where the first written pick/ban cell starts; the
                              // rest are written contiguously after it, in the
                              // order set by PICK_BAN_ORDER (see buildPickBanOrder_)
var PICK_BAN_ORDER = 'groupedByTeam'; // 'groupedByTeam' | 'bansFirst' | 'draftOrder'
var DEBUG_MODE = false;

// Discord IDs read from Settings - see DISCORD API section below.
var DISCORD_GUILD_ID = '';
var DISCORD_MATCHES_FORUM_CHANNEL_ID = '';

// Default text for a freshly-installed copy of this project (before
// Settings has ever been saved) - also what a blank Settings field
// falls back to (see saveSidebarConfig). Doubles as a worked example
// for the {{team1}}/{{team2}}/{{round}} placeholders: organizers can
// see a realistic full message in the sidebar's Settings panel and
// adjust it from there, rather than starting from a blank textarea.
// The <@12345678912345678> is a placeholder Discord user ID - swap it
// for a real one (or a role mention like <@&ROLE_ID>) once configured.
// Both forms actually ping (see createForumThread_'s allowed_mentions).
var DEFAULT_MATCH_THREAD_MESSAGE_TEMPLATE =
  '{{team1}} {{team2}} here\'s your match channel for {{round}} ({{bestOf}}).\n' +
  'In a moment, this bot will flip a coin. The winning team chooses whether to pick their side or their pick order (First/Second Pick) first, then the other team picks the remaining option with the buttons provided. This will create your draft lobby.\n\n' +
  'Once the draft is complete, a game lobby code will appear in the draft website for everyone to join.\n' +
  'Once your match concludes, press the "Match Complete" button below the draft link further down this thread. This bot will pull the result from Statlocker automatically - if it\'s not there yet, it\'ll ask which team won.\n' +
  'Please ping <@12345678912345678> or a @Tournament Admin if anything goes wrong.\n' +
  'good luck, have fun!';

var MATCH_THREAD_MESSAGE_TEMPLATE = DEFAULT_MATCH_THREAD_MESSAGE_TEMPLATE;

// Deadlock's two official side names - fixed, not user-configurable.
var SIDE_A_LABEL = 'Hidden King';
var SIDE_B_LABEL = 'Archmother';

// Background colors applied to a row's Team 1/Team 2 cells once sides
// are chosen (see applySideAndPickOrder_) - Team 1/Team 2 order means
// pick order (Team 1 = First Pick), so the cell color is what shows
// which side each team is on. Amber-ish for Hidden King, sapphire-ish
// for Archmother. The Winner cell copies whichever of these the
// winning team has (see applyWinnerColor_).
var SIDE_A_COLOR = '#f9cb9c';
var SIDE_B_COLOR = '#9fc5e8';

// Raw request/response lines collected during the CURRENT execution when
// DEBUG_MODE is on - reset and read by fetchDraftData() so the sidebar
// can show them as a copyable field, rather than requiring a trip to
// Extensions > Apps Script > Executions. See callStatlockerApi_.
var DEBUG_LOG_ENTRIES = [];

var CONFIG_PROPERTY_KEY = 'STATLOCKER_CONFIG';

var DEFAULT_CONFIG = {
  draftColumn: 8,
  team1Offset: -6,
  team2Offset: -5,
  roundOffset: -4,
  matchIdOffset: -3,
  winnerOffset: -2,
  matchLengthOffset: -1,
  picksStartOffset: 1,
  pickBanOrder: 'groupedByTeam',
  discordGuildId: '',
  discordMatchesForumChannelId: '',
  matchThreadMessageTemplate: DEFAULT_MATCH_THREAD_MESSAGE_TEMPLATE,
  debugMode: false
};

/**
 * Returns the config either saved in this spreadsheet's Document
 * Properties or the defaults above, merged so a partially-saved/older
 * config never leaves a field undefined.
 * @return {Object}
 */
function getConfig_() {
  var config = {};
  for (var k in DEFAULT_CONFIG) config[k] = DEFAULT_CONFIG[k];

  var stored = PropertiesService.getDocumentProperties().getProperty(CONFIG_PROPERTY_KEY);
  if (stored) {
    try {
      var parsed = JSON.parse(stored);
      for (var key in parsed) {
        if (config.hasOwnProperty(key)) config[key] = parsed[key];
      }
    } catch (e) {
      // Malformed stored config - fall back to defaults rather than fail.
    }
  }
  return config;
}

/**
 * Reads the saved config (or defaults) and populates the module-level
 * layout vars above. Call this at the start of any entry point that
 * reads/writes sheet columns, before it does so - everything it calls
 * afterwards in that same execution shares the same JS global state,
 * so one call per entry point is enough.
 * @return {Object} the config that was loaded.
 */
function loadConfigIntoGlobals_() {
  var config = getConfig_();
  DRAFT_URL_COLUMN   = config.draftColumn;
  TEAM1_NAME_OFFSET   = config.team1Offset;
  TEAM2_NAME_OFFSET   = config.team2Offset;
  ROUND_OFFSET        = config.roundOffset;
  MATCH_ID_OFFSET     = config.matchIdOffset;
  WINNER_OFFSET       = config.winnerOffset;
  MATCH_LENGTH_OFFSET = config.matchLengthOffset;
  PICKS_START_OFFSET  = config.picksStartOffset;
  PICK_BAN_ORDER = (['groupedByTeam', 'bansFirst', 'draftOrder'].indexOf(config.pickBanOrder) !== -1)
    ? config.pickBanOrder
    : 'groupedByTeam';
  DISCORD_GUILD_ID = config.discordGuildId;
  DISCORD_MATCHES_FORUM_CHANNEL_ID = config.discordMatchesForumChannelId;
  MATCH_THREAD_MESSAGE_TEMPLATE = config.matchThreadMessageTemplate;
  DEBUG_MODE = !!config.debugMode;
  return config;
}

/**
 * Turns one draft's steps into a flat, ordered list of hero name
 * strings, ready to write into a single contiguous row of cells
 * starting at PICKS_START_OFFSET (see writeDraftRowToSheet). The
 * arrangement depends on PICK_BAN_ORDER (configurable from the
 * sidebar's Settings panel):
 *   - 'groupedByTeam' (default): Team 1's bans, Team 1's picks,
 *     Team 2's bans, Team 2's picks.
 *   - 'bansFirst': every ban (Team 1 then Team 2), then every pick
 *     (Team 1 then Team 2) - e.g. all 4 bans before all 12 picks.
 *   - 'draftOrder': exactly the order selections happened in the
 *     draft itself - bans and picks, both teams, interleaved.
 * "Team 1"/"Team 2" above always means the SHEET's Team 1/Team 2
 * columns (via sheetColumnForDraftTeam_), already corrected for a
 * draft whose own team numbering came in reversed.
 * @param {Array<Object>} steps the draft's steps array (any order)
 * @param {Object} orient as returned by determineOrientation_
 * @return {Array<string>} hero names in the order they'll be written
 */
function buildPickBanOrder_(steps, orient) {
  var parsed = (steps || [])
    .slice()
    .sort(function (a, b) { return a.selectionNumber - b.selectionNumber; })
    .map(function (step) {
      return {
        sheetCol: sheetColumnForDraftTeam_(orient, step.teamNumber),
        isPick: String(step.selectionType).toUpperCase() === 'PICK',
        heroName: step.heroName || (step.heroId !== undefined && step.heroId !== null ? ('Hero #' + step.heroId) : '')
      };
    })
    .filter(function (p) { return p.sheetCol === 1 || p.sheetCol === 2; });

  if (PICK_BAN_ORDER === 'draftOrder') {
    return namesOf_(parsed);
  }

  if (PICK_BAN_ORDER === 'bansFirst') {
    var bans = parsed.filter(function (p) { return !p.isPick; });
    var picks = parsed.filter(function (p) { return p.isPick; });
    return namesOf_(byTeam_(bans)).concat(namesOf_(byTeam_(picks)));
  }

  // 'groupedByTeam' (default).
  var team1 = parsed.filter(function (p) { return p.sheetCol === 1; });
  var team2 = parsed.filter(function (p) { return p.sheetCol === 2; });
  var order = [].concat(
    team1.filter(function (p) { return !p.isPick; }),
    team1.filter(function (p) { return p.isPick; }),
    team2.filter(function (p) { return !p.isPick; }),
    team2.filter(function (p) { return p.isPick; })
  );
  return namesOf_(order);
}

/** Stable sort of a parsed-step list into Team 1's entries then Team 2's. */
function byTeam_(list) {
  return list.filter(function (p) { return p.sheetCol === 1; })
    .concat(list.filter(function (p) { return p.sheetCol === 2; }));
}

/** Pulls just the heroName out of a list of parsed steps. */
function namesOf_(list) {
  return list.map(function (p) { return p.heroName; });
}

/**
 * Converts a spreadsheet column letter ("A", "H", "AA", ...) to its
 * 1-based column number. Case-insensitive.
 * @param {string} letter
 * @return {number}
 */
function columnLetterToNumber_(letter) {
  letter = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(letter)) {
    throw new Error('"' + letter + '" is not a valid column letter (use something like "H" or "AA").');
  }
  var num = 0;
  for (var i = 0; i < letter.length; i++) {
    num = num * 26 + (letter.charCodeAt(i) - 64);
  }
  return num;
}

/**
 * Converts a 1-based column number to its spreadsheet column letter.
 * @param {number} num
 * @return {string}
 */
function columnNumberToLetter_(num) {
  if (!(num >= 1)) return '?';
  var letter = '';
  while (num > 0) {
    var rem = (num - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    num = Math.floor((num - 1) / 26);
  }
  return letter;
}

/**
 * =====================================================================
 * SIDEBAR SETTINGS (Deadlock Tournament Management Bot > Open Sidebar > ▼ Settings)
 * =====================================================================
 * Lets you change every configurable column, plus the debug logging
 * toggle, from the sidebar's Settings panel instead of editing code.
 * =====================================================================
 */

/** Called by Sidebar.html on load/panel-open to populate the Settings fields. */
function getSidebarConfig() {
  return getConfigForSidebar();
}

/**
 * Returns the current config expressed as absolute column letters
 * (rather than offsets), for populating the sidebar's Settings fields.
 * @return {Object}
 */
function getConfigForSidebar() {
  var config = getConfig_();
  function letter(offset) { return columnNumberToLetter_(config.draftColumn + offset); }
  return {
    draftColumn: columnNumberToLetter_(config.draftColumn),
    team1Column: letter(config.team1Offset),
    team2Column: letter(config.team2Offset),
    roundColumn: letter(config.roundOffset),
    matchIdColumn: letter(config.matchIdOffset),
    winnerColumn: letter(config.winnerOffset),
    matchLengthColumn: letter(config.matchLengthOffset),
    picksStartColumn: letter(config.picksStartOffset),
    pickBanOrder: config.pickBanOrder,
    discordGuildId: config.discordGuildId,
    discordMatchesForumChannelId: config.discordMatchesForumChannelId,
    matchThreadMessageTemplate: config.matchThreadMessageTemplate,
    debugMode: !!config.debugMode
  };
}

/**
 * Validates a Discord snowflake ID (guild/channel ID - all digits).
 * Blank is allowed at save time so Settings can be saved incrementally
 * while setting things up; createMatchThreads() checks for blank
 * separately with a clearer error at the point it's actually needed.
 * @param {string} value
 * @param {string} label used in the error message
 * @return {string}
 */
function validateSnowflake_(value, label) {
  var trimmed = String(value || '').trim();
  if (trimmed === '') return '';
  if (!/^\d{5,25}$/.test(trimmed)) {
    throw new Error('"' + trimmed + '" doesn\'t look like a valid ' + label + ' (should be all digits).');
  }
  return trimmed;
}

/**
 * Called by Sidebar.html's Save Settings button. Converts the entered
 * column letters back to offsets relative to the Draft URL column and
 * persists everything to this spreadsheet's Document Properties.
 * @param {Object} formConfig { draftColumn, team1Column, team2Column,
 *   roundColumn, matchIdColumn, winnerColumn, matchLengthColumn,
 *   picksStartColumn, pickBanOrder, discordGuildId,
 *   discordMatchesForumChannelId, matchThreadMessageTemplate,
 *   debugMode }, all column fields as letter strings.
 * @return {string} confirmation message for the sidebar to show.
 */
function saveSidebarConfig(formConfig) {
  var draftColNum = columnLetterToNumber_(formConfig.draftColumn);

  var allowedOrders = ['groupedByTeam', 'bansFirst', 'draftOrder'];
  if (allowedOrders.indexOf(formConfig.pickBanOrder) === -1) {
    throw new Error('"' + formConfig.pickBanOrder + '" is not a valid pick/ban order.');
  }

  var config = {
    draftColumn: draftColNum,
    team1Offset: columnLetterToNumber_(formConfig.team1Column) - draftColNum,
    team2Offset: columnLetterToNumber_(formConfig.team2Column) - draftColNum,
    roundOffset: columnLetterToNumber_(formConfig.roundColumn) - draftColNum,
    matchIdOffset: columnLetterToNumber_(formConfig.matchIdColumn) - draftColNum,
    winnerOffset: columnLetterToNumber_(formConfig.winnerColumn) - draftColNum,
    matchLengthOffset: columnLetterToNumber_(formConfig.matchLengthColumn) - draftColNum,
    picksStartOffset: columnLetterToNumber_(formConfig.picksStartColumn) - draftColNum,
    pickBanOrder: formConfig.pickBanOrder,
    discordGuildId: validateSnowflake_(formConfig.discordGuildId, 'Discord Server ID'),
    discordMatchesForumChannelId: validateSnowflake_(formConfig.discordMatchesForumChannelId, 'Matches Forum Channel ID'),
    matchThreadMessageTemplate: String(formConfig.matchThreadMessageTemplate || '').trim()
      || DEFAULT_CONFIG.matchThreadMessageTemplate,
    debugMode: !!formConfig.debugMode
  };

  PropertiesService.getDocumentProperties()
    .setProperty(CONFIG_PROPERTY_KEY, JSON.stringify(config));

  loadConfigIntoGlobals_();

  return 'Configuration saved.';
}

/**
 * Reads the configured Draft URL column (SHEET_DATA_START_ROW to the
 * last row) top to bottom and returns an entry for every row that has
 * a recognizable draft code/URL. No cell selection needed. This is the
 * source for the "Fetch Draft Data" button - see fetchDraftData().
 *
 * Each entry also carries two INDEPENDENT completeness flags, so a
 * re-run only redoes the part of a row that's actually still missing:
 *   - draftHalfComplete: the first pick/ban cell already has a value -
 *     used as a stand-in for "this draft's team names/picks/bans have
 *     already been written", so that half is skipped.
 *   - matchHalfComplete: Match ID, Winner, AND Match Length are ALL
 *     already filled in - so the match lookup/write is skipped. If
 *     even one of those three is still blank (e.g. you pasted a Match
 *     ID by hand but Winner/Length haven't been fetched yet), this is
 *     false and the match half still runs.
 * A row where both are true is dropped entirely before any API call is
 * made for it - see processEntries_.
 *
 * @return {{entries: Array<Object>, alreadyCompleteCount: number}}
 *   entries: { cellA1, draftCode, row, col, sheetTeam1, sheetTeam2,
 *   sheetMatchId, draftHalfComplete, matchHalfComplete } for every row
 *   that still needs at least one half done; alreadyCompleteCount is
 *   how many rows were skipped entirely because both halves were done.
 */
function getEntriesFromColumnH_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < SHEET_DATA_START_ROW) return { entries: [], alreadyCompleteCount: 0 };

  var numRows = lastRow - SHEET_DATA_START_ROW + 1;
  var col = DRAFT_URL_COLUMN;
  var urlValues       = sheet.getRange(SHEET_DATA_START_ROW, col, numRows, 1).getValues();
  var team1Values     = sheet.getRange(SHEET_DATA_START_ROW, col + TEAM1_NAME_OFFSET, numRows, 1).getValues();
  var team2Values     = sheet.getRange(SHEET_DATA_START_ROW, col + TEAM2_NAME_OFFSET, numRows, 1).getValues();
  var matchIdValues   = sheet.getRange(SHEET_DATA_START_ROW, col + MATCH_ID_OFFSET, numRows, 1).getValues();
  var winnerValues    = sheet.getRange(SHEET_DATA_START_ROW, col + WINNER_OFFSET, numRows, 1).getValues();
  var matchLenValues  = sheet.getRange(SHEET_DATA_START_ROW, col + MATCH_LENGTH_OFFSET, numRows, 1).getValues();
  var firstPickValues = sheet.getRange(SHEET_DATA_START_ROW, col + PICKS_START_OFFSET, numRows, 1).getValues();

  var results = [];
  var alreadyCompleteCount = 0;
  for (var i = 0; i < numRows; i++) {
    var raw = String(urlValues[i][0] || '').trim();
    if (!raw) continue;

    var draftCode = extractDraftCode_(raw);
    if (!draftCode) continue;

    var hasMatchId = String(matchIdValues[i][0] || '').trim() !== '';
    var hasWinner = String(winnerValues[i][0] || '').trim() !== '';
    var hasMatchLen = String(matchLenValues[i][0] || '').trim() !== '';
    var hasFirstPick = String(firstPickValues[i][0] || '').trim() !== '';

    var draftHalfComplete = hasFirstPick;
    var matchHalfComplete = hasMatchId && hasWinner && hasMatchLen;

    if (draftHalfComplete && matchHalfComplete) {
      alreadyCompleteCount++;
      continue; // fully done - skip before any API call is made for it
    }

    var row = SHEET_DATA_START_ROW + i;
    results.push({
      cellA1: sheet.getRange(row, col).getA1Notation(),
      draftCode: draftCode,
      row: row,
      col: col,
      sheet: sheet,
      sheetTeam1: String(team1Values[i][0] || '').trim(),
      sheetTeam2: String(team2Values[i][0] || '').trim(),
      sheetMatchId: String(matchIdValues[i][0] || '').trim(),
      draftHalfComplete: draftHalfComplete,
      matchHalfComplete: matchHalfComplete
    });
  }
  return { entries: results, alreadyCompleteCount: alreadyCompleteCount };
}

var SHEET_DATA_START_ROW = 2; // first data row (row 1 = headers)

function normalizeTeamName_(s) {
  return String(s || '').trim().toLowerCase();
}

// Statlocker falls back to these generic side labels on a draft's teams
// when no real team name was ever registered for it (e.g. an ad-hoc
// draft made without going through team setup). A sheet's real team
// names will never match these, but that's expected, not a swap
// problem - see the draftHasGenericNames guard in processEntries_.
var GENERIC_DRAFT_SIDE_NAMES = { 'hidden king': true, 'archmother': true };

function isGenericSideLabel_(name) {
  return !!GENERIC_DRAFT_SIDE_NAMES[normalizeTeamName_(name)];
}

// A fuzzy pairing (see stringSimilarity_) needs to score at least this
// well to count as a match at all - below this, two names are treated
// as genuinely different teams, not a naming variation.
var FUZZY_MATCH_MIN_CONFIDENCE = 0.6;
// ...and the winning orientation (swapped vs unswapped) needs to beat
// the other orientation's best score by at least this much. Without a
// margin, a row where BOTH orientations look like a plausible-ish fuzzy
// match (e.g. two similarly-named teams) would get "resolved" by
// whichever happened to score a hair higher - basically a coin flip.
// Requiring a clear winner means a genuinely ambiguous row correctly
// falls through to the "please verify" path instead.
var FUZZY_MATCH_MIN_MARGIN = 0.15;

/**
 * Iterative Levenshtein (edit) distance between two strings - the
 * minimum number of single-character insertions/deletions/substitutions
 * to turn one into the other.
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function levenshteinDistance_(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  var prev = new Array(n + 1);
  var curr = new Array(n + 1);
  for (var j = 0; j <= n; j++) prev[j] = j;

  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var jj = 1; jj <= n; jj++) {
      var cost = a.charAt(i - 1) === b.charAt(jj - 1) ? 0 : 1;
      curr[jj] = Math.min(
        prev[jj] + 1,      // deletion
        curr[jj - 1] + 1,  // insertion
        prev[jj - 1] + cost // substitution
      );
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/**
 * How similar two (already-normalized) team names are, from 0 (nothing
 * alike) to 1 (identical). Combines two signals so both typo-style and
 * containment-style variations score well:
 *  - edit-distance similarity: catches typos, abbreviations, punctuation
 *    differences ("archers" vs "archer's").
 *  - containment similarity: catches one name being fully embedded in
 *    the other ("ravens" vs "the ravens", "wolves" vs "team wolves"),
 *    which a raw edit distance penalizes more than this kind of
 *    everyday variation deserves.
 * @param {string} a already-normalized (trimmed, lowercased)
 * @param {string} b already-normalized (trimmed, lowercased)
 * @return {number} 0-1
 */
function stringSimilarity_(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  var maxLen = Math.max(a.length, b.length);
  var editSimilarity = 1 - (levenshteinDistance_(a, b) / maxLen);

  var containmentSimilarity = 0;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    containmentSimilarity = Math.min(a.length, b.length) / maxLen;
  }

  return Math.max(editSimilarity, containmentSimilarity);
}

// Words that stand for a connector when building an acronym - "Big N
// Round", "Big and Round", and "Big & Round" should all be able to
// match a shorthand like "BNR" or "B&R". Deliberately just these two
// (plus "&", handled separately by splitWords_/normalizeAcronymCandidate_
// below) rather than a broader stop-word list - dropping other words
// (e.g. "of", "the") from an acronym is a judgment call specific teams
// may or may not make, whereas and/n/& are simply different spellings
// of the same connector.
var ACRONYM_CONNECTOR_WORDS = { 'and': true, 'n': true };

/**
 * Splits a raw (case-preserved) team name into lowercase words.
 * Always splits on whitespace/punctuation and on "&" (expanded to
 * "and" first so it becomes its own word). splitCase/splitDigits
 * additionally control whether a camelCase-style transition ("Op" |
 * "Tic") and/or a letter/digit transition ("Cloud" | "9") also count
 * as a word boundary - this only works because this function runs on
 * the ORIGINAL casing, before normalizeTeamName_ has lowercased
 * everything away. Apostrophes are dropped rather than kept as word
 * characters, so "don't" and "dont" end up as the same word.
 * @param {string} name
 * @param {boolean} splitCase
 * @param {boolean} splitDigits
 * @return {Array<string>}
 */
function splitWordsRaw_(name, splitCase, splitDigits) {
  var s = String(name || '').replace(/&/g, ' and ').replace(/'/g, '');
  if (splitCase) {
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  }
  if (splitDigits) {
    s = s.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  }
  var words = s.split(/[^A-Za-z0-9]+/).filter(function (w) { return w.length > 0; });
  return words.map(function (w) { return w.toLowerCase(); });
}

/**
 * A single word/token can plausibly be meant as one unit OR as a
 * compound of several - there's no way to know which without asking
 * the person who typed it, so rather than guess we test both:
 *  - "split": break on camelCase AND letter/digit transitions, so
 *    "BigNRound" -> [big, n, round] and "Cloud9" -> [cloud, 9].
 *  - "whole": don't break internal casing/digits at all, so
 *    "FaZe" stays [faze] and "Cloud9" stays [cloud9].
 * Callers try both and keep whichever scores better - this is what
 * lets "FaZe" and "Faze" (or "OpTic" and "Optic") end up scoring the
 * same, instead of the stylized capitalization accidentally getting
 * treated as more "correct" than the plain one.
 * @param {string} name
 * @return {Array<Array<string>>} one or two word-list variants
 *   (deduplicated if both interpretations come out identical, e.g.
 *   a name with no internal case/digit transitions to begin with)
 */
function splitWordsVariants_(name) {
  var split = splitWordsRaw_(name, true, true);
  var whole = splitWordsRaw_(name, false, false);
  if (split.join(' ') === whole.join(' ')) return [split];
  return [split, whole];
}

/**
 * Builds an acronym string from a name's words - one letter per word,
 * connector words (see ACRONYM_CONNECTOR_WORDS) becoming "n" regardless
 * of whether they were originally "and"/"n"/"&". Returns two variants
 * because there's no single universal convention for whether a
 * connector gets its own letter ("BigNRound" -> "BNR") or is dropped
 * ("Parried & Complaining" -> "PC"); trying both means either
 * convention resolves without hard-coding one as "correct".
 * @param {Array<string>} words lowercase, from splitWords_
 * @return {{withConnectors: string, withoutConnectors: string}}
 */
function buildAcronymVariants_(words) {
  var withConnectors = [];
  var withoutConnectors = [];
  words.forEach(function (w) {
    if (ACRONYM_CONNECTOR_WORDS[w]) {
      withConnectors.push('n');
    } else {
      withConnectors.push(w.charAt(0));
      withoutConnectors.push(w.charAt(0));
    }
  });
  return { withConnectors: withConnectors.join(''), withoutConnectors: withoutConnectors.join('') };
}

/**
 * Normalizes a candidate shorthand for comparison against an acronym:
 * lowercase, "&" folded to "n" (same connector-letter convention as
 * buildAcronymVariants_, so "B&R" lines up with "BigNRound"'s "bnr"),
 * everything else that isn't a letter/digit stripped out.
 * @param {string} s
 * @return {string}
 */
function normalizeAcronymCandidate_(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]/g, '');
}

/**
 * True if every character of needle appears in haystack in the same
 * left-to-right order (not necessarily contiguous) - e.g. "dbv" is a
 * subsequence of "pdbv" (skip the leading "p"). This is what lets an
 * acronym that dropped a word ("DBV" for "Please Don't Ban Vindicta")
 * still match, not just ones that used every word.
 * @param {string} needle
 * @param {string} haystack
 * @return {boolean}
 */
function isSubsequence_(needle, haystack) {
  var i = 0;
  for (var j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack.charAt(j) === needle.charAt(i)) i++;
  }
  return i === needle.length;
}

/**
 * Checks whether candidateRaw looks like an acronym/initialism of
 * fullNameRaw - e.g. "DG" for "Dooms Goons", "PNC" for "Parried &
 * Complaining about it" (dropping "about"/"it" - a candidate doesn't
 * need to use every word, just hit the ones it uses in order), or
 * "C9" for "Cloud9" (via the letter/digit-split word variant - see
 * splitWordsVariants_). Only applies where a word-splitting variant
 * has 2+ words; a single, unsplittable word has no "initials" to
 * speak of.
 * @param {string} fullNameRaw case-preserved, trimmed
 * @param {string} candidateRaw case-preserved, trimmed
 * @return {number} 0-1
 */
function acronymMatchOneDirection_(fullNameRaw, candidateRaw) {
  var candidate = normalizeAcronymCandidate_(candidateRaw);
  if (candidate.length < 2) return 0; // too short to mean anything on its own

  var best = 0;
  splitWordsVariants_(fullNameRaw).forEach(function (words) {
    if (words.length < 2) return;
    var variants = buildAcronymVariants_(words);
    [variants.withConnectors, variants.withoutConnectors].forEach(function (initials) {
      if (!initials) return;
      if (candidate === initials) {
        best = Math.max(best, 1);
      } else if (candidate.length < initials.length && isSubsequence_(candidate, initials)) {
        // Dropped some words - still a match, just slightly less
        // confident the shorter the candidate is relative to the
        // acronym it's a subset of.
        best = Math.max(best, 0.75 + 0.25 * (candidate.length / initials.length));
      }
    });
  });
  return best;
}

/**
 * acronymMatchOneDirection_ in both directions, since we don't know
 * upfront whether the sheet's name or the draft's name is the fuller
 * one (either side could be the one carrying the shorthand).
 * @param {string} rawA case-preserved, trimmed
 * @param {string} rawB case-preserved, trimmed
 * @return {number} 0-1
 */
function acronymSimilarity_(rawA, rawB) {
  return Math.max(acronymMatchOneDirection_(rawA, rawB), acronymMatchOneDirection_(rawB, rawA));
}

/**
 * Checks whether candidateRaw is a run of WHOLE, exactly-spelled words
 * lifted straight out of fullNameRaw, in the same order, covering at
 * least half of the full name's word count - e.g. "dooms" for "Dooms
 * Goons" (1 of 2 words), "dont ban vindicta" for "Please don't ban
 * vindicta" (3 of 4 words, dropping only the leading "please"), or
 * "Faze" for "FaZe Clan" (1 of 2 words, via the no-internal-split word
 * variant - see splitWordsVariants_). This is deliberately stricter
 * than the acronym check: no per-word fuzziness, just whether the
 * candidate is a genuine contiguous excerpt.
 *
 * Two things this does NOT allow, on purpose:
 *  - dropping a word from the MIDDLE of the run ("Please Ban" for
 *    "Please don't ban vindicta" is not a match - "don't" would have
 *    to be skipped without also skipping to the end of the phrase).
 *  - a run shorter than half the full name ("Please" alone is 1 of 4
 *    words - real, but not enough of the name to be confident it's
 *    THIS team and not some other "Please..." name).
 * @param {string} fullNameRaw case-preserved, trimmed
 * @param {string} candidateRaw case-preserved, trimmed
 * @return {number} 0-1
 */
function wordSubstringMatchOneDirection_(fullNameRaw, candidateRaw) {
  var best = 0;
  splitWordsVariants_(fullNameRaw).forEach(function (fullWords) {
    if (fullWords.length < 2) return; // nothing to take "half" of
    var minWords = Math.ceil(fullWords.length / 2);

    splitWordsVariants_(candidateRaw).forEach(function (candWords) {
      if (candWords.length === 0 || candWords.length > fullWords.length) return;
      if (candWords.length < minWords) return;

      for (var start = 0; start + candWords.length <= fullWords.length; start++) {
        var isMatch = true;
        for (var k = 0; k < candWords.length; k++) {
          if (fullWords[start + k] !== candWords[k]) { isMatch = false; break; }
        }
        if (isMatch) {
          // More of the full name covered = more confident it's this
          // team and not just a coincidentally-matching fragment.
          best = Math.max(best, 0.7 + 0.3 * (candWords.length / fullWords.length));
          break;
        }
      }
    });
  });
  return best;
}

/**
 * wordSubstringMatchOneDirection_ in both directions - same reasoning
 * as acronymSimilarity_ above.
 * @param {string} rawA case-preserved, trimmed
 * @param {string} rawB case-preserved, trimmed
 * @return {number} 0-1
 */
function wordSubstringSimilarity_(rawA, rawB) {
  return Math.max(wordSubstringMatchOneDirection_(rawA, rawB), wordSubstringMatchOneDirection_(rawB, rawA));
}

/**
 * The actual per-pair score determineOrientation_ uses: the best of
 * three independent checks - typo/containment (stringSimilarity_),
 * acronym/initialism (acronymSimilarity_), and whole-word contiguous
 * excerpt (wordSubstringSimilarity_). Takes raw (case-preserved) names -
 * it does its own normalizing for each sub-check, since they need
 * different things (stringSimilarity_ wants lowercased text; the other
 * two need the original casing to find camelCase word boundaries).
 * @param {string} rawA
 * @param {string} rawB
 * @return {number} 0-1
 */
function combinedSimilarity_(rawA, rawB) {
  var a = normalizeTeamName_(rawA);
  var b = normalizeTeamName_(rawB);
  if (!a || !b) return 0;
  return Math.max(
    stringSimilarity_(a, b),
    acronymSimilarity_(rawA, rawB),
    wordSubstringSimilarity_(rawA, rawB)
  );
}

/**
 * Compares the sheet's existing Team 1/Team 2 text against the draft's
 * actual team names to figure out whether they're in the same order or
 * reversed. Tries an exact match first; if that fails, falls back to
 * fuzzy name matching (see combinedSimilarity_) to catch common naming
 * discrepancies - a sponsor tag, "The" prefix, minor typo, or an
 * acronym/initialism (with "and"/"n"/"&" all treated as the same
 * connector) - on one side or the other.
 *
 * The fuzzy fallback only needs ONE side to land a confident match -
 * e.g. if the sheet's "Ravens" scores well against the draft's "The
 * Ravens", that alone is enough to infer the other side's orientation
 * too, even if that other pair of names differs more than the
 * confidence threshold would allow on its own.
 *
 * Either way, the sheet's own team names are treated as ground truth:
 * this function only ever reports which way things line up - it never
 * substitutes the draft's names for the sheet's. See processEntries_,
 * which only ever fills in a team name cell when it was already blank.
 * @return {{swapped: boolean, matched: boolean, confidence: string}}
 *   confidence is 'exact', 'fuzzy', or 'none'. matched=false means
 *   neither order lined up confidently (or the sheet had no team names
 *   yet to compare against) - caller should NOT assume an order in
 *   that case.
 */
function determineOrientation_(sheetTeam1, sheetTeam2, draftTeam1Name, draftTeam2Name) {
  var s1 = normalizeTeamName_(sheetTeam1);
  var s2 = normalizeTeamName_(sheetTeam2);
  var d1 = normalizeTeamName_(draftTeam1Name);
  var d2 = normalizeTeamName_(draftTeam2Name);

  if (!s1 && !s2) return { swapped: false, matched: false, confidence: 'none' }; // nothing to compare against yet
  if (s1 === d1 && s2 === d2) return { swapped: false, matched: true, confidence: 'exact' };
  if (s1 === d2 && s2 === d1) return { swapped: true, matched: true, confidence: 'exact' };

  var unswappedConfidence = Math.max(
    s1 && d1 ? combinedSimilarity_(sheetTeam1, draftTeam1Name) : 0,
    s2 && d2 ? combinedSimilarity_(sheetTeam2, draftTeam2Name) : 0
  );
  var swappedConfidence = Math.max(
    s1 && d2 ? combinedSimilarity_(sheetTeam1, draftTeam2Name) : 0,
    s2 && d1 ? combinedSimilarity_(sheetTeam2, draftTeam1Name) : 0
  );

  if (unswappedConfidence >= FUZZY_MATCH_MIN_CONFIDENCE &&
      unswappedConfidence - swappedConfidence >= FUZZY_MATCH_MIN_MARGIN) {
    return { swapped: false, matched: true, confidence: 'fuzzy' };
  }
  if (swappedConfidence >= FUZZY_MATCH_MIN_CONFIDENCE &&
      swappedConfidence - unswappedConfidence >= FUZZY_MATCH_MIN_MARGIN) {
    return { swapped: true, matched: true, confidence: 'fuzzy' };
  }

  return { swapped: false, matched: false, confidence: 'none' }; // names present but didn't line up confidently either way
}

/**
 * Given whether the row is swapped, returns which SHEET column (1 or
 * 2, meaning Team 1 or Team 2) a given DRAFT team number corresponds
 * to.
 * @param {{swapped: boolean}} orient
 * @param {number} draftTeamNumber 1 or 2
 * @return {number} 1 or 2
 */
function sheetColumnForDraftTeam_(orient, draftTeamNumber) {
  if (!orient.swapped) return draftTeamNumber;
  return draftTeamNumber === 1 ? 2 : 1;
}

function writeSingleCell_(sheet, row, col, value) {
  sheet.getRange(row, col).setValue(value);
}

/**
 * Colors the Winner cell to match whichever of Team 1 / Team 2's cell
 * background it corresponds to, so the Winner column visually matches
 * whatever team-color coding is already used in that row - whatever
 * that happens to be, since it just copies the color rather than
 * assuming any particular one.
 * @param {Sheet} sheet
 * @param {number} row
 * @param {number} col DRAFT_URL_COLUMN (the anchor column offsets are relative to)
 * @param {number} winnerSheetCol 1 or 2 - which team column the winner came from
 */
function applyWinnerColor_(sheet, row, col, winnerSheetCol) {
  var sourceOffset = winnerSheetCol === 1 ? TEAM1_NAME_OFFSET : TEAM2_NAME_OFFSET;
  var sourceColor = sheet.getRange(row, col + sourceOffset).getBackground();
  sheet.getRange(row, col + WINNER_OFFSET).setBackground(sourceColor);
}

/**
 * Main entry point, called by the sidebar's "Fetch Draft Data" button.
 * Reads every row in the configured Draft URL column (column H by
 * default) - no cell selection needed. Rows that are already fully
 * done (both halves complete) are skipped before any API call is made
 * for them - see getEntriesFromColumnH_.
 * @return {{summary: string, debugLog: string}} summary is the
 *   human-readable result for the sidebar's status line; debugLog is
 *   the raw request/response text collected this run (empty string
 *   when debug mode is off), for the sidebar's copyable debug field.
 */
function fetchDraftData() {
  DEBUG_LOG_ENTRIES = [];
  var config = loadConfigIntoGlobals_();

  var scan = getEntriesFromColumnH_();
  if (scan.entries.length === 0) {
    if (scan.alreadyCompleteCount > 0) {
      return {
        summary: 'Nothing to do - all ' + scan.alreadyCompleteCount +
          ' row' + (scan.alreadyCompleteCount === 1 ? '' : 's') + ' already complete.',
        debugLog: ''
      };
    }
    throw new Error('No draft codes found in column ' + columnNumberToLetter_(DRAFT_URL_COLUMN) + '.');
  }

  var summary = processEntries_(scan.entries);
  if (scan.alreadyCompleteCount > 0) {
    summary += ' ' + scan.alreadyCompleteCount +
      ' row' + (scan.alreadyCompleteCount === 1 ? '' : 's') + ' already complete, skipped.';
  }

  return {
    summary: summary,
    debugLog: config.debugMode ? DEBUG_LOG_ENTRIES.join('\n\n') : ''
  };
}

/**
 * For every entry: fetches the draft (batched, 25 at a time), fetches
 * every distinct linked match still needed (batched), figures out
 * whether Team 1/Team 2 are reversed relative to the draft, and writes
 * whichever of the two "halves" isn't already done - oriented to match
 * your existing Team 1/Team 2 columns rather than the draft's own
 * numbering. Called by fetchDraftData(); assumes
 * loadConfigIntoGlobals_() has already been called this execution.
 *
 * @param {Array<Object>} entries as returned by getEntriesFromColumnH_
 *   (already excludes rows where both halves are complete).
 * @return {string} a human-readable summary.
 */
function processEntries_(entries) {
  var codes = entries.map(function (e) { return e.draftCode; });
  var draftsByCode = fetchDraftsByCodes_(codes);

  // Effective match ID per entry: a Match ID you've already pasted into
  // the sheet always wins (you may have it when Statlocker hasn't
  // linked the draft yet, e.g. a bad auto-link). Falls back to the
  // draft's own linked matchId when the sheet cell is blank.
  entries.forEach(function (e) {
    var d = draftsByCode[e.draftCode];
    e._draft = d;
    e._effectiveMatchId = e.sheetMatchId || (d && d.matchId) || null;
  });

  var matchIds = [];
  entries.forEach(function (e) {
    if (e.matchHalfComplete) return; // already have Match ID + Winner + Match Length - no lookup needed
    if (e._effectiveMatchId && matchIds.indexOf(e._effectiveMatchId) === -1) {
      matchIds.push(e._effectiveMatchId);
    }
  });
  var matchesById = matchIds.length ? fetchMatchesByIds_(matchIds) : {};

  var writtenCount = 0;
  var missing = [];         // codes with no draft data returned
  var ambiguous = [];       // rows where team order couldn't be confirmed at all
  var fuzzyMatched = [];    // rows where team order was inferred by fuzzy name match, not exact
  var fallbackWinnerCount = 0; // rows where the match endpoint didn't give amberHandWon
  var draftHalfSkipped = 0; // rows whose picks/bans were already written
  var matchHalfSkipped = 0; // rows whose Match ID/Winner/Match Length were already complete

  entries.forEach(function (e) {
    var d = e._draft;
    if (!d) {
      missing.push(e.cellA1 + ' (' + e.draftCode + ')');
      return;
    }

    var teams = d.teams || [];
    var t1 = teams.filter(function (t) { return t.teamNumber === 1; })[0] || {};
    var t2 = teams.filter(function (t) { return t.teamNumber === 2; })[0] || {};

    var orient = determineOrientation_(e.sheetTeam1, e.sheetTeam2, t1.name, t2.name);
    var draftHasGenericNames = isGenericSideLabel_(t1.name) && isGenericSideLabel_(t2.name);
    if (!orient.matched && e.sheetTeam1 && e.sheetTeam2 && !draftHasGenericNames) {
      var writeDescription = e.draftHalfComplete
        ? 'existing picks/bans were left as-is - team order could not be re-verified this run'
        : 'picks/bans written unswapped this run';
      ambiguous.push(e.cellA1 + ': sheet teams "' + e.sheetTeam1 + '" / "' + e.sheetTeam2 +
        '" did not match draft teams "' + (t1.name || '') + '" / "' + (t2.name || '') +
        '" - ' + writeDescription + ', please verify.');
    } else if (orient.matched && orient.confidence === 'fuzzy') {
      // Not wrong often, but it IS a guess - worth a quick glance
      // rather than being indistinguishable from an exact match.
      fuzzyMatched.push(e.cellA1 + ': sheet teams "' + e.sheetTeam1 + '" / "' + e.sheetTeam2 +
        '" matched draft teams "' + (t1.name || '') + '" / "' + (t2.name || '') +
        '" by close-but-not-exact name, ' + (orient.swapped ? 'swapped' : 'kept as-is') + '.');
    }

    // Team names: only fill in if currently blank, oriented correctly.
    if (!e.sheetTeam1 && (orient.swapped ? t2.name : t1.name)) {
      writeSingleCell_(e.sheet, e.row, e.col + TEAM1_NAME_OFFSET, orient.swapped ? t2.name : t1.name);
    }
    if (!e.sheetTeam2 && (orient.swapped ? t1.name : t2.name)) {
      writeSingleCell_(e.sheet, e.row, e.col + TEAM2_NAME_OFFSET, orient.swapped ? t1.name : t2.name);
    }

    // Match ID: only fill in if you haven't already pasted one in by hand.
    if (!e.sheetMatchId && e._effectiveMatchId) {
      writeSingleCell_(e.sheet, e.row, e.col + MATCH_ID_OFFSET, e._effectiveMatchId);
    }

    var match = e._effectiveMatchId ? matchesById[e._effectiveMatchId] : null;

    if (!e.matchHalfComplete) {
      // Match length - straight from the match endpoint. If the match
      // couldn't be fetched (or the ID doesn't exist yet, e.g. the game
      // hasn't finished), this is left blank - re-running Fetch Draft
      // Data later will try again, since this half still won't be complete.
      var durationSeconds = extractMatchDurationSeconds_(match);
      if (durationSeconds !== null) {
        writeSingleCell_(e.sheet, e.row, e.col + MATCH_LENGTH_OFFSET, formatDuration_(durationSeconds));
      }

      // Winner - prefer the match endpoint's amberHandWon (authoritative,
      // works even when the draft itself doesn't carry a winner e.g. a
      // manually-pasted Match ID). The match endpoint can lack
      // amberHandWon even when the draft already knows the winner, so
      // fall back to the draft's own winnerTeamNumber in that case
      // instead of leaving Winner blank. If neither has it yet (match
      // still in progress), Winner is left blank and picked up on a
      // later manual re-run.
      var winnerTeamNumber = winnerTeamNumberFromMatch_(match, teams);
      var usedFallbackWinner = false;
      if (winnerTeamNumber === null && (d.winnerTeamNumber === 1 || d.winnerTeamNumber === 2)) {
        winnerTeamNumber = d.winnerTeamNumber;
        usedFallbackWinner = true;
      }
      if (winnerTeamNumber === 1 || winnerTeamNumber === 2) {
        var winnerSheetCol = sheetColumnForDraftTeam_(orient, winnerTeamNumber);
        var winnerName = winnerSheetCol === 1 ? (e.sheetTeam1 || t1.name) : (e.sheetTeam2 || t2.name);
        if (winnerName) {
          writeSingleCell_(e.sheet, e.row, e.col + WINNER_OFFSET, winnerName);
          applyWinnerColor_(e.sheet, e.row, e.col, winnerSheetCol);
          if (usedFallbackWinner) fallbackWinnerCount++;
        }
      }
    } else {
      matchHalfSkipped++;
    }

    if (!e.draftHalfComplete) {
      // Picks/bans, oriented to the correct sheet side and arranged
      // according to PICK_BAN_ORDER.
      var heroNames = buildPickBanOrder_(d.steps, orient);
      writeDraftRowToSheet(e.sheet, e.cellA1, heroNames);
    } else {
      draftHalfSkipped++;
    }

    writtenCount++;
  });

  var message = writtenCount + ' of ' + entries.length + ' draft' +
    (entries.length === 1 ? '' : 's') + ' processed.';
  if (draftHalfSkipped > 0 || matchHalfSkipped > 0) {
    message += ' (' + draftHalfSkipped + ' already had picks/bans, ' +
      matchHalfSkipped + ' already had Match ID/Winner/Length.)';
  }
  if (fallbackWinnerCount > 0) {
    message += ' ' + fallbackWinnerCount + ' winner' + (fallbackWinnerCount === 1 ? '' : 's') +
      ' used the draft\'s own result (match endpoint had no amberHandWon).';
  }
  if (missing.length > 0) {
    message += ' No draft data returned for: ' + missing.join(', ') + '.';
  }
  if (fuzzyMatched.length > 0) {
    message += ' ' + fuzzyMatched.join(' ');
  }
  if (ambiguous.length > 0) {
    message += ' ' + ambiguous.join(' ');
  }
  return message;
}

/**
 * Writes one draft's picks/bans into the sheet as a single contiguous
 * row of cells, starting at PICKS_START_OFFSET relative to the draft
 * code cell. The order/grouping of heroNames itself is decided by
 * buildPickBanOrder_ (per PICK_BAN_ORDER) before this is called - this
 * function just lays whatever it's given out left-to-right, no gaps.
 *
 * @param {Sheet} sheet the sheet tab this row belongs to - never
 *   inferred from getActiveSheet() (see writeSingleCell_'s JSDoc and
 *   doPost's JSDoc for why).
 * @param {string} sourceCellA1 A1 notation of the draft code cell.
 * @param {Array<string>} heroNames ordered hero name strings.
 * @return {string} A1 notation of the first cell written, or
 *   sourceCellA1 unchanged if there was nothing to write.
 */
function writeDraftRowToSheet(sheet, sourceCellA1, heroNames) {
  if (!heroNames || heroNames.length === 0) return sourceCellA1;

  var sourceRange = sheet.getRange(sourceCellA1);
  var sourceRow = sourceRange.getRow();
  var startCol = sourceRange.getColumn() + PICKS_START_OFFSET;

  var range = sheet.getRange(sourceRow, startCol, 1, heroNames.length);
  range.setValues([heroNames]);

  return range.getCell(1, 1).getA1Notation();
}

/**
 * =====================================================================
 * MATCH THREAD CREATION (Discord)
 * =====================================================================
 * Creates one forum post per SERIES in the configured matches forum
 * channel, tagging both teams' Discord roles by exact name match
 * against Team 1/Team 2, and writes a "waiting for draft" placeholder
 * into every row that series covers (see buildMatchThreadEntries_).
 * Entry point: createMatchThreads(), called by the sidebar's "Create
 * Match Threads" button.
 *
 * ROW SELECTION: if the current selection has any rows where BOTH the
 * Team 1 cell and Team 2 cell are highlighted, only those rows are
 * used. Otherwise, every row with Team 1 AND Team 2 filled in but no
 * Draft URL yet is used. Either way, a row whose Draft URL cell is
 * already non-blank - whether that's the placeholder or a real draft
 * URL someone's since pasted in - is always skipped, so a repeat click
 * never creates a duplicate thread.
 *
 * SERIES GROUPING (best-of-X): once the candidate rows above are
 * found, they're grouped into series by buildMatchThreadEntries_ - a
 * run of rows counts as one series only when EVERY row in it sits on
 * the next sheet row after the previous one (no gap) AND has the exact
 * same Team 1/Team 2 text (case-insensitive). One thread gets created
 * per series, not per row - a best-of-3 block of rows 5-7 makes exactly
 * one thread, which then plays out game-by-game as "Match Complete" is
 * pressed on each row in turn (see MATCH COMPLETION further down).
 *
 * SIDE SELECTION OVERRIDE: for each row, if exactly one of its Team 1/
 * Team 2 cells is bold, that team gets automatic choice priority for
 * that specific game - no coinflip (game 1) and no losers-pick (later
 * games). Bold on both cells or neither is not an override.
 *
 * UNDERLINE OVERRIDE: for each row, if exactly one of its Team 1/Team 2
 * cells is underlined, that team is locked onto Hidden King directly -
 * no coinflip AND no side-selection buttons. If BOTH cells are
 * underlined and this isn't game 1 of the series, the two teams swap
 * sides from the previous game instead. Ambiguous combinations (see
 * getSideSignalsForRow_) fall back to the standard rule untouched.
 * =====================================================================
 */

/**
 * Main entry point, called by the sidebar's "Create Match Threads"
 * button. See the ROW SELECTION rules above.
 * @return {{summary: string, debugLog: string}}
 */
function createMatchThreads() {
  DEBUG_LOG_ENTRIES = [];
  var config = loadConfigIntoGlobals_();

  // Captured now, while a human is actually looking at this tab -
  // this is the only reliable moment to know it. See startCoinflip_'s
  // JSDoc for why this can't just be re-derived later from
  // getActiveSheet() when the webhook call comes back in.
  var sheetName = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();
  var sheet = getSheetByNameOrThrow_(sheetName);

  if (!DISCORD_GUILD_ID || !DISCORD_MATCHES_FORUM_CHANNEL_ID) {
    throw new Error('Set the Discord Server ID and Matches Forum Channel ID in Settings before creating match threads.');
  }

  var selectedRows = getSelectedRowsWithBothTeams_();
  var usedSelection = selectedRows.length > 0;
  var rowNumbers = usedSelection ? selectedRows : getScannedRowsNeedingThreads_();

  var built = buildMatchThreadEntries_(rowNumbers);
  var entries = built.entries;

  if (entries.length === 0) {
    if (built.alreadyHasThreadCount > 0) {
      return {
        summary: 'Nothing to do - all ' + built.alreadyHasThreadCount +
          ' matching row' + (built.alreadyHasThreadCount === 1 ? '' : 's') + ' already have a thread.',
        debugLog: ''
      };
    }
    throw new Error(usedSelection
      ? 'None of the selected rows have both Team 1 and Team 2 filled in.'
      : 'No rows found with Team 1 and Team 2 filled in and no Draft URL yet.');
  }

  var roleIdByName = getGuildRolesByName_();

  var createdCount = 0;
  var missingRoles = [];
  var threadFailures = [];
  var coinflipFailures = [];
  var registerFailures = [];

  entries.forEach(function (e) {
    var team1RoleId = roleIdByName[e.team1];
    var team2RoleId = roleIdByName[e.team2];
    var rowsLabel = e.rows.length > 1 ? ('rows ' + e.rows[0] + '-' + e.rows[e.rows.length - 1]) : ('row ' + e.rows[0]);

    if (!team1RoleId || !team2RoleId) {
      var missingNames = [];
      if (!team1RoleId) missingNames.push(e.team1);
      if (!team2RoleId) missingNames.push(e.team2);
      missingRoles.push(rowsLabel + ' (' + missingNames.join(', ') + ')');
      return;
    }

    var bestOf = e.rows.length;
    var threadName = (e.team1 + ' vs ' + e.team2 + (bestOf > 1 ? ' (Bo' + bestOf + (e.playAll ? ', play all' : '') + ')' : ''))
      .slice(0, 100); // Discord's thread name limit
    var content = buildMatchThreadMessage_(MATCH_THREAD_MESSAGE_TEMPLATE, team1RoleId, team2RoleId, e.round, bestOf, roleIdByName, e.playAll);

    // Isolated from the rest of the batch: one series' thread creation
    // failing (bad permissions, a transient Discord error, etc.) should
    // be reported and skipped, not abort every series after it.
    var thread;
    try {
      thread = createForumThread_(DISCORD_MATCHES_FORUM_CHANNEL_ID, threadName, content);
    } catch (err) {
      threadFailures.push(rowsLabel + ' (' + err.message + ')');
      return;
    }

    // The placeholder goes into EVERY row this series covers - not
    // just the first - so a later "Create Match Threads" run never
    // mistakes an unstarted later game in this same series for a brand
    // new match needing its own thread. Only the row whose game is
    // currently being played ever gets a real draft URL; the rest get
    // theirs one at a time as the series progresses (see
    // advanceSeriesAfterWin_ in discord-relay-worker.js).
    e.rows.forEach(function (row) {
      writeSingleCell_(sheet, row, DRAFT_URL_COLUMN, MATCH_THREAD_PLACEHOLDER);
    });
    // Commit this placeholder write NOW, before startCoinflip_ below. For
    // an underline-locked match, that call synchronously triggers a
    // nested doPost() execution (runHiddenKingLock_ -> writeDraftUrl_)
    // that writes the REAL draft URL into this same cell before this
    // function returns. Without an explicit flush here, this execution's
    // buffered "waiting for draft" write is still only local - when this
    // function eventually ends and Apps Script commits its buffer, it
    // silently clobbers whatever the nested webhook call already wrote,
    // reverting the cell back to the placeholder with no error anywhere.
    SpreadsheetApp.flush();
    createdCount++;

    // Registered before the coinflip call so the Match Complete button
    // (already visible the instant the thread was created, above) works
    // even if the coinflip call that follows fails on its own.
    try {
      registerMatchSeries_(thread.id, e.rows, sheetName, e.team1, e.team2, team1RoleId, team2RoleId, e.round, e.sideOverrides, e.hiddenKingOverrides, e.playAll);
    } catch (err) {
      registerFailures.push(rowsLabel + ' (' + err.message + ')');
    }

    try {
      // Only the FIRST game's side is decided by coinflip - every
      // later game in the series (if any) has its side chosen by
      // whichever team lost the previous game instead; see
      // advanceSeriesAfterWin_ in discord-relay-worker.js, which
      // takes over from here once a winner is recorded. Either way,
      // e.sideOverrides[0] can force game 1's side selection straight
      // to one team (bold override - see getSideSignalsForRow_),
      // skipping the coinflip entirely for that game - and
      // e.hiddenKingOverrides[0] can go further still (underline
      // override) and skip the side-selection buttons too, locking
      // that team onto Hidden King and creating the draft immediately.
      startCoinflip_(thread.id, e.rows[0], sheetName, e.team1, e.team2, team1RoleId, team2RoleId, e.round, e.sideOverrides[0], e.hiddenKingOverrides[0]);
    } catch (err) {
      // The thread itself was created successfully - a coinflip failure
      // shouldn't be treated as the whole series having failed, but it
      // does need to be visible so you know to trigger the flip manually.
      coinflipFailures.push(rowsLabel + ' (' + err.message + ')');
    }
  });

  var message = createdCount + ' of ' + entries.length + ' match thread' +
    (entries.length === 1 ? '' : 's') + ' created.';
  if (built.alreadyHasThreadCount > 0) {
    message += ' ' + built.alreadyHasThreadCount +
      ' row' + (built.alreadyHasThreadCount === 1 ? '' : 's') + ' already had a thread, skipped.';
  }
  if (missingRoles.length > 0) {
    message += ' No matching Discord role for: ' + missingRoles.join('; ') + '.';
  }
  if (threadFailures.length > 0) {
    message += ' Thread creation failed for: ' + threadFailures.join('; ') + '.';
  }
  if (coinflipFailures.length > 0) {
    message += ' Coinflip failed to start for: ' + coinflipFailures.join('; ') + '.';
  }
  if (registerFailures.length > 0) {
    message += ' Match Complete button won\'t work yet for: ' + registerFailures.join('; ') +
      ' (re-run once fixed, or ask an organizer to run Fetch Draft Data manually for those rows).';
  }

  return {
    summary: message,
    debugLog: config.debugMode ? DEBUG_LOG_ENTRIES.join('\n\n') : ''
  };
}

/**
 * Finds every row where BOTH the Team 1 cell and Team 2 cell are
 * within the current selection - a row highlighted only partway
 * (e.g. just Team 1) does not count.
 * @return {Array<number>} sorted row numbers.
 */
function getSelectedRowsWithBothTeams_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var rangeList = sheet.getActiveRangeList();
  var activeRange = sheet.getActiveRange();
  var ranges = rangeList ? rangeList.getRanges() : (activeRange ? [activeRange] : []);
  if (ranges.length === 0) return [];

  var team1Col = DRAFT_URL_COLUMN + TEAM1_NAME_OFFSET;
  var team2Col = DRAFT_URL_COLUMN + TEAM2_NAME_OFFSET;

  var covered = {}; // row -> { team1: boolean, team2: boolean }
  ranges.forEach(function (range) {
    var startRow = range.getRow();
    var endRow = startRow + range.getNumRows() - 1;
    var startCol = range.getColumn();
    var endCol = startCol + range.getNumColumns() - 1;
    var coversTeam1 = team1Col >= startCol && team1Col <= endCol;
    var coversTeam2 = team2Col >= startCol && team2Col <= endCol;
    if (!coversTeam1 && !coversTeam2) return;

    for (var r = startRow; r <= endRow; r++) {
      if (!covered[r]) covered[r] = { team1: false, team2: false };
      if (coversTeam1) covered[r].team1 = true;
      if (coversTeam2) covered[r].team2 = true;
    }
  });

  var rows = [];
  Object.keys(covered).forEach(function (rowStr) {
    var row = Number(rowStr);
    if (covered[row].team1 && covered[row].team2) rows.push(row);
  });
  rows.sort(function (a, b) { return a - b; });
  return rows;
}

/**
 * Scans the whole sheet for rows with Team 1 AND Team 2 filled in but
 * no Draft URL yet - the fallback used when nothing qualifies via
 * getSelectedRowsWithBothTeams_().
 * @return {Array<number>} row numbers.
 */
function getScannedRowsNeedingThreads_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < SHEET_DATA_START_ROW) return [];

  var numRows = lastRow - SHEET_DATA_START_ROW + 1;
  var team1Values = sheet.getRange(SHEET_DATA_START_ROW, DRAFT_URL_COLUMN + TEAM1_NAME_OFFSET, numRows, 1).getValues();
  var team2Values = sheet.getRange(SHEET_DATA_START_ROW, DRAFT_URL_COLUMN + TEAM2_NAME_OFFSET, numRows, 1).getValues();
  var draftUrlValues = sheet.getRange(SHEET_DATA_START_ROW, DRAFT_URL_COLUMN, numRows, 1).getValues();

  var rows = [];
  for (var i = 0; i < numRows; i++) {
    var hasTeam1 = String(team1Values[i][0] || '').trim() !== '';
    var hasTeam2 = String(team2Values[i][0] || '').trim() !== '';
    var hasDraftUrl = String(draftUrlValues[i][0] || '').trim() !== '';
    if (hasTeam1 && hasTeam2 && !hasDraftUrl) rows.push(SHEET_DATA_START_ROW + i);
  }
  return rows;
}

/**
 * Reads Team 1/Team 2/Round for a list of row numbers, drops rows
 * whose Draft URL cell is already non-blank (placeholder or real URL)
 * so they're never re-created, then groups what's left into best-of-X
 * SERIES: a run of two or more rows counts as one series only when
 * every row in it sits on the sheet row directly after the previous
 * one (no gap - a dropped/skipped row breaks the run) AND has the
 * exact same Team 1/Team 2 text, compared case-insensitively via
 * normalizeTeamName_. A row with no such neighbor is still returned as
 * its own one-row series (an ordinary best-of-1 match) - see
 * createMatchThreads(), which reads e.rows.length as that series' "Bo"
 * number.
 *
 * Also reads each row's side-selection signals via
 * getSideSignalsForRow_ (bold and underline formatting on that row's
 * Team 1/Team 2 cells) - this is read now, up front for every row in
 * the series including games that haven't started yet, since bold/
 * underline formatting on a not-yet-played game's row can't be
 * reliably re-read later (its Draft URL cell is still blank, so it
 * wouldn't be found by a future createMatchThreads() scan once the
 * series is underway). Each row's index WITHIN its series (0 for game
 * 1, 1 for game 2, ...) is known only once rows have been grouped into
 * runs below, which is why signals are read after grouping rather than
 * in the same pass as everything else - see getSideSignalsForRow_'s
 * isFirstGameOfSeries param.
 * @param {Array<number>} rowNumbers
 * @return {{entries: Array<Object>, alreadyHasThreadCount: number}}
 *   entries: { rows: Array<number>, team1, team2, round, sideOverrides,
 *   hiddenKingOverrides } - rows is ascending and, for a series of
 *   length > 1, contiguous. sideOverrides and hiddenKingOverrides are
 *   each an array parallel to rows (see getSideSignalsForRow_).
 *   alreadyHasThreadCount counts individual ROWS skipped for already
 *   having a thread (placeholder or real URL), not series.
 */
function buildMatchThreadEntries_(rowNumbers) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var perRow = [];
  var alreadyHasThreadCount = 0;

  rowNumbers.forEach(function (row) {
    var team1 = String(sheet.getRange(row, DRAFT_URL_COLUMN + TEAM1_NAME_OFFSET).getValue() || '').trim();
    var team2 = String(sheet.getRange(row, DRAFT_URL_COLUMN + TEAM2_NAME_OFFSET).getValue() || '').trim();
    var round = String(sheet.getRange(row, DRAFT_URL_COLUMN + ROUND_OFFSET).getValue() || '').trim();
    var draftUrlCell = String(sheet.getRange(row, DRAFT_URL_COLUMN).getValue() || '').trim();

    if (draftUrlCell) { alreadyHasThreadCount++; return; }
    if (!team1 || !team2) return;

    perRow.push({ row: row, team1: team1, team2: team2, round: round });
  });

  perRow.sort(function (a, b) { return a.row - b.row; });

  var entries = [];
  var i = 0;
  while (i < perRow.length) {
    var run = [perRow[i]];
    var j = i + 1;
    while (j < perRow.length &&
           perRow[j].row === perRow[j - 1].row + 1 &&
           normalizeTeamName_(perRow[j].team1) === normalizeTeamName_(perRow[i].team1) &&
           normalizeTeamName_(perRow[j].team2) === normalizeTeamName_(perRow[i].team2)) {
      run.push(perRow[j]);
      j++;
    }

    var sideOverrides = [];
    var hiddenKingOverrides = [];
    run.forEach(function (r, idx) {
      var signals = getSideSignalsForRow_(sheet, r.row, idx === 0);
      sideOverrides.push(signals.boldOverride);
      hiddenKingOverrides.push(signals.hiddenKingOverride);
    });

    entries.push({
      rows: run.map(function (r) { return r.row; }),
      team1: run[0].team1,
      team2: run[0].team2,
      round: run[0].round,
      sideOverrides: sideOverrides,
      hiddenKingOverrides: hiddenKingOverrides,
      // "Play all" signal (see isRoundCellUnderlined_) - only game 1's
      // Round cell is checked; underlining any other row's Round cell
      // in the same series has no effect.
      playAll: isRoundCellUnderlined_(sheet, run[0].row)
    });
    i = j;
  }

  return { entries: entries, alreadyHasThreadCount: alreadyHasThreadCount };
}

/**
 * PLAY ALL: whether a best-of-X series should keep creating/playing
 * every one of its rows even after one side has already clinched the
 * series majority - normally a clinch ends things early (see
 * advanceSeriesAfterWin_ in discord-relay-worker.js, and
 * markRowsNotPlayed_ for what happens to the unplayed rows when it
 * does). Signaled the same way as the other per-row formatting
 * overrides above: underline the Round cell on the series' GAME 1 row
 * only - underlining it on any later row in the same series is
 * ignored.
 * @param {Sheet} sheet
 * @param {number} row game 1's row for this series.
 * @return {boolean}
 */
function isRoundCellUnderlined_(sheet, row) {
  return sheet.getRange(row, DRAFT_URL_COLUMN + ROUND_OFFSET).getFontLine() === 'underline';
}

/**
 * Checks a single row's Team 1/Team 2 cells for BOTH side-selection
 * signals this bot understands - bold and underline:
 *
 *   - BOLD on exactly one of the two cells means that team gets
 *     automatic choice priority for this row's game - no coinflip, and
 *     (for game 2+) the losers-pick rule is skipped - but the team
 *     still chooses side or pick order first via the normal buttons. Bold on
 *     both cells, or on neither, is not an override.
 *
 *   - UNDERLINE on exactly one of the two cells means that team is
 *     locked onto Hidden King directly for this game - no coinflip AND
 *     no side choice; the other (Archmother) team only chooses First/
 *     Second Pick, then the draft is created.
 *
 *   - UNDERLINE on BOTH cells means the two teams swap sides from the
 *     previous game (whoever was Hidden King last game becomes
 *     Archmother, and vice versa) - again with no coinflip/side choice -
 *     but only from game 2 of a series onward, since game 1 has no
 *     previous game to swap from (see isFirstGameOfSeries below).
 *
 * Some combinations are AMBIGUOUS and fall back to the standard
 * coinflip/losers-pick rule entirely, ignoring both bold and underline
 * for that row:
 *   - a single cell is both bold AND underlined
 *   - one team is underlined while the OTHER is bold
 *   - both teams are underlined on game 1 of a series
 *
 * @param {Sheet} sheet
 * @param {number} row
 * @param {boolean} isFirstGameOfSeries true when this row is the first
 *   row of its series (game 1) - controls whether "both underlined"
 *   means "swap from last game" (game 2+) or is ambiguous (game 1,
 *   since there's no last game yet).
 * @return {{boldOverride: ?string, hiddenKingOverride: ?string}}
 *   boldOverride is 'team1', 'team2', or null. hiddenKingOverride is
 *   'team1', 'team2', 'swap', or null. At most one of the two fields is
 *   ever non-null for a given row - underline (when unambiguous) always
 *   takes priority over bold, since a row can only have one signal at
 *   a time by construction here.
 */
function getSideSignalsForRow_(sheet, row, isFirstGameOfSeries) {
  var team1Cell = sheet.getRange(row, DRAFT_URL_COLUMN + TEAM1_NAME_OFFSET);
  var team2Cell = sheet.getRange(row, DRAFT_URL_COLUMN + TEAM2_NAME_OFFSET);

  var team1Bold = team1Cell.getFontWeight() === 'bold';
  var team2Bold = team2Cell.getFontWeight() === 'bold';
  var team1Underline = team1Cell.getFontLine() === 'underline';
  var team2Underline = team2Cell.getFontLine() === 'underline';

  var sameCellBoldAndUnderline = (team1Bold && team1Underline) || (team2Bold && team2Underline);
  var crossedBoldAndUnderline = (team1Underline && team2Bold) || (team2Underline && team1Bold);
  var bothUnderlinedOnGameOne = team1Underline && team2Underline && isFirstGameOfSeries;

  if (sameCellBoldAndUnderline || crossedBoldAndUnderline || bothUnderlinedOnGameOne) {
    // Ambiguous - ignore both signals for this row entirely, standard
    // coinflip/losers-pick rule applies as if nothing were formatted.
    return { boldOverride: null, hiddenKingOverride: null };
  }

  if (team1Underline !== team2Underline) {
    return { boldOverride: null, hiddenKingOverride: team1Underline ? 'team1' : 'team2' };
  }

  if (team1Underline && team2Underline) {
    // Both underlined, game 2+ (game 1 was already handled above by
    // bothUnderlinedOnGameOne) - swap from the previous game.
    return { boldOverride: null, hiddenKingOverride: 'swap' };
  }

  // No underline signal on this row at all - fall back to the bold-only
  // rule exactly as before.
  var boldOverride = (team1Bold === team2Bold) ? null : (team1Bold ? 'team1' : 'team2');
  return { boldOverride: boldOverride, hiddenKingOverride: null };
}

/**
 * Fills in a match thread message template with the given round text,
 * role mentions for both teams, and a description of the series length.
 * Also resolves any other @RoleName text in the template (e.g. "@Tournament
 * Admin") into a real Discord role mention - see applyRoleMentions_.
 * @param {string} template raw text containing {{team1}}, {{team2}},
 *   {{round}}, and/or {{bestOf}} placeholders (any/all optional, any count),
 *   plus optionally @RoleName mentions of any other guild role.
 * @param {string} team1RoleId
 * @param {string} team2RoleId
 * @param {string} round
 * @param {number=} bestOf how many rows this thread's series covers -
 *   1 (or omitted) renders {{bestOf}} as "a single match"; 3, 5, etc.
 *   render as "Best of 3", "Best of 5", and so on. See
 *   buildMatchThreadEntries_ for how a series' row count is decided.
 * @param {Object=} roleIdByName role name -> role ID map, from
 *   getGuildRolesByName_ - used to resolve @RoleName mentions. Omit to
 *   skip that step (team1RoleId/team2RoleId's {{team1}}/{{team2}} still
 *   resolve either way).
 * @param {boolean=} playAll from isRoundCellUnderlined_ - appends
 *   ", play all" onto the {{bestOf}} text (e.g. "Best of 3, play all").
 * @return {string}
 */
function buildMatchThreadMessage_(template, team1RoleId, team2RoleId, round, bestOf, roleIdByName, playAll) {
  var text = String(template || '').trim();
  if (!text) text = '{{team1}} {{team2}}'; // Discord requires non-empty message content

  var bestOfText = (bestOf && bestOf > 1) ? ('Best of ' + bestOf + (playAll ? ', play all' : '')) : 'a single match';

  text = text
    .split('{{team1}}').join('<@&' + team1RoleId + '>')
    .split('{{team2}}').join('<@&' + team2RoleId + '>')
    .split('{{round}}').join(round || '')
    .split('{{bestOf}}').join(bestOfText);

  return applyRoleMentions_(text, roleIdByName);
}

/**
 * Replaces any "@RoleName" text in a message with Discord's <@&roleId>
 * mention syntax, so a configured message can tag a role the same easy
 * way a user is tagged with <@userId> - by name - instead of requiring
 * the raw <@&ROLE_ID> syntax. (Discord's own client does this
 * automatically when a human types the message; a bot posting via the
 * API has to do the substitution itself.)
 *
 * Role names are tried longest-first, so a name that's a prefix of
 * another role's name (e.g. "Team" vs "Team Alpha") doesn't get matched
 * - and left with a dangling " Alpha" - before the more specific one is
 * tried. Matching is an exact, case-sensitive substring match on
 * "@" + the role's name, same as how team names are already looked up
 * in createMatchThreads() above.
 * @param {string} text
 * @param {Object=} roleIdByName role name -> role ID map, from
 *   getGuildRolesByName_. Omit/empty to leave text unchanged.
 * @return {string}
 */
function applyRoleMentions_(text, roleIdByName) {
  if (!roleIdByName) return text;

  Object.keys(roleIdByName)
    .filter(function (name) { return name; }) // skip a blank/unnamed role, if any
    .sort(function (a, b) { return b.length - a.length; })
    .forEach(function (name) {
      text = text.split('@' + name).join('<@&' + roleIdByName[name] + '>');
    });

  return text;
}

/**
 * =====================================================================
 * MATCH COMPLETION (Discord "Match Complete" button)
 * =====================================================================
 * Reached via doPost's 'matchComplete' and 'recordWinner' actions (see
 * the SHEET WEBHOOK section below), themselves triggered by the relay
 * worker when a player presses the persistent "Match Complete" button
 * on a match thread (see createForumThread_) or one of the "who won?"
 * buttons the worker posts when Statlocker doesn't have a result yet
 * (see discord-relay-worker.js's handleMatchCompleteClick_ /
 * handleWinnerClick_).
 *
 * Both entry points below are scoped to a SINGLE row, unlike
 * fetchDraftData()/processEntries_ which walk every row in the sheet -
 * a button click should only ever touch the one match it was pressed
 * on. They reuse processEntries_ itself (just with a one-entry array)
 * so the exact same fetch/orientation/skip-if-already-done logic
 * applies whether Fetch Draft Data is run from the sidebar or
 * triggered from Discord.
 *
 * Neither function here needs to know anything about best-of-X series
 * - "row" is always whichever row's game is currently active, and the
 * relay worker (not this file) is the one tracking which row that is
 * and deciding whether to advance to the next game once a winner comes
 * back. See discord-relay-worker.js's advanceSeriesAfterWin_.
 * =====================================================================
 */

/**
 * Builds the same kind of entry object getEntriesFromColumnH_ returns,
 * but for one specific row only - no full-column scan. Returns null if
 * that row has no recognizable draft code yet (e.g. the thread's Draft
 * URL cell is still the "waiting for draft" placeholder).
 * @param {Sheet} sheet
 * @param {number} row
 * @return {?Object} same shape as one entry from getEntriesFromColumnH_
 */
function getEntryForRow_(sheet, row) {
  var col = DRAFT_URL_COLUMN;
  var raw = String(sheet.getRange(row, col).getValue() || '').trim();
  var draftCode = extractDraftCode_(raw);
  if (!draftCode) return null;

  var team1 = String(sheet.getRange(row, col + TEAM1_NAME_OFFSET).getValue() || '').trim();
  var team2 = String(sheet.getRange(row, col + TEAM2_NAME_OFFSET).getValue() || '').trim();
  var matchId = String(sheet.getRange(row, col + MATCH_ID_OFFSET).getValue() || '').trim();
  var winner = String(sheet.getRange(row, col + WINNER_OFFSET).getValue() || '').trim();
  var matchLen = String(sheet.getRange(row, col + MATCH_LENGTH_OFFSET).getValue() || '').trim();
  var firstPick = String(sheet.getRange(row, col + PICKS_START_OFFSET).getValue() || '').trim();

  return {
    cellA1: sheet.getRange(row, col).getA1Notation(),
    draftCode: draftCode,
    row: row,
    col: col,
    sheet: sheet,
    sheetTeam1: team1,
    sheetTeam2: team2,
    sheetMatchId: matchId,
    draftHalfComplete: firstPick !== '',
    matchHalfComplete: (matchId !== '' && winner !== '' && matchLen !== '')
  };
}

/**
 * Runs the equivalent of "Fetch Draft Data" for a single row - called
 * when someone presses "Match Complete" for that row's match (see
 * doPost's 'matchComplete' action). The Discord button itself can only
 * be pressed once (it's removed the moment it's clicked - see the
 * relay worker's finishMatchComplete_), but this function stays
 * idempotent regardless, since it's the same code path Fetch Draft
 * Data uses from the sidebar: if the row's already fully done, it just
 * reports the existing result without making any Statlocker API call
 * (same short-circuit getEntriesFromColumnH_ uses, applied to one row).
 * Assumes loadConfigIntoGlobals_() has already been called this
 * execution (doPost does this once before routing to any action).
 * @param {number} row
 * @param {string} sheetName
 * @return {{ok: boolean, error: (string|undefined), winnerKnown: boolean,
 *   winnerJustRecorded: boolean, winner: string, team1: string,
 *   team2: string, matchLength: string, matchIdKnown: boolean,
 *   matchLengthKnown: boolean}}
 *   winnerKnown/winnerJustRecorded/winner/team1/team2/matchLength/
 *   matchIdKnown/matchLengthKnown are only meaningful when ok is true.
 *   winnerJustRecorded is true only for the call that actually
 *   transitioned the Winner cell from empty to filled (guarded by a
 *   script lock - see below); a repeat/racing call that finds the
 *   winner already there gets winnerKnown: true but
 *   winnerJustRecorded: false, the same distinction alreadyRecorded
 *   makes for recordManualWinner_. This is what the relay worker's
 *   finishMatchComplete_ gates advanceSeriesAfterWin_ on, since the
 *   "Match Complete" button is deliberately left clickable/retryable -
 *   without this, two people pressing it around the same moment (or
 *   one impatient double-press) could each believe they were the one
 *   who just found the result and double the series score.
 *   matchIdKnown/matchLengthKnown let the caller (the relay worker)
 *   tell "Statlocker gave us everything" apart from "Statlocker never
 *   linked this match at all" independently of whether a winner has
 *   been recorded - e.g. a manually-typed winner with no Match ID/
 *   Length yet is matchIdKnown: false, matchLengthKnown: false,
 *   winnerKnown: true - see discord-relay-worker.js's
 *   missingStatsWarning_.
 */
function runMatchCompleteFetch_(row, sheetName) {
  var sheet = getSheetByNameOrThrow_(sheetName);
  var entry = getEntryForRow_(sheet, row);
  if (!entry) {
    releaseWinnerClaim_(row, sheetName);
    return { ok: false, error: 'No draft URL recorded for this match yet - link the draft in the sheet first.' };
  }

  var col = DRAFT_URL_COLUMN;
  var winnerJustRecorded = false;

  if (entry.draftHalfComplete && entry.matchHalfComplete) {
    // Already fully done - a read-only re-check needs no lock. Also
    // the common case: most Match Complete presses land after the
    // game's already resolved.
  } else {
    // Not done yet - fetching from Statlocker and writing whatever's
    // newly available needs a lock around it: two concurrent calls
    // could otherwise both read the Winner cell as empty before either
    // writes it, and both would think THEY just recorded the win.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000); // ms - a single row's fetch, not the bulk sidebar scan, so this should stay well under that
    try {
      var winnerBefore = String(sheet.getRange(row, col + WINNER_OFFSET).getValue() || '').trim();
      if (!winnerBefore) {
        processEntries_([entry]); // writes whatever is newly available straight to the sheet
        var winnerAfter = String(sheet.getRange(row, col + WINNER_OFFSET).getValue() || '').trim();
        winnerJustRecorded = winnerAfter !== '';
      }
    } finally {
      lock.releaseLock();
    }
  }

  var team1 = String(sheet.getRange(row, col + TEAM1_NAME_OFFSET).getValue() || '').trim();
  var team2 = String(sheet.getRange(row, col + TEAM2_NAME_OFFSET).getValue() || '').trim();
  var matchId = String(sheet.getRange(row, col + MATCH_ID_OFFSET).getValue() || '').trim();
  var winner = String(sheet.getRange(row, col + WINNER_OFFSET).getValue() || '').trim();
  var matchLength = String(sheet.getRange(row, col + MATCH_LENGTH_OFFSET).getValue() || '').trim();

  // Whatever this call found (or didn't), it's done touching the
  // Winner cell - release the claim now rather than making a later,
  // unrelated attempt (a retry, or a "who won?" vote) wait out the
  // remaining TTL for no reason.
  releaseWinnerClaim_(row, sheetName);

  return {
    ok: true,
    winnerKnown: winner !== '',
    winnerJustRecorded: winnerJustRecorded,
    winner: winner,
    team1: team1,
    team2: team2,
    matchLength: matchLength,
    matchIdKnown: matchId !== '',
    matchLengthKnown: matchLength !== ''
  };
}

/**
 * Writes a manually-confirmed winner into the Winner cell for a row -
 * used when the "who won?" buttons are answered because Statlocker
 * didn't have a result yet (see doPost's 'recordWinner' action).
 * Refuses to overwrite a winner that's already there: between the
 * Match Complete click and someone answering the "who won?" buttons, a
 * later automatic fetch (or another click) may have already filled it
 * in from Statlocker - that authoritative value should win over a
 * manual button press, not get clobbered by one.
 *
 * The read-check-write is wrapped in a script lock so two concurrent
 * doPost executions (e.g. a double-click) can't both read the Winner
 * cell as empty and both report alreadyRecorded: false - see the
 * in-function comment.
 * @param {number} row
 * @param {string} sheetName
 * @param {string} winnerName
 * @return {{ok: boolean, alreadyRecorded: boolean, winner: string}}
 */
function recordManualWinner_(row, sheetName, winnerName) {
  var sheet = getSheetByNameOrThrow_(sheetName);
  var col = DRAFT_URL_COLUMN;

  // Two "who won?" clicks landing close together (e.g. two players on
  // one team double-tapping) can each arrive as their own concurrent
  // doPost execution. Without a lock, both could read the Winner cell
  // as empty before either writes it, and both would then return
  // alreadyRecorded: false - which the relay worker takes as "I'm the
  // call that actually recorded this" and uses to decide whether to
  // advance the series score (see discord-relay-worker.js's
  // finishRecordWinner_). A script lock around the read-check-write
  // makes sure only the first request in can ever see the cell empty,
  // so only one call gets alreadyRecorded: false.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // ms - this critical section is a single cell read+write, so it should never hold long
  var existing, alreadyRecorded;
  try {
    existing = String(sheet.getRange(row, col + WINNER_OFFSET).getValue() || '').trim();
    alreadyRecorded = !!existing;
    if (!alreadyRecorded) {
      sheet.getRange(row, col + WINNER_OFFSET).setValue(winnerName);
    }
  } finally {
    lock.releaseLock();
  }

  // Same reasoning as runMatchCompleteFetch_'s release: this call is
  // done touching the Winner cell either way, so free up the claim for
  // whatever legitimate call might come next.
  releaseWinnerClaim_(row, sheetName);

  if (alreadyRecorded) {
    return { ok: true, alreadyRecorded: true, winner: existing };
  }

  // Match the winner against Team 1/Team 2 (case/whitespace-insensitive,
  // in case of any drift between what the Discord button was labeled
  // with and the cell as it stands now) so the Winner cell picks up
  // that team's color. If neither matches - e.g. the cell was edited
  // by hand after the thread was created - leave the color as-is
  // rather than guessing. Outside the lock: it's a cosmetic side
  // effect that doesn't affect alreadyRecorded/winner correctness.
  var normalized = winnerName.trim().toLowerCase();
  var team1 = String(sheet.getRange(row, col + TEAM1_NAME_OFFSET).getValue() || '').trim().toLowerCase();
  var team2 = String(sheet.getRange(row, col + TEAM2_NAME_OFFSET).getValue() || '').trim().toLowerCase();
  if (normalized === team1) {
    applyWinnerColor_(sheet, row, col, 1);
  } else if (normalized === team2) {
    applyWinnerColor_(sheet, row, col, 2);
  }

  return { ok: true, alreadyRecorded: false, winner: winnerName };
}

/**
 * Claims the right to create the Statlocker draft for a row's side
 * selection - called by the relay worker at the top of
 * finishDraftCreation_, before it does anything else. Exists because
 * the worker's own "resolved" flag lives in Cloudflare KV, which has
 * no atomic compare-and-swap: two side-selection clicks landing close
 * together (e.g. two players on the coinflip-winning team both
 * tapping their side) can each read that flag as false before either
 * write lands, so both would otherwise go on to create their own
 * Statlocker draft. Apps Script's LockService gives a real mutex that
 * KV doesn't, so the worker routes the actual "who goes first" call
 * through here instead - same shape as recordManualWinner_'s
 * read-check-write lock above, just guarding a claim flag
 * (CacheService) instead of a sheet cell.
 *
 * First caller in gets claimed: true and should proceed with draft
 * creation as normal. Any caller after that (for the same row/sheet,
 * within the 6-hour cache TTL - comfortably longer than any single
 * match) gets claimed: false and should back off without creating a
 * draft or editing the coinflip message further; the first caller's
 * flow already owns that.
 * @param {number} row
 * @param {string} sheetName
 * @return {{ok: boolean, claimed: boolean}}
 */
function claimSideResolution_(row, sheetName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // ms - this critical section is one cache read+write, so it should never hold long
  try {
    var cache = CacheService.getScriptCache();
    var key = 'sideClaim:' + sheetName + ':' + row;
    if (cache.get(key)) {
      return { ok: true, claimed: false };
    }
    cache.put(key, '1', 21600); // 6 hours - CacheService's max TTL, comfortably longer than one match takes to resolve
    return { ok: true, claimed: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Claims the right to attempt resolving this row's winner right now -
 * called at the very top of both the automatic Statlocker check
 * (runMatchCompleteFetch_, via the 'claimWinnerResolution' webhook
 * action below) and the manual "who won?" write (recordManualWinner_),
 * before either does any of its own, separately-locked work.
 *
 * Added after LockService's own per-function critical sections proved,
 * in practice, not to fully serialize two doPost executions landing
 * well under a second apart (confirmed via Cloudflare Workers logs, 15
 * Aug 2026 - both calls advanced the series for the same game win,
 * despite each individually being wrapped in its own script-lock
 * section). Whatever the exact cause on Apps Script's side, this claim
 * adds one independent, much shorter critical section (a single cache
 * read+write, no network calls) that has to be won BEFORE either
 * function's slower work begins - the worker backs its losing caller
 * off immediately rather than letting it reach the Winner cell at all.
 *
 * Unlike claimSideResolution_'s claim (permanent - a game's side is
 * only ever decided once), this one is short-lived: a resolution
 * attempt that finds nothing to record (e.g. Statlocker hasn't synced
 * yet) shouldn't lock out later, unrelated attempts - a retry, or an
 * eventual "who won?" vote - so it expires on its own after 20s, and
 * releaseWinnerClaim_ clears it early once a caller knows it isn't
 * going to write anything.
 * @param {number} row
 * @param {string} sheetName
 * @return {{ok: boolean, claimed: boolean}}
 */
function claimWinnerResolution_(row, sheetName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // ms - this critical section is one cache read+write, so it should never hold long
  try {
    var cache = CacheService.getScriptCache();
    var key = 'winnerClaim:' + sheetName + ':' + row;
    if (cache.get(key)) {
      return { ok: true, claimed: false };
    }
    cache.put(key, '1', 20); // seconds - just long enough to cover one resolution attempt, not meant to outlive it
    return { ok: true, claimed: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Clears an in-progress claimWinnerResolution_ claim early, once the
 * claiming call knows it isn't going to write a winner after all (e.g.
 * Statlocker still has no result for this game). Best-effort - if this
 * doesn't run for any reason, the claim just expires on its own after
 * 20s, same end state either way.
 * @param {number} row
 * @param {string} sheetName
 */
function releaseWinnerClaim_(row, sheetName) {
  CacheService.getScriptCache().remove('winnerClaim:' + sheetName + ':' + row);
}

/**
 * =====================================================================
 * SHEET WEBHOOK (Worker -> Apps Script): side swap, draft URL, match completion
 * =====================================================================
 * Everything else in this file is Apps Script calling OUT to the relay
 * worker. This is the one path that runs the other way: the worker
 * calls IN to this project - specifically to doPost() below - so the
 * sheet can be updated immediately rather than waiting for the next
 * manual action. One shared endpoint, four independent jobs, routed by
 * an explicit "action" field for two of them, and simply by which
 * fields are present in the body for the other two:
 *   - Side + pick order: the moment both teams have made their
 *     choices in Discord, whichever team has First Pick is moved into
 *     the Team 1 cell and both cells are colored by side (see
 *     applySideAndPickOrder_).
 *   - Draft URL: once the worker has also created the Statlocker draft
 *     for that match, its URL is written into the Draft URL column
 *     (see writeDraftUrl_) - the same cell fetchDraftData() already
 *     expects to find it in, so no other part of this script needs to
 *     know or care that it got there automatically instead of pasted
 *     in by hand.
 *   - action: 'matchComplete': runs Fetch Draft Data for just one row,
 *     triggered by the "Match Complete" button (see
 *     runMatchCompleteFetch_ above).
 *   - action: 'recordWinner': records a manually-chosen winner from the
 *     "who won?" buttons (see recordManualWinner_ above).
 * See discord-relay-worker.js's handleButtonClick / finishDraftCreation_
 * / handleMatchCompleteClick_ / handleWinnerClick_ for the calling side.
 *
 * This requires deploying THIS Apps Script project as a Web App (see
 * INSTALL step 7 at the top of this file) to get a URL the worker can
 * reach, plus a shared secret (SHEET_WEBHOOK_SECRET) so random
 * internet traffic can't trigger sheet writes. Apps Script Web Apps
 * don't expose custom request headers to doPost(), so - unlike
 * RELAY_SECRET, which travels as a signed header - this one is verified
 * via an HMAC signature (over action/row/sheetName/timestamp) carried
 * in the JSON body instead; see computeWebhookSignature_ and
 * SIGNATURE_WINDOW_MS. The secret itself never travels on the wire
 * either way.
 * =====================================================================
 */

/**
 * Web App entry point for GET requests. The only thing this needs to
 * handle today is the Setup Wizard's self-check: after you deploy this
 * project as a Web App and paste the resulting URL back into the
 * wizard (install guide, step 2.3), the wizard has Code.gs fetch
 * ?ping=1 on that exact URL from the server side (see verifyWebAppUrl
 * below) to confirm it's really live, really this deployment, and not
 * stuck behind a Google sign-in/consent page. No secret is needed for
 * this - it deliberately reveals nothing but "yes, I'm here."
 * @param {Object} e Apps Script's standard doGet event object.
 * @return {TextOutput} JSON.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.ping) {
    return jsonTextOutput_({ ok: true, ping: 'pong', scriptId: ScriptApp.getScriptId() });
  }
  return jsonTextOutput_({ ok: false, error: 'No recognized query parameter.' });
}

/**
 * Web App entry point. Called by the relay worker after a side button
 * is resolved, once Statlocker has created a draft, and whenever
 * someone presses "Match Complete" or one of the "who won?" buttons.
 * Every call carries a "timestamp" and an HMAC "signature" instead of
 * the raw secret - see computeWebhookSignature_ / doPost's own check.
 * Expects a JSON body:
 *   { timestamp: number, signature: string, row: number, sheetName: string,
 *     hiddenKingTeam?: string, firstPickTeam?: string, draftUrl?: string }
 *   ...for the side + pick order / draft-URL path (see
 *   applySideAndPickOrder_ / writeDraftUrl_) - hiddenKingTeam and
 *   draftUrl may each be present on their own, or both together in one
 *   call. firstPickTeam only means anything alongside hiddenKingTeam;
 *   if it's missing (an older worker), the Hidden King team is treated
 *   as First Pick, matching the old Team 1 = Hidden King behavior.
 *
 * It also routes two explicit action requests (see the MATCH
 * COMPLETION section above for both):
 *   { timestamp, signature, row: number, sheetName: string,
 *     action: 'matchComplete' }
 *     -> runMatchCompleteFetch_(row, sheetName)
 *   { timestamp, signature, row: number, sheetName: string,
 *     action: 'recordWinner', winner: string }
 *     -> recordManualWinner_(row, sheetName, winner)
 *   { timestamp, signature, row: number, sheetName: string,
 *     action: 'claimSideResolution' }
 *     -> claimSideResolution_(row, sheetName)
 *   { timestamp, signature, row: number, sheetName: string,
 *     action: 'markNotPlayed', rows: Array<number> }
 *     -> markRowsNotPlayed_(rows, sheetName) - "row" is still required/
 *     validated above like every other action, but ignored in favor of
 *     "rows" (the relay worker sends rows[0] as "row" too, so this
 *     never actually fails that check). Called by the relay worker
 *     when a best-of-X series clinches before every row in it got
 *     played - see advanceSeriesAfterWin_ in discord-relay-worker.js.
 *
 * sheetName is REQUIRED, not optional, for every path above: this call
 * arrives from the relay worker asynchronously, often long after any
 * human last had the spreadsheet open, so there is no reliable "active
 * sheet" to fall back on - SpreadsheetApp.getActiveSheet() would just
 * return whatever tab a human happened to leave open last, which may
 * not be this match's tab at all (see startCoinflip_'s JSDoc for where
 * sheetName is captured). Always look the sheet up by the name that
 * was captured at match-thread-creation time instead.
 * @param {Object} e Apps Script's standard doPost event object.
 * @return {TextOutput} JSON { ok: true, ... } or { ok: false, error }.
 */
/**
 * Builds a stable, order-independent string of every payload field
 * (except "signature") for HMAC signing - "key=JSON.stringify(value)"
 * pairs sorted by key and joined with "&", so the signature covers the
 * whole body instead of a fixed field subset. Must match worker.js's
 * canonicalizePayload_.
 * @param {Object} payload
 * @return {string}
 */
function canonicalizePayload_(payload) {
  return Object.keys(payload)
    .filter(function(key) { return key !== 'signature'; })
    .sort()
    .map(function(key) { return key + '=' + JSON.stringify(payload[key]); })
    .join('&');
}

/** HMAC-SHA256(secret, canonicalized payload) - must match worker.js's computeWebhookSignature_. */
function computeWebhookSignature_(secret, payload) {
  return hmacHex_(secret, canonicalizePayload_(payload));
}

function doPost(e) {
  try {
    var payload = JSON.parse((e.postData && e.postData.contents) || '{}');

    var expectedSecret = PropertiesService.getScriptProperties().getProperty('SHEET_WEBHOOK_SECRET');
    if (!expectedSecret) {
      return jsonTextOutput_({ ok: false, error: 'Forbidden - webhook secret not configured' });
    }

    var row = Number(payload.row);
    if (!row || row < SHEET_DATA_START_ROW) {
      return jsonTextOutput_({ ok: false, error: 'Missing or invalid "row"' });
    }
    var sheetName = String(payload.sheetName || '').trim();
    if (!sheetName) {
      return jsonTextOutput_({ ok: false, error: 'Missing "sheetName"' });
    }

    // Signed rather than a bare secret comparison - see
    // buildRelayAuthHeaders_'s doc comment (the same reasoning applies
    // here, just in the body instead of a header, since Apps Script Web
    // Apps don't expose custom request headers to doPost). The
    // signature covers action/row/sheetName/timestamp, so a captured
    // request can't be replayed against a different row or past
    // SIGNATURE_WINDOW_MS.
    var timestamp = Number(payload.timestamp);
    if (!timestamp || Math.abs(Date.now() - timestamp) > SIGNATURE_WINDOW_MS) {
      return jsonTextOutput_({ ok: false, error: 'Forbidden - missing or stale timestamp' });
    }
    var expectedSignature = computeWebhookSignature_(expectedSecret, payload);
    if (!timingSafeEqual_(String(payload.signature || ''), expectedSignature)) {
      return jsonTextOutput_({ ok: false, error: 'Forbidden - bad or missing signature' });
    }

    loadConfigIntoGlobals_();

    if (payload.action === 'matchComplete') {
      return jsonTextOutput_(runMatchCompleteFetch_(row, sheetName));
    }
    if (payload.action === 'recordWinner') {
      var winnerName = String(payload.winner || '').trim();
      if (!winnerName) {
        return jsonTextOutput_({ ok: false, error: 'Missing "winner"' });
      }
      return jsonTextOutput_(recordManualWinner_(row, sheetName, winnerName));
    }
    if (payload.action === 'claimSideResolution') {
      return jsonTextOutput_(claimSideResolution_(row, sheetName));
    }
    if (payload.action === 'claimWinnerResolution') {
      return jsonTextOutput_(claimWinnerResolution_(row, sheetName));
    }
    if (payload.action === 'markNotPlayed') {
      var notPlayedRows = Array.isArray(payload.rows)
        ? payload.rows.map(Number).filter(function (r) { return r && r >= SHEET_DATA_START_ROW; })
        : [];
      if (notPlayedRows.length === 0) {
        return jsonTextOutput_({ ok: false, error: 'Missing or invalid "rows"' });
      }
      return jsonTextOutput_(markRowsNotPlayed_(notPlayedRows, sheetName));
    }

    if (!payload.hiddenKingTeam && !payload.draftUrl) {
      return jsonTextOutput_({ ok: false, error: 'Provide at least one of "hiddenKingTeam" or "draftUrl", or a valid "action"' });
    }

    // Side/pick order and draft-URL are independent writes - one failing (e.g.
    // a team-name mismatch in applySideAndPickOrder_) must not prevent the other
    // from happening, so each gets its own try/catch instead of sharing
    // doPost's outer one.
    var result = { ok: true };
    var errors = [];
    if (payload.hiddenKingTeam) {
      try {
        applySideAndPickOrder_(row, sheetName, String(payload.hiddenKingTeam),
          String(payload.firstPickTeam || payload.hiddenKingTeam));
        result.sideSwapped = true;
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (payload.draftUrl) {
      try {
        writeDraftUrl_(row, sheetName, String(payload.draftUrl).trim());
        result.draftUrlWritten = true;
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (errors.length > 0) {
      result.ok = false;
      result.error = errors.join(' ');
    }

    return jsonTextOutput_(result);
  } catch (err) {
    return jsonTextOutput_({ ok: false, error: err.message });
  }
}

/**
 * Looks up a sheet tab by name, rather than relying on
 * SpreadsheetApp.getActiveSheet() - see doPost's JSDoc for why that
 * matters for webhook-triggered writes. Throws a clear error if the
 * tab has since been renamed or deleted.
 * @param {string} name
 * @return {Sheet}
 */
function getSheetByNameOrThrow_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet tab "' + name + '" no longer exists (renamed or deleted since this match thread was created).');
  }
  return sheet;
}

/**
 * Writes a freshly-created draft's URL into the Draft URL column for
 * the given row, in whatever column this spreadsheet's own saved
 * Settings currently point at (DRAFT_URL_COLUMN, set moments earlier
 * by doPost's loadConfigIntoGlobals_() call) - never a hardcoded
 * column, so this stays correct even if that Settings value changes.
 * @param {number} row
 * @param {string} sheetName
 * @param {string} draftUrl
 */
function writeDraftUrl_(row, sheetName, draftUrl) {
  var sheet = getSheetByNameOrThrow_(sheetName);
  sheet.getRange(row, DRAFT_URL_COLUMN).setValue(draftUrl);
}

/**
 * Swaps MATCH_THREAD_PLACEHOLDER for MATCH_NOT_PLAYED_PLACEHOLDER in
 * each given row's Draft URL cell - called once a best-of-X series
 * clinches early, for whichever rows are left over with no game ever
 * played in them. Only touches a cell that's STILL the placeholder,
 * same "never clobber a real value" rule as everywhere else this
 * placeholder is checked - if an organizer already pasted a real draft
 * URL into one of these rows by hand for some reason, it's left alone.
 * @param {Array<number>} rows
 * @param {string} sheetName
 * @return {{ok: true, updatedRows: Array<number>}}
 */
function markRowsNotPlayed_(rows, sheetName) {
  var sheet = getSheetByNameOrThrow_(sheetName);
  var updatedRows = [];
  rows.forEach(function (row) {
    var cell = sheet.getRange(row, DRAFT_URL_COLUMN);
    if (String(cell.getValue()).trim() === MATCH_THREAD_PLACEHOLDER) {
      cell.setValue(MATCH_NOT_PLAYED_PLACEHOLDER);
      updatedRows.push(row);
    }
  });
  return { ok: true, updatedRows: updatedRows };
}

/**
 * Records a row's decided sides and pick order in the sheet:
 *   - Team 1 is whichever team has First Pick, swapping Team 1 <->
 *     Team 2 if that team is currently in the Team 2 cell.
 *   - Each team's cell is colored by side (SIDE_A_COLOR for Hidden
 *     King, SIDE_B_COLOR for Archmother), so the side is still visible
 *     at a glance now that Team 1/Team 2 order means pick order.
 * Only the cell values move on a swap - the cells' own formatting
 * (bold/underline signals etc.) stays where it is. Throws if either
 * name matches neither cell, rather than guessing - that's a real
 * inconsistency (e.g. a team renamed mid-tournament) worth surfacing
 * via the worker's own logs instead of silently doing nothing.
 * @param {number} row
 * @param {string} sheetName
 * @param {string} hiddenKingTeamName
 * @param {string} firstPickTeamName
 */
function applySideAndPickOrder_(row, sheetName, hiddenKingTeamName, firstPickTeamName) {
  var sheet = getSheetByNameOrThrow_(sheetName);
  var team1Cell = sheet.getRange(row, DRAFT_URL_COLUMN + TEAM1_NAME_OFFSET);
  var team2Cell = sheet.getRange(row, DRAFT_URL_COLUMN + TEAM2_NAME_OFFSET);

  var team1 = String(team1Cell.getValue() || '').trim();
  var team2 = String(team2Cell.getValue() || '').trim();

  var matchesWhich = function (name) {
    var target = normalizeTeamName_(name);
    if (normalizeTeamName_(team1) === target) return 1;
    if (normalizeTeamName_(team2) === target) return 2;
    throw new Error('"' + name + '" matched neither Team 1 ("' + team1 +
      '") nor Team 2 ("' + team2 + '") in row ' + row + '.');
  };
  var firstPickCol = matchesWhich(firstPickTeamName);
  var hiddenKingCol = matchesWhich(hiddenKingTeamName);

  if (firstPickCol === 2) {
    team1Cell.setValue(team2);
    team2Cell.setValue(team1);
  }

  // After the swap above, Team 1 is the First Pick team - so Hidden
  // King is in Team 1 exactly when the Hidden King team has First Pick.
  var hiddenKingIsTeam1 = hiddenKingCol === firstPickCol;
  team1Cell.setBackground(hiddenKingIsTeam1 ? SIDE_A_COLOR : SIDE_B_COLOR);
  team2Cell.setBackground(hiddenKingIsTeam1 ? SIDE_B_COLOR : SIDE_A_COLOR);
}

/**
 * =====================================================================
 * SETUP WIZARD (SetupWizard.html)
 * =====================================================================
 * Backs the step-by-step Setup Wizard dialog - Deadlock Tournament Management Bot > Setup
 * Wizard, or auto-launched once on an unconfigured copy (see onOpen's
 * maybeAutoLaunchWizard_ call). Every step here saves to the exact same
 * Script/Document Properties the rest of this file already reads
 * (getStatlockerApiKey, getDiscordRelayConfig_, getConfig_, doPost's
 * SHEET_WEBHOOK_SECRET check) - the wizard is a friendlier way to fill
 * those in, not a separate config system.
 *
 * Every step is independently skippable: saving is per-field, so
 * closing the wizard partway through (or clicking Skip on a step you
 * don't have information for yet) never loses earlier steps' progress,
 * and reopening the wizard shows what's already set via getWizardState.
 * =====================================================================
 */

// Document Property key marking that the wizard has already been
// auto-launched once (regardless of whether it was completed) - see
// maybeAutoLaunchWizard_. A separate key from CONFIG_PROPERTY_KEY so it
// survives independently of the sidebar's own Settings.
var WIZARD_SEEN_PROPERTY_KEY = 'WIZARD_AUTO_LAUNCH_SEEN';

// Document Property key for the wizard's record of the deployed Web
// App URL (step 3.4/5 below). Purely bookkeeping for the wizard's own
// UI (so it can show/re-verify the URL on a later visit) - nothing
// else in this file needs to know its own URL.
var WIZARD_WEB_APP_URL_KEY = 'WIZARD_SHEET_WEB_APP_URL';

// Document Property key set once someone confirms (in the wizard) that
// they've pasted SHEET_WEBHOOK_URL/SHEET_WEBHOOK_SECRET into Cloudflare.
// Purely a UI checkmark - doPost's actual secret check is unaffected
// either way.
var WIZARD_CLOUDFLARE_CONFIRMED_KEY = 'WIZARD_CLOUDFLARE_CONFIRMED';

/**
 * True if any of the properties a fully-working install needs are
 * still missing. Used only to decide whether to auto-launch the
 * wizard - the wizard's own diagnostics step (runWizardDiagnostics)
 * does the thorough, live-tested version of this same check.
 * @return {boolean}
 */
function wizardLooksIncomplete_() {
  var scriptProps = PropertiesService.getScriptProperties();
  if (!scriptProps.getProperty('STATLOCKER_API_KEY')) return true;
  if (!scriptProps.getProperty('DISCORD_RELAY_URL')) return true;
  if (!scriptProps.getProperty('DISCORD_RELAY_SECRET')) return true;

  var config = getConfig_();
  if (!config.discordGuildId || !config.discordMatchesForumChannelId) return true;

  return false;
}

/**
 * Called once from onOpen(). Auto-launches the Setup Wizard the first
 * time anyone opens a copy of the sheet that doesn't look configured
 * yet - and never again after that, whether or not setup was actually
 * finished, so it doesn't nag on every open. Wrapped defensively: a
 * failure here should never take down menu creation in onOpen.
 */
function maybeAutoLaunchWizard_() {
  try {
    var docProps = PropertiesService.getDocumentProperties();
    if (docProps.getProperty(WIZARD_SEEN_PROPERTY_KEY)) return;
    docProps.setProperty(WIZARD_SEEN_PROPERTY_KEY, 'true');

    if (wizardLooksIncomplete_()) {
      showSetupWizard();
    }
  } catch (e) {
    // Simple triggers run with restricted authorization - if anything
    // here isn't allowed yet, just skip the auto-launch silently. The
    // menu item still opens the wizard on request either way.
  }
}

/**
 * Returns everything the wizard needs to render its current state when
 * it opens - which steps already have something saved, so it can show
 * checkmarks and jump to the right step, without making any live
 * network calls (that's runWizardDiagnostics's job, called separately
 * from the wizard's last step).
 * @return {Object}
 */
function getWizardState() {
  var scriptProps = PropertiesService.getScriptProperties();
  var docProps = PropertiesService.getDocumentProperties();
  var config = getConfig_();

  var statlockerKey = scriptProps.getProperty('STATLOCKER_API_KEY') || '';
  var relayUrl = scriptProps.getProperty('DISCORD_RELAY_URL') || '';
  var relaySecret = scriptProps.getProperty('DISCORD_RELAY_SECRET') || '';
  var webhookSecret = scriptProps.getProperty('SHEET_WEBHOOK_SECRET') || '';

  return {
    statlockerApiKeySet: !!statlockerKey,
    statlockerApiKeyMasked: maskSecret_(statlockerKey),
    discordRelayUrl: relayUrl,
    discordRelaySecretSet: !!relaySecret,
    sheetWebhookSecret: webhookSecret,
    sheetWebAppUrl: docProps.getProperty(WIZARD_WEB_APP_URL_KEY) || '',
    cloudflareConfirmed: docProps.getProperty(WIZARD_CLOUDFLARE_CONFIRMED_KEY) === 'true',
    discordGuildId: config.discordGuildId,
    discordMatchesForumChannelId: config.discordMatchesForumChannelId,
    scriptId: ScriptApp.getScriptId()
  };
}

/**
 * Shows just enough of a secret to recognize it without fully
 * displaying it back - used for the Statlocker key, which (unlike
 * SHEET_WEBHOOK_SECRET) never needs to be copied back out of the
 * wizard, only confirmed as "yes, something's saved".
 * @param {string} value
 * @return {string}
 */
function maskSecret_(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

/**
 * Saves the Statlocker API key (wizard step 2's Save & Next). Kept
 * separate from testStatlockerApiKey so the wizard can test a value
 * before committing to saving it.
 * @param {string} key
 * @return {string} confirmation message.
 */
function saveStatlockerApiKey(key) {
  var trimmed = String(key || '').trim();
  if (!trimmed) {
    throw new Error('Enter your Statlocker API key, or use Skip if you don\'t have it yet.');
  }
  PropertiesService.getScriptProperties().setProperty('STATLOCKER_API_KEY', trimmed);
  return 'Saved.';
}

/**
 * Live-tests a Statlocker API key WITHOUT saving it. Used by the
 * wizard's "Test key" button.
 *
 * Hits GET /api/public/match/{matchId} - the match ID (41525919) is
 * lifted straight from Statlocker's own API docs example, so it's
 * almost certainly a real record, giving a clean 200 on a valid key
 * rather than an ambiguous 404. This replaced an earlier version that
 * POSTed to an undocumented /drafts (plural) endpoint with a
 * synthetic body - that endpoint isn't in Statlocker's public docs at
 * all (only the singular /draft, which CREATES a lobby - not
 * something to call repeatedly just to test a key), so its behavior
 * on odd inputs was unverified. This endpoint is documented, GET-only
 * (no side effects), and was confirmed against the real API to return
 * 200/401 correctly for valid/invalid keys respectively.
 *
 * The _cb query param exists to defeat response caching that was
 * observed on this endpoint during testing: identical consecutive GET
 * requests to the same URL returned a cached response WITHOUT
 * re-checking the X-API-Key header on the second request, so a bad
 * key immediately following a valid one incorrectly showed as
 * accepted. A random value per call keeps every request's URL unique,
 * which reliably avoided a cached hit in testing (confirmed with a
 * good/bad/good/bad sequence, each returning the correct status). If
 * Statlocker's caching behavior ever changes, this may no longer be
 * necessary, but leaving it in place is harmless either way.
 *
 * @param {string} key
 * @return {string} a short human-readable success message.
 */
function testStatlockerApiKey(key) {
  var trimmed = String(key || '').trim();
  if (!trimmed) {
    throw new Error('Enter a key first.');
  }

  var cacheBuster = Utilities.getUuid();
  var response = UrlFetchApp.fetch(
    MATCH_BASE + '/match/41525919?_cb=' + cacheBuster,
    {
      method: 'get',
      headers: { 'X-API-Key': trimmed },
      muteHttpExceptions: true
    }
  );
  var code = response.getResponseCode();

  if (code === 401 || code === 403) {
    throw new Error('Statlocker rejected this key (HTTP ' + code + ') - double check it was copied in full.');
  }
  if (code >= 400) {
    throw new Error('Statlocker returned HTTP ' + code + ' - the key format looks off, or Statlocker is having issues.');
  }
  return 'Key accepted by Statlocker.';
}

/**
 * Saves the Discord relay URL + secret (wizard step 3's Save & Next).
 * @param {string} url
 * @param {string} secret
 * @return {string} confirmation message.
 */
function saveDiscordRelayConfig(url, secret) {
  var trimmedUrl = String(url || '').trim().replace(/\/$/, '');
  var trimmedSecret = String(secret || '').trim();
  if (!trimmedUrl || !trimmedSecret) {
    throw new Error('Enter both the Worker URL and RELAY_SECRET, or use Skip if you don\'t have them yet.');
  }
  var scriptProps = PropertiesService.getScriptProperties();
  scriptProps.setProperty('DISCORD_RELAY_URL', trimmedUrl);
  scriptProps.setProperty('DISCORD_RELAY_SECRET', trimmedSecret);
  return 'Saved.';
}

/**
 * Live-tests a Worker URL + RELAY_SECRET pair WITHOUT saving them, by
 * calling the Worker's /internal/health endpoint (see worker.js's
 * handleHealth). Used by the wizard's "Test connection" button on step
 * 3, and again (with the saved values) by runWizardDiagnostics.
 * @param {string} url
 * @param {string} secret
 * @return {Object} the Worker's reported configuration booleans, plus
 *   a summary string for display.
 */
function testDiscordRelayConnection(url, secret) {
  var trimmedUrl = String(url || '').trim().replace(/\/$/, '');
  var trimmedSecret = String(secret || '').trim();
  if (!trimmedUrl || !trimmedSecret) {
    throw new Error('Enter both the Worker URL and RELAY_SECRET first.');
  }

  var response;
  try {
    response = UrlFetchApp.fetch(trimmedUrl + '/internal/health', {
      headers: buildRelayAuthHeaders_(trimmedSecret),
      muteHttpExceptions: true
    });
  } catch (e) {
    throw new Error('Could not reach that URL at all - double check it\'s your Worker\'s address (e.g. https://your-worker.your-subdomain.workers.dev).');
  }

  var code = response.getResponseCode();
  if (code === 403) {
    throw new Error('The Worker is reachable, but rejected this RELAY_SECRET - it doesn\'t match what\'s set on the Worker (Settings > Variables and Secrets).');
  }
  if (code >= 400) {
    throw new Error('Worker returned HTTP ' + code + ' - check it deployed correctly.');
  }

  var data = null;
  try {
    data = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error('Worker responded, but not with the expected JSON - it may be an older deployment. Try redeploying worker.js.');
  }

  var missing = [];
  if (!data.configured.discordBotToken) missing.push('DISCORD_BOT_TOKEN');
  if (!data.configured.discordPublicKey) missing.push('DISCORD_PUBLIC_KEY');
  if (!data.configured.statlockerApiKey) missing.push('STATLOCKER_API_KEY');
  if (!data.kvBound) missing.push('MATCH_STATE KV binding');

  var summary = missing.length
    ? 'Connected - RELAY_SECRET matches. Still missing on the Worker: ' + missing.join(', ') + '.'
    : 'Connected - RELAY_SECRET matches and every core Worker secret is set.';

  return { summary: summary, configured: data.configured, kvBound: data.kvBound };
}

/**
 * Returns the existing SHEET_WEBHOOK_SECRET if one's already set
 * (idempotent - safe to call every time the wizard reaches this step,
 * including on a repeat visit, without invalidating whatever's already
 * been pasted into Cloudflare), or generates and saves a new
 * cryptographically random one otherwise. Mirrors what the Node.js
 * installer's setup.js does for RELAY_SECRET on the Worker side - see
 * that file's putSecret('RELAY_SECRET', ...) call.
 * @return {{value: string, generated: boolean}}
 */
function ensureSheetWebhookSecret() {
  var scriptProps = PropertiesService.getScriptProperties();
  var existing = scriptProps.getProperty('SHEET_WEBHOOK_SECRET');
  if (existing && existing !== 'not-set-yet') {
    return { value: existing, generated: false };
  }

  var fresh = generateRandomSecret_();
  scriptProps.setProperty('SHEET_WEBHOOK_SECRET', fresh);
  return { value: fresh, generated: true };
}

/**
 * Generates a long random hex-ish string suitable for use as a shared
 * secret. Apps Script has no crypto.randomBytes, so this leans on
 * Utilities.getUuid() (RFC 4122 v4 - cryptographically random) and
 * concatenates two of them for extra length/margin.
 * @return {string}
 */
function generateRandomSecret_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/**
 * Attempts to read this project's own current Web App URL directly
 * from Apps Script, via ScriptApp.getService().getUrl() - this only
 * returns a real URL once the FIRST "Deploy > New deployment > Web
 * app" has been done at least once by hand (that first click can't be
 * automated - creating/authorizing a deployment isn't something a
 * script can trigger on itself without a human present at the consent
 * screen). Once that one manual step is done, though, there's no
 * reason to make someone copy-paste the URL afterward: this fetches it
 * directly, and the wizard still runs it through verifyWebAppUrl (the
 * same live ?ping=1 check a pasted URL gets) before trusting it, so
 * auto-detected and manually-pasted URLs are held to the same
 * standard.
 * @return {{url: string, message: string}}
 */
function detectWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('No deployment found yet - use Deploy > New deployment > Web app in the ' +
      'Apps Script editor first, then try Auto-detect again.');
  }
  var message = verifyWebAppUrl(url, true);
  return { url: url, message: message };
}

/**
 * Verifies a pasted Web App URL (wizard step 4/5, after the person
 * manually does Deploy > New deployment - see this file's INSTALL step
 * 7) by fetching ?ping=1 on it from the SERVER side (avoids any
 * browser CORS/sign-in complications a client-side fetch would hit)
 * and checking the response really comes from THIS script, not some
 * other stale or copy-pasted-wrong URL. Saves it to Document
 * Properties for the wizard's own bookkeeping on success (see
 * WIZARD_WEB_APP_URL_KEY's JSDoc - nothing else in this file uses it).
 * @param {string} url
 * @return {string} confirmation message.
 */
function verifyWebAppUrl(url, autoDetected) {
  var trimmed = String(url || '').trim();
  if (!trimmed) {
    throw new Error('Paste the Web App URL from Deploy > New deployment first.');
  }

  var pingUrl = trimmed + (trimmed.indexOf('?') === -1 ? '?' : '&') + 'ping=1';
  var response;
  try {
    response = UrlFetchApp.fetch(pingUrl, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    throw new Error('Could not reach that URL. Double check it was copied in full from the deployment dialog.');
  }

  var code = response.getResponseCode();
  var text = response.getContentText();
  var data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Wrong access setting isn't the only way to land here: if this
    // project has more than one Web App deployment (each Deploy > New
    // deployment click makes a distinct URL - only Deploy > Manage
    // deployments > edit > New version updates one in place), an
    // auto-detected URL might just be a DIFFERENT, unused deployment
    // with narrower access than the one actually wired up to
    // Cloudflare - not a real problem with the one that matters.
    var hint = autoDetected
      ? 'This URL was auto-detected as Apps Script\'s current deployment, which isn\'t ' +
        'necessarily the one Cloudflare is actually using - if this project has more than ' +
        'one Web app deployment (Deploy > Manage deployments), copy the exact URL from ' +
        'SHEET_WEBHOOK_URL on the Worker and paste it in here yourself instead of relying ' +
        'on auto-detect. It\'s also possible "Who has access" genuinely isn\'t set to ' +
        '"Anyone" on this specific deployment - worth checking either way.'
      : 'This usually means "Who has access" isn\'t set to "Anyone" - check Deploy > Manage ' +
        'deployments. If more than one Web app deployment is listed there, also double check ' +
        'this is the exact URL actually in use, not a different one.';
    throw new Error('That URL didn\'t return the expected response (got HTTP ' + code + ', non-JSON). ' + hint);
  }

  if (!data.ok || data.ping !== 'pong') {
    throw new Error('That URL responded, but not the way this script expects. Double check it\'s this project\'s deployment, not a different script\'s.');
  }
  if (data.scriptId !== ScriptApp.getScriptId()) {
    throw new Error('That URL belongs to a different Apps Script project - copy the URL from THIS spreadsheet\'s Deploy dialog.');
  }

  PropertiesService.getDocumentProperties().setProperty(WIZARD_WEB_APP_URL_KEY, trimmed);
  return 'Verified - this is a live deployment of this exact spreadsheet.';
}

/**
 * Marks (wizard step 5's confirmation button) that the person has
 * pasted SHEET_WEBHOOK_URL/SHEET_WEBHOOK_SECRET into the Worker's
 * Cloudflare settings. Purely a checkmark for the wizard's own UI -
 * doPost's actual SHEET_WEBHOOK_SECRET check (see doPost above) works
 * the same regardless of whether this was ever called.
 * @return {string} confirmation message.
 */
function markCloudflareConfirmed() {
  PropertiesService.getDocumentProperties().setProperty(WIZARD_CLOUDFLARE_CONFIRMED_KEY, 'true');
  return 'Got it.';
}

/**
 * Runs every check the wizard cares about, live, and returns a
 * checklist for the wizard's final Diagnostics step. Unlike
 * getWizardState (which is instant/local), this makes real network
 * calls where relevant, so it's only run when the person reaches that
 * step or clicks "Re-run diagnostics" - not on every wizard open.
 * @return {{items: Array<Object>, allOk: boolean}}
 */
function runWizardDiagnostics() {
  var items = [];
  var scriptProps = PropertiesService.getScriptProperties();
  var config = getConfig_();

  // Statlocker API key.
  var statlockerKey = scriptProps.getProperty('STATLOCKER_API_KEY');
  if (!statlockerKey) {
    items.push({ id: 'statlocker', ok: null, label: 'Statlocker API key', detail: 'Not set yet.' });
  } else {
    try {
      testStatlockerApiKey(statlockerKey);
      items.push({ id: 'statlocker', ok: true, label: 'Statlocker API key', detail: 'Valid.' });
    } catch (e) {
      items.push({ id: 'statlocker', ok: false, label: 'Statlocker API key', detail: e.message });
    }
  }

  // Discord relay (Cloudflare Worker). relayResult is declared outside
  // this block (not with var scoped to the try) so the webhook secret
  // check just below can reuse its already-fetched data instead of
  // hitting the Worker a second time.
  var relayUrl = scriptProps.getProperty('DISCORD_RELAY_URL');
  var relaySecret = scriptProps.getProperty('DISCORD_RELAY_SECRET');
  var relayResult = null;
  if (!relayUrl || !relaySecret) {
    items.push({ id: 'relay', ok: null, label: 'Discord relay connection', detail: 'Not set yet.' });
  } else {
    try {
      relayResult = testDiscordRelayConnection(relayUrl, relaySecret);
      items.push({ id: 'relay', ok: true, label: 'Discord relay connection', detail: relayResult.summary });
    } catch (e) {
      items.push({ id: 'relay', ok: false, label: 'Discord relay connection', detail: e.message });
    }
  }

  // Sheet webhook secret. Prefer the LIVE answer: the Worker's own
  // /internal/health response (already fetched above for the relay
  // check) reports whether SHEET_WEBHOOK_URL and SHEET_WEBHOOK_SECRET
  // are actually set on the Worker right now - that's real evidence
  // this was pasted into Cloudflare correctly, not just a record of
  // whether the wizard personally watched it happen. Only fall back to
  // the wizard's own step-5 confirmation flag when the relay itself
  // couldn't be reached, since without it there's no live signal to
  // check against at all.
  var webhookSecret = scriptProps.getProperty('SHEET_WEBHOOK_SECRET');
  if (!webhookSecret) {
    items.push({ id: 'webhookSecret', ok: null, label: 'Sheet webhook secret', detail: 'Not generated yet.' });
  } else if (relayResult) {
    var missingOnWorker = [];
    if (!relayResult.configured.sheetWebhookUrl) missingOnWorker.push('SHEET_WEBHOOK_URL');
    if (!relayResult.configured.sheetWebhookSecret) missingOnWorker.push('SHEET_WEBHOOK_SECRET');
    if (missingOnWorker.length === 0) {
      items.push({ id: 'webhookSecret', ok: true, label: 'Sheet webhook secret', detail: 'Generated, and the Worker confirms it\'s set.' });
    } else {
      items.push({ id: 'webhookSecret', ok: false, label: 'Sheet webhook secret', detail: 'Generated locally, but the Worker reports ' + missingOnWorker.join(' and ') + ' not set - paste it into Cloudflare (Settings > Variables and Secrets).' });
    }
  } else {
    // No live relay data to check against (relay unreachable/unset
    // above) - fall back to whether the wizard itself watched step 5
    // get confirmed.
    var cloudflareConfirmed = PropertiesService.getDocumentProperties()
      .getProperty(WIZARD_CLOUDFLARE_CONFIRMED_KEY) === 'true';
    if (cloudflareConfirmed) {
      items.push({ id: 'webhookSecret', ok: true, label: 'Sheet webhook secret', detail: 'Generated and confirmed pasted into Cloudflare.' });
    } else {
      items.push({ id: 'webhookSecret', ok: false, label: 'Sheet webhook secret', detail: 'Generated, but can\'t confirm it\'s on Cloudflare - the relay check above needs to pass first to verify this live.' });
    }
  }

  // Web App deployment. Prefer the LIVE answer here too: if the wizard
  // never watched this get confirmed (e.g. deployed before this wizard
  // existed, or set up outside it), ask Apps Script directly whether
  // THIS script already has a deployment, via ScriptApp.getService().
  // getUrl(), rather than assuming there isn't one just because nobody
  // clicked through step 4 in this tool specifically.
  var webAppUrl = PropertiesService.getDocumentProperties().getProperty(WIZARD_WEB_APP_URL_KEY);
  var webAppUrlWasAutoDetected = false;
  if (!webAppUrl) {
    webAppUrl = ScriptApp.getService().getUrl() || '';
    webAppUrlWasAutoDetected = true;
  }
  if (!webAppUrl) {
    items.push({ id: 'webApp', ok: null, label: 'Web App deployment', detail: 'Not deployed/verified yet.' });
  } else {
    try {
      // verifyWebAppUrl also saves this to Document Properties on
      // success, so an existing-but-unconfirmed deployment found this
      // way gets backfilled into the wizard's own bookkeeping - step 4
      // will show it prefilled from now on too.
      verifyWebAppUrl(webAppUrl, webAppUrlWasAutoDetected);
      items.push({ id: 'webApp', ok: true, label: 'Web App deployment', detail: 'Live and verified.' });
    } catch (e) {
      items.push({ id: 'webApp', ok: false, label: 'Web App deployment', detail: e.message });
    }
  }

  // Discord Server ID / Matches Forum Channel ID.
  if (!config.discordGuildId || !config.discordMatchesForumChannelId) {
    items.push({ id: 'discordIds', ok: null, label: 'Discord Server ID / Forum Channel ID', detail: 'Not set yet.' });
  } else {
    items.push({ id: 'discordIds', ok: true, label: 'Discord Server ID / Forum Channel ID', detail: 'Both set.' });
  }

  var allOk = items.every(function (item) { return item.ok === true; });
  return { items: items, allOk: allOk };
}

/**
 * =====================================================================
 * COMPLETE MY EVENT
 * =====================================================================
 * The intended workflow this supports: keep ONE persistent "controller"
 * spreadsheet with your real API keys and Script Properties, adding a
 * new tab per event rather than copying the whole file each time. When
 * an event wraps up and you're ready to hand the results off to an
 * external organization (Liquipedia, etc.), run Complete Event from
 * the button pinned to the bottom of the sidebar - there is no
 * separate "make a copy first" step any more; this function makes the
 * copy for you.
 *
 * What it does: creates a brand new, separate Google Spreadsheet, then
 * copies every tab from this controller sheet into it, replacing each
 * tab's formulas with their current values along the way - except tabs
 * with "stats" anywhere in their name, which are copied with live
 * formulas intact (they keep working in the new file, since everything
 * they reference got copied alongside them). This controller sheet
 * itself is never modified - it keeps every tab and every live formula,
 * ready for the next event.
 *
 * Why this needs NO special setup, unlike an earlier version of this
 * feature: a spreadsheet created via SpreadsheetApp.create() has no
 * Apps Script project bound to it at all - not this project with its
 * code stripped out, but genuinely zero code, from the moment it's
 * created. Script Properties (API keys, secrets) live on THIS script
 * project, never on the spreadsheet, so the new file has nothing to
 * leak by construction. That also means this only ever touches
 * SpreadsheetApp, which every part of this project already has
 * permission to use - no sensitive OAuth scope, no Apps Script API, no
 * per-copy Google Cloud project to configure.
 *
 * Known limitation: Sheet.copyTo() carries over values, formulas,
 * formatting, and tab color, but does not reliably carry over sheet
 * protections/protected ranges. If you rely on those to block
 * accidental edits, re-apply them by hand on the handoff copy - nothing
 * sensitive is at stake either way, since the new file has no bot code
 * or credentials in it regardless.
 */

/**
 * Lets the sidebar prefill its "name the new spreadsheet" text box with
 * the same default runCompleteMyEvent_ would otherwise fall back to, so
 * the user sees exactly what they'll get if they don't type anything.
 * @return {string}
 */
function getCompleteEventDefaultName() {
  return SpreadsheetApp.getActiveSpreadsheet().getName() + ' - Complete';
}

/**
 * Entry point for the sidebar's "Complete Event" button (the
 * confirmation prompt, including the new-spreadsheet name field, is
 * handled in the sidebar itself - see Sidebar.html - since a native
 * ui.alert() can't include a text input).
 * @param {string} eventName Name to give the new spreadsheet, as typed
 *   into the sidebar's confirmation prompt. Falls back to the default
 *   name in runCompleteMyEvent_ if blank.
 * @return {{name: string, url: string, tabsCopied: number}}
 */
function completeMyEventFromSidebar(eventName) {
  return runCompleteMyEvent_(eventName);
}

/**
 * Does the actual work: creates a new spreadsheet and copies every tab
 * from the active (controller) spreadsheet into it, freezing formulas
 * to values along the way except on "stats" tabs.
 * @param {string} [customName] Name for the new spreadsheet. Falls back
 *   to "<controller name> - Complete" if blank.
 * @return {{name: string, url: string, tabsCopied: number}}
 */
function runCompleteMyEvent_(customName) {
  var source = SpreadsheetApp.getActiveSpreadsheet();
  var name = (customName && customName.trim()) ? customName.trim() : (source.getName() + ' - Complete');
  var dest = SpreadsheetApp.create(name);

  // A brand new spreadsheet always starts with exactly one sheet, and a
  // spreadsheet can never be left with zero sheets - keep this
  // placeholder around until every real tab has been copied in, then
  // delete it.
  var placeholder = dest.getSheets()[0];

  var tabsCopied = 0;
  source.getSheets().forEach(function (sheet) {
    var copied = sheet.copyTo(dest);
    copied.setName(sheet.getName());

    var isStatsTab = sheet.getName().toLowerCase().indexOf('stats') !== -1;
    if (!isStatsTab) {
      var range = copied.getDataRange();
      if (range.getNumRows() > 0 && range.getNumColumns() > 0) {
        range.setValues(range.getValues());
      }
    }
    tabsCopied++;
  });

  dest.deleteSheet(placeholder);

  return { name: dest.getName(), url: dest.getUrl(), tabsCopied: tabsCopied };
}

function jsonTextOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
