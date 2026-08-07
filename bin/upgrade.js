#!/usr/bin/env node
// Installer script version: 20260807.1
'use strict';

/**
 * Interactive upgrade for the Deadlock Tournament Management Bot's Cloudflare Worker.
 *
 * Use this - instead of setup.js - when you already have the bot running
 * and just want to push out a newer version of the Worker code. Run
 * `npm install` once, then `npm run upgrade`. This script:
 *   1. Confirms Wrangler is available and you're logged into Cloudflare.
 *   2. Asks for the name of your EXISTING Worker (so it upgrades that one
 *      in place, instead of creating a new one alongside it) - pre-filled
 *      from bin/saved-settings.json if you've run this before, so most of
 *      the time you can just press Enter.
 *   3. Before deploying, restores MODERATOR_ROLE_IDS and the button-icon
 *      vars into this freshly-unzipped wrangler.jsonc from
 *      bin/saved-settings.json, so they don't go out blank. (Cloudflare's
 *      `keep_vars` option only protects vars that are missing from
 *      wrangler.jsonc entirely - it does NOT stop a deploy from pushing a
 *      blank value for a var that's present-but-empty, which is exactly
 *      what a fresh copy of this file has. `keep_vars` is still turned on
 *      as a backstop for anything set only via the dashboard, but it is
 *      not what protects these two.) Secrets (bot token, public key,
 *      relay secret, Statlocker key, sheet webhook values) are never
 *      touched by a deploy either way, so none of that needs to be
 *      re-entered.
 *   4. Afterwards, checks which secrets are actually set on that Worker
 *      and, if any are missing (e.g. this is an older install that never
 *      finished setup, or a new secret was added since you installed),
 *      asks for just those.
 *   5. Prints a confirmation, including the version stamp from the top
 *      of worker.js, so you can tell at a glance that the upgrade you
 *      expected actually shipped.
 *
 * Safe to re-run.
 *
 * NOTE: this upgrades the Cloudflare Worker only. Run upgrade-sheet.js
 * (or just double-click run-upgrade.bat, which runs both) to also bring
 * the spreadsheet's Apps Script code up to date.
 */

const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBotConfig, saveBotConfig } = require('./bot-config');

const WRANGLER_JSONC = path.join(__dirname, 'wrangler.jsonc');
// emoji/ lives alongside this file, in bin/.
const EMOJI_DIR = path.join(__dirname, 'emoji');
const IS_WINDOWS = process.platform === 'win32';
const DISCORD_API = 'https://discord.com/api/v10';
const EMOJI_MAX_BYTES = 256 * 1024; // Discord's own limit

// Every secret the Worker needs. Kept in one place so that if a future
// version adds a new one, adding its key (and a short help line below in
// SECRET_HELP) is all this script needs to pick it up automatically.
const REQUIRED_SECRETS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'RELAY_SECRET',
  'STATLOCKER_API_KEY',
  'SHEET_WEBHOOK_URL',
  'SHEET_WEBHOOK_SECRET'
];

const SECRET_HELP = {
  DISCORD_BOT_TOKEN: "Discord bot token - Developer Portal > your app > Bot > Reset Token / Copy.",
  DISCORD_PUBLIC_KEY: "Discord public key - Developer Portal > your app > General Information.",
  RELAY_SECRET: "A long random string only this Worker and your spreadsheet share. Check the spreadsheet's Script Properties (DISCORD_RELAY_SECRET) if you still have it there - it must match exactly. Leave blank here and this script will generate a new one for you, but you'll then need to paste that new value into the spreadsheet too.",
  STATLOCKER_API_KEY: "Your Statlocker API key.",
  SHEET_WEBHOOK_URL: "From the spreadsheet's Setup Wizard (Deadlock Tournament Management Bot > Setup Wizard), the 'Connect Cloudflare' step.",
  SHEET_WEBHOOK_SECRET: "From the same 'Connect Cloudflare' step as SHEET_WEBHOOK_URL."
};

