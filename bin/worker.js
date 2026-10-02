// Bot version: 20261002.1
/**
 * =====================================================================
 * Discord API Relay + Interactions - Cloudflare Worker
 * =====================================================================
 *
 * This worker is the Discord-facing half of the match thread system
 * (Code.gs, the Apps Script project bound to the spreadsheet, is the
 * other half). It exists mainly because Apps Script's outbound IPs are
 * shared across many Google customers and are prone to being blocked
 * by Discord's Cloudflare layer - so instead of Apps Script talking to
 * discord.com directly, it talks to this worker, which does.
 *
 * Being a Cloudflare Worker, it's stateless between requests - nothing
 * is held in memory from one call to the next. Anything that needs to
 * survive between steps (which team is picking a side, which sheet row
 * a thread belongs to, the running score of a series) is written to
 * Workers KV and read back on the next relevant request.
 *
 * There are seven jobs here, roughly in the order they happen for one
 * match:
 *
 * 1. REST RELAY: a thin passthrough Apps Script uses for a fixed
 *    allow-list of ordinary Discord API calls (create a forum thread,
 *    look up guild roles - see RELAY_ALLOWED_CALLS) instead of calling
 *    discord.com itself. Authenticated via an HMAC signature over a
 *    timestamp (X-Relay-Timestamp / X-Relay-Signature headers), which
 *    only Apps Script and this worker can produce from RELAY_SECRET -
 *    see handleDiscordProxy / verifyRelayRequest_.
 *
 * 2. THREAD REGISTRATION (/internal/register-thread): Apps Script
 *    calls this once, right after a match thread is created, before
 *    the side-selection call below - so it can't be taken down by a
 *    side-selection failure. It stores which sheet row(s), tab, teams,
 *    and role IDs the thread covers, keyed by thread ID in KV. This is
 *    what lets the "Match Complete" button (posted later, once a draft
 *    URL exists - see job 5) find its way back to the right row, and
 *    is also where a best-of-X series' win threshold and per-game side
 *    overrides are recorded up front - see handleRegisterThread.
 *
 * 3. SIDE + PICK ORDER SELECTION TRIGGER (/internal/coinflip): Apps
 *    Script calls this once, right after thread registration, to
 *    decide who gets choice priority for game 1. Side (Hidden King/
 *    Archmother) and pick order (First/Second Pick) are decoupled:
 *    the team with choice priority first chooses WHICH of the two
 *    they want to decide (Side Selection or Pick Order), then makes
 *    that choice, and the other team makes the remaining one - see
 *    handleSelectionClick_. Choice priority normally comes from a coin
 *    flip; if Apps Script detected a bold-cell override for that row
 *    (see Code.gs's getSideSignalsForRow_), the flip is skipped and
 *    that team is given priority directly instead - either way, the
 *    result is written to KV and a message with Side Selection/Pick
 *    Order buttons is posted into the thread. If Apps Script instead
 *    detected an underline override (a stronger signal - see
 *    getSideSignalsForRow_ again), the side is already decided: the
 *    team is locked onto Hidden King directly and only the Archmother
 *    team is asked for First/Second Pick - see runHiddenKingLock_.
 *    See handleCoinflip.
 *
 * 4. INTERACTIONS ENDPOINT (/interactions): Discord itself calls this
 *    directly - not via the relay secret - whenever someone clicks one
 *    of the bot's buttons (side selection, Match Complete, or a "who
 *    won?" vote). It's authenticated by verifying Discord's Ed25519
 *    request signature, which is how Discord proves a request really
 *    came from them and not someone guessing the URL. This is also
 *    what lets the bot react to button clicks without an always-on
 *    Gateway connection or the Message Content intent - no separate
 *    bot process to host, just this same worker. See handleInteraction
 *    / handleButtonClick.
 *
 * 5. STATLOCKER DRAFT CREATION: the moment the second of the two
 *    choices (side and pick order) is made, this worker calls
 *    Statlocker's POST /api/public-draft/draft directly (no Apps
 *    Script round trip for the creation itself) with the two team
 *    names slotted into the correct side, and tells the sheet which
 *    team has First Pick (moved into Team 1) and which side each team
 *    is on (Team 1/Team 2 cells colored by side). The final selection
 *    message is edited in place just to show the sides and pick order
 *    (buttons stripped), but the resulting draft URL and
 *    "Match Complete" button are posted as a brand-new message, so
 *    they land at the bottom of the thread rather than back up where
 *    the coinflip happened. Separately calls back into Apps Script
 *    (via the sheet webhook - see Code.gs's SHEET WEBHOOK section) so
 *    the URL lands in the sheet too. Since all of this can occasionally
 *    run past Discord's 3-second ack window, the click is acknowledged
 *    immediately (type 6, DEFERRED_UPDATE_MESSAGE) and the rest
 *    happens afterward via ctx.waitUntil. See handleSelectionClick_ /
 *    finishDraftCreation_.
 *
 * 6. MATCH COMPLETION: pressing "Match Complete" calls back into Apps
 *    Script's 'matchComplete' webhook action, which runs Fetch Draft
 *    Data for just that one row. Status and results are posted as a
 *    new message at the bottom of the thread rather than edited into
 *    the Match Complete message itself - which is deliberately left
 *    untouched and clickable, so a premature check (before Statlocker
 *    has synced) can just be retried with another press. If Statlocker
 *    already has a winner, it's reported directly. If not, this worker
 *    posts a pair of "who won?" buttons, one per team, in their own new
 *    message. An ordinary player's click only records their own team's
 *    vote (handleTeamVote_) - the sheet isn't written until both teams
 *    agree, and a mismatch is flagged in the thread rather than
 *    written. Anyone holding one of the roles listed in the optional
 *    MODERATOR_ROLE_IDS environment variable can instead settle it
 *    immediately with one click, skipping the two-team wait
 *    (clickerHasModeratorRole_) - useful for resolving a dispute
 *    without waiting on both teams to agree. Either way, the agreed or
 *    moderator-decided result calls back into Apps Script's
 *    'recordWinner' action to write the winner in, posts the final
 *    result as a new message, and only then strips both the "who won?"
 *    buttons and the Match Complete button for good.
 *    Separately, whenever Statlocker didn't return a Match ID and/or
 *    Match Length for a game - regardless of whether the winner is
 *    known - a line is appended asking someone to upload the
 *    post-match stats screen for an admin to enter by hand
 *    (missingStatsWarning_). See handleMatchCompleteClick_ /
 *    handleWinnerClick_ / handleTeamVote_ / finishRecordWinner_.
 *
 * 7. BEST-OF-X SERIES PROGRESSION: once a game's winner is recorded
 *    (via job 6, either path), advanceSeriesAfterWin_ updates the
 *    series' running score in the "thread:" KV entry from job 2, then
 *    either declares the series over (a team reached a majority of its
 *    rows, or there are no rows left) or moves on to the next row.
 *    That next row gets its side decided the same way game 1's would
 *    have been, checked in priority order: an underline override for
 *    that row (locks a team onto Hidden King directly, or - if both
 *    cells were underlined - swaps Hidden King/Archmother from
 *    whichever team held Hidden King last game, via
 *    threadState.lastHiddenKingTeam; the Archmother team then chooses
 *    pick order) beats a bold override for that row (automatic choice
 *    priority, but the team still chooses) beats the default:
 *    whichever team just LOST the game that finished gets choice
 *    priority (standard best-of-X practice). A bold-or-default prompt
 *    reuses the exact same KV shape and buttons as job 3, so job 4's
 *    handleSelectionClick_ needs no changes to handle it; an underline
 *    override starts straight at the pick order step, same as job 3's
 *    own underline path - see runHiddenKingLock_. No new thread is ever created
 *    partway through a series - see Code.gs's buildMatchThreadEntries_
 *    for how a run of sequential same-matchup rows becomes one series
 *    in the first place.
 *
 * ---------------------------------------------------------------------
 * SETUP
 * ---------------------------------------------------------------------
 * 1. In the Cloudflare dashboard, create a Worker and paste in this
 *    entire file. Deploy.
 * 2. Settings > Variables and Secrets - add DISCORD_BOT_TOKEN (your
 *    bot's token), RELAY_SECRET (a secret string of your choosing,
 *    shared with Code.gs's DISCORD_RELAY_SECRET property),
 *    DISCORD_PUBLIC_KEY (from the Discord Developer Portal's General
 *    Information page), STATLOCKER_API_KEY, SHEET_WEBHOOK_URL, and
 *    SHEET_WEBHOOK_SECRET (the Apps Script Web App URL and secret from
 *    Code.gs's INSTALL step 7 - only needed for the side-swap/draft-URL
 *    webhook behaviors described there).
 * 3. Settings > Bindings > Add > KV Namespace - create and bind a
 *    namespace named MATCH_STATE. This is where job 2/3's per-thread
 *    and per-game state lives.
 * 4. In the Discord Developer Portal, set your application's
 *    Interactions Endpoint URL to this worker's URL + "/interactions".
 * 5. OPTIONAL - MODERATOR OVERRIDE: to let a moderator/admin role
 *    press the side-selection, Match Complete, or "who won?" buttons
 *    even when they're not on either team (useful for settling a
 *    dispute, e.g. both teams claiming the win), add a
 *    MODERATOR_ROLE_IDS variable under Settings > Variables and
 *    Secrets with one or more Discord role IDs, comma-separated (e.g.
 *    "111111111111111111,222222222222222222"). Leave it unset to keep
 *    every button team-only. See clickerHasModeratorRole_.
 * 6. OPTIONAL - SIDE BUTTON ICONS: to show a small icon on the sideA/
 *    sideB buttons, upload your own Application Emoji (Developer
 *    Portal > your app > Emoji tab, or automatically via the Node.js
 *    installer's setup script - see the install guide), then add
 *    SIDE_A_EMOJI_ID, SIDE_A_EMOJI_NAME, SIDE_B_EMOJI_ID, and
 *    SIDE_B_EMOJI_NAME as plain Variables with the resulting values.
 *    All four are optional and independent per side - leave any or all
 *    unset for plain buttons with no icon. See sideSelectionButtons_.
 *    Note this is Application Emoji, not Guild (server) Emoji - an
 *    emoji ID copied from a Discord server, or from someone else's
 *    bot, will not work here; each bot needs its own uploaded copy.
 *
 * UPGRADING AN EXISTING WORKER: replacing an older copy's code with
 * this file is normally a drop-in change using the same secrets and KV
 * binding. The one exception is the "thread:" KV schema, which stores
 * a whole series ({ rows, gameIndex, team1Wins, team2Wins, ... }) - a
 * match thread created by a copy of this worker old enough to only
 * store a single row should be allowed to finish out under that old
 * code, or be completed by hand in the sheet, before you deploy a
 * version with the newer schema; otherwise its "Match Complete" button
 * won't find the fields it expects.
 * =====================================================================
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";
const STATLOCKER_API_BASE = "https://statlocker.gg/api/public-draft";
const MATCH_STATE_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 week - plenty for a tournament day
const THREAD_STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - registered well before the
                                                      // draft/Match Complete button exists,
                                                      // so this needs to outlive the shorter-
                                                      // lived coinflip state comfortably

// How much clock skew + retry delay to tolerate between a request being
// signed and reaching here - generous relative to a normal request/
// retry cycle, tight enough that a captured request is useless to
// replay shortly after. Shared by both RELAY_SECRET (this file
// verifies) and SHEET_WEBHOOK_SECRET (this file signs, Code.gs
// verifies) - see verifyRelayRequest_ / computeWebhookSignature_.
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

// The only Discord REST calls Code.gs actually needs relayed (see its
// callDiscordApi_ call sites) - deliberately narrow rather than a bare
// "any method, any path" passthrough, so a leaked RELAY_SECRET only
// buys an attacker these two specific actions instead of the bot's
// entire Discord permission set. Add an entry here (and in Code.gs, if
// it's a new call site) if a future version needs another endpoint.
const RELAY_ALLOWED_CALLS = [
  { method: "GET", pattern: /^\/guilds\/\d+\/roles$/ },
  { method: "POST", pattern: /^\/channels\/\d+\/threads$/ }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/interactions") {
      return handleInteraction(request, env, ctx);
    }
    if (url.pathname === "/internal/coinflip") {
      return handleCoinflip(request, env);
    }
    if (url.pathname === "/internal/register-thread") {
      return handleRegisterThread(request, env);
    }
    if (url.pathname === "/internal/health") {
      return handleHealth(request, env);
    }
    return handleDiscordProxy(request, env);
  }
};

/**
 * =====================================================================
 * 1. REST RELAY - forwards ordinary Discord API calls from Apps Script
 * =====================================================================
 */
