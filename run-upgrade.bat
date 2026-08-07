@echo off
title Deadlock Tournament Management Bot - Upgrade
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\run-upgrade.ps1"