// Which of REQUIRED_SECRETS are actual secrets worth masking on-screen
// as they're typed (see askSecret) - DISCORD_PUBLIC_KEY is, despite the
// name, meant to be public (it's how Discord's signature gets
// verified), and SHEET_WEBHOOK_URL is just a URL, so both stay plainly
// visible for easier proofreading.
const MASKED_SECRETS = new Set(['DISCORD_BOT_TOKEN', 'RELAY_SECRET', 'STATLOCKER_API_KEY', 'SHEET_WEBHOOK_SECRET']);

/**
 * Quotes a single argument for cmd.exe. Wraps in double quotes and
 * escapes embedded quotes unless the argument is already "plain"
 * (letters/digits/common path characters only), in which case it's
 * left bare for readability.
 * @param {string} arg
 * @return {string}
 */
function quoteWindowsArg(arg) {
  const str = String(arg);
  if (/^[A-Za-z0-9_.,:/@=+-]+$/.test(str)) return str;
  return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Runs a command, optionally via a shell. On Windows this is needed
 * because npx/clip etc. are resolved by cmd.exe rather than being
 * directly executable - but spawnSync's shell option only escapes
 * arguments correctly when the whole command is a single string, not
 * when it's given a separate args array (see Node's DEP0190). So on
 * Windows we build one quoted command-line string ourselves and pass
 * no args array; on other platforms we skip the shell entirely.
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {object} [opts]
 */
function run(cmd, args, opts) {
  args = args || [];
  if (IS_WINDOWS) {
    const commandLine = [cmd, ...args].map(quoteWindowsArg).join(' ');
    return spawnSync(commandLine, Object.assign({ encoding: 'utf8', shell: true }, opts || {}));
  }
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}

function patchWranglerJsonc(mutate) {
  const text = fs.readFileSync(WRANGLER_JSONC, 'utf8');
  fs.writeFileSync(WRANGLER_JSONC, mutate(text));
}

function setWorkerName(name) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  patchWranglerJsonc(text => text.replace(/"name":\s*"[^"]*"/, `"name": "${escaped}"`));
}

// Cloudflare's own rule for Worker names: lowercase letters, digits, and
// dashes only, 63 chars max on a workers.dev subdomain. A name that
// breaks this rule can't be an existing Worker either - Cloudflare would
// never have allowed creating one with it - so it's a typo or a stray
// space, not a real reference.
const WORKER_NAME_RULE = 'lowercase letters, numbers, and dashes only (no spaces, underscores, or other symbols), 63 characters or fewer, and can\'t start or end with a dash';

function isValidWorkerName(name) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