async function handleDiscordProxy(request, env) {
  if (!(await verifyRelayRequest_(request, env))) {
    return jsonResponse({ message: "Forbidden - bad, missing, or stale relay signature" }, 403);
  }

  const incomingUrl = new URL(request.url);

  const allowed = RELAY_ALLOWED_CALLS.some(
    (call) => call.method === request.method && call.pattern.test(incomingUrl.pathname)
  );
  if (!allowed) {
    return jsonResponse({ message: "Forbidden - this relay only forwards a fixed allow-list of Discord API calls" }, 403);
  }

  const discordUrl = DISCORD_API_BASE + incomingUrl.pathname + incomingUrl.search;

  let body = undefined;
  const headers = {
    "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
    "User-Agent": "DeadlockTournamentManagementBot/1.0"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    body = await request.text();
  }

  let discordResponse;
  try {
    discordResponse = await fetch(discordUrl, { method: request.method, headers, body });
  } catch (err) {
    return jsonResponse({ message: "Relay fetch to Discord failed: " + err.message }, 502);
  }

  const responseText = await discordResponse.text();
  return new Response(responseText, {
    status: discordResponse.status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * =====================================================================
 * 1b. HEALTH CHECK - lets the spreadsheet's Setup Wizard confirm this
 *     Worker is reachable and that its own copy of RELAY_SECRET matches
 *     before the wizard lets a person move on, instead of them only
 *     finding out later via "Coinflip failed to start for: ..." during
 *     a real match. Reports which OTHER secrets/bindings are present
 *     as booleans only - never the values themselves, so this can't be
 *     used to exfiltrate anything even by someone who already has a
 *     valid RELAY_SECRET.
 * =====================================================================
 */
async function handleHealth(request, env) {
  if (!(await verifyRelayRequest_(request, env))) {
    return jsonResponse({ ok: false, message: "Forbidden - bad, missing, or stale relay signature" }, 403);
  }

  return jsonResponse({
    ok: true,
    configured: {
      discordBotToken: Boolean(env.DISCORD_BOT_TOKEN),
      discordPublicKey: Boolean(env.DISCORD_PUBLIC_KEY),
      statlockerApiKey: Boolean(env.STATLOCKER_API_KEY),
      moderatorRoleIds: Boolean(env.MODERATOR_ROLE_IDS),
      sheetWebhookUrl: Boolean(env.SHEET_WEBHOOK_URL) && env.SHEET_WEBHOOK_URL !== "not-set-yet",
      sheetWebhookSecret: Boolean(env.SHEET_WEBHOOK_SECRET) && env.SHEET_WEBHOOK_SECRET !== "not-set-yet",
      sideEmoji: Boolean(env.SIDE_A_EMOJI_ID && env.SIDE_B_EMOJI_ID)
    },
    kvBound: Boolean(env.MATCH_STATE)
  });
}

/**
 * Builds the sideA/sideB button row used both for game 1 (handleCoinflip)
 * and for every later game in a series (advanceSeriesAfterWin_).
 *
 * The small icons on these buttons are entirely optional and specific
 * to whoever's running this bot - they're Application Emoji (see
 * https://docs.discord.com/developers/resources/emoji), which belong
 * to your Discord application itself rather than to any one server, so
 * every installer needs to upload their own copy for their own bot
 * (an emoji ID from someone else's application can't be reused - see
 * the install guide's optional emoji step). If SIDE_A_EMOJI_ID/
 * SIDE_A_EMOJI_NAME and/or SIDE_B_EMOJI_ID/SIDE_B_EMOJI_NAME aren't
 * set, the matching button is just plain text - nothing breaks either
 * way, since this is cosmetic only.
 * @param {string} sideALabel
 * @param {string} sideBLabel
 * @param {Object} env
 * @return {Array<Object>} a single Discord action row component
 */
function sideSelectionButtons_(sideALabel, sideBLabel, env) {
  const sideAButton = { type: 2, style: 1, label: sideALabel, custom_id: "sideA" };
  const sideBButton = { type: 2, style: 1, label: sideBLabel, custom_id: "sideB" };
  if (env.SIDE_A_EMOJI_ID && env.SIDE_A_EMOJI_NAME) {
    sideAButton.emoji = { id: env.SIDE_A_EMOJI_ID, name: env.SIDE_A_EMOJI_NAME };
  }
  if (env.SIDE_B_EMOJI_ID && env.SIDE_B_EMOJI_NAME) {
    sideBButton.emoji = { id: env.SIDE_B_EMOJI_ID, name: env.SIDE_B_EMOJI_NAME };
  }
  return [{ type: 1, components: [sideAButton, sideBButton] }];
}

/**
 * The first button row the choosing team sees (coinflip winner, bold
 * override, or a previous game's loser): which of the two decoupled
 * choices - side or pick order - they want to make themselves. The
 * other team gets whichever one isn't picked here. See
 * handleSelectionClick_.
 * @return {Array<Object>} a single Discord action row component
 */
function choiceTypeButtons_() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: "Side Selection", custom_id: "chooseSide" },
      { type: 2, style: 1, label: "Pick Order", custom_id: "choosePick" }
    ]
  }];
}

/**
 * The First Pick / Second Pick button row - shown either to the
 * choosing team (if they chose Pick Order) or to the other team (if
 * the choosing team chose Side Selection, or the side was locked by an
 * underline override - see runHiddenKingLock_).
 * @return {Array<Object>} a single Discord action row component
 */
function pickOrderButtons_() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: "First Pick", custom_id: "pickFirst" },
      { type: 2, style: 1, label: "Second Pick", custom_id: "pickSecond" }
    ]
  }];
}

function otherTeamKey_(teamKey) {
  return teamKey === "team1" ? "team2" : "team1";
}

/**
 * @param {Object} match a "match:" KV entry (or anything else carrying
 *   team1/team2/team1RoleId/team2RoleId)
 * @param {string} teamKey 'team1' or 'team2'
 * @return {{key: string, name: string, roleId: string}}
 */
function teamInfo_(match, teamKey) {
  return { key: teamKey, name: match[teamKey], roleId: match[teamKey + "RoleId"] };
}

/**
 * =====================================================================
 * 3. SIDE + PICK ORDER SELECTION TRIGGER - called once by Apps Script right after a
 *    match thread is created
 * =====================================================================
 * Normally flips a coin for game 1's choice priority: the winner
 * chooses whether to pick their side (Hidden King/Archmother) or their
 * pick order (First/Second Pick), makes that choice, and the other
 * team then makes the remaining one - see handleSelectionClick_. If
 * Apps Script sends an overrideTeam ('team1' or 'team2' - set when
 * exactly one of that row's Team 1/Team 2 cells was bold, see
 * getSideSignalsForRow_ in Code.gs), the flip is skipped entirely and
 * that team is given choice priority directly instead (they still
 * choose via the buttons). If Apps Script instead sends a
 * hiddenKingTeam ('team1' or 'team2' - set when exactly one cell was
 * underlined), the side is already decided - that team is locked onto
 * Hidden King directly, and only the Archmother team is asked to
 * choose First/Second Pick via runHiddenKingLock_. hiddenKingTeam always takes
 * priority over overrideTeam when Apps Script somehow sends both,
 * though getSideSignalsForRow_ never sets both for the same row.
 */
async function handleCoinflip(request, env) {
  if (!(await verifyRelayRequest_(request, env))) {
    return jsonResponse({ message: "Forbidden - bad, missing, or stale relay signature" }, 403);
  }

  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch (err) {
    return jsonResponse({ message: "Invalid JSON body" }, 400);
  }

  const { threadId, row, sheetName, team1, team2, team1RoleId, team2RoleId, round, sideALabel, sideBLabel, overrideTeam, hiddenKingTeam } = payload;
  if (!threadId || !row || !sheetName || !team1 || !team2 || !team1RoleId || !team2RoleId) {
    return jsonResponse({ message: "Missing one of: threadId, row, sheetName, team1, team2, team1RoleId, team2RoleId" }, 400);
  }

  const baseState = {
    row, sheetName, team1, team2, team1RoleId, team2RoleId, round,
    sideALabel: sideALabel || "Hidden King",
    sideBLabel: sideBLabel || "Archmother"
  };

  if (hiddenKingTeam === "team1" || hiddenKingTeam === "team2") {
    const amberName = hiddenKingTeam === "team1" ? team1 : team2;
    const reasonLine = "**" + amberName + "** automatically on " + baseState.sideALabel + ":";

    const posted = await runHiddenKingLock_(threadId, baseState, hiddenKingTeam, reasonLine, env);
    if (!posted) {
      return jsonResponse({ message: "Posting the Hidden King lock message to Discord failed - see the Worker logs." }, 502);
    }
    await updateThreadLastHiddenKing_(threadId, hiddenKingTeam, env);
    return jsonResponse({ ok: true, winningTeam: amberName });
  }

  const isOverride = overrideTeam === "team1" || overrideTeam === "team2";
  const winningTeam = isOverride ? overrideTeam : (Math.random() < 0.5 ? "team1" : "team2");
  const winningTeamName = winningTeam === "team1" ? team1 : team2;
  const winningRoleId = winningTeam === "team1" ? team1RoleId : team2RoleId;

  // "winningTeam" is the team with choice priority - see
  // handleSelectionClick_ for the stage machine this starts.
  const matchState = Object.assign({}, baseState, {
    winningTeam, winningTeamName, winningRoleId,
    stage: "category",
    chooserCategory: null,
    amberTeam: null,
    firstPickTeam: null,
    resolved: false
  });

  await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(matchState), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });

  // Bold override skips the flip, so it gets its own message - no
  // "won the coin flip" language for a choice that was never at risk.
  const content = (isOverride
    ? "<@&" + winningRoleId + "> gets automatic choice priority."
    : "<@&" + winningRoleId + "> won the coin flip!") +
    " Choose whether you want to pick your **side** or your **pick order** - the other team gets the remaining choice:";
  const components = choiceTypeButtons_();

  let discordResponse;
  try {
    discordResponse = await fetch(DISCORD_API_BASE + "/channels/" + threadId + "/messages", {
      method: "POST",
      headers: {
        "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": "DeadlockTournamentManagementBot/1.0"
      },
      body: JSON.stringify({ content, components, allowed_mentions: { parse: ["roles"] } })
    });
  } catch (err) {
    return jsonResponse({ message: "Posting coinflip message to Discord failed: " + err.message }, 502);
  }

  const responseText = await discordResponse.text();
  if (discordResponse.status >= 400) {
    return jsonResponse({ message: "Discord rejected the coinflip message: " + responseText }, discordResponse.status);
  }

  return jsonResponse({ ok: true, winningTeam: winningTeamName });
}

/**
 * =====================================================================
 * 2. THREAD/SERIES REGISTRATION - called once by Apps Script right
 *    after each match thread is created (before the side-selection
 *    call), so the series this thread belongs to is already known by
 *    the time the "Match Complete" button appears later (once a draft
 *    URL exists - see finishDraftCreation_) - see Code.gs's
 *    registerMatchSeries_.
 *
 *    "rows" is every row in the series (one row per game, ascending -
 *    see Code.gs's buildMatchThreadEntries_), even though only the
 *    first one has a game actually starting yet. From this, a
 *    best-of-X win threshold is derived (a simple majority of the
 *    rows: 2 of 3, 3 of 5, ...) and stored alongside a gameIndex
 *    (starting at 0, into rows[]) marking which row is the currently
 *    active game, plus a running per-team win count - all of which
 *    advanceSeriesAfterWin_ updates as the series plays out.
 *
 *    "sideOverrides" is parallel to "rows" - each entry 'team1',
 *    'team2', or null/undefined, from Code.gs's
 *    getSideOverrideForRow_ (bold on exactly one of that row's Team 1/
 *    Team 2 cells). advanceSeriesAfterWin_ checks the entry for
 *    whichever row is about to become active and, if set, gives that
 *    team automatic choice priority instead of applying the normal
 *    losers-pick rule.
 * =====================================================================
 */
