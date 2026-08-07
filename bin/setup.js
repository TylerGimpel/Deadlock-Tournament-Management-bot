#!/usr/bin/env node
// Installer script version: 20260807.1
'use strict';

/**
 * Interactive setup for the Deadlock Tournament Management Bot's Cloudflare Worker.
 *
 * Launched via run-setup.bat/run-setup.ps1 in the installer root (this
 * file itself lives in bin/, along with everything else the setup and
 * upgrade scripts need but you don't need to open by hand).
 *
 * Run `npm install` once, then `npm run setup`. This script:
 *   1. Confirms Wrangler is available and you're logged into Cloudflare
 *      (opening a browser tab for that login if needed - no GitHub
 *      account is ever involved).
 *   2. Asks for a Worker name and each secret value, with a short
 *      explanation of where to find it.
 *   3. Optionally uploads the two side-button icons as Application
 *      Emoji for your own bot (see uploadApplicationEmoji) - purely
 *      cosmetic, skip if you don't want them.
 *   4. Writes those into wrangler.jsonc / sets them as real Worker
 *      secrets, then runs `wrangler deploy`.
 *   5. Saves the Worker name, moderator role IDs, and button-icon IDs
 *      (plus Script ID, if you have it handy yet) to
 *      bin/saved-settings.json (see bot-config.js), so that
 *      run-upgrade.bat can find your bot - and restore these same
 *      values into a freshly-unzipped wrangler.jsonc - automatically
 *      later, without asking you to type them again.
 *   6. Prints your Worker's URL and what to do with it next.
 *
 * Safe to re-run: it reuses your existing KV namespace, Worker, and
 * uploaded emoji instead of creating duplicates, and only overwrites
 * secrets you actually type a new value for.
 */

const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { saveBotConfig } = require('./bot-config');

const WRANGLER_JSONC = path.join(__dirname, 'wrangler.jsonc');
// emoji/ lives alongside this file, in bin/.
const EMOJI_DIR = path.join(__dirname, 'emoji');
const IS_WINDOWS = process.platform === 'win32';
const DISCORD_API = 'https://discord.com/api/v10';
const EMOJI_MAX_BYTES = 256 * 1024; // Discord's own limit

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
// dashes only, no leading/trailing dash, 63 chars max if you're using a
// workers.dev subdomain (which this installer always does). Anything else
// gets rejected by the deploy API itself - we just want to catch it here,
// with a message that makes sense, instead of down in a Wrangler error.
const WORKER_NAME_RULE = 'lowercase letters, numbers, and dashes only (no spaces, underscores, or other symbols), 63 characters or fewer, and can\'t start or end with a dash';

function isValidWorkerName(name) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

// Turns whatever someone typed into the closest valid Worker name: spaces
// and underscores become dashes, anything else not allowed gets dropped,
// repeats collapse, and it's capped at 63 characters.
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

// Asks for a Worker name and keeps asking until it's valid. If what was
// typed isn't quite valid, offers the closest sanitized version rather
// than just rejecting it outright.
async function askWorkerName(rl, opts) {
  const typed = await ask(rl, 'Worker name', opts);
  if (isValidWorkerName(typed)) return typed;

  const suggestion = sanitizeWorkerName(typed);
  console.log(`  Worker names can only use ${WORKER_NAME_RULE}.`);
  if (suggestion && isValidWorkerName(suggestion)) {
    if (await confirmSuggestion(rl, suggestion)) return suggestion;
  }
  return askWorkerName(rl, opts);
}

