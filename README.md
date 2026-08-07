# Deadlock Tournament Management Bot

A Discord bot + Google Sheets combo for running Deadlock tournaments: team registration, match thread creation, side-pick coinflips, and automatic result pull-in from [Statlocker](https://statlocker.gg/)'s Draft API - all synced back into a spreadsheet you control.

Runs as a Cloudflare Worker (Discord-facing) paired with a Google Apps Script project bound to your own copy of the tournament spreadsheet.

## Getting started

- **New install?** Start with [`Installation Guide - READ ME.docx`](./Installation%20Guide%20-%20READ%20ME.docx).

- **Already installed and want to know how to run an event?** See [`User Guide (after installing).docx`](./User%20Guide%20%28after%20installing%29.docx).

- **Upgrading an existing install?** `run-upgrade.bat` (or `npm run upgrade-all` from `bin/`) brings both the Worker and the spreadsheet up to date together - see the Installation Guide's troubleshooting section if anything doesn't match after upgrading.

## Support / feature requests

This bot is actively developed and maintained. Bug reports, feature requests, and general feedback are always welcome – just message me (**pulse\_ks**) on Discord – I’d love to help.

## Disclaimer

This project was built with heavy use of AI assistance (Claude), both for the original implementation and for the security review/fixes in this version. While the code has been human-tested, and is running on my own discord server, I don’t claim to be an expert on this bot or software development in general.

## License

MIT - see [`LICENSE`](./LICENSE).