async function handleRegisterThread(request, env) {
  if (!(await verifyRelayRequest_(request, env))) {
    return jsonResponse({ message: "Forbidden - bad, missing, or stale relay signature" }, 403);
  }

  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch (err) {
    return jsonResponse({ message: "Invalid JSON body" }, 400);
  }

  const { threadId, rows, sheetName, team1, team2, team1RoleId, team2RoleId, round, sideALabel, sideBLabel, sideOverrides, hiddenKingOverrides, playAll } = payload;
  if (!threadId || !Array.isArray(rows) || rows.length === 0 || !sheetName || !team1 || !team2) {
    return jsonResponse({ message: "Missing one of: threadId, rows (non-empty array), sheetName, team1, team2" }, 400);
  }

  const seriesLength = rows.length;
  const winsNeeded = Math.floor(seriesLength / 2) + 1; // best-of-N clinches at a simple majority of rows

  const threadState = {
    rows, sheetName, team1, team2,
    team1RoleId: team1RoleId || null,
    team2RoleId: team2RoleId || null,
    round: round || "",
    sideALabel: sideALabel || "Hidden King",
    sideBLabel: sideBLabel || "Archmother",
    sideOverrides: Array.isArray(sideOverrides) ? sideOverrides : [],
    // Parallel to rows - each entry 'team1', 'team2', 'swap', or
    // null/undefined, from Code.gs's getSideSignalsForRow_. Checked by
    // advanceSeriesAfterWin_ before falling back to sideOverrides/
    // losers-pick for each upcoming game - see runHiddenKingLock_.
    hiddenKingOverrides: Array.isArray(hiddenKingOverrides) ? hiddenKingOverrides : [],
    // Which team ('team1'/'team2') held Hidden King in the most
    // recently decided game of this series - null until the first
    // game's side is actually resolved (by a button click or a
    // hiddenKingOverrides lock). Only meaningful once set; used to
    // resolve a later 'swap' entry in hiddenKingOverrides. See
    // updateThreadLastHiddenKing_.
    lastHiddenKingTeam: null,
    seriesLength,
    winsNeeded,
    // "Round" cell underlined on game 1's row (Code.gs's
    // isRoundCellUnderlined_) - every row in this block gets played
    // out even if one side clinches the series early. See
    // advanceSeriesAfterWin_.
    playAll: !!playAll,
    gameIndex: 0,        // index into rows[] of the game currently being played
    team1Wins: 0,
    team2Wins: 0,
    seriesComplete: false
  };

  await env.MATCH_STATE.put("thread:" + threadId, JSON.stringify(threadState), {
    expirationTtl: THREAD_STATE_TTL_SECONDS
  });

  return jsonResponse({ ok: true });
}

/**
 * =====================================================================
 * 4. INTERACTIONS ENDPOINT - Discord calls this directly when a button
 *    is clicked (or to verify the endpoint with a PING)
 * =====================================================================
 */
async function handleInteraction(request, env, ctx) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const rawBody = await request.text();

  const validSignature = signature && timestamp &&
    await verifyDiscordSignature(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!validSignature) {
    return new Response("Bad request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // Discord's handshake check when you first set the Interactions
  // Endpoint URL, and periodically thereafter.
  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  // A button click.
  if (interaction.type === 3) {
    return handleButtonClick(interaction, env, ctx);
  }

  return jsonResponse({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });
}

/**
 * Routes a button click to the right handler by custom_id:
 *   - "chooseSide" / "choosePick" / "sideA" / "sideB" / "pickFirst" /
 *     "pickSecond": the side + pick order selection flow (coinflip
 *     winner, bold override, or a losers-pick from the previous game
 *     choosing first, then the other team) -> handleSelectionClick_
 *   - "matchComplete": the persistent per-thread button -> handleMatchCompleteClick_
 *   - "winnerTeam1" / "winnerTeam2": the "who won?" follow-up buttons -> handleWinnerClick_
 */
async function handleButtonClick(interaction, env, ctx) {
  const customId = interaction.data && interaction.data.custom_id;

  if (SELECTION_BUTTON_IDS.indexOf(customId) !== -1) {
    return handleSelectionClick_(interaction, env, ctx);
  }
  if (customId === "matchComplete") {
    return handleMatchCompleteClick_(interaction, env, ctx);
  }
  if (customId === "winnerTeam1" || customId === "winnerTeam2") {
    return handleWinnerClick_(interaction, env, ctx, customId);
  }

  return jsonResponse({ type: 4, data: { content: "Unrecognized button.", flags: 64 } });
}

// Every button custom_id that belongs to the side + pick order
// selection flow - see handleSelectionClick_.
const SELECTION_BUTTON_IDS = ["chooseSide", "choosePick", "sideA", "sideB", "pickFirst", "pickSecond"];

/**
 * Works out, for a "match:" KV entry's current stage, which team is
 * expected to click next, which category ('side' or 'pick') they're
 * choosing in, and which buttons are valid right now. The stages, in
 * order:
 *   - "category": the team with choice priority (match.winningTeam -
 *     coinflip winner, bold override, or previous game's loser)
 *     chooses Side Selection or Pick Order.
 *   - "chooserSelect": that same team makes the choice they picked
 *     (Hidden King/Archmother, or First/Second Pick).
 *   - "otherSelect": the other team makes the remaining choice. An
 *     underline Hidden King lock starts here directly, with the side
 *     already filled in - see runHiddenKingLock_.
 * @param {Object} match
 * @return {{actorKey: string, category: ?string, validIds: Array<string>}}
 */
function selectionStep_(match) {
  const sideIds = ["sideA", "sideB"];
  const pickIds = ["pickFirst", "pickSecond"];
  if (match.stage === "category") {
    return { actorKey: match.winningTeam, category: null, validIds: ["chooseSide", "choosePick"] };
  }
  if (match.stage === "chooserSelect") {
    const category = match.chooserCategory;
    return { actorKey: match.winningTeam, category, validIds: category === "side" ? sideIds : pickIds };
  }
  const category = match.chooserCategory === "side" ? "pick" : "side";
  return { actorKey: otherTeamKey_(match.winningTeam), category, validIds: category === "side" ? sideIds : pickIds };
}

/** Human-readable label for a side/pick button, for messages. */
function selectionLabel_(match, customId) {
  if (customId === "sideA") return match.sideALabel;
  if (customId === "sideB") return match.sideBLabel;
  if (customId === "pickFirst") return "First Pick";
  return "Second Pick";
}

/**
 * Records a side or pick order click onto the match state, as seen
 * from the clicking team (actorKey).
 */
function applySelection_(match, actorKey, customId) {
  if (customId === "sideA") match.amberTeam = actorKey;
  if (customId === "sideB") match.amberTeam = otherTeamKey_(actorKey);
  if (customId === "pickFirst") match.firstPickTeam = actorKey;
  if (customId === "pickSecond") match.firstPickTeam = otherTeamKey_(actorKey);
}

/**
 * Works out which team ends up on which side (Hidden King/Amber vs
 * Archmother/Sapphire) and which team has First Pick, once both
 * choices have been made, plus the message lines announcing it. Shared
 * by handleSelectionClick_'s immediate ack and finishDraftCreation_'s
 * final edit so the two copies can't drift apart.
 * @param {Object} match this match's stored state (amberTeam and
 *   firstPickTeam both set)
 * @return {{amber: Object, sapphire: Object, firstPick: Object,
 *   secondPick: Object, lines: Array<string>}}
 */
function computeFinalAssignment_(match) {
  const amber = teamInfo_(match, match.amberTeam);
  const sapphire = teamInfo_(match, otherTeamKey_(match.amberTeam));
  const firstPick = teamInfo_(match, match.firstPickTeam);
  const secondPick = teamInfo_(match, otherTeamKey_(match.firstPickTeam));

  // Always listed Hidden King first, then Archmother, then First/Second
  // Pick - regardless of who chose what - so the layout is consistent
  // from game to game.
  const lines = [
    "Side and pick order chosen!",
    match.sideALabel + ": <@&" + amber.roleId + "> (" + amber.name + ")",
    match.sideBLabel + ": <@&" + sapphire.roleId + "> (" + sapphire.name + ")",
    "First Pick: <@&" + firstPick.roleId + "> (" + firstPick.name + ")",
    "Second Pick: <@&" + secondPick.roleId + "> (" + secondPick.name + ")"
  ];

  return { amber, sapphire, firstPick, secondPick, lines };
}

/**
 * Handles every click in the side + pick order selection flow (see
 * selectionStep_ for the stages). Validation (expired match state,
 * already resolved, stale button, wrong clicker) is fast and happens
 * synchronously, well within Discord's 3-second ack window.
 *
 * Each click is acknowledged with UPDATE_MESSAGE (type 7), editing the
 * clicked message in place and stripping/replacing its buttons in the
 * same round trip:
 *   - category click: the same message switches to that team's side
 *     or pick order buttons.
 *   - choosing team's selection: the message becomes a record of the
 *     choice, and a NEW message pinging the other team (an edit
 *     wouldn't notify them) carries the remaining buttons - see
 *     postNextSelectionPrompt_.
 *   - other team's selection: both choices are known, so the message
 *     shows the final sides + pick order and the Statlocker draft is
 *     created in the background via finishDraftCreation_ (kept alive
 *     past the response via ctx.waitUntil). Stripping the buttons in
 *     the ack closes the main real-world trigger for a duplicate draft
 *     (a second click while they're still visible); finishDraftCreation_'s
 *     claim check covers a true sub-second double-tap.
 *
 * Moderators (MODERATOR_ROLE_IDS) can click on behalf of whichever team
 * is expected at each stage.
 */
async function handleSelectionClick_(interaction, env, ctx) {
  const customId = interaction.data && interaction.data.custom_id;

  const threadId = interaction.channel_id;
  const stored = await env.MATCH_STATE.get("match:" + threadId);
  if (!stored) {
    return ephemeral("Couldn't find this match anymore - it may have expired. Ask an organizer to re-run the coinflip.");
  }

  const match = JSON.parse(stored);
  if (match.resolved) {
    return ephemeral("This match's side and pick order have already been decided.");
  }
  if (!match.stage) {
    // Stored by an older copy of this worker (side-only prompt already
    // posted) - treat it as the choosing team having picked Side
    // Selection, so the other team still gets asked for pick order.
    match.stage = "chooserSelect";
    match.chooserCategory = "side";
  }

  const step = selectionStep_(match);
  if (step.validIds.indexOf(customId) === -1) {
    return ephemeral("That button isn't active anymore - use the newest selection message in this thread.");
  }

  const actor = teamInfo_(match, step.actorKey);
  const clickerRoles = (interaction.member && interaction.member.roles) || [];
  if (clickerRoles.indexOf(actor.roleId) === -1 && !clickerHasModeratorRole_(interaction, env)) {
    return ephemeral("Only someone on " + actor.name + " - or a moderator - can make this call.");
  }

  if (match.stage === "category") {
    const choseSide = customId === "chooseSide";
    match.chooserCategory = choseSide ? "side" : "pick";
    match.stage = "chooserSelect";
    await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(match), {
      expirationTtl: MATCH_STATE_TTL_SECONDS
    });

    return jsonResponse({
      type: 7, // UPDATE_MESSAGE
      data: {
        content: "<@&" + actor.roleId + "> (" + actor.name + ") chose **" + (choseSide ? "Side Selection" : "Pick Order") + "**. " +
          (choseSide ? "Choose your side:" : "Choose your pick order:"),
        components: choseSide ? sideSelectionButtons_(match.sideALabel, match.sideBLabel, env) : pickOrderButtons_(),
        allowed_mentions: { parse: ["roles"] }
      }
    });
  }

  applySelection_(match, step.actorKey, customId);
  const choiceLabel = selectionLabel_(match, customId);

  if (match.stage === "chooserSelect") {
    match.stage = "otherSelect";
    await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(match), {
      expirationTtl: MATCH_STATE_TTL_SECONDS
    });

    const other = teamInfo_(match, otherTeamKey_(step.actorKey));
    const remainingIsSide = match.chooserCategory === "pick";
    const recordLine = "**" + actor.name + "** chose " + (remainingIsSide ? "Pick Order" : "Side Selection") +
      ": **" + choiceLabel + "**.";
    const promptContent = "<@&" + other.roleId + "> (" + other.name + "), " + actor.name + " chose **" + choiceLabel + "**. " +
      (remainingIsSide ? "Choose your side:" : "Choose your pick order:");
    const components = remainingIsSide
      ? sideSelectionButtons_(match.sideALabel, match.sideBLabel, env)
      : pickOrderButtons_();

    ctx.waitUntil(postNextSelectionPrompt_(interaction, recordLine, promptContent, components, env));

    return jsonResponse({
      type: 7, // UPDATE_MESSAGE
      data: { content: recordLine, components: [], allowed_mentions: { parse: ["roles"] } }
    });
  }

  // stage === "otherSelect" - both choices are now known.
  match.resolved = true;
  await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(match), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });

  const { lines } = computeFinalAssignment_(match);

  // Ack now (editing the message and clearing its buttons in the same
  // response), do the Statlocker call + follow-up message in the
  // background.
  ctx.waitUntil(finishDraftCreation_(interaction, match, env));

  return jsonResponse({
    type: 7, // UPDATE_MESSAGE
    data: {
      content: lines.join("\n") + "\n⏳ Creating your draft...",
      components: [],
      allowed_mentions: { parse: ["roles"] }
    }
  });
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts the other team's prompt (with the remaining side or pick order
 * buttons) as a new follow-up message, so their role ping actually
 * notifies them. Discord only accepts a follow-up once it has received
 * this click's ack - which is still in flight when this starts under
 * ctx.waitUntil - so this waits briefly and retries rather than
 * failing on the first attempt. If every attempt fails, the prompt and
 * buttons are put back on the clicked message itself instead, so the
 * flow is never stranded (that edit won't ping anyone, but the buttons
 * still work).
 * @param {Object} interaction the raw Discord interaction payload
 * @param {string} recordLine what the clicked message already says
 * @param {string} promptContent the other team's prompt
 * @param {Array<Object>} components the remaining choice's buttons
 * @param {Object} env
 */
