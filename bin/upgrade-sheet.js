#!/usr/bin/env node
// Installer script version: 20260807.1
'use strict';

/**
 * Interactive upgrade for the Deadlock Tournament Management Bot's spreadsheet side
 * (Code.gs / Sidebar.html / SetupWizard.html).
 *
 * Use this - alongside upgrade.js for the Cloudflare Worker - when you
 * already have a tournament spreadsheet set up and just want to bring
 * its Apps Script code up to date, instead of making a fresh copy of
 * the template and redoing the whole Setup Wizard.
 *
 * Run `npm install` once, then `npm run upgrade-sheet`. This script:
 *   1. Confirms clasp (Google's Apps Script CLI) is available and you're
 *      logged into the Google account that owns your spreadsheet.
 *   2. Asks for your spreadsheet's Script ID (Extensions > Apps Script >
 *      Project Settings > Script ID) - pre-filled from
 *      bin/saved-settings.json if setup.js or upgrade.js already saved
 *      one - and downloads a full copy of that Apps Script project into
 *      a scratch folder here.
 *   3. Backs up what it downloaded into sheet-backups/ before touching
 *      anything, so a pre-upgrade copy of your code always exists on
 *      disk if you ever need to roll back or compare.
 *   4. Replaces only Code.gs, Sidebar.html and SetupWizard.html with the
 *      versions in this folder's "Spreadsheet Code" directory, and
 *      pushes the result back. Script Properties (your API key, relay
 *      secret, webhook URL, column layout, etc) live separately from
 *      the code and are never touched by this. Your spreadsheet's data
 *      - every row, every tab - is untouched too; this only ever talks
 *      to the Apps Script project, never the sheet's cells. If the
 *      project cloned down with no appsscript.json (clasp requires one
 *      to push at all), a fallback manifest is generated on the spot
 *      from this computer's own timezone - see ensureManifest() - and
 *      left alone otherwise. Nothing about this is ever baked into a
 *      shipped file. Separately, if a manifest exists but is missing
 *      the `webapp` access block, that block is filled in with true
 *      no-login "ANYONE_ANONYMOUS" access (see ensureWebAppAccess()) -
 *      without it, step 5
 *      below can silently redeploy your Web App under a far more
 *      restrictive default, breaking the Worker's calls even though
 *      the URL doesn't change.
 *   5. If the spreadsheet already has a Web App deployment (the one
 *      from install guide step 2.3, used for side-swap/draft-URL
 *      write-back), updates THAT SAME deployment to a new version so
 *      its URL stays stable and your Cloudflare Worker's
 *      SHEET_WEBHOOK_URL keeps working without changes.
 *   6. Prints a confirmation, including the version stamp from the top
 *      of Code.gs, so you can tell at a glance that the upgrade you
 *      expected actually shipped.
 *
 * Safe to re-run.
 *
 * NOTE: this upgrades the spreadsheet only. Run upgrade.js too (or just
 * use run-upgrade.bat, which runs both) if this version also changed
 * the Cloudflare Worker.
 */

const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const fs = require('fs');
const path = require('path');
const { loadBotConfig, saveBotConfig } = require('./bot-config');

const IS_WINDOWS = process.platform === 'win32';
const SOURCE_DIR = path.join(__dirname, 'Spreadsheet Code');
const WORKSPACE_DIR = path.join(__dirname, 'sheet-upgrade-workspace');
const BACKUPS_DIR = path.join(__dirname, 'sheet-backups');

// clasp's "project already exists" check runs against the current
// working directory (this file's folder) BEFORE it applies --rootDir,
// so `clasp clone-script ... --rootDir sheet-upgrade-workspace` writes
// its .clasp.json here, next to this script, not inside that rootDir.
// Wiping WORKSPACE_DIR every run (below) never touches this file, so
// on the second and every later run clasp finds this leftover file and
// refuses to clone at all - see ensureCleanClaspState() and the
// hardened success-check after the clone call.
const STRAY_CLASP_CONFIG = path.join(__dirname, '.clasp.json');