function sanitizeWorkerName(raw) {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

// Keeps asking until the name is one Cloudflare could actually have. This
// is meant to be your EXISTING Worker's exact name, so an invalid answer
// is treated as a mistake to fix, not something to silently rewrite.
async function askWorkerName(rl, opts) {
  const typed = await ask(rl, 'Worker name', opts);
  if (isValidWorkerName(typed)) return typed;

  console.log(`  That can't be right - Worker names only ever use ${WORKER_NAME_RULE}, so your existing Worker can't actually be named that.`);
  const suggestion = sanitizeWorkerName(typed);
  if (suggestion && isValidWorkerName(suggestion)) {
    console.log(`  Did you mean "${suggestion}"? Check the Cloudflare dashboard if you're not sure.`);
  }
  return askWorkerName(rl, opts);
}

/**
 * Makes sure `"keep_vars": true` is present at the top level of
 * wrangler.jsonc - see https://developers.cloudflare.com/workers/wrangler/configuration/
 * ("Whether Wrangler should keep variables configured in the dashboard
 * on deploy"). Only a backstop: it stops Wrangler from deleting a var on
 * deploy when that var is missing from wrangler.jsonc entirely (e.g. one
 * added by hand via the dashboard). It does NOT stop Wrangler from
 * pushing a blank value for a var that IS present in wrangler.jsonc, even
 * if that value is an empty string - which is exactly the state
 * MODERATOR_ROLE_IDS and the emoji vars are in in this freshly-unzipped
 * file. Those two are protected separately, by restoreSavedVars() below,
 * which patches the real remembered values back in before deploy. Secrets
 * are never affected by deploys either way, with or without this flag.
 */
function ensureKeepVars() {
  patchWranglerJsonc(text => {
    if (/"keep_vars"\s*:/.test(text)) return text;
    return text.replace(
      /("main":\s*"[^"]*",)/,
      `$1\n\n  // Added by upgrade.js: don't let this deploy overwrite MODERATOR_ROLE_IDS\n  // or the emoji vars already configured on the target Worker with the\n  // blank ones in this fresh copy of the file.\n  "keep_vars": true,`
    );
  });
}

function setModeratorRoleIds(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  patchWranglerJsonc(text => text.replace(/"MODERATOR_ROLE_IDS":\s*"[^"]*"/, `"MODERATOR_ROLE_IDS": "${escaped}"`));
}

function setEmojiVars(sideAId, sideAName, sideBId, sideBName) {
  patchWranglerJsonc(text => text
    .replace(/"SIDE_A_EMOJI_ID":\s*"[^"]*"/, `"SIDE_A_EMOJI_ID": "${sideAId}"`)
    .replace(/"SIDE_A_EMOJI_NAME":\s*"[^"]*"/, `"SIDE_A_EMOJI_NAME": "${sideAName}"`)
    .replace(/"SIDE_B_EMOJI_ID":\s*"[^"]*"/, `"SIDE_B_EMOJI_ID": "${sideBId}"`)
    .replace(/"SIDE_B_EMOJI_NAME":\s*"[^"]*"/, `"SIDE_B_EMOJI_NAME": "${sideBName}"`));
}

/**
 * Restores MODERATOR_ROLE_IDS and the emoji vars from saved-settings.json
 * into this freshly-unzipped wrangler.jsonc, so the upcoming deploy
 * pushes the real values instead of the blank placeholders the zip ships
 * with. See ensureKeepVars() above for why keep_vars alone can't do this.
 * @param {object} saved - result of loadBotConfig()
 * @return {{restoredModerator: boolean, restoredEmoji: boolean}} which
 *   pieces were actually found locally and restored, so the caller can
 *   warn about anything that wasn't.
 */
function restoreSavedVars(saved) {
  let restoredModerator = false;
  let restoredEmoji = false;
  if (saved.moderatorRoleIds) {
    setModeratorRoleIds(saved.moderatorRoleIds);
    restoredModerator = true;
  }
  if (saved.emoji && saved.emoji.sideAId && saved.emoji.sideBId) {
    setEmojiVars(saved.emoji.sideAId, saved.emoji.sideAName, saved.emoji.sideBId, saved.emoji.sideBName);
    restoredEmoji = true;
  }
  return { restoredModerator, restoredEmoji };
}

/**
 * Uploads (or reuses) a Discord Application Emoji - see setup.js for the
 * full explanation. Idempotent: if an emoji with this name already
 * exists on the application, its existing ID is reused.
 * @param {string} botToken
 * @param {string} name
 * @param {string} pngPath
 * @return {Promise<string>} the emoji's ID
 */
async function uploadApplicationEmoji(botToken, name, pngPath) {
  const headers = { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' };

  const appRes = await fetch(`${DISCORD_API}/applications/@me`, { headers });
  if (!appRes.ok) {
    throw new Error(`could not look up your application (HTTP ${appRes.status}) - is the bot token correct?`);
  }
  const app = await appRes.json();

  const listRes = await fetch(`${DISCORD_API}/applications/${app.id}/emojis`, { headers });
  if (listRes.ok) {
    const list = await listRes.json();
    const existing = (list.items || []).find(e => e.name === name);
    if (existing) return existing.id;
  }

  const imageBuffer = fs.readFileSync(pngPath);
  if (imageBuffer.length > EMOJI_MAX_BYTES) {
    throw new Error(`${pngPath} is larger than Discord's 256 KiB emoji limit`);
  }
  const dataUri = `data:image/png;base64,${imageBuffer.toString('base64')}`;

  const createRes = await fetch(`${DISCORD_API}/applications/${app.id}/emojis`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, image: dataUri })
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`upload failed (HTTP ${createRes.status}): ${body.slice(0, 300)}`);
  }
  const created = await createRes.json();
  return created.id;
}

function putSecret(key, value) {
  const result = run('npx', ['wrangler', 'secret', 'put', key], { input: value + '\n' });
  if (result.status !== 0) {
    console.error(`  Could not set ${key}:`);
    console.error('  ' + (result.stderr || result.stdout || '(no error output)').trim());
    return false;
  }
  console.log(`  Set ${key}.`);
  return true;
}

/**
 * Returns the list of secret names already set on the given Worker, or
 * null if that couldn't be determined (in which case the caller should
 * not assume anything is missing).
 * @param {string} workerName
 * @return {string[]|null}
 */
function listExistingSecrets(workerName) {
  const result = run('npx', ['wrangler', 'secret', 'list', '--name', workerName]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return parsed.map(s => s.name).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Reads the "// Bot version: ..." stamp from the first line of a file,
 * if present, so a deploy can print exactly which version it just
 * shipped - a quick way to confirm an upgrade actually took effect
 * without having to open the file and check by hand.
 * @param {string} filePath
 * @return {string|null}
 */
function readVersionStamp(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n', 1)[0];
    const match = firstLine.match(/Bot version:\s*(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function ask(rl, question, opts) {
  opts = opts || {};
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  if (!answer && opts.defaultValue) return opts.defaultValue;
  if (!answer && opts.required) {
    console.log('  This one is required - please enter a value.');
    return ask(rl, question, opts);
  }
  return answer;
}

/**
 * Same as ask(), but echoes "*" for each character instead of the
 * character itself - used for secret values so they aren't visible
 * on-screen while typed or left in terminal scrollback/screen
 * recordings afterward. See setup.js's askSecret for the full
 * explanation of how this works (temporarily overriding readline's
 * internal _writeToOutput).
 * @param {import('readline/promises').Interface} rl
 * @param {string} question
 * @param {{defaultValue?: string, required?: boolean}} [opts]
 * @return {Promise<string>}
 */
function askSecret(rl, question, opts) {
  opts = opts || {};
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : '';
  rl.output.write(`${question}${suffix}: `);
  return new Promise((resolve) => {
    const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function (stringToWrite) {
      rl.output.write(/[\r\n]/.test(stringToWrite) ? stringToWrite : '*');
    };
    rl.question('', (answer) => {
      if (originalWrite) rl._writeToOutput = originalWrite;
      else delete rl._writeToOutput;
      const trimmed = answer.trim();
      if (!trimmed && opts.defaultValue) { resolve(opts.defaultValue); return; }
      if (!trimmed && opts.required) {
        console.log('  This one is required - please enter a value.');
        resolve(askSecret(rl, question, opts));
        return;
      }
      resolve(trimmed);
    });
  });
}

async function main() {
  console.log('');
  console.log('=== Deadlock Tournament Management Bot - Cloudflare Worker upgrade ===');
  console.log('');
  console.log('This pushes the newer Worker code in this folder out to a bot you already');
  console.log('have running - it does not create a new bot or ask for secrets you\'ve');
  console.log('already set.');
  console.log('');

  const versionCheck = run('npx', ['wrangler', '--version']);
  if (versionCheck.status !== 0) {
    console.error('Could not run Wrangler. Run `npm install` in this folder first, then try again.');
    process.exit(1);
  }
  console.log(`Using ${(versionCheck.stdout || '').trim()}`);

  const whoami = run('npx', ['wrangler', 'whoami']);
  const loggedIn = whoami.status === 0 && /You are logged in|account/i.test(whoami.stdout || '');
  if (!loggedIn) {
    console.log('');
    console.log('Opening your browser to log into Cloudflare (the same account your existing');
    console.log('Worker is deployed under)...');
    const login = run('npx', ['wrangler', 'login'], { stdio: 'inherit' });
    if (login.status !== 0) {
      console.error('Login did not complete. Run `npx wrangler login` yourself, then re-run this script.');
      process.exit(1);
    }
  } else {
    console.log('Already logged into Cloudflare.');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const remembered = loadBotConfig().workerName;
  console.log('');
  console.log('Enter the EXACT name of the Worker you\'re already using. Getting this right');
  console.log('matters: it\'s how this script finds your existing bot instead of creating a');
  console.log('new, separate one. (Check the Cloudflare dashboard, under Workers & Pages, if');
  console.log('you\'re not sure.)');
  if (remembered) {
    console.log(`Last used from this folder: "${remembered}" - press Enter to reuse it, or type a different name.`);
  }
  const workerName = await askWorkerName(rl, { defaultValue: remembered || 'deadlock-tournament-management-bot', required: true });
  setWorkerName(workerName);
  ensureKeepVars();

  // Put back whatever we already know locally (from a previous setup.js
  // or upgrade.js run) before this deploy goes out, so this freshly-
  // unzipped wrangler.jsonc doesn't push blanks over real values.
  const saved = loadBotConfig();
  const { restoredModerator, restoredEmoji } = restoreSavedVars(saved);

  console.log('');
  console.log('Optional: update your moderator role IDs (comma-separated). Press Enter to');
  console.log('leave whatever is already set unchanged.');
  if (restoredModerator) {
    console.log(`Last used from this folder: "${saved.moderatorRoleIds}" - press Enter to keep it.`);
  }
  const moderatorRoleIds = await ask(rl, 'MODERATOR_ROLE_IDS');
  if (moderatorRoleIds) {
    setModeratorRoleIds(moderatorRoleIds);
    saveBotConfig({ moderatorRoleIds });
  } else if (!restoredModerator) {
    console.log('  Nothing saved locally for this yet, and nothing entered above - if you');
    console.log('  already have moderator role IDs set on the Worker, this deploy will clear');
    console.log('  them. Re-run and paste them in above to keep them (they\'ll be remembered');
    console.log('  from then on), or ignore this if you\'ve never set any.');
  }
  if (!restoredEmoji && !saved.emoji) {
    console.log('');
    console.log('Note: no button-icon IDs saved locally yet either - if you uploaded the');
    console.log('side-selection icons during your original setup, this deploy will clear');
    console.log('them too. Answer \'y\' to the icon-upload question further down to restore');
    console.log('them (they\'ll be remembered automatically after that).');
  }

  if (loadBotConfig().scriptId) {
    console.log('');
    console.log('Script ID already saved from before - the spreadsheet step will reuse it.');
  } else {
    console.log('');
    console.log('Optional: paste your spreadsheet\'s Script ID too (Setup Wizard > Connect');
    console.log('Cloudflare step has a Copy button for it). Not needed by Cloudflare itself -');
    console.log('saving it now just means a future spreadsheet upgrade won\'t ask for it.');
    const scriptId = await ask(rl, 'Script ID (optional)');
    if (scriptId) saveBotConfig({ scriptId });
  }

  console.log('');
  console.log(`Deploying the latest code to "${workerName}"...`);
  const deploy = run('npx', ['wrangler', 'deploy'], { stdio: 'pipe' });
  console.log(deploy.stdout || '');
  if (deploy.status !== 0) {
    console.error(deploy.stderr || '');
    console.error('Deploy failed - see the error above. Fix it and run `npm run upgrade` to retry.');
    rl.close();
    process.exit(1);
  }

  const urlMatch = (deploy.stdout || '').match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  const workerUrl = urlMatch ? urlMatch[0] : '(check the Cloudflare dashboard for your Worker\'s URL)';

  // Remembered so the next run of upgrade.js can suggest this name
  // again instead of asking blind - see bot-config.js.
  saveBotConfig({ workerName });

  console.log('');
  console.log('Checking that all required secrets are still set on this Worker...');
  const existingSecrets = listExistingSecrets(workerName);
  const missing = existingSecrets === null ? [] : REQUIRED_SECRETS.filter(k => !existingSecrets.includes(k));

  if (existingSecrets === null) {
    console.log('  Could not check automatically - skipping. If Discord verification fails');
    console.log('  below, double check your secrets with `npx wrangler secret list`.');
  } else if (missing.length === 0) {
    console.log('  All set - nothing missing.');
  } else {
    console.log(`  Missing: ${missing.join(', ')}. Let's fill those in now.`);
    for (const key of missing) {
      console.log('');
      console.log(SECRET_HELP[key] || key);
      if (key === 'RELAY_SECRET') {
        const useGenerated = (await ask(rl, 'Generate a new RELAY_SECRET automatically? (Y/n)')).trim().toLowerCase();
        if (useGenerated !== 'n' && useGenerated !== 'no') {
          const relaySecret = crypto.randomBytes(24).toString('hex');
          putSecret('RELAY_SECRET', relaySecret);
          console.log('');
          console.log('  Set on the Worker. Paste this exact value into the spreadsheet\'s');
          console.log('  DISCORD_RELAY_SECRET Script Property too, or the two sides won\'t agree:');
          console.log('');
          console.log('  --------------------------------------------------------');
          console.log(`  ${relaySecret}`);
          console.log('  --------------------------------------------------------');
          continue;
        }
      }
      const value = await (MASKED_SECRETS.has(key) ? askSecret(rl, key, { required: true }) : ask(rl, key, { required: true }));
      putSecret(key, value);
    }
  }

  let botTokenForEmoji = null;
  console.log('');
  console.log('Optional: (re)upload the side-button icons (Hidden King / Archmother). Only');
  console.log('needed if you skipped this during install or the icons aren\'t showing up.');
  const wantEmoji = (await ask(rl, 'Upload the button icons? (y/N)')).trim().toLowerCase();
  if (wantEmoji === 'y' || wantEmoji === 'yes') {
    botTokenForEmoji = await askSecret(rl, 'DISCORD_BOT_TOKEN (not stored anywhere, only used for this upload)', { required: true });
    try {
      console.log('  Uploading...');
      const sideAId = await uploadApplicationEmoji(botTokenForEmoji, 'Hidden_King', path.join(EMOJI_DIR, 'hidden-king.png'));
      const sideBId = await uploadApplicationEmoji(botTokenForEmoji, 'Archmother', path.join(EMOJI_DIR, 'archmother.png'));
      setEmojiVars(sideAId, 'Hidden_King', sideBId, 'Archmother');
      // Saved so future upgrades restore these automatically without
      // needing the bot token again - see restoreSavedVars() above.
      saveBotConfig({ emoji: { sideAId, sideAName: 'Hidden_King', sideBId, sideBName: 'Archmother' } });
      console.log('  Done - both icons uploaded and configured. Deploying once more to apply them...');
      const redeploy = run('npx', ['wrangler', 'deploy'], { stdio: 'pipe' });
      if (redeploy.status !== 0) {
        console.error(redeploy.stderr || '');
        console.error('  That last deploy failed - everything else above is still fine; run');
        console.error('  `npm run upgrade` again to retry just this part.');
      }
    } catch (err) {
      console.log(`  Could not upload the icons automatically (${err.message}).`);
      console.log('  Skipping - nothing else is affected.');
    }
  }

  rl.close();

  console.log('');
  console.log('=== Done ===');
  console.log(`Your Worker is live at: ${workerUrl}`);
  const deployedVersion = readVersionStamp(path.join(__dirname, 'worker.js'));
  if (deployedVersion) console.log(`Deployed version: ${deployedVersion}`);
  console.log('');
  console.log('Nothing else to do - your Discord Interactions Endpoint URL, spreadsheet');
  console.log('connection, and all your secrets are unchanged, since this upgraded the');
  console.log(`Worker named "${workerName}" in place rather than creating a new one.`);
  console.log('If that name is different from what you were using before, you\'ll need to');
  console.log('update the Interactions Endpoint URL in the Discord Developer Portal (install');
  console.log('guide step 2.5) to point at the URL printed above.');
  console.log('');
  console.log('This upgraded the Cloudflare Worker only. Run upgrade-sheet.js too (or just');
  console.log('use run-upgrade.bat, which runs both) if this version also changed the');
  console.log('spreadsheet side.');
  console.log('');
}

main().catch(err => {
  console.error('Upgrade failed unexpectedly:', err);
  process.exit(1);
});