async function postNextSelectionPrompt_(interaction, recordLine, promptContent, components, env) {
  for (const delayMs of [500, 1500, 3000]) {
    await sleep_(delayMs);
    try {
      if (await postFollowupMessage_(interaction, promptContent, components, env)) return;
    } catch (err) {
      console.error("Posting the next selection prompt failed: " + err.message);
    }
  }
  await editOriginalInteractionResponse_(interaction, recordLine + "\n" + promptContent, components, env);
}

/**
 * Runs after the final selection click has already been ack'd: creates
 * the Statlocker draft with the two team names slotted into the
 * correct side, then edits the final selection message in place with
 * the result (or with a fallback message telling the organizer to run
 * /draft create by hand, if Statlocker's API call fails for any
 * reason).
 *
 * Starts with a dedup claim through Apps Script's LockService (see
 * Code.gs's claimSideResolution_) before doing anything else. This is
 * the real fix for the underlying race: handleSelectionClick_'s
 * "resolved" flag lives in Cloudflare KV, which has no atomic
 * compare-and-swap, so two clicks landing close enough together can
 * both pass that check before either write lands and both end up here.
 * Losing the claim means another call already owns this row's draft
 * creation, so this call backs off immediately - no Statlocker draft,
 * no further message edits (the caller who won the claim already owns
 * those). If the claim call itself fails (e.g. Apps Script
 * unreachable), this fails open and proceeds rather than blocking the
 * whole flow on it - same best-effort posture as the sheet-sync calls
 * further down, consistent with the rest of this function.
 * @param {Object} interaction the raw Discord interaction payload
 * @param {Object} match this match's stored state (already marked
 *   resolved, with amberTeam and firstPickTeam set)
 */
async function finishDraftCreation_(interaction, match, env) {
  try {
    const claim = await callSheetWebhookAction_(match.row, match.sheetName, { action: "claimSideResolution" }, env);
    if (claim.ok === true && claim.claimed === false) {
      console.log("Lost the side-resolution claim for row " + match.row + " (" + match.sheetName + ") - another click already owns draft creation, backing off.");
      return;
    }
  } catch (err) {
    console.error("Side-resolution claim check failed, proceeding anyway: " + err.message);
  }

  const { amber, sapphire, firstPick, lines } = computeFinalAssignment_(match);

  // Best-effort: record which team ended up on Hidden King for THIS
  // game, so that IF a later game in this series has "both cells
  // underlined" (an underline swap - see Code.gs's
  // getSideSignalsForRow_), advanceSeriesAfterWin_ knows what to swap
  // from. A failure here shouldn't block the rest of this flow - it
  // would only affect a swap game later, if this series even has one.
  try {
    await updateThreadLastHiddenKing_(interaction.channel_id, amber.key, env);
  } catch (err) {
    console.error("Failed to record lastHiddenKingTeam: " + err.message);
  }

  const draftLines = [];

  // Sides and pick order are already known at this point regardless of
  // whether Statlocker creation succeeds below - push them into the
  // sheet (First Pick team into Team 1, cells colored by side - see
  // Code.gs's applySideAndPickOrder_) right away rather than making it
  // wait on (or fail alongside) an unrelated Statlocker outage.
  try {
    await callSheetWebhook_(match.row, match.sheetName, { hiddenKingTeam: amber.name, firstPickTeam: firstPick.name }, env);
  } catch (sheetErr) {
    draftLines.push("(Couldn't sync Team 1/Team 2 order and side colors in the sheet: " + sheetErr.message + ".)");
  }

  let draftUrlCreated = false;
  try {
    const draft = await createStatlockerDraft_(amber.name, sapphire.name, env);
    draftLines.push("Draft created: " + draft.draftUrl);
    draftUrlCreated = true;

    // Best-effort: get the URL into the sheet too. A failure here
    // doesn't change anything about the draft itself (it's already
    // created and posted above) - just note it so it's not silently
    // missing from the sheet with no explanation.
    try {
      await callSheetWebhook_(match.row, match.sheetName, { draftUrl: draft.draftUrl }, env);
    } catch (sheetErr) {
      draftLines.push("(Couldn't write the URL into the sheet automatically: " + sheetErr.message + " - paste it into row " + match.row + " by hand.)");
    }
  } catch (err) {
    draftLines.push("Couldn't auto-create the Statlocker draft (" + err.message + "). Run `/draft create` manually.");
  }

  // Once the draft attempt is settled, clear the "⏳ Creating your
  // draft..." placeholder off the selection message - it stays as a
  // clean, final record of the sides and pick order, with no loading
  // text stuck on it forever.
  await editOriginalInteractionResponse_(interaction, lines.join("\n"), [], env);

  // "Match Complete" only makes sense once there's a draft URL to check
  // against, so it's posted here - right under the URL - rather than on
  // the thread's opening instructions post (see createForumThread_,
  // which carries no buttons of its own). See finishMatchComplete_ for
  // what happens when it's pressed. The draft link + button go in a
  // brand-new message (rather than another edit to the selection
  // message above) so they land at the bottom of the thread, where
  // players are actually looking.
  const components = draftUrlCreated ? [{
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Match Complete', custom_id: 'matchComplete' }
    ]
  }] : [];

  await postFollowupMessage_(interaction, draftLines.join("\n"), components, env);
}

/**
 * The underline-override path: Code.gs already determined the side
 * from underlined cells (see getSideSignalsForRow_), so there's no coin
 * flip and no side choice for anyone to make. Pick order is still
 * open, though, and goes to the team that DIDN'T get locked onto
 * Hidden King - this posts the locked sides plus First/Second Pick
 * buttons for the Archmother team, and stores a "match:" KV entry that
 * starts directly at handleSelectionClick_'s "otherSelect" stage (with
 * the side already filled in). Their click then runs the exact same
 * finishDraftCreation_ as every other path. Because there's no click
 * to reply to yet, this posts via the bot token (postChannelMessage_)
 * rather than an interaction webhook. Called from two places:
 * handleCoinflip, for a game 1 whose row had exactly one cell
 * underlined, and advanceSeriesAfterWin_, for a later game whose row
 * had one cell underlined OR both cells underlined (a swap, already
 * resolved to a concrete Hidden King team by the caller before this
 * function is ever called - this function doesn't need to know which
 * case it was).
 * @param {string} threadId
 * @param {Object} baseState row, sheetName, team1, team2, team1RoleId,
 *   team2RoleId, round, sideALabel, sideBLabel
 * @param {string} amberKey 'team1' or 'team2' - the team locked onto
 *   Hidden King
 * @param {string} reasonLine shown as the message's opening line -
 *   phrased by the caller so it can say "underlined" vs "swapped from
 *   last game" as appropriate.
 * @param {Object} env
 * @return {Promise<boolean>} false if the message couldn't be posted
 */
async function runHiddenKingLock_(threadId, baseState, amberKey, reasonLine, env) {
  const amber = teamInfo_(baseState, amberKey);
  const sapphire = teamInfo_(baseState, otherTeamKey_(amberKey));

  const matchState = Object.assign({}, baseState, {
    winningTeam: amberKey,
    winningTeamName: amber.name,
    winningRoleId: amber.roleId,
    stage: "otherSelect",
    chooserCategory: "side",
    amberTeam: amberKey,
    firstPickTeam: null,
    resolved: false
  });
  await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(matchState), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });

  const content = [
    reasonLine,
    baseState.sideALabel + ": <@&" + amber.roleId + "> (" + amber.name + ")",
    baseState.sideBLabel + ": <@&" + sapphire.roleId + "> (" + sapphire.name + ")",
    "",
    "<@&" + sapphire.roleId + "> (" + sapphire.name + "), you're on " + baseState.sideBLabel + ", so you choose your pick order:"
  ].join("\n");

  try {
    await postChannelMessage_(threadId, content, pickOrderButtons_(), env);
    return true;
  } catch (err) {
    // Log it so it's visible in Cloudflare's Worker logs, same as the
    // other places a Discord post can fail silently from the person's
    // point of view.
    console.error("Failed to post Hidden King lock message: " + err.message);
    return false;
  }
}

/**
 * Records which team (('team1'/'team2') ended up on Hidden King for
 * the game that was just decided, in the series' "thread:" KV entry -
 * read fresh and merged rather than assumed, since this can be called
 * from a background context (ctx.waitUntil) that may run after other
 * updates to the same thread state. This is the only thing a later
 * underline "swap" game (both cells underlined, game 2+ - see Code.gs's
 * getSideSignalsForRow_) needs in order to know what to swap from.
 * A missing "thread:" entry (expired KV, bad threadId, etc.) is not
 * treated as an error here - there's nothing useful to update.
 * @param {string} threadId
 * @param {string} hiddenKingTeam 'team1' or 'team2'
 * @param {Object} env
 */
async function updateThreadLastHiddenKing_(threadId, hiddenKingTeam, env) {
  const stored = await env.MATCH_STATE.get("thread:" + threadId);
  if (!stored) return;

  const threadState = JSON.parse(stored);
  threadState.lastHiddenKingTeam = hiddenKingTeam;
  await env.MATCH_STATE.put("thread:" + threadId, JSON.stringify(threadState), {
    expirationTtl: THREAD_STATE_TTL_SECONDS
  });
}

/**
 * =====================================================================
 * 6. MATCH COMPLETION - the "Match Complete" button posted on the
 *    draft-created message once a side is chosen, plus the "who won?"
 *    follow-up buttons it posts when Statlocker doesn't have a result
 *    yet.
 * =====================================================================
 */

/**
 * Handles a "Match Complete" button click. Looks up which sheet row/
 * tab this thread belongs to (stored once, right when the thread was
 * created - see handleRegisterThread), optionally restricts who can
 * press it to players on either team, then defers with
 * DEFERRED_UPDATE_MESSAGE (type 6). Unlike the side-selection buttons,
 * this button is deliberately left in place and clickable for as long
 * as no winner has been recorded yet - the underlying lookup
 * (runMatchCompleteFetch_ via finishMatchComplete_) is idempotent, so
 * pressing it again just re-checks Statlocker, which is exactly what
 * you want if the first check ran before Statlocker had synced. It's
 * only stripped once a winner is actually on the books (see
 * finishMatchComplete_ and finishRecordWinner_), at which point the
 * "who won?" buttons, if any were posted, come down too.
 *
 * If a "who won?" vote is already pending for this row, a press here
 * doesn't re-check Statlocker at all - see bumpPendingWinnerVote_.
 */
async function handleMatchCompleteClick_(interaction, env, ctx) {
  const threadId = interaction.channel_id;
  const stored = await env.MATCH_STATE.get("thread:" + threadId);
  if (!stored) {
    return ephemeral("Couldn't find which sheet row this thread belongs to - ask an organizer to check the sheet directly.");
  }
  const threadState = JSON.parse(stored);

  if (threadState.seriesComplete) {
    return ephemeral("This series is already decided - there's no active game left to complete.");
  }

  const clickerRoles = (interaction.member && interaction.member.roles) || [];
  if (threadState.team1RoleId && threadState.team2RoleId &&
      clickerRoles.indexOf(threadState.team1RoleId) === -1 &&
      clickerRoles.indexOf(threadState.team2RoleId) === -1 &&
      !clickerHasModeratorRole_(interaction, env)) {
    return ephemeral("Only someone from " + threadState.team1 + ", " + threadState.team2 + ", or a moderator can do this.");
  }

  // If a "who won?" vote is already pending for this row, don't kick off
  // a second, independent Statlocker re-check alongside it. The two
  // paths write the same Winner cell via separate webhook calls
  // (matchComplete vs recordWinner), and if they land close enough
  // together they can both see the cell as empty and both advance the
  // series - see bumpPendingWinnerVote_'s docstring for the race this
  // closes. Just resurface the existing prompt at the bottom of the
  // thread instead of starting a competing resolution.
  const pendingStored = await env.MATCH_STATE.get("pending_winner:" + threadId);
  if (pendingStored) {
    ctx.waitUntil(bumpPendingWinnerVote_(interaction, JSON.parse(pendingStored), threadId, env));
    return jsonResponse({ type: 6 });
  }

  ctx.waitUntil(finishMatchComplete_(interaction, threadState, env));
  return jsonResponse({ type: 6 }); // DEFERRED_UPDATE_MESSAGE - no visual change; the button stays as-is
}