// Strict yes/no for the "use this suggestion?" prompt - deliberately NOT
// a loose /^y/ check, since a typed alternative name that happens to
// start with "y" (e.g. "yellowbot") would otherwise be misread as a yes
// and silently swap in the suggestion instead of what was actually typed.
async function confirmSuggestion(rl, suggestion) {
  const raw = (await ask(rl, `  Use "${suggestion}" instead?`, { defaultValue: 'y' })).trim().toLowerCase();
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  console.log('  Please answer y or n.');
  return confirmSuggestion(rl, suggestion);
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
 * Uploads (or reuses) a Discord Application Emoji - an emoji that
 * belongs to this bot's own application rather than to any one
 * server, so it works in every server the bot posts to. See
 * https://docs.discord.com/developers/resources/emoji.
 *
 * Idempotent: if an emoji with this name already exists on the
 * application (e.g. this script has been run before), its existing ID
 * is reused instead of creating a duplicate.
 * @param {string} botToken
 * @param {string} name
 * @param {string} pngPath
 * @return {Promise<string>} the emoji's ID
 */
async function uploadApplicationEmoji(botToken, name, pngPath) {
  const headers = { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' };

  const appRes = await fetch(`${DISCORD_API}/applications/@me`, { headers });
  if (!appRes.ok) {
    throw new Error(`could not look up your application (HTTP ${appRes.status}) - is DISCORD_BOT_TOKEN correct?`);
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
 * Reads the "// Bot version: ..." stamp from the first line of a file,
 * if present, so a deploy/push can print exactly which version it just
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
 * character itself - used for secret values (bot token, API keys) so
 * they aren't visible on-screen while being typed, or left sitting in
 * terminal scrollback/screen recordings/session-logging software
 * afterward. RELAY_SECRET doesn't need this - it's generated
 * automatically rather than typed - but everything pasted in by hand
 * does.
 *
 * Works by temporarily overriding the readline Interface's internal
 * _writeToOutput - the standard (if undocumented) way to intercept its
 * per-keystroke echo, since Node's readline has never grown a public
 * masked-input option. The prompt text itself is written directly
 * beforehand (via rl.output), before the override is installed, so
 * only what's actually typed gets masked.
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
  console.log('=== Deadlock Tournament Management Bot - Cloudflare Worker setup ===');
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
    console.log('Opening your browser to log into Cloudflare (this is your Cloudflare account - not GitHub)...');
    const login = run('npx', ['wrangler', 'login'], { stdio: 'inherit' });
    if (login.status !== 0) {
      console.error('Login did not complete. Run `npx wrangler login` yourself, then re-run this script.');
      process.exit(1);
    }
  } else {
    console.log('Already logged into Cloudflare.');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log('');
  const workerName = await askWorkerName(rl, { defaultValue: 'deadlock-tournament-management-bot' });
  setWorkerName(workerName);

  console.log('');
  console.log('Now the secrets. Paste each value and press Enter - nothing you type here is');
  console.log('shown anywhere except your own terminal.');
  console.log('');

  console.log("Discord bot token - Developer Portal > your app > Bot > Reset Token / Copy.");
  const botToken = await askSecret(rl, 'DISCORD_BOT_TOKEN', { required: true });
  putSecret('DISCORD_BOT_TOKEN', botToken);

  console.log('');
  console.log('Discord public key - Developer Portal > your app > General Information.');
  const publicKey = await ask(rl, 'DISCORD_PUBLIC_KEY', { required: true });
  putSecret('DISCORD_PUBLIC_KEY', publicKey);

  console.log('');
  console.log('Relay secret - a long random string only this Worker and your spreadsheet');
  console.log('share. No need to make one up: generating it automatically now.');
  const relaySecret = crypto.randomBytes(24).toString('hex');
  putSecret('RELAY_SECRET', relaySecret);

  let copiedToClipboard = false;
  if (IS_WINDOWS) {
    const clipResult = run('clip', [], { input: relaySecret });
    copiedToClipboard = clipResult.status === 0;
  }

  console.log('');
  console.log('  Set on the Worker. You\'ll also need to paste this exact value into the');
  console.log('  spreadsheet later (install guide step 2.6, the DISCORD_RELAY_SECRET');
  console.log('  Script Property):');
  console.log('');
  console.log('  --------------------------------------------------------');
  console.log(`  ${relaySecret}`);
  console.log('  --------------------------------------------------------');
  if (copiedToClipboard) {
    console.log('');
    console.log('  It\'s already copied to your clipboard - just paste it in when you get');
    console.log('  to step 2.6. (Nothing is saved to a file, and copying something else');
    console.log('  will overwrite the clipboard, so paste it somewhere safe if that\'s a');
    console.log('  while away.)');
  } else {
    console.log('');
    console.log('  Copy that value now and keep it somewhere safe until step 2.6 - this');
    console.log('  script does not save it anywhere.');
  }

  console.log('');
  console.log('Statlocker API key.');
  const statlockerKey = await askSecret(rl, 'STATLOCKER_API_KEY', { required: true });
  putSecret('STATLOCKER_API_KEY', statlockerKey);

  console.log('');
  console.log('Moderator role ID(s), comma-separated - optional. Lets that Discord role');
  console.log('override side-selection/match-result buttons even when not on either team.');
  console.log('Press Enter to skip.');
  const moderatorRoleIds = await ask(rl, 'MODERATOR_ROLE_IDS');
  if (moderatorRoleIds) {
    setModeratorRoleIds(moderatorRoleIds);
    // Saved so a future upgrade.js run can put this same value back into
    // the freshly-unzipped wrangler.jsonc instead of leaving it blank -
    // see bot-config.js and the matching code in upgrade.js.
    saveBotConfig({ moderatorRoleIds });
  }

  console.log('');
  console.log('Optional: this bot can show small icons on the side-selection buttons');
  console.log('(a "Hidden King" and an "Archmother" icon, included in this folder\'s emoji/');
  console.log('subfolder). Purely cosmetic - safe to skip.');
  const wantEmoji = (await ask(rl, 'Upload the button icons? (y/N)')).trim().toLowerCase();
  if (wantEmoji === 'y' || wantEmoji === 'yes') {
    try {
      console.log('  Uploading...');
      const sideAId = await uploadApplicationEmoji(botToken, 'Hidden_King', path.join(EMOJI_DIR, 'hidden-king.png'));
      const sideBId = await uploadApplicationEmoji(botToken, 'Archmother', path.join(EMOJI_DIR, 'archmother.png'));
      setEmojiVars(sideAId, 'Hidden_King', sideBId, 'Archmother');
      // Saved for the same reason as moderatorRoleIds above - so upgrade.js
      // can restore these into a fresh wrangler.jsonc without needing your
      // bot token again or wiping them if you don't re-run the upload step.
      saveBotConfig({ emoji: { sideAId, sideAName: 'Hidden_King', sideBId, sideBName: 'Archmother' } });
      console.log('  Done - both icons uploaded to your application and configured.');
    } catch (err) {
      console.log(`  Could not upload the icons automatically (${err.message}).`);
      console.log('  Skipping - the buttons will just show as plain text, nothing else is affected.');
    }
  }

  const deferred = [];
  console.log('');
  console.log('SHEET_WEBHOOK_URL, SHEET_WEBHOOK_SECRET and Script ID all come from the');
  console.log('spreadsheet\'s Setup Wizard (Deadlock Tournament Management Bot > Setup Wizard). If you');
  console.log('haven\'t already, open it now and go through it up to its "Connect Cloudflare"');
  console.log('step - it shows all three with Copy buttons. Paste them in below, then come');
  console.log('back here.');
  console.log('(Rather do this later instead? Press Enter to skip - this script will remind');
  console.log('you exactly how to set the two secrets once you have them. Script ID isn\'t');
  console.log('needed by Cloudflare at all - it\'s just saved here so a future spreadsheet');
  console.log('upgrade won\'t need to ask for it separately.)');
  const sheetUrl = await ask(rl, 'SHEET_WEBHOOK_URL (optional, can set later)');
  putSecret('SHEET_WEBHOOK_URL', sheetUrl || 'not-set-yet');
  if (!sheetUrl) deferred.push('SHEET_WEBHOOK_URL');
  const sheetSecret = await askSecret(rl, 'SHEET_WEBHOOK_SECRET (optional, can set later)');
  putSecret('SHEET_WEBHOOK_SECRET', sheetSecret || 'not-set-yet');
  if (!sheetSecret) deferred.push('SHEET_WEBHOOK_SECRET');
  const scriptId = await ask(rl, 'Script ID (optional)');
  if (scriptId) saveBotConfig({ scriptId });


  rl.close();

  console.log('');
  console.log('Deploying (this also creates and binds the KV storage the bot needs)...');
  const deploy = run('npx', ['wrangler', 'deploy'], { stdio: 'pipe' });
  console.log(deploy.stdout || '');
  if (deploy.status !== 0) {
    console.error(deploy.stderr || '');
    console.error('Deploy failed - see the error above. Fix it and run `npm run deploy` to retry');
    console.error('without repeating the questions above.');
    process.exit(1);
  }

  const urlMatch = (deploy.stdout || '').match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  const workerUrl = urlMatch ? urlMatch[0] : '(check the Cloudflare dashboard for your Worker\'s URL)';

  saveBotConfig({ workerName });

  console.log('');
  console.log('=== Done ===');
  console.log(`Your Worker is live at: ${workerUrl}`);
  const deployedVersion = readVersionStamp(path.join(__dirname, 'worker.js'));
  if (deployedVersion) console.log(`Deployed version: ${deployedVersion}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. In the Discord Developer Portal, set your app\'s Interactions Endpoint URL to:');
  console.log(`   ${workerUrl}/interactions`);
  console.log('   (install guide step 2.5)');
  if (deferred.length) {
    console.log(`2. Once you have real values for ${deferred.join(' and ')}, come back to this`);
    console.log('   folder and run, for each one:');
    for (const key of deferred) console.log(`     npx wrangler secret put ${key}`);
    console.log('   (paste the real value when prompted, then press Enter).');
    console.log('3. Then switch to the spreadsheet\'s Setup Wizard and continue with install guide');
    console.log('   step 2.6 to finish connecting everything.');
  } else {
    console.log('2. Switch back to the spreadsheet\'s Setup Wizard (still open on its "Connect');
    console.log('   Cloudflare" step) and continue with install guide step 2.6 to finish');
    console.log('   connecting everything.');
  }
  console.log('');
}

main().catch(err => {
  console.error('Setup failed unexpectedly:', err);
  process.exit(1);
});