'use strict';

/**
 * Tiny persisted-config helper shared by setup.js, upgrade.js and
 * upgrade-sheet.js.
 *
 * Remembers the Worker name and spreadsheet Script ID between runs so
 * upgrade.js / upgrade-sheet.js can suggest them instead of asking
 * blind every time. Stored as saved-settings.json right here in bin/,
 * alongside the code - NOT anywhere on the wider system. This file is
 * deliberately never part of the installer zip itself, so re-extracting
 * a newer version of the installer into this SAME folder (which is how
 * upgrades are meant to be installed) can't touch or overwrite it, no
 * matter whether the tool you're extracting with replaces existing
 * files or not - there's nothing in the archive with this name for it
 * to replace. It only goes away if this whole folder is deleted, or if
 * you extract an upgrade into a brand new folder instead of over this
 * one - in which case the next run just asks fresh, same as it always
 * used to.
 *
 * This is just a convenience default, never a silent decision: every
 * place that reads it still shows the value and lets the person
 * confirm or type something else.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'saved-settings.json');

function loadBotConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Merges the given fields into the persisted config and writes it back.
 * @param {object} partial
 */
function saveBotConfig(partial) {
  const current = loadBotConfig();
  const next = Object.assign({}, current, partial);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch {
    // Non-fatal - worst case, the next run just asks again instead of
    // suggesting a default.
  }
}

module.exports = { loadBotConfig, saveBotConfig, CONFIG_PATH };