/**
 * Re-posts an already-pending "who won?" prompt at the bottom of the
 * thread, in place of running a second, independent Statlocker check.
 *
 * Before this existed, the "Match Complete" button stayed live and
 * retryable even while a "who won?" vote was outstanding (by design -
 * see handleMatchCompleteClick_'s JSDoc), with no link between the two.
 * That meant a press on the old button while a vote was still pending
 * kicked off finishMatchComplete_'s Statlocker re-check completely
 * independently of the vote - and if that re-check and someone
 * answering (or a moderator overriding) the pending vote landed close
 * enough together, both could see the Winner cell as still empty and
 * both call advanceSeriesAfterWin_, double-posting the next-step
 * message (the "picks the side for Game 2" prompt appearing twice).
 * Code.gs's own locking is meant to stop the underlying cell write from
 * happening twice, but there's no reason to invite the race at all when
 * a vote is already in flight for this exact row.
 *
 * This strips the previous prompt's buttons (via the bot token, since
 * its own interaction token may be long expired by the time someone
 * re-presses Match Complete) and posts a fresh copy at the bottom, so
 * there's only ever one live "who won?" prompt per row and pressing
 * Match Complete again just brings it back into view instead of racing
 * it.
 * @param {Object} interaction the Match Complete click's interaction
 * @param {Object} pending the "pending_winner:" KV entry
 * @param {string} threadId
 * @param {Object} env
 */
async function bumpPendingWinnerVote_(interaction, pending, threadId, env) {
  if (pending.whoWonMessageId) {
    await editChannelMessage_(threadId, pending.whoWonMessageId,
      "Who won this match?\n(Moved below - see the newest prompt.)", [], env);
  }

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: pending.team1.slice(0, 80), custom_id: "winnerTeam1" },
      { type: 2, style: 1, label: pending.team2.slice(0, 80), custom_id: "winnerTeam2" }
    ]
  }];

  let statusText = "Who won this match? Both teams need to agree (or a moderator can settle it).";
  if (pending.votes && (pending.votes.team1 || pending.votes.team2)) {
    const votedKey = pending.votes.team1 ? "team1" : "team2";
    const voterTeamName = votedKey === "team1" ? pending.team1 : pending.team2;
    const otherTeamName = votedKey === "team1" ? pending.team2 : pending.team1;
    statusText = "Who won this match?\n" + voterTeamName + " says **" + pending.votes[votedKey] +
      "**. Waiting on " + otherTeamName + " to confirm (or a moderator to settle it).";
  }

  const bumped = await postFollowupMessage_(interaction, statusText, components, env);

  pending.whoWonMessageId = bumped && bumped.id;
  await env.MATCH_STATE.put("pending_winner:" + threadId, JSON.stringify(pending), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });
}

/**
 * Runs after the click has already been ack'd. The "Match Complete"
 * button itself is deliberately left untouched on its original message
 * (see handleMatchCompleteClick_'s JSDoc) - everything this function
 * has to say goes into a brand-new "checking" message instead, posted
 * right away and then edited in place as the lookup (the sheet's
 * 'matchComplete' webhook action - Fetch Draft Data for just this row)
 * resolves. That keeps the status update at the bottom of the thread
 * without disturbing the button, which stays clickable so a failed or
 * premature check (e.g. Statlocker hasn't synced yet) can just be
 * retried with another press - no separate retry button needed.
 *
 * The Match Complete button (and, if one was posted, the "who won?"
 * buttons) only come down once a winner is actually on record - either
 * because this lookup found one directly (handled here), or because a
 * later vote/moderator override resolves one (see finishRecordWinner_,
 * which strips both via the IDs stashed in "pending_winner:" below).
 * @param {Object} interaction the raw Discord interaction payload
 * @param {Object} threadState the series' "thread:" KV entry (rows,
 *   gameIndex, sheetName, team1, team2, team1RoleId, team2RoleId, ...)
 *   - see handleRegisterThread
 */
async function finishMatchComplete_(interaction, threadState, env) {
  const activeRow = threadState.rows[threadState.gameIndex];
  const threadId = interaction.channel_id;

  // Claim this row before doing anything else - see Code.gs's
  // claimWinnerResolution_ docstring for why this exists on top of
  // (rather than instead of) the checks already inside
  // runMatchCompleteFetch_/recordManualWinner_: those alone let two
  // genuinely-simultaneous doPost calls both proceed in practice (see
  // bumpPendingWinnerVote_'s docstring for the incident that surfaced
  // this). Losing the claim means some other resolution attempt for
  // this exact row is already in flight - back off without touching
  // Statlocker or the sheet at all.
  let claim;
  try {
    claim = await callSheetWebhookAction_(activeRow, threadState.sheetName, { action: "claimWinnerResolution" }, env);
  } catch (err) {
    claim = null; // fail open - see the same reasoning in finishDraftCreation_'s claim check
  }
  if (claim && claim.ok === true && claim.claimed === false) {
    await postFollowupMessage_(interaction, "Someone else is already checking this match's result - give it a moment and check below.", [], env);
    return;
  }

  // The message the "Match Complete" button itself sits on - needed so
  // a later, separate interaction (a "who won?" vote) can still find
  // and strip this button once a winner is settled there instead.
  const matchCompleteMessageId = interaction.message && interaction.message.id;
  const matchCompleteMessageContent = (interaction.message && interaction.message.content) || "";

  const statusMsg = await postFollowupMessage_(interaction, "⏳ Checking match result...", [], env);

  let result;
  try {
    result = await callSheetWebhookAction_(activeRow, threadState.sheetName, { action: "matchComplete" }, env);
  } catch (err) {
    if (statusMsg) {
      await editInteractionMessage_(interaction, statusMsg.id,
        "Couldn't fetch the draft/match data: " + err.message + ". Ask an organizer to run Fetch Draft Data manually, or press Match Complete again to retry.",
        [], env);
    }
    return;
  }

  if (!result.ok) {
    if (statusMsg) {
      await editInteractionMessage_(interaction, statusMsg.id,
        (result.error || "Couldn't check this match's result.") + " Press Match Complete again to retry once that's fixed.",
        [], env);
    }
    return;
  }

  if (result.winnerKnown) {
    const lengthText = result.matchLength ? " (" + result.matchLength + ")" : "";

    // Only the call that actually just found this winner (see
    // runMatchCompleteFetch_'s winnerJustRecorded) may advance the
    // series score - a retried/racing press that finds the winner
    // already on record must not. Also re-read "thread:" fresh rather
    // than trusting the threadState snapshot passed in: that snapshot
    // was captured back in handleMatchCompleteClick_, before the
    // Statlocker fetch above (which can take a few seconds) - if the
    // series advanced some other way in that window (e.g. a
    // moderator's "who won?" override), team1Wins/team2Wins/
    // seriesComplete in the stale copy would be wrong to score off.
    let scoreLine = "";
    let postAdvance = null;
    if (result.winnerJustRecorded) {
      const threadStored = await env.MATCH_STATE.get("thread:" + threadId);
      const freshThreadState = threadStored ? JSON.parse(threadStored) : threadState;
      if (!freshThreadState.seriesComplete) {
        const advance = await advanceSeriesAfterWin_(interaction, freshThreadState, result.winner, env);
        scoreLine = advance.scoreLine ? "\n" + advance.scoreLine : "";
        postAdvance = advance.postAdvance;
      }
    }

    const finalText = "✅ Match recorded. Winner: **" + result.winner + "**" + lengthText + "." +
      scoreLine +
      missingStatsWarning_(result);
    if (statusMsg) {
      await editInteractionMessage_(interaction, statusMsg.id, finalText, [], env);
    } else {
      await postFollowupMessage_(interaction, finalText, [], env);
    }

    // Only now that "Match recorded" is on record does the next-step
    // message (side-selection prompt, hidden king lock, or series-won
    // announcement) go out, so it lands below it in the thread rather
    // than above it.
    if (postAdvance) {
      await postAdvance();
    }

    // Winner's settled - strip the Match Complete button for good.
    if (matchCompleteMessageId) {
      await editInteractionMessage_(interaction, matchCompleteMessageId, matchCompleteMessageContent, [], env);
    }

    // If an earlier click already posted "who won?" buttons that never
    // got answered (this fetch beat the vote to a result), those need
    // to come down too, and the stale vote state cleared.
    await clearPendingWinnerButtons_(threadId, env);
    return;
  }

  // Statlocker doesn't have a result yet - ask the players. Use the
  // team names the sheet just returned (current Team 1/Team 2, post
  // any side-swap) rather than threadState's, which were captured back
  // at thread creation and may be stale/reversed since.
  const team1 = result.team1 || threadState.team1;
  const team2 = result.team2 || threadState.team2;

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: team1.slice(0, 80), custom_id: "winnerTeam1" },
      { type: 2, style: 1, label: team2.slice(0, 80), custom_id: "winnerTeam2" }
    ]
  }];

  const whoWonMsg = await postFollowupMessage_(interaction, "Who won this match? Both teams need to agree (or a moderator can settle it).", components, env);

  // Stashes both message IDs so finishRecordWinner_ - which may run
  // from a completely different interaction (someone clicking a "who
  // won?" button later) - can strip this Match Complete button and the
  // "who won?" buttons above once a winner is actually settled.
  await env.MATCH_STATE.put("pending_winner:" + threadId, JSON.stringify({
    row: activeRow,
    sheetName: threadState.sheetName,
    team1: team1,
    team2: team2,
    matchCompleteMessageId: matchCompleteMessageId,
    matchCompleteMessageContent: matchCompleteMessageContent,
    whoWonMessageId: whoWonMsg && whoWonMsg.id
  }), { expirationTtl: MATCH_STATE_TTL_SECONDS });

  if (statusMsg) {
    await editInteractionMessage_(interaction, statusMsg.id,
      "Statlocker doesn't have a result for this match yet - asking below." + missingStatsWarning_(result),
      [], env);
  }
}

/**
 * Strips the "who won?" buttons off a stale pending-vote message (if
 * one exists for this thread) and clears the vote state, without
 * touching the Match Complete button - used when a winner turns out to
 * already be settled some other way (a direct Match Complete re-check
 * beating an unanswered vote to the result). Uses the bot token rather
 * than an interaction webhook since the interaction that originally
 * posted the "who won?" message may be long gone by the time this
 * runs.
 * @param {string} threadId
 * @param {Object} env
 */
async function clearPendingWinnerButtons_(threadId, env) {
  const stored = await env.MATCH_STATE.get("pending_winner:" + threadId);
  if (!stored) return;

  const pending = JSON.parse(stored);
  if (pending.whoWonMessageId) {
    await editChannelMessage_(threadId, pending.whoWonMessageId,
      "Who won this match?\nAlready settled - see below.", [], env);
  }
  await env.MATCH_STATE.delete("pending_winner:" + threadId);
}

/**
 * Builds a warning line asking players to upload the post-match stats
 * screen when Statlocker's Match ID and/or Match Length weren't found
 * for this game - regardless of whether a winner is known. This is
 * deliberately independent of winnerKnown: a missing winner already
 * gets its own "who won?" flow (see above), and a winner that IS known
 * but with a missing Match ID/Length (e.g. someone typed the winner
 * into the sheet by hand before Statlocker linked the match) still
 * needs flagging, since the underlying match data itself is what's
 * actually missing here, not just the winner.
 * @param {Object} result the 'matchComplete' webhook response - needs
 *   matchIdKnown and matchLengthKnown (see Code.gs's
 *   runMatchCompleteFetch_)
 * @return {string} either "" (nothing missing) or a "\n⚠️ ..." line
 *   ready to append to a message.
 */
function missingStatsWarning_(result) {
  const missing = [];
  if (!result.matchIdKnown) missing.push("Match ID");
  if (!result.matchLengthKnown) missing.push("Match Length");
  if (missing.length === 0) return "";

  return "\n⚠️ Couldn't find " + missing.join(" or ") +
    " from Statlocker for this game - could someone upload the post-match stats screen so an admin can record it manually?";
}

/**
 * Handles a click on one of the "who won?" buttons. Validation is fast
 * and synchronous, then an immediate DEFERRED_UPDATE_MESSAGE (type 6)
 * ack. The buttons stay live on the "who won?" message through partial
 * votes and disagreements (see handleTeamVote_) so either team can
 * click or re-click at any point - they only come down once
 * finishRecordWinner_ actually resolves things.
 *
 * A moderator's click (see clickerHasModeratorRole_) is immediate and
 * decisive - it writes the sheet right away via finishRecordWinner_,
 * same as this button worked before two-team confirmation existed.
 *
 * A team member's click instead records ONLY that team's vote (see
 * handleTeamVote_) - the sheet isn't touched until BOTH teams have
 * clicked and agree on the same winner. This is what keeps one team
 * from unilaterally declaring themselves the winner.
 * @param {string} customId "winnerTeam1" or "winnerTeam2"
 */
