# Avid Swiss Army Knife

The panel is called **Avid Swiss Army Knife** (Tools > Avid Swiss Army Knife in Media Composer). Its first category is **Organize and Import**. The project and folder are still named `MediaFolderPanel`, and the helper, bundle and installer keep those names. It shows a folder tree from local disk and turns the folders you tick into bins with the media files linked into them. A small Node helper serves both the panel page and the tree data as JSON.

## Categories

A row of tabs at the top of the panel switches between categories. Left/Right arrow keys move between tabs (Home and End jump to the first and last; the tab list wraps around), and Tab moves focus into the selected tab's content. Switching only shows and hides the panels, so a run in progress in Organize and Import keeps going and its state is still there when you switch back.

Each tab is a stack of collapsible sections, and every section sits in its own light box. The caret at the left of a section header collapses or expands it. The button in the tab header flips between **Collapse all** and **Expand all** for that tab only. A section's open/closed state is stored in `sessionStorage`, so it survives tab switches and page refreshes for the rest of the panel session; a new session starts with the defaults (everything open except "What this tab cannot fix"). Review has no sections yet, so it has no collapse control.

- **Organize and Import** (shown first, selected by default): the folder tree, bin creation and linking described below.
- **Script Import**: choose a transcript text file and inject it into the transcript of the clip loaded in Media Composer. See "Script Import tab" below.
- **Export**: queue sequences and export them with ExportFile, ExportEDL or ExportOTIO. See "Export tab" below.
- **Maintenance**: health check, media databases, caches, Avid Attic, bin locks, MXF folders, menu commands, services and console commands. See "Maintenance tab" below.
- **Review**: placeholder. It shows its heading and a "Coming soon" note, nothing else.

The tab logic is in `panel/tabs.js`, the collapsible sections in `panel/sections.js`; `panel/app.js` only drives the Organize and Import panel, `panel/script.js` only the Script Import panel, `panel/export.js` only the Export panel and `panel/maintenance.js` only the Maintenance panel.

## What "Create bins and link" does

It must run inside Media Composer, because it calls the PanelSDK gRPC-web API (`mcapi` object injected by Media Composer). Opened in a normal browser, the button prints a message that `mcapi` is not available and does nothing else.

**The picked folder is never a bin; its direct subfolders are, but only those that contain media.** When you pick a folder with Browse (or the panel reopens the one picked earlier in this helper session), a direct subfolder is ticked only if it has at least one media file directly inside it (same extension filter as `LinkFile`, list in `panel/app.js`). Subfolders without direct media are unticked, marked "no media, no bin" in the tree and listed in the log. The picked folder is shown as a header line above the tree (path, media count, "picked folder"), not as a row, so it has no checkbox and cannot be selected.

**Panel behaviour.**

- Every tree row has the same columns: expand toggle (a `<button>` with `aria-expanded`), checkbox, name (long names are cut with an ellipsis; the full name is the tooltip), media count ("12 media") and a state label: `bin`, `no media, no bin`, `name clash`, `not ticked`, `not scanned` (a deeper folder not listed yet; ticking it lists it) or `unreadable, no bin`.
- **Select all** ticks the direct child folders that have media. **Select none** clears every tick, including deeper folders ticked by hand.
- A plan line next to the action button is recomputed on every change, for example "Will create 4 bins (Day 1, Day 2, Day 3, Day 4) and link 128 files." The button is disabled when nothing creatable is ticked and while a run is in progress; Browse, Select all/none and the checkboxes are locked during a run.
- A run that would link more than 20 files or create more than 10 bins first shows an in-panel confirm row (Cancel / Create). Limits: `CONFIRM_FILES` and `CONFIRM_BINS` in `panel/app.js`.
- After a run a one-line summary appears above the tree, for example "Created 2 bins, linked 2 files, skipped 1 folder with no media, 0 errors." It turns red when there are errors. **Show details** expands the complete raw log, which is the text to copy when reporting a problem.

For the ticked folders (sorted by path), one step at a time:

1. `GetListOfLinkSettings` reads the link settings names in Media Composer and logs them.
2. Each ticked folder is listed again. **A folder with no media directly inside it gets no bin** (no `CreateBin` call); it is logged as skipped and counted ("folders with no media skipped"). This also applies to any deeper folder you tick by hand.
3. **One bin per folder with media, named after that folder, created at the project root.** `CreateBin` with `folder_path` = `""` and `bin_name` = the folder's own name (not its path), for example `Day2`, not `Media/Show1/Day2`. No bin is created for the picked folder, and no parent bins or project folders are created. `OpenBin` is then called on `<name>.avb` (see "LinkFile details" below).
4. **Direct media only.** Each media file directly inside the folder is linked with `LinkFile` (`file_path`, `destination_bin` = `<name>.avb`, `link_settings_name`). Subfolders are not descended into: media inside them is not linked, and they are counted and reported in the summary ("Subfolders not linked"). Other files are counted as skipped.
   - **Media directly inside the picked folder has no bin**, so it is skipped and counted in the summary ("Media in picked folder skipped: N").
   - **Manual selection.** Untick child folders you do not want. You may also tick deeper folders (grandchildren and below); one with media becomes its own bin at project root, named after that folder. Only the picked folder itself can never be selected. Because bins are flat, a deeper folder whose name matches another selected folder collides (see 5).