// The three files this installer owns and will overwrite. Everything
// else clasp downloads (appsscript.json, any files you've added
// yourself) is left exactly as found.
const OWNED_BASENAMES = ['Code', 'Sidebar', 'SetupWizard'];

/**
 * Quotes a single argument for cmd.exe - see upgrade.js for the full
 * explanation of why this is needed on Windows.
 * @param {string} arg
 * @return {string}
 */
function quoteWindowsArg(arg) {
  const str = String(arg);
  if (/^[A-Za-z0-9_.,:/@=+-]+$/.test(str)) return str;
  return '"' + str.replace(/"/g, '""') + '"';
}

/**
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

function clasp(args, opts) {
  return run('npx', ['@google/clasp', ...args], opts);
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
 * Accepts either a bare Script ID or a script.google.com URL containing
 * one, and returns just the ID. Throws a friendly, specific error if
 * what was pasted is clearly a spreadsheet URL instead (an easy mistake
 * - the two look similar but Google doesn't let us resolve one from the
 * other) or otherwise doesn't look like a real Script ID, rather than
 * letting it through to fail later inside clasp with a much less clear
 * error.
 * @param {string} input
 * @return {string}
 */
function extractScriptId(input) {
  const trimmed = input.trim();

  if (/docs\.google\.com\/spreadsheets/i.test(trimmed)) {
    throw new Error(
      'That looks like your spreadsheet\'s URL, not its Script ID - Google doesn\'t let us\n' +
      '  turn one into the other automatically, unfortunately. Get the Script ID instead:\n' +
      '  open the spreadsheet -> Extensions > Apps Script -> the gear-icon Project Settings\n' +
      '  on the left -> copy the value under "Script ID".'
    );
  }

  const fromUrl = trimmed.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || trimmed.match(/\/projects\/([a-zA-Z0-9_-]{20,})/);
  const candidate = fromUrl ? fromUrl[1] : trimmed;

  if (!/^[a-zA-Z0-9_-]{20,}$/.test(candidate)) {
    throw new Error(
      'That doesn\'t look like a Script ID (expected a long string of letters/numbers, no\n' +
      '  spaces). Double check you copied the "Script ID" field from Project Settings, not\n' +
      '  something else nearby.'
    );
  }

  return candidate;
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes the stray .clasp.json clasp leaves next to this script (see
 * STRAY_CLASP_CONFIG above) so `clone-script` starts from a clean
 * slate every run instead of tripping over a leftover project file
 * from a previous upgrade and refusing to clone.
 */
function ensureCleanClaspState() {
  fs.rmSync(STRAY_CLASP_CONFIG, { force: true });
}

/**
 * clasp's clone-script command exits 0 even when it fails with
 * "Project file already exists." (a leftover .clasp.json from an
 * earlier run, found in the current directory before --rootDir is
 * applied). ensureCleanClaspState() prevents that from happening, but
 * this is a second, independent check: if the clone reports that exact
 * message, or the workspace it claims to have populated is empty, treat
 * it as a failure regardless of exit code, rather than silently
 * continuing to push stale/empty content over the real project.
 * @param {ReturnType<typeof clasp>} result
 * @return {string|null} a failure reason, or null if the clone looks real
 */
function claspCloneFailureReason(result) {
  const text = (result.stdout || '') + (result.stderr || '');
  if (/Project file already exists/i.test(text)) {
    return 'clasp refused to clone because it found a leftover project file - this should ' +
      'have been cleared automatically; please report this.';
  }
  let entries = [];
  try {
    entries = fs.readdirSync(WORKSPACE_DIR);
  } catch {
    return 'the workspace folder clasp was supposed to download into does not exist.';
  }
  if (entries.length === 0) {
    return 'clasp reported success but downloaded no files.';
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Finds the local file (any extension) whose base name matches one of
 * OWNED_BASENAMES, e.g. "Code.js" or "Code.gs" both match "Code".
 * @param {string} dir
 * @param {string} baseName
 * @return {string|null} full path, or null if not found
 */
function findOwnedFile(dir, baseName) {
  for (const entry of fs.readdirSync(dir)) {
    const ext = path.extname(entry);
    const base = path.basename(entry, ext);
    if (base === baseName) return path.join(dir, entry);
  }
  return null;
}

/**
 * Replaces Code/Sidebar/SetupWizard in the workspace with the versions
 * bundled in this installer's "Spreadsheet Code" folder, regardless of
 * what local extension clasp happened to clone them with.
 */
function applyLatestFiles() {
  const sourceMap = {
    Code: 'Code.gs',
    Sidebar: 'Sidebar.html',
    SetupWizard: 'SetupWizard.html'
  };
  for (const baseName of OWNED_BASENAMES) {
    const existing = findOwnedFile(WORKSPACE_DIR, baseName);
    if (existing) fs.rmSync(existing);
    const sourceFile = path.join(SOURCE_DIR, sourceMap[baseName]);
    const destFile = path.join(WORKSPACE_DIR, sourceMap[baseName]);
    fs.copyFileSync(sourceFile, destFile);
  }
}

/**
 * Builds fallback manifest content for a project that has none. Nothing
 * here is shipped in the installer zip - it's assembled fresh from this
 * machine's own timezone every time, so no packaged file ever ends up
 * carrying a real timezone (or anything else) and getting redistributed.
 * Falls back to a neutral zone if detection fails for any reason.
 * @return {string} JSON text ready to write to appsscript.json
 */
function buildDefaultManifest() {
  let timeZone = 'Etc/GMT';
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) timeZone = detected;
  } catch {
    // Keep the Etc/GMT fallback.
  }
  return JSON.stringify({
    timeZone,
    dependencies: {},
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    webapp: {
      executeAs: 'USER_DEPLOYING',
      access: 'ANYONE_ANONYMOUS'
    }
  }, null, 2) + '\n';
}

/**
 * Some container-bound script projects - typically ones that were never
 * opened in the online Apps Script editor before clasp got involved - clone
 * down with no appsscript.json at all. `clasp push` refuses to push a
 * project with no manifest ("Project contents must include a manifest file
 * named appsscript."), so this fills one in - generated fresh from this
 * machine's timezone, never from a shipped file - if and only if the clone
 * came back without one. If a manifest already exists, it's left completely
 * untouched - same as every other file clasp downloaded that isn't
 * Code/Sidebar/SetupWizard.
 * @return {boolean} true if a fallback manifest was added
 */
function ensureManifest() {
  const manifestPath = path.join(WORKSPACE_DIR, 'appsscript.json');
  if (fs.existsSync(manifestPath)) return false;
  fs.writeFileSync(manifestPath, buildDefaultManifest());
  return true;
}

/**
 * Apps Script derives a deployment's actual access level ("no login
 * required" vs "Only myself" vs the states in between) from the `webapp`
 * block of whichever version's manifest
 * it's currently pointed at - not from whatever was originally chosen in
 * the Deploy dialog. A manifest that's missing that block entirely (common
 * for projects only ever touched through the online editor, which doesn't
 * reliably write it back) makes clasp deploy a new version under Apps
 * Script's own, far more restrictive, default access - silently turning a
 * previously-working no-login webhook into one that 401s every external
 * caller, even though the deployment ID/URL and everything else look
 * unchanged. The value that matters here is specifically "ANYONE_ANONYMOUS"
 * - Apps Script's "ANYONE" (no underscore) still requires the caller to be
 * logged into some Google account, which a Cloudflare Worker never is; only
 * "ANYONE_ANONYMOUS" grants true no-login access. This fills the block in
 * if it's missing (leaving every other manifest field - timeZone,
 * oauthScopes, etc - untouched) and never overrides one that's already
 * there; if one exists but isn't "ANYONE_ANONYMOUS", it's left alone and
 * flagged back to the caller instead, since that could be intentional.
 * @return {{changed: boolean, warning: string|null}}
 */
function ensureWebAppAccess() {
  const manifestPath = path.join(WORKSPACE_DIR, 'appsscript.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.webapp) {
    manifest.webapp = { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { changed: true, warning: null };
  }
  if (manifest.webapp.access !== 'ANYONE_ANONYMOUS') {
    return {
      changed: false,
      warning: 'the manifest\'s webapp.access is "' + manifest.webapp.access + '", not ' +
        '"ANYONE_ANONYMOUS" - the Cloudflare Worker calls this webhook with no Google ' +
        'login, so anything else (including plain "ANYONE", which still requires some ' +
        'Google account) will 401 it. Left as-is in case that\'s intentional; fix under ' +
        'Project Settings > "Show appsscript.json manifest file" if it isn\'t.'
    };
  }
  return { changed: false, warning: null };
}

function looksLikeApiDisabled(text) {
  return /apps script api|has not been used|is disabled|PERMISSION_DENIED/i.test(text || '');
}

/**
 * Best-effort cross-platform "open this URL in the default browser".
 * Silently does nothing on failure - the caller always prints the URL
 * too, so worst case the person opens it by hand.
 * @param {string} url
 */
function openUrl(url) {
  try {
    if (IS_WINDOWS) {
      spawnSync('cmd', ['/c', 'start', '', url], { shell: true });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [url]);
    } else {
      spawnSync('xdg-open', [url]);
    }
  } catch {
    // non-fatal
  }
}

/**
 * Runs a clasp command, and if it fails specifically because the Apps
 * Script API toggle (https://script.google.com/home/usersettings) is
 * off for this Google account - a one-time per-account setting that
 * nothing in this script can flip on programmatically, since it's a
 * consent screen only a signed-in person can click through - opens
 * that settings page, waits for the person to turn it on and press
 * Enter, then retries the exact same command. Loops so a person who
 * hasn't waited long enough for the toggle to take effect yet can just
 * hit Enter again rather than re-running the whole script over.
 * @param {string[]} args
 * @param {object|undefined} opts
 * @param {import('readline/promises').Interface} rl
 * @return {ReturnType<typeof clasp>}
 */
async function claspWithApiRetry(args, opts, rl) {
  for (;;) {
    const result = clasp(args, opts);
    if (result.status === 0) return result;
    const text = (result.stderr || '') + (result.stdout || '');
    if (!looksLikeApiDisabled(text)) return result;

    console.log('');
    console.log('  This needs the "Google Apps Script API" toggle turned on for your Google');
    console.log('  account - a one-time setting, separate from any individual script.');
    console.log('  Opening https://script.google.com/home/usersettings ...');
    openUrl('https://script.google.com/home/usersettings');
    const answer = await ask(rl, '  Tick the toggle there, then press Enter to retry (or type "skip" to stop here)', { defaultValue: '' });
    if (/^skip$/i.test(answer.trim())) return result;
    console.log('  Retrying...');
  }
}

/**
 * Parses `clasp list-deployments` output for entries that are real Web
 * App deployments (i.e. not the @HEAD test deployment, which updates
 * itself automatically and isn't what SHEET_WEBHOOK_URL points at).
 * @param {string} text
 * @return {{id: string, version: string, description: string}[]}
 */
function parseDeployments(text) {
  const results = [];
  const lines = (text || '').split('\n');
  const re = /^-\s*(\S+)\s*@(HEAD|\d+)(?:\s*-\s*(.*))?$/;
  for (const line of lines) {
    const m = line.trim().match(re);
    if (m && m[2] !== 'HEAD') {
      results.push({ id: m[1], version: m[2], description: (m[3] || '').trim() });
    }
  }
  return results;
}

/**
 * Reads the "// Bot version: ..." stamp from the first line of a file,
 * if present, so a push can print exactly which version it just
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

async function main() {
  console.log('');
  console.log('=== Deadlock Tournament Management Bot - Spreadsheet upgrade ===');
  console.log('');
  console.log('This pushes the newer Code.gs / Sidebar.html / SetupWizard.html in this');
  console.log('folder out to a spreadsheet you already have set up - it does not touch your');
  console.log('spreadsheet\'s data, Script Properties, or create a new spreadsheet.');
  console.log('');

  const versionCheck = run('npx', ['@google/clasp', '--version']);
  if (versionCheck.status !== 0) {
    console.error('Could not run clasp. Run `npm install` in this folder first, then try again.');
    process.exit(1);
  }
  console.log(`Using clasp ${(versionCheck.stdout || '').trim()}`);

  const whoami = clasp(['show-authorized-user']);
  const loggedIn = whoami.status === 0 && /@/.test(whoami.stdout || '');
  if (!loggedIn) {
    console.log('');
    console.log('Not logged in yet. First, make sure the Apps Script API is turned on for');
    console.log('the Google account that owns your spreadsheet (one-time, if you haven\'t');
    console.log('already): https://script.google.com/home/usersettings');
    console.log('');
    console.log('Opening your browser to log into that Google account...');
    const login = clasp(['login'], { stdio: 'inherit' });
    if (login.status !== 0) {
      console.error('Login did not complete. Run `npx @google/clasp login` yourself, then re-run this script.');
      process.exit(1);
    }
  } else {
    console.log(`Already logged in as ${(whoami.stdout || '').trim()}.`);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const remembered = loadBotConfig().scriptId;
  console.log('');
  console.log('Enter your spreadsheet\'s Script ID. Find it by opening your spreadsheet ->');
  console.log('Extensions > Apps Script -> the gear-icon Project Settings on the left ->');
  console.log('copy the value under "Script ID". (Pasting the whole script.google.com URL');
  console.log('also works.)');
  if (remembered) {
    console.log(`Last used from this folder: "${remembered}" - press Enter to reuse it, or paste a different ID.`);
  }
  let scriptId;
  while (scriptId === undefined) {
    const rawScriptId = await ask(rl, 'Script ID', { defaultValue: remembered, required: true });
    try {
      scriptId = extractScriptId(rawScriptId);
    } catch (err) {
      console.log('');
      console.log(err.message);
      console.log('');
    }
  }

  console.log('');
  console.log('Downloading your current spreadsheet project...');
  rimraf(WORKSPACE_DIR);
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  ensureCleanClaspState();
  const clone = await claspWithApiRetry(['clone-script', scriptId, '--rootDir', WORKSPACE_DIR], undefined, rl);
  const cloneFailure = clone.status !== 0
    ? (clone.stderr || clone.stdout || 'clasp exited with an error.')
    : claspCloneFailureReason(clone);
  if (cloneFailure) {
    console.error(cloneFailure);
    console.error('');
    console.error('Could not download your project - double check the Script ID above and');
    console.error('that you\'re logged into the Google account that has access to it. Nothing');
    console.error('was pushed.');
    rl.close();
    process.exit(1);
  }
  console.log('  Done.');

  // Remembered so the next run of upgrade-sheet.js can suggest this ID
  // again instead of asking blind - see bot-config.js.
  saveBotConfig({ scriptId });

  console.log('');
  console.log('Backing up what\'s currently there before changing anything...');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Script IDs shouldn't contain anything odd, but this becomes part of a
  // folder name, so strip anything a mis-paste could sneak in that isn't
  // safe in a Windows/macOS path.
  const scriptIdForPath = scriptId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '');
  const backupDir = path.join(BACKUPS_DIR, `${stamp}-${scriptIdForPath}`);
  copyDir(WORKSPACE_DIR, backupDir);
  console.log(`  Saved to: ${path.relative(__dirname, backupDir)}`);

  console.log('');
  console.log('Applying the latest Code.gs, Sidebar.html and SetupWizard.html...');
  const addedManifest = ensureManifest();
  const accessCheck = ensureWebAppAccess();
  applyLatestFiles();
  if (addedManifest) {
    console.log('  This project had no appsscript.json manifest - clasp needs one to push, so');
    console.log('  one was generated using this computer\'s timezone, with the no-login');
    console.log('  "ANYONE_ANONYMOUS" Web App access your Cloudflare Worker needs to reach');
    console.log('  it. Change the timezone later under Project Settings > "Show');
    console.log('  appsscript.json manifest file" if needed.');
  } else if (accessCheck.changed) {
    console.log('  Your manifest was missing the Web App access block clasp needs when it');
    console.log('  redeploys - added no-login "ANYONE_ANONYMOUS" access back in (this is what');
    console.log('  makes your Cloudflare Worker\'s calls work without a Google login).');
    console.log('  Everything else in your manifest is untouched.');
  } else {
    console.log('  Everything else in your project (Script Properties, appsscript.json, any');
    console.log('  files you added yourself) is left exactly as it was.');
  }
  if (accessCheck.warning) {
    console.log('');
    console.log('WARNING: ' + accessCheck.warning);
  }

  console.log('');
  console.log('Pushing the update...');
  const push = await claspWithApiRetry(['push', '--force'], { cwd: WORKSPACE_DIR }, rl);
  console.log(push.stdout || '');
  if (push.status !== 0) {
    console.error(push.stderr || '');
    console.error('Push failed - see the error above. Your backup is still at the path');
    console.error(`printed above (${path.relative(__dirname, backupDir)}) if you need it. Fix the`);
    console.error('issue and run `npm run upgrade-sheet` again to retry.');
    rl.close();
    process.exit(1);
  }
  console.log('  Code updated.');

  console.log('');
  console.log('Checking for an existing Web App deployment to update in place...');
  const deployments = clasp(['list-deployments'], { cwd: WORKSPACE_DIR });
  const webAppDeployments = deployments.status === 0 ? parseDeployments(deployments.stdout) : [];

  if (webAppDeployments.length === 0) {
    console.log('  None found - either you haven\'t deployed a Web App yet (install guide');
    console.log('  step 2.3), or it\'s not needed for your setup. Nothing more to do here.');
  } else {
    let target = webAppDeployments[0];
    if (webAppDeployments.length > 1) {
      console.log('  Found more than one:');
      webAppDeployments.forEach((d, i) => {
        console.log(`    ${i + 1}. ${d.id} (version ${d.version})${d.description ? ' - ' + d.description : ''}`);
      });
      const choice = await ask(rl, `Which one is your active Web App deployment? (1-${webAppDeployments.length})`, { defaultValue: '1' });
      const idx = parseInt(choice, 10) - 1;
      target = webAppDeployments[idx] || webAppDeployments[0];
    } else {
      console.log(`  Found one: ${target.id} (currently version ${target.version}).`);
    }

    console.log('  Creating a new version and pointing that same deployment at it, so its');
    console.log('  URL - and your Worker\'s SHEET_WEBHOOK_URL - stays exactly the same...');
    const stampDesc = `Upgrade ${new Date().toISOString().slice(0, 10)}`;
    const versionResult = clasp(['create-version', stampDesc], { cwd: WORKSPACE_DIR });
    const versionMatch = (versionResult.stdout || '').match(/version\s+(\d+)/i);
    if (versionResult.status !== 0 || !versionMatch) {
      console.error(versionResult.stderr || versionResult.stdout || '');
      console.error('  Could not create a new version automatically. Your code is pushed, but');
      console.error('  you\'ll need to point your Web App deployment at it by hand: open the');
      console.error('  script editor (Deploy > Manage deployments), edit your existing');
      console.error('  deployment (pencil icon), and choose "New version".');
    } else {
      const versionNumber = versionMatch[1];
      const redeploy = clasp(['update-deployment', target.id, '--versionNumber', versionNumber, '--description', stampDesc], { cwd: WORKSPACE_DIR });
      if (redeploy.status !== 0) {
        console.error(redeploy.stderr || redeploy.stdout || '');
        console.error('  Could not update that deployment automatically. Your code is pushed and');
        console.error(`  version ${versionNumber} was created, but you'll need to point your Web App`);
        console.error('  deployment at it by hand: Deploy > Manage deployments > pencil icon on');
        console.error(`  deployment ${target.id} > choose version ${versionNumber} > Deploy.`);
      } else {
        console.log(`  Done - deployment ${target.id} now serves version ${versionNumber}.`);
      }
    }
  }

  rl.close();

  console.log('');
  console.log('=== Done ===');
  const deployedVersion = readVersionStamp(path.join(SOURCE_DIR, 'Code.gs'));
  if (deployedVersion) console.log(`Deployed version: ${deployedVersion}`);
  console.log('Reload the spreadsheet tab so any menu changes show up. Your Script');
  console.log('Properties (API key, relay secret, webhook values, column layout) and every');
  console.log('row of data are untouched.');
  console.log('');
}

main().catch(err => {
  console.error('Upgrade failed unexpectedly:', err);
  process.exit(1);
});