async function handleWinnerClick_(interaction, env, ctx, customId) {
  const threadId = interaction.channel_id;
  const stored = await env.MATCH_STATE.get("pending_winner:" + threadId);
  if (!stored) {
    return ephemeral("This match's winner request has expired or was already handled - press Match Complete again, or ask an organizer to check the sheet.");
  }
  const pending = JSON.parse(stored);

  // Team identity for permission AND for knowing which of the two
  // "voter slots" a click fills - see handleTeamVote_. Comes from the
  // durable "thread:" state (role IDs), not "pending_winner:" itself,
  // which only carries team names.
  const threadStored = await env.MATCH_STATE.get("thread:" + threadId);
  const threadState = threadStored ? JSON.parse(threadStored) : null;
  const rolesKnown = !!(threadState && threadState.team1RoleId && threadState.team2RoleId);

  const clickerRoles = (interaction.member && interaction.member.roles) || [];
  const isModerator = clickerHasModeratorRole_(interaction, env);
  const clickerIsTeam1 = !!(rolesKnown && clickerRoles.indexOf(threadState.team1RoleId) !== -1);
  const clickerIsTeam2 = !!(rolesKnown && clickerRoles.indexOf(threadState.team2RoleId) !== -1);

  if (rolesKnown && !isModerator && !clickerIsTeam1 && !clickerIsTeam2) {
    return ephemeral("Only someone from " + pending.team1 + ", " + pending.team2 + ", or a moderator can do this.");
  }

  const winnerName = customId === "winnerTeam1" ? pending.team1 : pending.team2;

  if (isModerator) {
    ctx.waitUntil(finishRecordWinner_(interaction, pending, winnerName, env, " (set by a moderator)"));
    return jsonResponse({ type: 6 });
  }

  if (!rolesKnown) {
    // No team roles on record for this thread (shouldn't normally
    // happen - see handleRegisterThread) - there's no reliable way to
    // tell the two teams' clicks apart, so fall back to the old
    // single-click behavior rather than waiting on a vote that could
    // never be verified as "the other team".
    ctx.waitUntil(finishRecordWinner_(interaction, pending, winnerName, env, ""));
    return jsonResponse({ type: 6 });
  }

  const voterKey = clickerIsTeam1 ? "team1" : "team2";
  ctx.waitUntil(handleTeamVote_(interaction, threadId, voterKey, winnerName, env));
  return jsonResponse({ type: 6 }); // DEFERRED_UPDATE_MESSAGE - edits the "who won?" message in place
}

/**
 * Records one team's vote for who they say won, then decides what
 * happens next. Re-reads "pending_winner:" fresh from KV (rather than
 * trusting a copy passed in) since both teams' clicks can race each
 * other within the same second.
 *   - Other team hasn't voted yet: saves this vote and edits the
 *     message to show the partial status. Sheet untouched.
 *   - Other team already voted and AGREES: finalizes via
 *     finishRecordWinner_ - this is the only path that actually writes
 *     the sheet for a team-submitted (non-moderator) result.
 *   - Other team already voted and DISAGREES: flags the mismatch in
 *     the message and asks for a moderator. Sheet untouched. Either
 *     team can still change their vote by clicking again (each click
 *     overwrites that team's own prior vote and re-runs this check).
 * @param {Object} interaction
 * @param {string} threadId
 * @param {string} voterKey "team1" or "team2" - which team the
 *   clicker is on, i.e. which vote slot this fills (NOT who they say
 *   won - that's winnerName)
 * @param {string} winnerName the team name the clicker picked
 */
async function handleTeamVote_(interaction, threadId, voterKey, winnerName, env) {
  const stored = await env.MATCH_STATE.get("pending_winner:" + threadId);
  if (!stored) {
    await editOriginalInteractionResponse_(interaction,
      "This match's winner request has expired or was already handled.", [], env);
    return;
  }
  const pending = JSON.parse(stored);
  pending.votes = pending.votes || {};
  pending.votes[voterKey] = winnerName;

  const otherKey = voterKey === "team1" ? "team2" : "team1";
  const otherVote = pending.votes[otherKey];

  // pending.team1/pending.team2 are Statlocker's per-game Amber/
  // Sapphire slot order and can be reversed relative to voterKey
  // (which comes from the FIXED team1RoleId/team2RoleId in "thread:"
  // state) whenever sides have swapped since the series started. Use
  // threadState's fixed names for anything keyed by voterKey/otherKey,
  // or a player who voted correctly can be shown as the other team.
  const threadStored = await env.MATCH_STATE.get("thread:" + threadId);
  const threadState = threadStored ? JSON.parse(threadStored) : null;
  const fixedTeam1 = (threadState && threadState.team1) || pending.team1;
  const fixedTeam2 = (threadState && threadState.team2) || pending.team2;
  const fixedName = function (key) { return key === "team1" ? fixedTeam1 : fixedTeam2; };

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: pending.team1.slice(0, 80), custom_id: "winnerTeam1" },
      { type: 2, style: 1, label: pending.team2.slice(0, 80), custom_id: "winnerTeam2" }
    ]
  }];

  if (!otherVote) {
    await env.MATCH_STATE.put("pending_winner:" + threadId, JSON.stringify(pending), {
      expirationTtl: MATCH_STATE_TTL_SECONDS
    });
    const voterTeamName = fixedName(voterKey);
    const otherTeamName = fixedName(otherKey);
    await editOriginalInteractionResponse_(interaction,
      "Who won this match?\n" + voterTeamName + " says **" + winnerName + "**. Waiting on " +
        otherTeamName + " to confirm (or a moderator to settle it).",
      components, env);
    return;
  }

  if (otherVote === winnerName) {
    // Both teams agree - finalize. finishRecordWinner_ clears the
    // pending state itself once the sheet write succeeds.
    await finishRecordWinner_(interaction, pending, winnerName, env, " (confirmed by both teams)");
    return;
  }

  // Disagreement - don't touch the sheet, flag it and wait for a
  // moderator (or for one side to change their vote).
  await env.MATCH_STATE.put("pending_winner:" + threadId, JSON.stringify(pending), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });
  await editOriginalInteractionResponse_(interaction,
    "Who won this match?\n⚠️ " + fixedTeam1 + " says **" + pending.votes.team1 + "**, " +
      fixedTeam2 + " says **" + pending.votes.team2 +
      "** - that's a disagreement. A moderator needs to settle this (press either button).",
    components, env);
}

/**
 * Runs after a winner is decided - either both teams agreed
 * (handleTeamVote_) or a moderator overrode (handleWinnerClick_).
 * Writes the chosen winner into the sheet via the 'recordWinner'
 * webhook action. A failed write leaves the "who won?" buttons exactly
 * as they were (same as Match Complete, an unresolved state stays
 * retryable) and just reports the problem in place. A successful write
 * is the actual resolution point for this game, so it's the one place
 * where buttons come down for good: the "who won?" buttons on this
 * message, and - via the matchCompleteMessageId/Content stashed in
 * "pending_winner:" by finishMatchComplete_ - the Match Complete
 * button too, wherever its message happens to be (this may be a
 * completely different interaction than the one that originally
 * posted that button). The final recorded-winner text goes out as a
 * new message so it lands at the bottom of the thread.
 *
 * Series scoring (advanceSeriesAfterWin_) only runs when
 * result.alreadyRecorded is false - i.e. only for the one call that
 * actually wrote the sheet. Two clicks racing each other (e.g. two
 * players on the same team double-tapping) can both pass the sheet's
 * own idempotency check before either write lands, but the sheet
 * write itself is still atomic - only one of them gets
 * alreadyRecorded: false back. Gating on that, rather than on
 * threadState.seriesComplete, is what keeps a single game win from
 * incrementing the series score twice.
 * @param {Object} interaction
 * @param {Object} pending the "pending_winner:" KV entry (row,
 *   sheetName, team1, team2, votes, matchCompleteMessageId,
 *   matchCompleteMessageContent, whoWonMessageId)
 * @param {string} winnerName
 * @param {Object} env
 * @param {string} reasonSuffix short parenthetical appended to the
 *   confirmation message, e.g. " (confirmed by both teams)" or
 *   " (set by a moderator)" - purely cosmetic, explains how the result
 *   was reached.
 */
async function finishRecordWinner_(interaction, pending, winnerName, env, reasonSuffix) {
  // Same claim as finishMatchComplete_ - see Code.gs's
  // claimWinnerResolution_ docstring. Losing it here means an
  // automatic Statlocker check (or another "who won?" resolution) for
  // this exact row is already in flight; back off rather than racing
  // it to the Winner cell.
  let claim;
  try {
    claim = await callSheetWebhookAction_(pending.row, pending.sheetName, { action: "claimWinnerResolution" }, env);
  } catch (err) {
    claim = null; // fail open - same posture as finishDraftCreation_'s claim check
  }
  if (claim && claim.ok === true && claim.claimed === false) {
    await editOriginalInteractionResponse_(interaction,
      "Who won this match?\nSomeone else is already resolving this - check below in a moment.", [], env);
    return;
  }

  let result;
  try {
    result = await callSheetWebhookAction_(pending.row, pending.sheetName, { action: "recordWinner", winner: winnerName }, env);
  } catch (err) {
    await editOriginalInteractionResponse_(interaction,
      "Couldn't record the winner: " + err.message + ". Ask an organizer to enter it in the sheet by hand.",
      [], env);
    return;
  }

  if (!result.ok) {
    await editOriginalInteractionResponse_(interaction, result.error || "Couldn't record the winner.", [], env);
    return;
  }

  const threadId = interaction.channel_id;
  await env.MATCH_STATE.delete("pending_winner:" + threadId);

  // result.winner is authoritative (it may differ from winnerName if
  // Statlocker's own result beat this button click in - see
  // recordManualWinner_'s "never overwrite" rule in Code.gs), so the
  // series is scored off result.winner, not the name this click sent.
  let scoreLine = "";
  let postAdvance = null;
  const threadStored = await env.MATCH_STATE.get("thread:" + threadId);
  if (threadStored) {
    const threadState = JSON.parse(threadStored);
    // result.alreadyRecorded means THIS call didn't write the sheet -
    // some other call (a racing duplicate click, or Statlocker) beat it
    // there. Only the call that actually performed the write may
    // advance the series score, or two near-simultaneous clicks for the
    // same win can each bump team1Wins/team2Wins once - see
    // finishRecordWinner_'s docstring.
    if (!result.alreadyRecorded && !threadState.seriesComplete) {
      const advance = await advanceSeriesAfterWin_(interaction, threadState, result.winner, env);
      scoreLine = advance.scoreLine ? "\n" + advance.scoreLine : "";
      postAdvance = advance.postAdvance;
    }
  }

  const note = result.alreadyRecorded
    ? "Winner was already recorded as **" + result.winner + "** (Statlocker must have caught up first)."
    : "✅ Recorded winner: **" + result.winner + "**" + (reasonSuffix || "") + ".";
  await postFollowupMessage_(interaction, note + scoreLine, [], env);

  // Only after "Recorded winner" is posted does the next-step message
  // (side-selection prompt, hidden king lock, or series-won
  // announcement) go out - this is what keeps it below the recorded-
  // winner line in the thread instead of above it (the bug where
  // "Side chosen!" used to appear before "Recorded winner").
  if (postAdvance) {
    await postAdvance();
  }

  // Resolved - strip the "who won?" buttons off this message...
  await editOriginalInteractionResponse_(interaction, "Who won this match?\nSettled - see below.", [], env);

  // ...and the Match Complete button off its message, which may belong
  // to an entirely different interaction than this one.
  if (pending.matchCompleteMessageId) {
    await editChannelMessage_(threadId, pending.matchCompleteMessageId, pending.matchCompleteMessageContent || "", [], env);
  }
}

/**
 * =====================================================================
 * 7. BEST-OF-X SERIES PROGRESSION
 * =====================================================================
 * Called once a game's winner is known - either automatically from
 * Statlocker (finishMatchComplete_) or manually via the "who won?"
 * buttons (finishRecordWinner_). Updates the series' running score in
 * "thread:" KV, then either:
 *   - declares the series over (one team reached a majority of the
 *     series' rows, or there are no rows left in the block) and posts
 *     the result, or
 *   - advances gameIndex to the next row and decides that game's side,
 *     checked in priority order:
 *       1. an underline override in threadState.hiddenKingOverrides
 *          (see Code.gs's getSideSignalsForRow_) - locks a team onto
 *          Hidden King directly (or, for 'swap', flips whoever held
 *          Hidden King in threadState.lastHiddenKingTeam) with no
 *          side choice; the Archmother team only chooses First/Second
 *          Pick - via runHiddenKingLock_.
 *       2. a bold override in threadState.sideOverrides (see the same
 *          getSideSignalsForRow_) - that team gets choice priority
 *          instead of the loser, but still chooses via buttons.
 *       3. the default: whichever team just LOST the game that
 *          finished gets choice priority (not a coinflip - the loser
 *          choosing first going into the next game is standard
 *          best-of-X practice).
 *     Cases 2 and 3 post a new follow-up message carrying the same
 *     Side Selection/Pick Order buttons handleSelectionClick_ already
 *     knows how to handle; case 1 starts straight at the pick order
 *     step, same as game 1's own underline path in handleCoinflip.
 *
 * For cases 2 and 3, the "match:" KV entry this builds for the next
 * game is the exact same shape a coinflip produces (row, sheetName,
 * team1, team2, role IDs, round, side labels,
 * winningTeam/winningTeamName/winningRoleId, stage, resolved) - so
 * handleSelectionClick_/finishDraftCreation_ need no changes at all to
 * run the next game's selection and draft creation. "winningTeam"/
 * "winningRoleId" there just mean "the team with choice priority",
 * regardless of whether that team won a coinflip, lost the previous
 * game, or has a bold override - neither function needs to know
 * which. Case 1's entry (written by runHiddenKingLock_) is the same
 * shape too, just starting at the "otherSelect" stage.
 * @param {Object} interaction the raw Discord interaction that
 *   triggered this (used only to know which thread/channel to post
 *   the next message into, via postFollowupMessage_)
 * @param {Object} threadState the "thread:" KV entry for this series,
 *   as of just before the game that just finished (rows, gameIndex,
 *   team1Wins, team2Wins, winsNeeded, etc - see handleRegisterThread)
 * @param {string} winnerName the winning team's name, exactly as
 *   written into the sheet's Winner column for the game just finished
 * @return {{scoreLine: string}} a short line describing the new score
 *   (or the series result if it just ended), for the caller to fold
 *   into its own message edit.
 */