5. **Name collisions.** Among folders that have media, if two have the same name (compared ignoring case), the first (by path order) gets the bin and the second is reported and skipped; folders are never merged into one bin. Folder names that cannot be a bin name (containing `/` or `\`) are also skipped and reported.

Progress and every error go to the raw log (behind Show details) and the browser console. A failed step is reported and the run continues. A `CreateBin` error is non-fatal because the bin may already exist.

Settings at the top of `panel/app.js`: `LINK_SETTINGS_NAME` (default `''` = Media Composer's default link settings, per `MCAPI_Types.proto`: "If empty or incorrect, default link setting is used"; a non-empty name must match one logged from `GetListOfLinkSettings`), `CREATE_BIN_OPEN_OPTION` (`FOLLOWBINSETTINGS`; `CreateBin` also opens the bin, so `FLOATBIN` would open one window per bin), `OPEN_BIN_BEFORE_LINK`, `BIN_FILE_EXTENSION` (`.avb`), `MEDIA_EXTENSIONS`, `CALL_TIMEOUT_MS`.

### LinkFile details and troubleshooting

What the SDK says (`MCAPI_Types.proto`, `MCAPI.proto`):

- `LinkFileRequestBody.file_path`: "path to file that is to be link". The panel sends the full absolute Windows path with backslashes, exactly as the helper reports it from disk.
- `LinkFileRequestBody.destination_bin`: "path can be relative to project folder or an absolute path". The panel sends `<name>.avb`, the bin's file name on disk (a bin at the project root).
- `LinkFileRequestBody.link_settings_name`: "Name of an already-existing link-specific setting from the MC. If empty or incorrect, default link setting is used." The panel sends `''`.
- `LinkFile` rpc: "Link a file from a file path using an link-specific setting from Media Composer. Clip is added to to the specified destination bin. Returns the mobID of the resulting clip."
- Unlike `CreateClipsFromAvidMediaFilesFolder` ("If the destination bin isn't opened, the call will fail."; `bin_path` "The bin must be opened."), **`LinkFile` has no "bin must be open" note.** The panel still calls `OpenBin` on each new bin first as a precaution (`OPEN_BIN_BEFORE_LINK`), and logs the result.
- `GetBins` documents a bin's path as "Absolute path, including name and extension". The SDK does not say whether a bare bin name for `destination_bin` / `OpenBin` needs the extension.
- Seen in Media Composer: `CreateBin` with `bin_name` `Evan` succeeds, but `OpenBin("Evan")` and `LinkFile` with `destination_bin` = `Evan` fail with gRPC code 2 and `{"ErrorMessage": "Bin not found. Bin: Evan", "ErrorType": 9}`. ErrorType 9 is `OS_FileNotFound`: both calls look for the bin as a file on disk. `OpenBin("Evan.avb")` and `LinkFile` with `destination_bin` = `Evan.avb` succeed. So the panel creates each bin by name and uses `<name>.avb` (`BIN_FILE_EXTENSION`, the file name on disk) for `OpenBin` and every `LinkFile`. It does not try the bare name.
- If `OpenBin` or `LinkFile` still says "Bin not found" for `<name>.avb`, the panel prints the full request and gRPC error (once), a single "Bin not found" message, and a diagnostic: `GetBinInfo` on `<name>.avb`, then `GetBins` (logs every `absolute_path`). If `OpenBin` fails this way, that bin's `LinkFile` calls are skipped and counted as link errors. Copy that block when reporting. The diagnostic runs only on this failure, once per run. `GetBins` is not exported by the current bundle. The panel reaches it through the global `proto.mcapi` namespace, which the generated code registers.
- The response header's `status` and `error` fields are marked deprecated in the proto, so failures normally arrive as a gRPC error (`code` is the gRPC status number, `message` the server text). The panel also treats a non-warning header error, or an empty `mob_id`, as a failed link.

Every response is checked. The first failure of each call type (`CreateBin`, `OpenBin`, `LinkFile`, `GetBinInfo`) prints the full request payload, the gRPC error (code, name, message, metadata) or the response, and whether an access token was set, in the log under the tree. Copy those lines when reporting a problem.

Not verified in Media Composer (no way to run it here). The SDK does not say how `CreateBin` treats a name that already exists.

## Script Import tab

Needs Media Composer like Organize does (the `mcapi` object). Opened in a normal browser, **Inject transcript** prints the same "The Media Composer API object (mcapi) is not available..." message as the other tabs and does nothing else. Two sections:

1. **Transcript file.** **Browse...** posts to the helper's `/api/browse-file`, which shows the Windows file dialog (see "Choose a folder (Browse...)" below for how the helper does that). The dialog offers "Transcript text files (*.txt)" and "All files (*.*)"; I left out `.srt`, `.json` and `.csv` on purpose, because the panel does not parse them and an SRT would be imported as its cue numbers and times. If you pick another extension through "All files" the panel only notes that the file is read as plain text. The chosen path is shown in the box; **Inject transcript** stays disabled until a file is chosen.
2. **Inject.** The panel asks the helper for the text of that file (`/api/read-file`, which only serves files picked with Browse... in this helper session), finds the target clip, and calls `SetTranscriptInfo`. A summary line says how many segments went into which clip, or why it did not work; **Show details** holds the log (every call, the monitors found, the first segment sent).

**File format (my assumption; nothing in the SDK says how a script file should look).** Plain text, one segment per line. A line is `HH:MM:SS:FF`, a tab, then the text (`;` before the frames is accepted for drop frame), or just the text. Blank lines are skipped; a timecode with no text is skipped and named in the log. Each line becomes one `STTEntrySegment`: `seg_id` is the line's index among the segments (0, 1, 2 ...), `seg_transcript` the text, `seg_startTc` the timecode if the line has one, and `seg_endTc` the next segment's start timecode when both lines have one (the last segment gets none). Left empty because the file does not carry them: `seg_mediaGuid`, `seg_projectGuid`, `seg_language`, speaker fields and `wordTimes`. `STTEntryBase.model_name` is "Avid Swiss Army Knife script import" and `clip_name` is the `Name` column from `GetMobInfo` (empty if that call fails). Whether Media Composer accepts a transcript without word times or media GUIDs is not settled by the docs.

**Which clip.** The SDK has no call for "the clip selected in a bin" or "the one open in the timeline". The panel uses `GetViewerMobs`, which lists the mob loaded in each monitor (Source, Record, Popup, Center) and flags the active one: it takes the active monitor's mob, or the only loaded mob if just one monitor has something, and otherwise stops and asks you to click the monitor you mean. Load the clip in the Source monitor first. `SetTranscriptInfo` documents its `mob_id` as "mobID of a clip", so a sequence loaded in the Record monitor may be refused; the error is shown as is. The SDK has no call that opens the transcript window, so open it yourself to see the result. The docs say only "Set transcript for a specified mob"; they do not say whether an existing transcript is replaced.

`SetTranscriptInfo` uses the `avid.mediacomposer.transcript` scope in `MCAPI.proto`, so `usesApi` in `avid-manifest.json` now lists it next to `general` and `command`. The signed `.avpi` needs the developer toggle or re-signing before Media Composer loads it with the extra scope. The calls need Media Composer 25.12.2 or 2026.7 (`@added` in `doc.md`). The request classes are read from `window.proto.mcapi` like the Export tab's, so the bundle was not rebuilt.

Not verified in Media Composer; the helper side (the dialog opening, cancelling, the 405/403/409 answers) was run on Windows.

## Export tab

Needs Media Composer like Organize does (the `mcapi` object). Four numbered sections, top to bottom:

1. **Choose sequences.** Type a bin name or a path relative to the project and click **List sequences**. `.avb` is added if missing (`Day 1` becomes `Day 1.avb`; a path that already ends in `.avb`, such as `Sub\Cuts.avb`, is sent as typed). The panel calls `OpenBin` (read-only) first because the proto describes `GetListOfBinItems` as working on an "already opened bin", then `GetListOfBinItems` with only the `sequences` filter. Rows have checkboxes; **Select all**, **Select none** and **Add selected to queue** work on them. A bin that does not exist is reported and nothing else is called.
2. **Queue.** A bordered drop area ("Drop sequences here") takes drags from a Media Composer bin. Each dropped item with `type` `sequence` (or no type) is queued by `id`; items with another type are skipped and named in the status line; duplicates (same mob ID, case ignored) are ignored. A drop carries no name, so the panel asks `GetMobInfo` for the `Name` column and shows the mob ID until it arrives (or for good if that fails; the failure is in the log). The queue shows a count and a Remove button per row. Drag and drop cannot be done from the keyboard; the bin list plus **Add selected to queue** is the keyboard route.
3. **Export settings.** Choosing a format loads its preset list (`(default)` first, value `''`). **Reload presets** repeats the call.
   - **ExportFile**: preset (`GetListOfExportSettings`), file name, destination folder (text field plus **Browse...**, which posts to the helper's `/api/browse`; note the helper then also remembers that folder as its last picked folder), subfolder name (`in_directory`), and 15 `ExportFileOption` checkboxes inside a collapsed "Export options" section, all unchecked. With more than one sequence in the queue the file name field is locked and each file is named after its sequence (`\ / : * ? " < > |` become `_`); with one sequence the typed name (empty = Media Composer default) is sent.
   - **ExportEDL**: preset (`GetListOfExportEDLSettings`) and tracks.
   - **ExportOTIO**: preset (`GetListOfExportOTIOSettings`) and tracks (`TrackList2`). If the settings call fails, the format shows as "ExportOTIO (unavailable)", the note names the error (gRPC UNIMPLEMENTED is called out) and the SDK's "added in 25.12.2 / 2026.7", and **Export queue** is disabled for it until **Reload presets** succeeds.
   - **Tracks** (EDL and OTIO): one box per `TrackType` (Picture, Sound, Timecode, Edgecode, Data) taking numbers such as `1,2,4` or `1-3`. All boxes empty sends an empty track list, which the proto defines as every track. Timecode and Edgecode are offered because the enum has them, but the proto says only picture, sound and data tracks are used.
   - EDL and OTIO have no destination or file name in the API; Media Composer returns the path.
4. **Run export.** The **Export queue** button runs the items that are not already done, one at a time, in order. The settings are copied when the run starts; the queue, the bin list and every setting are locked until it ends. A failure never stops the queue. Each row shows Queued, Running, Done (with the path), Failed (gRPC code and message, plus the `ErrorType` name, for example `[ErrorType 9 = OS_FileNotFound]`) or Unknown result. A summary line like `Exported 1 of 5 sequences, 2 failures, 2 unknown results.` appears above **Show details**, which holds the full log (every request as sent). A second click on **Export queue** retries the failed and unknown items and skips the done ones; **Clear queue** starts over.
   - **ExportFile** waits for `ExportFileFinished` with the `taskId` from the `ExportFile` response header (`mcapi.onEvent`). A notification that arrives before the response is kept and matched afterwards. `errorCode` other than 0 is Failed, with the `ErrorType` name. No notification within 30 minutes (`EXPORT_FINISHED_TIMEOUT_MS`), the project closing while waiting, a call that times out, or a gRPC code 14, 1 or 4 (connection lost) gives **Unknown result**: the export may or may not have happened, so check Media Composer. `mcapi.onEvent` has no documented disconnect signal, so a connection that drops while only waiting is caught by the timeout.
   - **ExportEDL** / **ExportOTIO** return the file path in the response; an empty path is a failure.

Request payloads (as `toObject()` of the generated message; the access token travels in the call metadata, not in the message):

```json
ExportFile  {"body":{"mobId":"urn:smpte:umid:S1","fileName":"MyFile","exportSettingsName":"XDCAM HD 50","destinationPath":"D:\\Out","inDirectory":"Day1","optionFlagsList":[1,11]}}
ExportEDL   {"body":{"mobId":"urn:smpte:umid:E1","edlSettingsName":"CMX3600","trackList":{"trackLabelsList":[{"type":0,"number":1},{"type":1,"number":1},{"type":1,"number":2},{"type":4,"number":3}]}}}
ExportOTIO  {"body":{"mobId":"urn:smpte:umid:E3","otioSettingsName":"OTIO Default","trackList":{"trackLabelsList":[{"type":0,"number":1},{"type":0,"number":2},{"type":1,"number":1}]}}}
```

Drag and drop, per `doc/ddmimetypes.md`: "Sequences and clips dragged from Media Composer will have the MIME type `text/x.avid.mc-api-asset-list+json`", whose data is a JSON array of objects with `id`, `head`, `in`, `out`, `systemID`, `systemType` and `type`. The panel uses `id` (the mob ID) and `type`. The SDK samples compare `type` with `"sequence"`. The drag-and-drop sample's manifest has an empty `subscribesToChannels`, and no document names a manifest field for receiving drops or for `ExportFileStarted`/`ExportFileFinished`, so `avid-manifest.json` is unchanged and `usesApi` stays `avid.mediacomposer.general` (all the export calls use that scope in `MCAPI.proto`).

The request classes for these calls are not exported by name in `panel/sdk/mcapi-bundle.js`. The panel takes them from the global `proto.mcapi` namespace the generated code registers (the same way it reads `GetBins`), so the bundle was not rebuilt. `cls()` in `panel/export.js` looks in `window.McapiSdk` first, so a later rebuild that exports them changes nothing.

Not verified in Media Composer. Not settled by the docs: the bin path form for `GetListOfBinItems` beyond "relative to project path or absolute path" (the panel reuses the `<name>.avb` form that `OpenBin` needs), whether `file_name` should carry an extension, the exact `type` strings other than `sequence`, the name of the name column in `GetMobInfo` (the panel matches `Name` ignoring case), and what a dropped `systemID` from another system means.

## Maintenance tab

Two halves, because the repairs need both:

- **PanelSDK half** (`panel/maintenance.js`, needs `mcapi`): app and host info, open project, media volumes, job queues, windows, `GetBins`/`GetBinInfo` lock state, `ScanAvidMediaFilesFolder`, and `GetListOfCommands` + `DoCommand` for menu items.
- **Helper half** (`helper/maintenance.js`, `/api/maint/*`): files, drives, services, processes and console keys. These work when the panel is opened in a browser too; only the SDK rows show "not available".

Groups, top to bottom:

1. **Health check.** Read-only. One row per check with OK / Check / Problem / Unknown: Media Composer process and version, cache size, Avid Attic size, drives under 10% free, network adapters not Up, automatic Avid services not running, Defender exclusions for the main Media Composer executables, time sync, then the SDK rows (app name/version/SDK and busy state, host, open project, media volumes under 10 GB free, job queues, windows). The full request/response log is behind **Show details**.
2. **Media databases.** Volume list from `GetMediaVolumeList` (free space in KB in the proto, shown as GB). **Rescan folder** calls `ScanAvidMediaFilesFolder` with the volume plus a folder such as `MXF\1`; the SDK requires a number in that path. **Refresh media directories** reads the command list and runs the first enabled command whose name matches "refresh … media … director"; if none matches it says so instead of guessing an id.
3. **Caches and state files.** AMA Management, AvidImageCache, AvidSourceBrowserCache, Avid FatalErrorReports, MCState files and site settings (MC State, Site Attributes, Site Settings). Sizes come from the helper. **Rebuild selected** asks the helper to rename cache folders in place with `_old-<timestamp>` and move state files to quarantine. Media Composer must be quit: the helper checks with `tasklist` and returns 409 otherwise.
4. **Avid Attic.** Per-project sizes. **Archive checked** writes a zip per project into the quarantine folder with `Compress-Archive`; **Archive and clear checked** deletes the project folder only after the zip exists and is non-empty. Nothing is deleted without a verified zip.
5. **Bins and lock files.** **List open bins and locks** streams `GetBins` and calls `GetBinInfo` on each bin file name (the `<name>.avb` form `OpenBin` needs) for open state, lock state/owner and size. **Scan for .lck files** reads the project folder through the helper and shows the owner text inside each `.lck`; **Release checked locks** moves the ticked `.lck` files to quarantine (they are never deleted). **Use open project** fills the folder from `GetOpenProjectInfo`.
6. **Media folders on disk.** Counts `.mxf` files in a folder under an `Avid MediaFiles` tree, shows the five oldest and whether `msmMMOB.mdb`/`msmFMID.pmr` are present. **Split oldest** moves the overflow over the limit (5000 by default) into the next numbered folder, keeping the original folder at the limit; nothing is deleted. **Quarantine databases** moves those two files to quarantine, with the same "quit Media Composer" guard.
7. **Commands (menu items).** `GetListOfCommands` and a search box. The default filter shows maintenance-related names; clearing it lists everything. Each row has **Run**, which sends `DoCommand` with that id. Command ids are only valid for the current launch, so the list is read fresh and never cached between sessions.
8. **System and console.** Environment tables (machine, version, data folder, quarantine, drives, adapters, services, Defender exclusions), a restart for `AvidBackgroundServicesManager` and `avid-api-gateway` (the gateway restart drops this panel's own connection), and four fixed console actions: `workgroupoverride on`, `workgroupoverride off`, `panelsdk reinit` (Ctrl+6 plus the typed command) and Alt+6 play in to out. The helper brings Media Composer to the front first; it only accepts those fixed actions, never free text.
9. **What this tab cannot fix.** Licensing, judging which media is corrupt, server-side (Media Indexer/NEXIS/Interplay) repairs, hardware and plug-in compatibility are named in the UI but not automated.

Safety rules in `helper/maintenance.js`:

- Every mutation needs `confirm: true` in the JSON body; the panel's destructive buttons arm on the first click and run on the second within 6 seconds.
- Paths must be under the Avid data folder, inside an `Avid MediaFiles` tree, or a folder that directly contains `.avp`/`.avb` files. Anything else gets 403.
- Files are moved to `%LOCALAPPDATA%\AvidSwissArmyKnife\quarantine\<timestamp>\` with a `manifest.json` note, never deleted. Cache folders are renamed in place.
- Cache rebuilds and database quarantine return 409 while `avidmediacomposer.exe` is running.

Not verified in Media Composer (nothing here could run it): the exact command names and whether `DoCommand` accepts a command id without a window id; whether `ScanAvidMediaFilesFolder` wants the absolute path or a path relative to the volume (the panel builds `<volume>\Avid MediaFiles\<folder>`, and an absolute path typed in the field is sent as is); the shape of `MediaVolume.name` on shared storage; and whether `GetBinInfo` accepts just the bin file name in every project layout. The cache folder names, state file names and Attic handling follow Avid's own knowledge base; the Defender list is a short subset of the executables Avid names in its security guide.

`usesApi` is now `avid.mediacomposer.general` plus `avid.mediacomposer.command` (`GetListOfCommands` and `DoCommand` use that scope in `MCAPI.proto`). The request classes for the new calls are read from `window.proto.mcapi` like the Export tab's, so the committed bundle was not rebuilt. The signed `.avpi` needs the developer toggle or re-signing before Media Composer will load it with the extra scope.

## Layout

```
avid-manifest.json     plugin manifest (goes into the .avpi bundle)
helper/server.js       Node helper (built-ins only, no npm install)
helper/maintenance.js  maintenance endpoints (/api/maint/*): files, drives, services, console keys
helper/config.json     optional pre-approved root folders (empty by default; Browse... adds more per session)
panel/                 index.html, app.js (Organize and Import), script.js (Script Import), export.js (Export), maintenance.js (Maintenance), tabs.js (category tabs), sections.js (collapsible sections), style.css, icon.svg
panel/sdk/             mcapi-bundle.js, the PanelSDK gRPC-web client (generated, committed)
sdk-build/             copy of PanelSDK grpc-web/*.js plus the build that makes the bundle
```

## gRPC-web bundle

The generated files in `PanelSDK/grpc-web` are CommonJS (`require('grpc-web')`, `require('google-protobuf')`), so a plain `<script>` cannot load them. `sdk-build/` bundles them with esbuild (target `chrome87` for compatibility with Chromium 87 and later, ES5-style output) into `panel/sdk/mcapi-bundle.js`, which defines `window.McapiSdk`. The bundle is committed, so the helper and panel run without npm. Rebuild only after updating the SDK files:

```
copy PanelSDK\grpc-web\*.js sdk-build\grpc-web\
cd sdk-build
npm install
npm run build
```

If you add an MCAPI call, export its request classes in `sdk-build/entry.js` and rebuild. The committed bundle exports the classes for `CreateBin`, `OpenBin`, `GetBinInfo`, `LinkFile` and `GetListOfLinkSettings`; the Export tab reads its classes from `proto.mcapi`. `entry.js` also lists `GetBins`, which will be exported after the next rebuild. Until then the panel reads `GetBins` from `window.proto.mcapi`.

## Run

The helper must be running before the panel is opened in Media Composer.

```
node helper\server.js
```

It listens on `http://127.0.0.1:47831/`. Open that URL in a browser to test the panel outside Media Composer. If the port is already in use the helper prints a message and exits with code 1. Set `MFP_PORT` to run a second copy for testing (for example `$env:MFP_PORT=47832; node helper\server.js`) without stopping the installed helper; the panel page then lives on that port, but the panel itself always talks to the helper that served it, so open `http://127.0.0.1:47832/`.

## Choose a folder (Browse...) and optional pre-approved roots

There is no default folder. On first open the panel shows no tree and asks you to click **Browse...**. It opens the Windows Explorer-style folder picker (the same dialog as File > Open, with the address bar, search and favorites) so you can navigate to any folder; the chosen folder becomes the tree root and its full path is shown next to the button. Cancelling the dialog changes nothing. If the helper cannot open the dialog, the panel shows the helper's error message.

A web page cannot open a native dialog itself, so the helper does it: `POST /api/browse` runs `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand ...` and shows the Explorer-style picker through the `IFileOpenDialog` COM interface with `FOS_PICKFOLDERS` (Windows only; `POST /api/browse-file` uses the same wrapper without that flag and with a file type filter; the small C# wrapper is compiled with `Add-Type` inside that PowerShell process, and the start folder is passed in the `MFP_START_PATH` environment variable). The dialog is titled "Choose a media folder" and starts at the folder chosen last. It opens in front of other windows when Windows allows it, but may still appear behind Media Composer. The helper waits up to 5 minutes for an answer.

The helper runs from `C:\ProgramData\MediaFolderPanel\` once installed, so a change to `helper\server.js` (like this picker) only takes effect after you re-run `installer\install.cmd`, which copies the helper there and restarts it.

**Picked roots.** A folder chosen in the dialog is trusted, because you chose it on your own machine. The helper adds it to an in-memory list of picked roots, and `/api/tree` serves it and everything below it. The list lives only while the helper process runs (restarting the helper clears it). The helper also remembers the last picked folder for that session, and the panel reopens it when it loads. After a helper restart the panel is empty again until you click Browse.

**`helper\config.json` is optional and empty by default.** It lists pre-approved roots that `/api/tree` serves without a pick. They are never opened automatically; the panel only ever shows a folder you picked. Leave it as it is unless you want a folder readable without Browse. The Browse button adds to the set for this session only; it never writes `config.json`. If the file is missing, the helper starts with no pre-approved roots.

```json
{
  "allowedRoots": []
}
```

Example with a pre-approved root: `{ "allowedRoots": ["D:\\Footage"] }`. Escape backslashes in JSON (`\\`). Restart the helper after editing.

Any path outside the pre-approved and picked roots returns 403, so with an empty list and nothing picked every `/api/tree` call returns 403. `..` segments are resolved before the check, symlinks must stay inside the root, and a sibling with the same prefix (`D:\FootageEvil` against root `D:\Footage`) does not match.

## API

- `GET /api/roots` returns `{ "allowedRoots": [...], "configuredRoots": [...], "pickedRoots": [...], "lastPicked": "..." | null }`. `allowedRoots` is the combined list (config.json plus picked roots); the other fields show where each entry came from. With the default config and nothing picked: `{ "allowedRoots": [], "configuredRoots": [], "pickedRoots": [], "lastPicked": null }`.
- `POST /api/browse` opens the folder dialog and waits for it to close. It returns `{ "path": "<folder>" }`, or `{ "path": null }` if cancelled, or a JSON error (`500`; `409` if a dialog is already open; `501` off Windows). Other methods get `405`. Requests with a non-localhost `Origin` header get `403`.
- `POST /api/browse-file` opens the file dialog (Script Import) and waits for it to close. Same answers and rules as `/api/browse`: `{ "path": "<file>" }`, `{ "path": null }` if cancelled, `500` on failure, `409` if any folder or file dialog is already open, `501` off Windows, `405` for other methods, `403` for a non-localhost `Origin`. The dialog is titled "Choose a transcript or script file", starts at the folder of the file chosen last, and has two filters: "Transcript text files (*.txt)" (selected) and "All files (*.*)". The chosen file is not added to the folders `/api/tree` serves.
- `POST /api/read-file?path=<absolute file>` returns `{ "path", "name", "size", "text" }` for a file chosen with `/api/browse-file` in this helper session, and `403` for any other path (so it is not a general file reader). It decodes UTF-8 (a BOM is dropped) or UTF-16 LE with a BOM, answers `413` above 5 MB and `415` for a file with NUL bytes. `405` for other methods, `403` for a non-localhost `Origin`.
- `GET /api/tree?path=<absolute folder>&depth=<n>` returns `{ name, path, type: "folder", children: [...] }`. Files are `{ name, path, type: "file", size }`. `depth` defaults to 3 and is capped at 10. Folders beyond the depth limit have `loaded: false` and an empty `children` array. The panel loads them on expand.

Maintenance endpoints (all POST except the first; mutations need `"confirm": true`; non-Avid paths get 403, and 409 means Media Composer is running):

- `GET /api/maint/env` — machine, user, `avidRoot` and whether it exists, `mc` (Media Composer processes), `mcVersion`, `caches` (id, path, exists, files, bytes), `stateFiles`, `attic` (per project), `drives`, `adapters`, `services`, `defender` exclusions, `time` (w32tm text) and `quarantine`.
- `POST /api/maint/cleanup` `{items: ["ama"|"imagecache"|"sourcebrowser"|"fatal"|"mcstate"|"sitesettings"]}` — rename cache folders with `_old-<timestamp>`, move state files to quarantine.
- `POST /api/maint/attic` `{action: "list"|"archive"|"archive-clear", projects: [names]}` — list sizes, or zip each project and optionally clear it after the zip is verified.
- `POST /api/maint/locks` `{projectPath}` and `POST /api/maint/release-locks` `{projectPath, files: [paths]}` — list `.lck` files with their owner text, or move them to quarantine.
- `POST /api/maint/mxf` `{action: "count"|"split"|"quarantine-databases", folder, limit}` — count MXF files and databases, move the oldest overflow into the next numbered folder, or quarantine `msmMMOB.mdb`/`msmFMID.pmr`.
- `POST /api/maint/service` `{name}` — restart `AvidBackgroundServicesManager` or `avid-api-gateway` only.
- `POST /api/maint/keys` `{action}` — one of `console-workgroup-on`, `console-workgroup-off`, `console-reinit`, `play-in-out`; brings Media Composer forward and sends fixed keys.
- `POST /api/maint/reveal` `{path}` — show an existing path in Explorer.

## Package and install the .avpi

Output: `dist\MediaFolderPanel.avpi`. It holds only `avid-manifest.json` and `panel/icon.svg`. The panel page itself is served by the helper at `http://localhost:47831/`, not from the bundle.

PanelSDK rules this relies on (`PanelSDK_26.6b7_Drop17\doc`):

- "A plugin file is a zipped bundle with .avpi extension. At a minimum, a plugin bundle contains the `avid-manifest.json` file and an icon file." (`dev-concepts.md`)
- "The 'avid-manifest.json' file must be at the root of your avpi package. This is a common problem when someone manually creates the avpi zip file from the entire directory instead of just the directory **contents**." (`troubleshooting.md`)
- "An icon file is required and must be specified in the 'avid-manifest.json' file. Make sure it is included in the plugin bundle." (`troubleshooting.md`)
- Each `allowedDomains` entry is `localhost: <port_number>`, here `localhost:47831`. (`tutorial/1-create-mc-plugin.md`)

Build (PowerShell, from the `MediaFolderPanel` folder). It stages the two files so the zip root holds the manifest directly, zips them, then renames to `.avpi`:

```powershell
$stage = Join-Path $env:TEMP 'mfp-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$stage\panel" | Out-Null
Copy-Item avid-manifest.json $stage
Copy-Item panel\icon.svg "$stage\panel\"
New-Item -ItemType Directory -Force dist | Out-Null
Remove-Item dist\MediaFolderPanel.zip, dist\MediaFolderPanel.avpi -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath dist\MediaFolderPanel.zip
Rename-Item dist\MediaFolderPanel.zip MediaFolderPanel.avpi
```

Windows PowerShell 5.1's `Compress-Archive` stores the entry as `panel\icon.svg` (backslash), but the manifest says `panel/icon.svg` and the zip format wants forward slashes. After the steps above, rewrite the entry names to forward slashes:

```powershell
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$avpi = (Resolve-Path dist\MediaFolderPanel.avpi).Path; $tmp = "$avpi.tmp"
$src = [IO.Compression.ZipFile]::OpenRead($avpi); $dst = [IO.Compression.ZipFile]::Open($tmp, 'Create')
foreach ($e in $src.Entries) {
  $ne = $dst.CreateEntry($e.FullName.Replace('\', '/'), 'Optimal')
  $i = $e.Open(); $o = $ne.Open(); $i.CopyTo($o); $o.Dispose(); $i.Dispose()
}
$dst.Dispose(); $src.Dispose(); Move-Item $tmp $avpi -Force
```

Check the contents; expect exactly `avid-manifest.json` and `panel/icon.svg`:

```powershell
$z = [IO.Compression.ZipFile]::OpenRead($avpi); $z.Entries.FullName; $z.Dispose()
```

Install folder: "Place the file `sampleecho.avpi` in `%ProgramData%\Avid\PanelSDKPlugins`." (`tutorial/2-install-plugin.md`). That is `C:\ProgramData\Avid\PanelSDKPlugins` on Windows, `/Library/Application Support/Avid/PanelSDKPlugins` on Mac. Copy `dist\MediaFolderPanel.avpi` there (this may need Administrator rights), start the helper (`node helper\server.js`), then relaunch Media Composer. "Media Composer picks up the plugin and creates UI items as defined in the manifest file." It appears under **Tools > Avid Swiss Army Knife**. To reload without restarting: kill the `avid-api-gateway` process, reinstall the `.avpi`, then in the Console (Ctrl+6) run `panelsdk reinit` (`releases.md`, `dev-concepts.md`).

Unsigned bundles need the developer toggle. "The purpose of the SDKDeveloperToggle is to allow you to develop your plugin bundle without having to sign it each time you change it." (`tutorial/panelsdk-getting-started.md`). Avid issues the encrypted toggle files per Device ID after you send them the Device ID of each development machine. Copy the files to `%ProgramData%\Avid\Support` (Mac: `/Library/Application Support/Avid/Support`) and relaunch Media Composer. Look for `***` next to "Activated" on the splash screen, or open Help > About Avid Media Composer, to confirm the toggle was found. Without it: "your bundle must be signed by you and also Avid" (`releases.md`).

Things this repo cannot do for you:

- Get the toggle files. They come from Avid (a signed PanelSDK agreement and a Media Composer Ultimate or Enterprise license are prerequisites).
- Sign the bundle. "In every deployment option, the zip compressed plugin bundle must have the .avpi extension and be signed by the developer and Avid", and a localhost-URL plugin "must go through the Avid on-boarding process" for each `.avpi` (`tutorial/samples/mchtml-dev-process.md`, `tutorial/plugin-signing-process.md`). Before submitting, replace the placeholder `companyPrefix` and `name` in the manifest.

## Installer (Windows)

`installer\` automates the manual steps above. Double-click `installer\install.cmd` (it asks for administrator rights and runs `install.ps1` with `-ExecutionPolicy Bypass`), or from an elevated Windows PowerShell 5.1 prompt run `installer\install.ps1`. Use `-DryRun` to print the planned steps without changing anything (no admin needed). Run it from the full `MediaFolderPanel` folder layout (`helper\`, `panel\`, `dist\MediaFolderPanel.avpi`).

Steps, each reporting its result:

1. Requires administrator rights; if not elevated it relaunches itself elevated and exits.
2. Checks `node --version`. If Node.js is missing or older than v14, runs `winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements` and re-checks `C:\Program Files\nodejs\node.exe`. If winget is missing it prints the https://nodejs.org link and stops.
3. Confirms `127.0.0.1:47831` is free. If another program uses it, it stops and names the port. (A helper from an earlier install of this panel is stopped and replaced.)
4. Copies `helper\` and `panel\` (including `panel\sdk\` and `icon.svg`) to `C:\ProgramData\MediaFolderPanel\`, overwriting. `sdk-build\` and `dist\` are not copied. An existing `config.json` there is kept and the installer says so (an older install still has `C:\Media` in it until you edit it). Users may edit it without admin rights.
5. Copies `dist\MediaFolderPanel.avpi` to `C:\ProgramData\Avid\PanelSDKPlugins\` (created if missing).
6. Registers the scheduled task `MediaFolderPanelHelper`: at user logon it runs `node.exe "C:\ProgramData\MediaFolderPanel\helper\server.js"` hidden (through a small `run-helper.vbs` launcher so no console window appears), restarting on failure. It starts the task now and checks `GET http://localhost:47831/api/roots`.
7. Prints the install locations and next steps: restart Media Composer, or run `panelsdk reinit` in the Console (Ctrl+6).

The installer does not sign anything. The `.avpi` still needs the Avid on-boarding/signing (or Avid-issued developer toggle files) described above.

`installer\uninstall.cmd` / `installer\uninstall.ps1` stop the helper, remove the scheduled task, and, after a confirmation prompt (`-Force` skips it, `-DryRun` only prints), delete the `.avpi` and `C:\ProgramData\MediaFolderPanel`. Node.js is left installed.

## Notes

- The panel code is plain ES5 with no modules. It is written to run on Chromium 87 and later, and the bundle targets `chrome87` for compatibility. The PanelSDK docs say Media Composer 2024.12 moved the embedded Chromium from v87 to v108 (`releases.md`, Drop 12), so older Media Composer versions embed 87 and newer ones 108.
- `usesApi` is `avid.mediacomposer.general` plus `avid.mediacomposer.command`. In `MCAPI.proto`, `CreateBin`, `LinkFile` and `GetListOfLinkSettings` use the general scope and `GetListOfCommands`/`DoCommand` use the command scope; there is no `avid.mediacomposer.bin` scope in the proto files. The extra scope means the `.avpi` needs the developer toggle or re-signing before Media Composer loads it.
- `companyPrefix` and the plugin `name` are placeholders.
