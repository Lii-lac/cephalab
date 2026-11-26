# Companion

Reads your gear and serves the app at http://127.0.0.1:8765 (local only).

```
.venv\Scripts\python.exe tools\setup_s3s.py                       once: s3s + keyring into .venv
.venv\Scripts\python.exe -m companion --switch 192.168.1.50        CFW Switch (sys-botbase): exact seeds, live
.venv\Scripts\python.exe -m companion --splatnet                   no CFW: subs from SplatNet 3 (Nintendo sign-in once)
.venv\Scripts\python.exe tools\build_exe.py                        dist\cephalab.exe (build web\ first); on macOS dist/Cephalab.app
.venv\Scripts\python.exe -m companion --selftest                  server + web app + keyring check, exit 0 when fine (CI runs it)
.venv\Scripts\python.exe -m unittest tests.companion.test_companion
```

- Snapshots per source (`botbase`, `s3s`, `file`) in `state/last_<source>.json`; every change logged to `state/log.jsonl` as the pieces that changed and what they were. Polling goes on with the page closed.
- SplatNet sign-in: the app gets a link from `GET /api/login`, you paste the "Select this account" link back (`POST /api/login`). Tokens stay in Windows Credential Manager or the macOS Keychain ("cephalab"), never in files. Sign-in uses nxapi-znca-api to authenticate with Nintendo; the app says so before you sign in.
- s3s is GPLv3 and the companion imports it, so a public .exe ships under the GPL.
- Data folder: next to the exe on Windows, `~/Library/Application Support/Cephalab` for the Mac app, the repo when run from source.
- Discord card (`discord_rpc.py`): with the Switch connected, `s3seed/presence.py` takes one small look every 3 s (place, stage, rule, room, rank, Salmon Run) at fixed addresses, no searching; a value counts once two looks agree. The match type comes from the splatoon3.ink rotation (cached in `cache/schedules.json`). Without the Switch it falls back to SplatNet's last match.
- Endpoints: see the top of `server.py`.