async function advanceSeriesAfterWin_(interaction, threadState, winnerName, env) {
  const threadId = interaction.channel_id;
  const normalizedWinner = String(winnerName || "").trim().toLowerCase();
  const winnerIsTeam1 = normalizedWinner === String(threadState.team1 || "").trim().toLowerCase();
  const winnerIsTeam2 = normalizedWinner === String(threadState.team2 || "").trim().toLowerCase();

  if (!winnerIsTeam1 && !winnerIsTeam2) {
    // Winner text didn't match either team name exactly (e.g. the
    // Winner cell was hand-edited to something else) - can't safely
    // score the series. Leave the series state untouched rather than
    // guess which team it was.
    return {
      scoreLine: "(Couldn't match \"" + winnerName + "\" to either team - series score not updated. " +
        "An organizer may need to fix this row's Winner cell.)",
      postAdvance: null
    };
  }

  const team1Wins = threadState.team1Wins + (winnerIsTeam1 ? 1 : 0);
  const team2Wins = threadState.team2Wins + (winnerIsTeam2 ? 1 : 0);
  const gameNumber = threadState.gameIndex + 1; // 1-based, for messages
  const nextGameIndex = threadState.gameIndex + 1;
  const allRowsPlayed = nextGameIndex >= threadState.rows.length;
  // "Play all" series (Round cell underlined on game 1 - see Code.gs's
  // buildMatchThreadEntries_/isRoundCellUnderlined_) never end early on
  // a clinch - every row in the block gets played regardless of score.
  const clinched = !threadState.playAll &&
    (team1Wins >= threadState.winsNeeded || team2Wins >= threadState.winsNeeded);
  const seriesOver = clinched || allRowsPlayed;

  const updatedThreadState = Object.assign({}, threadState, {
    team1Wins: team1Wins,
    team2Wins: team2Wins,
    gameIndex: seriesOver ? threadState.gameIndex : nextGameIndex,
    seriesComplete: seriesOver
  });
  await env.MATCH_STATE.put("thread:" + threadId, JSON.stringify(updatedThreadState), {
    expirationTtl: THREAD_STATE_TTL_SECONDS
  });

  const scoreText = threadState.team1 + " " + team1Wins + " - " + team2Wins + " " + threadState.team2;

  if (seriesOver) {
    // Clinched before every row in the block was played (and this
    // isn't a "play all" series) - the leftover rows will never get a
    // game played in them, so their Draft URL cells would otherwise
    // sit on the "waiting for draft" placeholder forever. Swap it for
    // "not played" instead. Awaited but non-fatal: a failure here logs
    // and falls through, it never blocks the series-won announcement.
    if (clinched && !allRowsPlayed) {
      await markRowsNotPlayed_(threadState.rows.slice(nextGameIndex), threadState.sheetName, env);
    }

    const seriesWinnerName = team1Wins > team2Wins ? threadState.team1 : (team2Wins > team1Wins ? threadState.team2 : null);
    // team1Wins === team2Wins only happens for an even-length series
    // (best-of-2N) that ran out its rows without either side reaching
    // winsNeeded - a genuine tie, not just "no more games". Declare it
    // the same way a win is declared rather than a flat status line.
    const line = seriesWinnerName
      ? ("🏆 **" + seriesWinnerName + "** wins the series! (" + scoreText + ")")
      : ("🤝 Series tied! (" + scoreText + ")");
    // Not posted here - returned as postAdvance so the caller can post
    // its own "recorded winner"/"match recorded" message FIRST, and
    // this follow-up lands after it instead of before (see
    // finishRecordWinner_/finishMatchComplete_).
    return {
      scoreLine: "",
      postAdvance: function () { return postFollowupMessage_(interaction, line, [], env); }
    };
  }

  // Before anything else, check the next game's row for an UNDERLINE
  // override (threadState.hiddenKingOverrides[nextGameIndex] - see
  // Code.gs's getSideSignalsForRow_) - it takes priority over both the
  // bold override and the default losers-pick rule below, since it's a
  // stronger signal (no coinflip AND no buttons, not just automatic
  // pick). Two shapes:
  //   - 'team1'/'team2': that team is locked onto Hidden King directly.
  //   - 'swap': both cells were underlined - the two teams swap from
  //     whichever one held Hidden King last game
  //     (threadState.lastHiddenKingTeam). If that's not known for some
  //     reason (shouldn't happen once a series is underway, but cheap
  //     to guard), this falls through to the normal rule below instead
  //     of guessing.
  const hiddenKingOverride = threadState.hiddenKingOverrides && threadState.hiddenKingOverrides[nextGameIndex];
  let forcedAmberKey = null;
  if (hiddenKingOverride === "team1" || hiddenKingOverride === "team2") {
    forcedAmberKey = hiddenKingOverride;
  } else if (hiddenKingOverride === "swap" && threadState.lastHiddenKingTeam) {
    forcedAmberKey = threadState.lastHiddenKingTeam === "team1" ? "team2" : "team1";
  }

  const baseState = {
    row: threadState.rows[nextGameIndex],
    sheetName: threadState.sheetName,
    team1: threadState.team1,
    team2: threadState.team2,
    team1RoleId: threadState.team1RoleId,
    team2RoleId: threadState.team2RoleId,
    round: threadState.round,
    sideALabel: threadState.sideALabel || "Hidden King",
    sideBLabel: threadState.sideBLabel || "Archmother"
  };

  if (forcedAmberKey) {
    const amberName = threadState[forcedAmberKey];
    const reasonLine = hiddenKingOverride === "swap"
      ? ("Sides swapped from last game: **" + amberName + "** is now on " + baseState.sideALabel + ":")
      : ("**" + amberName + "** is automatically on " + baseState.sideALabel + " for Game " + (gameNumber + 1) + ":");

    return {
      scoreLine: "Game " + gameNumber + " complete (" + scoreText + ") - Starting Game " + (gameNumber + 1) + ".",
      postAdvance: async function () {
        await runHiddenKingLock_(threadId, baseState, forcedAmberKey, reasonLine, env);
        await updateThreadLastHiddenKing_(threadId, forcedAmberKey, env);
      }
    };
  }

  // Series continues - normally whichever team just LOST this game
  // gets choice priority (side or pick order first) for the next one,
  // UNLESS that next game's row has a bold override
  // (threadState.sideOverrides[nextGameIndex] - see Code.gs's
  // getSideSignalsForRow_), in which case the override team gets it
  // instead and the losers-pick rule is skipped entirely for this game.
  const override = threadState.sideOverrides && threadState.sideOverrides[nextGameIndex];
  const isOverride = override === "team1" || override === "team2";
  const loserIsTeam1 = winnerIsTeam2;

  const pickerIsTeam1 = isOverride ? override === "team1" : loserIsTeam1;
  const pickerName = pickerIsTeam1 ? threadState.team1 : threadState.team2;
  const pickerRoleId = pickerIsTeam1 ? threadState.team1RoleId : threadState.team2RoleId;

  const matchState = Object.assign({}, baseState, {
    winningTeam: pickerIsTeam1 ? "team1" : "team2",
    winningTeamName: pickerName,
    winningRoleId: pickerRoleId,
    stage: "category",
    chooserCategory: null,
    amberTeam: null,
    firstPickTeam: null,
    resolved: false
  });
  await env.MATCH_STATE.put("match:" + threadId, JSON.stringify(matchState), {
    expirationTtl: MATCH_STATE_TTL_SECONDS
  });

  // Deliberately doesn't restate "Game N goes to <winner> (score)" here -
  // the caller's own edit (built from this function's returned
  // scoreLine, below) already declares that. This message's only job
  // is the part that edit can't cover: who chooses next and why.
  const promptLine = (isOverride
    ? ("<@&" + pickerRoleId + "> (" + pickerName + ") gets choice priority for Game " + (gameNumber + 1) + ".")
    : ("<@&" + pickerRoleId + "> lost Game " + gameNumber + ", so " + pickerName + " gets choice priority for Game " + (gameNumber + 1) + ".")) +
    " Choose whether you want to pick your **side** or your **pick order** - the other team gets the remaining choice:";
  const components = choiceTypeButtons_();

  return {
    scoreLine: "Game " + gameNumber + " complete (" + scoreText + ") - Starting Game " + (gameNumber + 1) + ".",
    postAdvance: function () { return postFollowupMessage_(interaction, promptLine, components, env); }
  };
}

/**
 * Tells the sheet to swap the "waiting for draft" placeholder for
 * "not played" in every row passed in - used when a series clinches
 * before all its rows got played (see advanceSeriesAfterWin_). Fire-
 * and-forget from the caller's point of view: awaited here so it
 * completes before the series-won announcement goes out, but a
 * failure only logs - it never blocks or fails the rest of the win
 * flow, since this is just tidying up an unplayed row's placeholder
 * text, not anything score-critical.
 * @param {Array<number>} rows
 * @param {string} sheetName
 * @param {Object} env
 */
async function markRowsNotPlayed_(rows, sheetName, env) {
  if (!rows || rows.length === 0) return;
  try {
    await postToSheetWebhook_(rows[0], sheetName, { action: "markNotPlayed", rows: rows }, env);
  } catch (err) {
    console.error("Failed to mark rows [" + rows.join(",") + "] as not played: " + err.message);
  }
}

/**
 * Calls Statlocker's POST /api/public-draft/draft with the two team
 * names in the confirmed request shape ({team1: {name}, team2: {name}},
 * where team1 is always the Hidden King/Amber side and team2 is always
 * the Archmother/Sapphire side).
 * @param {string} amberName team name for the Hidden King side
 * @param {string} sapphireName team name for the Archmother side
 * @return {{draftCode: string, draftUrl: string}}
 */
async function createStatlockerDraft_(amberName, sapphireName, env) {
  if (!env.STATLOCKER_API_KEY) {
    throw new Error("STATLOCKER_API_KEY secret is not set on the worker");
  }

  const response = await fetch(STATLOCKER_API_BASE + "/draft", {
    method: "POST",
    headers: {
      "X-API-Key": env.STATLOCKER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      team1: { name: amberName },
      team2: { name: sapphireName }
    })
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }

  if (response.status >= 400) {
    const msg = (data && data.error) ? data.error : ("HTTP " + response.status);
    throw new Error(msg);
  }
  if (!data || !data.draftUrl) {
    throw new Error("unexpected response shape (no draftUrl)");
  }
  return data;
}

/**
 * Low-level POST to the Apps Script Web App webhook (see Code.gs's
 * SHEET WEBHOOK section). Returns whatever JSON body doPost() sent
 * back, including an { ok: false, error } response - it's up to the
 * caller to decide whether that counts as a thrown error or a normal
 * result to display (see callSheetWebhook_ vs callSheetWebhookAction_
 * below). Only throws for transport-level failures: a bad deployment
 * URL, "Anyone" access not actually granted, or a non-2xx status,
 * which Apps Script Web Apps otherwise never produce - success/failure
 * of the action itself always comes back as HTTP 200 with an ok field
 * in the body.
 * @param {number} row the sheet row this call is about
 * @param {string} sheetName the sheet tab this row is on
 * @param {Object} fields extra body fields specific to the action being
 *   called (e.g. { hiddenKingTeam }, { draftUrl }, { action: 'matchComplete' })
 * @return {Object} parsed JSON response body
 */
/**
 * Builds a stable, order-independent string of every payload field
 * (except "signature") for HMAC signing - "key=JSON.stringify(value)"
 * pairs sorted by key and joined with "&", so the signature covers the
 * whole body instead of a fixed field subset. Must match Code.gs's
 * canonicalizePayload_.
 */
function canonicalizePayload_(payload) {
  return Object.keys(payload)
    .filter((key) => key !== "signature")
    .sort()
    .map((key) => `${key}=${JSON.stringify(payload[key])}`)
    .join("&");
}

