<h1 align="center">
  <img src="docs/img/hero.png" width="100%" alt="Cephalab: Splatoon 3 gear builder and seed planner, no CFW required, with 3-piece joint seed paths and live sync via SplatNet or CFW.">
</h1>

**Cephalab** plans the shortest path of rolls, drink tickets, and chunks to finish your Splatoon 3 builds. Connect a Nintendo account or a modded Switch, pick a build, and it ticks every step forward as you play.

<p align="center">
  <a href="#install"><img src="docs/img/nav-install.png" height="46" alt="Install"></a>
  <a href="#using-it"><img src="docs/img/nav-using-it.png" height="46" alt="Using it"></a>
  <a href="#good-to-know"><img src="docs/img/nav-good-to-know.png" height="46" alt="Good to know"></a>
  <a href="#credits"><img src="docs/img/nav-credits.png" height="46" alt="Credits"></a>
  <a href="https://github.com/Lii-lac/cephalab/issues/new/choose"><img src="docs/img/btn-issue.png" height="46" alt="Open an issue"></a>
</p>

<img src="docs/img/div-turf.png" width="100%" alt="">

### Install

You need Windows 10 or 11 and either a Nintendo Switch Online account or a Switch running Atmosphere with [sys-botbase](https://github.com/olliz0r/sys-botbase/releases).

1. Download `cephalab.exe` from the latest release.
2. Run it. It opens in your browser at `http://127.0.0.1:8765`.
3. Open **Settings** (gear icon, top right) and connect:
   - **Nintendo account:** Click **Sign in**, right-click *Select this person* on Nintendo's page, copy the link, and paste it back into Cephalab.
   - **CFW Switch:** Install [sys-botbase](https://github.com/olliz0r/sys-botbase/releases), reboot into Atmosphere, and enter your Switch's IP (*System Settings → Internet*).

When your player name shows in the top-right pill, it's working.

<details>
<summary>Building from source</summary>

<br>

```bash
bash core/build.sh && node tests/core/run_tests.mjs          # C++ core -> wasm + tests
.venv\Scripts\python.exe -m unittest tests.companion.test_companion
cd web && npm run build
.venv\Scripts\python.exe tools\build_exe.py                  # dist\cephalab.exe
```

- Fake Switch for testing: `python tests/fake_botbase.py --stock --roll-every 20`
- Check chunk/drink RAM offsets: `.venv\Scripts\python.exe tools\find_stock.py`
- Core contract: [core/API.md](core/API.md)

</details>

<img src="docs/img/div-slots.png" width="100%" alt="">

### Using it

<img src="docs/img/diagram-loop.png" width="100%" alt="Three steps: 1. Pick a build from sendou.ink or make your own with live ability stats. 2. Follow Path across all three gear slots with drinks, rolls, scrubs, and chunk slaps. 3. Play battles and each roll ticks forward automatically.">

Pick a popular build under **Weapons** or build your own in the editor, then open **Path**. Cephalab plans your hat, shirt, and shoes together across the same battles and updates after every roll.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/img/shot-path.png" alt="Path planner"><br>
      <strong>Path</strong><br>
      Plans all three pieces together, balancing drink tickets, scrubs, swaps, and chunk slaps.
    </td>
    <td width="50%" valign="top">
      <img src="docs/img/shot-editor.png" alt="Build editor and live stats"><br>
      <strong>Build Editor</strong><br>
      Pick weapons, gear, mains, and subs with live ability stats.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/img/shot-weapons.png" alt="Weapons and sendou.ink builds"><br>
      <strong>Weapons</strong><br>
      Browse top builds per weapon from <a href="https://sendou.ink/">sendou.ink</a> and save your own under <strong>Gear</strong>.
    </td>
    <td width="50%" valign="top">
      <img src="docs/img/shot-settings.png" alt="Settings"><br>
      <strong>Settings</strong><br>
      Switch or Nintendo sync, display zoom, and build import/export.
    </td>
  </tr>
</table>

<img src="docs/img/div-squid.png" width="100%" alt="">

### Good to know

<img src="docs/img/diagram-sync.png" width="100%" alt="Comparison of Nintendo Account (No CFW) and CFW Switch (sys-botbase). Nintendo Account signs in once, syncs owned gear after each battle, cracks seeds by rolling and scrubbing, and takes chunk/drink counts manually. CFW Switch reads gear live every few seconds, reads exact seeds, chunks, drinks, and star levels from RAM, and adds mistake warnings and Copy outfit.">

**Privacy.** Nintendo login tokens stay in Windows Credential Manager and are never saved in files. Sign-in authenticates with Nintendo through [nxapi](https://github.com/samuelthomas2774/nxapi-znca-api).

**No login.** If you'd rather not sign in, you can import an `s3s --getseed` JSON file under **Settings → Data**.

**CFW safety.** Cephalab only reads Switch memory and never writes to the game, though going online on Atmosphere always carries some risk.

<img src="docs/img/div-items.png" width="100%" alt="">

### Credits

| | |
| :--- | :--- |
| [Leanny](https://leanny.github.io/) | Splatoon 3 data, game images, seed math, and idea |
| [sendou.ink](https://sendou.ink/) | Popular community builds and idea |
| [s3s](https://github.com/frozenpandaman/s3s) | SplatNet 3 integration |
| [nxapi](https://github.com/samuelthomas2774/nxapi-znca-api) | Nintendo Switch Online sign-in |
| LegoFigure11 / Splat3GearView | Switch memory offsets |

### License

Free and open source under [GPL-3.0](LICENSE) (you can use, share, and modify it as long as changes stay open source too). Includes [s3s](https://github.com/frozenpandaman/s3s) (GPL-3.0) and [three.js](assets/three-r159-LICENSE.txt) (MIT).
