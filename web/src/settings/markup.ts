// The Settings screen's markup, from web/mockups/settings.html (the approved design); settings/*.ts and signin.ts wire it.
export const SETTINGS_HTML = `<div class="st-page">
  <h1 class="si-sr">Settings</h1>
  <!-- the board: category stickers left, one grey paper panel right, the credits as a hint along its bottom edge -->
  <div class="st-menu">
    <nav class="st-cats" role="tablist" aria-label="Settings" aria-orientation="vertical">
      <button class="st-cat on" role="tab" data-cat="connections" style="--r:-3deg"><i class="st-frame"></i>Connections</button>
      <button class="st-cat" role="tab" data-cat="display" style="--r:-2deg"><i class="st-frame"></i>Display</button>
      <button class="st-cat" role="tab" data-cat="data" style="--r:2.5deg"><i class="st-frame"></i>Data</button>
    </nav>

    <!-- the categories' pages sit in the same cell of the paper and crossfade -->
    <div class="st-paper">
      <div class="st-offline si-msg" id="offLine" inert><span class="st-off-in"><span id="offText">Companion not running</span><button class="st-btn go st-off-btn" id="startComp" type="button"><span class="st-fade">Start companion</span></button></span></div>
      <span class="st-holes" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>

      <!-- Connections: the Switch (CFW + sys-botbase), then Nintendo (SplatNet through s3s) -->
      <section class="st-pg on" role="tabpanel" data-cat="connections" aria-label="Connections">
        <div class="st-grp">
          <p class="st-desc"><b>Switch</b><span class="st-stat" id="swStat"><i></i><span class="st-fade"></span></span>
            <a class="st-link st-end" href="https://github.com/olliz0r/sys-botbase/releases" target="_blank" rel="noreferrer" data-tip="Releases on GitHub">Get sys-botbase</a></p>
          <div class="st-slab" data-api>
            <span class="st-lbl">Address</span>
            <span class="st-ctl">
              <input class="si-in st-mono st-ip" id="ip" aria-label="Switch IP address" placeholder="192.168.1.20" autocomplete="off" spellcheck="false">
              <span class="st-colon" aria-hidden="true">:</span>
              <input class="si-in st-mono st-port" id="port" aria-label="Port" value="6000" maxlength="5" inputmode="numeric" autocomplete="off">
              <button class="st-btn" id="test" type="button">Test</button>
            </span>
          </div>
          <p class="si-msg" id="swMsg" role="status"><span></span></p>
          <div class="st-slab" id="readRow" data-api>
            <span class="st-lbl">Read every</span>
            <div class="st-seg st-ctl" role="radiogroup" aria-label="Read every" data-key="read"><button data-v="5">5 s</button><button data-v="15" class="on">15 s</button><button data-v="60">60 s</button></div>
          </div>
        </div>
        <div class="st-grp">
          <p class="st-desc"><b>Nintendo</b><button class="st-info" type="button" aria-label="SplatNet vs Switch info" data-tip="Without Switch (CFW):&#10;• Seeds are cracked by rolling &amp; scrubbing&#10;• Enter chunks &amp; drinks manually&#10;• No mistake warnings in Path&#10;• No Copy outfit or locked-slot info"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 9.2v4.6"/><circle cx="10" cy="6.4" r=".9" fill="currentColor" stroke="none"/></svg></button><span class="st-stat" id="nnStat"><i></i><span class="st-fade"></span></span></p>
          <div class="st-slab" data-api>
            <span class="st-lbl">Account</span>
            <span class="st-why" id="nnWhy"></span>
            <span class="st-ctl" id="nnIn"><button class="st-btn" id="signout" type="button">Sign out</button></span>
            <span class="st-ctl" id="nnOut">
              <span class="si-via" id="viaTip" data-tip="Uses nxapi-znca-api to authenticate with Nintendo. Tokens stay in Windows Credential Manager.">via nxapi</span>
              <button class="st-btn" id="signin" type="button" aria-describedby="viaTip">Sign in</button>
            </span>
          </div>
          <div class="si-reveal" id="strip" inert><div>
            <div class="st-slab st-sub">
              <div class="si-strip" role="group" aria-label="Steps: sign in, copy the link of the red button, paste it here">
                <span class="si-pill" role="img" aria-label="Step 1: on the Nintendo page, right-click the red button that says Select this person">Select this person</span>
                <svg class="si-mouse" viewBox="0 0 14 18" width="14" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="1.75" width="10.5" height="14.5" rx="5.25"/><path d="M7 1.75v6M1.75 8h10.5"/><path d="M7 1.75a5.25 5.25 0 0 1 5.25 5.25V8H7z" fill="currentColor"/></svg>
                <svg class="si-arrow" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 7h11M8 3l4 4-4 4"/></svg>
                <span class="si-chip" role="img" aria-label="Step 2: choose Copy link">Copy link</span>
                <svg class="si-arrow" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 7h11M8 3l4 4-4 4"/></svg>
                <input class="si-in" id="paste" placeholder="Paste link" autocomplete="off" spellcheck="false" aria-label="Step 3: paste the link here">
              </div>
            </div>
          </div></div>
          <p class="si-msg" id="nnMsg" role="status"><span></span></p>
          <div class="st-slab" id="checkRow" data-api>
            <span class="st-lbl">SplatNet</span>
            <span class="st-why"></span>
            <div class="st-seg st-ctl" role="radiogroup" aria-label="SplatNet" data-key="check"><button data-v="battle" class="on">Each battle</button><button data-v="5min">5 min</button><button data-v="off">Off</button></div>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab" data-api>
            <span class="st-lbl">Discord</span>
            <div class="st-seg st-ctl" role="radiogroup" aria-label="Discord" data-key="discord"><button data-v="off">Off</button><button data-v="basic" class="on">Basic</button><button data-v="full">Full</button></div>
          </div>
        </div>
      </section>

      <!-- Display: motion, zoom, contrast -->
      <section class="st-pg" role="tabpanel" data-cat="display" aria-label="Display" inert>
        <div class="st-grp">
          <div class="st-slab">
            <span class="st-lbl">Motion</span>
            <div class="st-seg st-ctl" role="radiogroup" aria-label="Motion" data-key="motion"><button data-v="system" class="on">System</button><button data-v="reduced">Reduced</button><button data-v="full">Full</button></div>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab">
            <span class="st-lbl">Zoom</span>
            <div class="st-tick st-ctl" id="zoom" role="slider" tabindex="0" aria-label="Zoom"><button data-v="0.9" tabindex="-1">90 %</button><button data-v="1" tabindex="-1" class="on">100 %</button><button data-v="1.1" tabindex="-1">110 %</button><button data-v="1.25" tabindex="-1">125 %</button></div>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab">
            <span class="st-lbl">High contrast</span>
            <button class="st-oo st-ctl" id="contrast" type="button" role="switch" aria-checked="false" aria-label="High contrast"><span>On</span><span>Off</span></button>
          </div>
        </div>
      </section>

      <!-- Data: your builds (export / import) and the s3s gear, then the folder and image cache -->
      <section class="st-pg" role="tabpanel" data-cat="data" aria-label="Data" inert>
        <div class="st-grp">
          <div class="st-slab">
            <span class="st-lbl">Your builds</span>
            <span class="st-ctl"><button class="st-btn" id="export" type="button"><svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 1.75v7.5M4.5 6.5l3 3 3-3"/><path d="M2.25 9.5v3h10.5v-3"/></svg>Export <b class="st-n" id="nBuilds">0</b></button><button class="st-btn" id="importB" type="button"><svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 9.25v-7.5M4.5 4.5l3-3 3 3"/><path d="M2.25 9.5v3h10.5v-3"/></svg>Import</button><input type="file" id="fileB" accept=".json,application/json" hidden></span>
          </div>
          <div class="si-reveal" id="incoming" inert><div>
            <div class="st-slab st-sub">
              <span class="st-file" data-tip="Builds in the file"><svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 1.75h5l3.25 3.25v8.25h-8.25z"/><path d="M8.5 1.75V5h3.25"/></svg><b class="st-n" id="nIn">0</b></span>
              <span class="st-ctl">
                <div class="st-seg" role="radiogroup" aria-label="Add or replace" data-key="merge"><button data-v="add" class="on">Add</button><button data-v="replace">Replace</button></div>
                <button class="st-btn" id="doImport" type="button">Import</button>
                <button class="st-quietbtn" id="cancelImport" type="button">Cancel</button>
              </span>
            </div>
          </div></div>
          <p class="si-msg" id="buildsMsg"><span></span></p>
        </div>
        <div class="st-grp">
          <div class="st-slab">
            <span class="st-lbl">s3s gear</span>
            <span class="st-ctl"><button class="st-btn" id="importG" type="button"><svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 9.25v-7.5M4.5 4.5l3-3 3 3"/><path d="M2.25 9.5v3h10.5v-3"/></svg>Import</button><input type="file" id="fileG" accept=".json" hidden></span>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab" data-api>
            <span class="st-lbl">Folder</span>
            <span class="st-ctl"><span class="st-mono st-path" id="dataDir"></span><button class="st-btn st-copy" id="copyLog" type="button" data-tip="Copy cephalab.log (tokens stripped)"><span class="st-fade">Copy log</span></button><button class="st-btn" id="openDir" type="button">Open</button></span>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab" data-api>
            <span class="st-lbl">Image cache</span>
            <span class="st-ctl"><span class="st-val" id="imgSize"></span><button class="st-btn" id="clearImg" type="button"><span class="st-fade">Clear</span></button></span>
          </div>
        </div>
        <div class="st-grp">
          <div class="st-slab" id="updRow" data-api>
            <span class="st-lbl">Updates</span>
            <span class="st-ctl">
              <span class="st-val" id="updVer"></span>
              <div class="st-seg" role="radiogroup" aria-label="Check for updates" data-key="updates"><button data-v="auto" class="on">On start</button><button data-v="manual">Manual</button></div>
              <button class="st-btn" id="updBtn" type="button"><span class="st-fade">Check</span></button>
            </span>
          </div>
        </div>
        <div class="st-foot" data-api><button class="st-btn st-danger" id="reset" type="button"><span class="st-fade">Reset everything</span></button></div>
      </section>
    </div>

    <!-- Credits: a quiet hint on the board's bottom edge, like the game's Back / Equip -->
    <p class="st-credits" aria-label="Credits"><b>Credits</b>
      <a href="https://leanny.github.io/" target="_blank" rel="noreferrer" data-tip="Data, images, and idea">Leanny</a> ·
      <a href="https://sendou.ink/" target="_blank" rel="noreferrer" data-tip="Builds and idea">sendou.ink</a> ·
      <a href="https://github.com/frozenpandaman/s3s" target="_blank" rel="noreferrer" data-tip="SplatNet">s3s</a> ·
      <a href="https://github.com/samuelthomas2774/nxapi-znca-api" target="_blank" rel="noreferrer" data-tip="Sign-in tokens">nxapi</a> ·
      <a href="https://github.com/Lii-lac/cephalab/issues/new/choose" target="_blank" rel="noreferrer" data-tip="Open an issue on GitHub">Report a bug</a></p>
  </div>
</div>`;