/** HMAC-SHA256(secret, canonicalized payload) - must match Code.gs's computeWebhookSignature_. */
function computeWebhookSignature_(secret, payload) {
  return hmacHex_(secret, canonicalizePayload_(payload));
}

async function postToSheetWebhook_(row, sheetName, fields, env) {
  if (!env.SHEET_WEBHOOK_URL || !env.SHEET_WEBHOOK_SECRET) {
    throw new Error("SHEET_WEBHOOK_URL / SHEET_WEBHOOK_SECRET not set on the worker");
  }

  // Same reasoning as the RELAY_SECRET direction (see
  // verifyRelayRequest_'s doc comment): sign rather than send
  // SHEET_WEBHOOK_SECRET itself, so a leaked request body (Apps Script's
  // own execution log can capture doPost's incoming payload) isn't
  // enough on its own to forge future calls, and a captured request
  // can't be replayed past SIGNATURE_WINDOW_MS. See Code.gs's doPost
  // for the matching verification. The signature covers the entire
  // body (via canonicalizePayload_), not just a fixed field subset.
  const timestamp = Date.now();
  const body = Object.assign({ timestamp, row, sheetName }, fields);
  body.signature = await computeWebhookSignature_(env.SHEET_WEBHOOK_SECRET, body);

  const response = await fetch(env.SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }

  if (response.status >= 400) {
    throw new Error("HTTP " + response.status);
  }
  if (!data) {
    throw new Error("unexpected response shape");
  }
  return data;
}

/**
 * Calls the sheet webhook to push one or both of: which team ended up
 * on Hidden King (triggers the sheet's Team 1/Team 2 side-swap) and a
 * freshly-created draft's URL (written into the Draft URL column).
 * Throws unless the response comes back ok - used by callers (the side
 * flow) that only care about success/failure, not the response shape.
 * Both fields land in whatever row/column that spreadsheet's own saved
 * Settings currently point at - the worker has no idea which column
 * that is, and doesn't need to; Code.gs looks it up from its own
 * getConfig_() at write time. sheetName is likewise passed through as-
 * is so Code.gs can look the tab up by name instead of relying on its
 * own notion of "the active sheet", which is meaningless for a call
 * arriving from outside any user's browser session.
 * @param {number} row the sheet row this match came from (from match
 *   state - set once, back when Apps Script created the thread)
 * @param {string} sheetName the sheet tab this row is on (also from
 *   match state, captured at the same time as row)
 * @param {{hiddenKingTeam: (string|undefined), draftUrl: (string|undefined)}} fields
 *   at least one of the two should be set
 */
async function callSheetWebhook_(row, sheetName, fields, env) {
  const data = await postToSheetWebhook_(row, sheetName, fields, env);
  if (data.ok !== true) {
    throw new Error(data.error || "unexpected response shape");
  }
}

/**
 * Same underlying call as callSheetWebhook_, but returns the response
 * body as-is (including an { ok: false, error } result) instead of
 * throwing on it - used by the Match Complete / "who won?" flow, which
 * wants to show the sheet's own error message (e.g. "no draft URL
 * recorded yet") directly in the thread rather than a generic failure.
 * @param {number} row
 * @param {string} sheetName
 * @param {Object} fields e.g. { action: 'matchComplete' } or
 *   { action: 'recordWinner', winner: '...' }
 * @return {Object} parsed JSON response body
 */
async function callSheetWebhookAction_(row, sheetName, fields, env) {
  return postToSheetWebhook_(row, sheetName, fields, env);
}

/**
 * Edits the message a deferred component interaction is attached to,
 * via the followup webhook endpoint. Authenticated by the interaction
 * token itself - no bot token needed - and valid for up to 15 minutes
 * after the original interaction.
 * @param {Object} interaction the raw Discord interaction payload
 *   (needs application_id and token)
 * @param {string} content the new message text
 * @param {Array<Object>} components component rows to leave on the
 *   message (e.g. the "who won?" buttons) - pass [] to clear/leave it
 *   with no buttons.
 */
async function editOriginalInteractionResponse_(interaction, content, components, env) {
  return editInteractionMessage_(interaction, "@original", content, components, env);
}

/**
 * Edits any message belonging to this interaction's follow-up flow -
 * either "@original" (the message the component was attached to) or
 * the ID of a follow-up message this same interaction posted earlier
 * (e.g. via postFollowupMessage_). Same auth (the interaction token,
 * no bot token needed) and 15-minute validity window as
 * editOriginalInteractionResponse_ - this is just the general form of
 * it, used when a flow needs to keep updating a message it created
 * partway through rather than the message the click came in on.
 * @param {Object} interaction the raw Discord interaction payload
 *   (needs application_id and token)
 * @param {string} messageId "@original", or a message ID returned by
 *   postFollowupMessage_
 * @param {string} content the new message text
 * @param {Array<Object>} components component rows to leave on the
 *   message - pass [] to clear/leave it with no buttons.
 */
async function editInteractionMessage_(interaction, messageId, content, components, env) {
  const url = DISCORD_API_BASE + "/webhooks/" + interaction.application_id +
    "/" + interaction.token + "/messages/" + messageId;

  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, components: components || [], allowed_mentions: { parse: ["roles"] } })
  });

  if (response.status >= 400) {
    // Nothing left to show the user at this point (the interaction
    // response is already spent) - log it so it's visible in
    // Cloudflare's Worker logs / tail rather than failing silently.
    console.error("Failed to edit interaction message " + messageId + ": " + response.status + " " + await response.text());
  }
}

/**
 * Posts a brand-new follow-up message tied to an existing interaction
 * (rather than editing the message the interaction came from) - this
 * is how draft links, match results, and new button prompts land at
 * the bottom of the thread instead of buried up in whatever message
 * the triggering click happened to be on. Valid for up to 15 minutes
 * after the original interaction, same as editOriginalInteractionResponse_.
 * Requests ?wait=true so Discord hands back the created message
 * (rather than an empty 204) - callers that want to keep updating this
 * new message as a flow progresses (e.g. finishDraftCreation_,
 * finishMatchComplete_) need its id for editInteractionMessage_.
 * @param {Object} interaction the raw Discord interaction payload
 *   (needs application_id and token)
 * @param {string} content the new message's text
 * @param {Array<Object>} components component rows for the new message
 * @return {?Object} the created message (has an "id" field), or null
 *   if the post failed
 */
async function postFollowupMessage_(interaction, content, components, env) {
  const url = DISCORD_API_BASE + "/webhooks/" + interaction.application_id + "/" + interaction.token + "?wait=true";

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, components: components || [], allowed_mentions: { parse: ["roles"] } })
  });

  const text = await response.text();
  if (response.status >= 400) {
    console.error("Failed to post follow-up message: " + response.status + " " + text);
    return null;
  }
  return JSON.parse(text);
}

function ephemeral(text) {
  return jsonResponse({ type: 4, data: { content: text, flags: 64 } });
}

/**
 * Posts a brand-new message straight into a channel/thread using the
 * bot token, rather than an interaction's webhook token. Used by the
 * underline Hidden King lock path (runHiddenKingLock_), which has no
 * button click / interaction to respond to - game 1's lock is
 * triggered directly by Apps Script's /internal/coinflip call, and a
 * later game's lock or swap happens inside advanceSeriesAfterWin_
 * where using the bot token directly (instead of the triggering
 * click's interaction token) keeps both call sites identical.
 * @param {string} channelId
 * @param {string} content
 * @param {Array<Object>} components
 * @param {Object} env
 * @return {Object} the created message (has an "id" field)
 */
async function postChannelMessage_(channelId, content, components, env) {
  const response = await fetch(DISCORD_API_BASE + "/channels/" + channelId + "/messages", {
    method: "POST",
    headers: {
      "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "DeadlockTournamentManagementBot/1.0"
    },
    body: JSON.stringify({ content, components: components || [], allowed_mentions: { parse: ["roles"] } })
  });

  const text = await response.text();
  if (response.status >= 400) {
    throw new Error("Discord rejected the message: " + text);
  }
  return JSON.parse(text);
}

/**
 * Edits a message previously posted via postChannelMessage_, again
 * using the bot token directly rather than an interaction webhook.
 * @param {string} channelId
 * @param {string} messageId
 * @param {string} content
 * @param {Array<Object>} components
 * @param {Object} env
 */
async function editChannelMessage_(channelId, messageId, content, components, env) {
  const response = await fetch(DISCORD_API_BASE + "/channels/" + channelId + "/messages/" + messageId, {
    method: "PATCH",
    headers: {
      "Authorization": "Bot " + env.DISCORD_BOT_TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "DeadlockTournamentManagementBot/1.0"
    },
    body: JSON.stringify({ content, components: components || [], allowed_mentions: { parse: ["roles"] } })
  });

  if (response.status >= 400) {
    console.error("Failed to edit channel message: " + response.status + " " + await response.text());
  }
}

/**
 * =====================================================================
 * HELPERS
 * =====================================================================
 */

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * True if the person who clicked a button holds any role listed in the
 * MODERATOR_ROLE_IDS environment variable (comma-separated Discord
 * role IDs - e.g. "111111111111111111,222222222222222222"). Used as
 * an override on top of the usual "must be on one of the two teams"
 * checks (side selection, Match Complete, and the "who won?" buttons),
 * so a tournament admin can always step in - e.g. to settle a dispute
 * over who actually won, or to act for a team that's unresponsive.
 * Unset/empty MODERATOR_ROLE_IDS means no moderator override exists -
 * every button stays team-only.
 * @param {Object} interaction the raw Discord interaction payload
 * @param {Object} env
 * @return {boolean}
 */
function clickerHasModeratorRole_(interaction, env) {
  const modRoleIds = String(env.MODERATOR_ROLE_IDS || "")
    .split(",")
    .map(function (id) { return id.trim(); })
    .filter(Boolean);
  if (modRoleIds.length === 0) return false;

  const clickerRoles = (interaction.member && interaction.member.roles) || [];
  return modRoleIds.some(function (id) { return clickerRoles.indexOf(id) !== -1; });
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex_(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HMAC-SHA256(secret, message) as lowercase hex, via the platform Web
 * Crypto API. Shared by both signature directions this worker deals
 * with: verifying RELAY_SECRET on inbound calls from Code.gs
 * (verifyRelayRequest_) and signing SHEET_WEBHOOK_SECRET on outbound
 * calls to Code.gs (postToSheetWebhook_'s computeWebhookSignature_).
 * @param {string} secret
 * @param {string} message
 * @return {Promise<string>}
 */
async function hmacHex_(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex_(new Uint8Array(signatureBuffer));
}

/** HMAC-SHA256(secret, "timestamp:nonce") - must match Code.gs's computeRelaySignature_. */
function computeRelaySignature_(secret, timestamp, nonce) {
  return hmacHex_(secret, `${timestamp}:${nonce}`);
}

/**
 * Verifies the X-Relay-Timestamp / X-Relay-Nonce / X-Relay-Signature
 * headers Code.gs sends on every relay call (see its
 * buildRelayAuthHeaders_) - an HMAC over the timestamp+nonce, rather
 * than RELAY_SECRET itself traveling as a bare bearer token. The
 * signature check is constant-time (timingSafeEqual); the timestamp
 * check bounds how long a captured request stays valid
 * (SIGNATURE_WINDOW_MS), and the nonce check makes it one-time-use
 * within that window - a captured valid request can't be resent even
 * before it expires, since its nonce is recorded in KV the first time
 * it's seen.
 * @param {Request} request
 * @param {Object} env
 * @return {Promise<boolean>}
 */
async function verifyRelayRequest_(request, env) {
  const secret = env.RELAY_SECRET || "";
  if (!secret) return false;

  const timestamp = Number(request.headers.get("X-Relay-Timestamp") || "");
  const nonce = request.headers.get("X-Relay-Nonce") || "";
  const signature = request.headers.get("X-Relay-Signature") || "";
  if (!timestamp || Math.abs(Date.now() - timestamp) > SIGNATURE_WINDOW_MS) return false;
  if (!nonce) return false;

  const expected = await computeRelaySignature_(secret, timestamp, nonce);
  if (!timingSafeEqual(signature, expected)) return false;

  const nonceKey = "relay_nonce:" + nonce;
  if (await env.MATCH_STATE.get(nonceKey)) return false;
  await env.MATCH_STATE.put(nonceKey, "1", { expirationTtl: Math.ceil(SIGNATURE_WINDOW_MS / 1000) });

  return true;
}

// Constant-time string comparison so the relay secret can't be guessed
// via response-time side channels.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Verifies Discord's Ed25519 request signature using the platform Web
// Crypto API (no external library needed). This is how the /interactions
// endpoint confirms a request genuinely came from Discord.
async function verifyDiscordSignature(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signatureHex), message);
  } catch (err) {
    return false;
  }
}
