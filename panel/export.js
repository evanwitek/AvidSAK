(function () {
  'use strict';

  // Export tab: pick sequences (bin list or drag and drop), queue them, export them one at a time with
  // ExportFile, ExportEDL or ExportOTIO. Plain ES5; the MCAPI request classes come from window.McapiSdk or,
  // for the ones the bundle does not export by name, from the global proto.mcapi namespace.
  var panelEl = document.getElementById('panel-export');
  if (!panelEl) {
    return;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  var binPathEl = byId('ex-bin-path');
  var listBtn = byId('ex-list-btn');
  var binStatusEl = byId('ex-bin-status');
  var selAllBtn = byId('ex-sel-all-btn');
  var selNoneBtn = byId('ex-sel-none-btn');
  var addBtn = byId('ex-add-btn');
  var binListEl = byId('ex-bin-list');
  var queueCountEl = byId('ex-queue-count');
  var dropEl = byId('ex-drop');
  var dropStatusEl = byId('ex-drop-status');
  var queueEmptyEl = byId('ex-queue-empty');
  var queueEl = byId('ex-queue');
  var clearBtn = byId('ex-clear-btn');
  var formatEl = byId('ex-format');
  var reloadBtn = byId('ex-reload-btn');
  var formatNoteEl = byId('ex-format-note');
  var fileOptsEl = byId('ex-file-opts');
  var edlOptsEl = byId('ex-edl-opts');
  var otioOptsEl = byId('ex-otio-opts');
  var tracksEl = byId('ex-tracks');
  var tracksListEl = byId('ex-tracks-list');
  var fileNameEl = byId('ex-file-name');
  var fileNameHintEl = byId('ex-file-name-hint');
  var destEl = byId('ex-dest');
  var browseBtn = byId('ex-browse-btn');
  var inDirEl = byId('ex-in-dir');
  var optionsListEl = byId('ex-options-list');
  var runBtn = byId('ex-run-btn');
  var runNoteEl = byId('ex-run-note');
  var summaryEl = byId('ex-summary');
  var detailsBtn = byId('ex-details-btn');
  var logEl = byId('ex-log');

  // text/x.avid.mc-api-asset-list+json is what Media Composer puts on a drag (doc/ddmimetypes.md).
  var ASSETLIST_MIME = 'text/x.avid.mc-api-asset-list+json';
  // The SDK samples compare the dropped item's "type" with this exact string.
  var SEQUENCE_TYPE = 'sequence';
  // OpenBin and the other bin calls only find a bin as its file name on disk (see the Organize notes in README).
  var BIN_EXTENSION = '.avb';
  var CALL_TIMEOUT_MS = 60000;
  // ExportEDL and ExportOTIO return only when the file is written.
  var LIST_EXPORT_TIMEOUT_MS = 300000;
  // ExportFile returns when the export starts; ExportFileFinished says when it ends.
  var EXPORT_FINISHED_TIMEOUT_MS = 30 * 60 * 1000;

  var GRPC_CODE_NAMES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL',
    'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
  // Every CommandErrorType in MCAPI_Types.proto.
  var COMMAND_ERROR_NAMES = {
    1: 'OS_WritePermissions', 2: 'OS_DirectoryPathNotFound', 3: 'OS_FilePathLocation', 4: 'OS_DuplicateName', 5: 'OS_ReadError',
    6: 'OS_DiskSpace', 7: 'OS_IllegalCharacters', 8: 'OS_CharactersLimit', 9: 'OS_FileNotFound', 10: 'OS_TimeOut',
    11: 'OS_FileOpenFailed', 12: 'OS_DirectoryCannotBeCreated', 50: 'MC_BinNotOpened', 51: 'MC_FileExists',
    52: 'MC_DownloadFailed', 53: 'MC_MobNotFound', 54: 'MC_BinColumnNotFound', 55: 'MC_BinElementIsNotModifiable',
    56: 'MC_ProjectDataIdIsNotValid', 57: 'MC_ProjectDatakeyIsNotValid', 58: 'MC_AccessTokenIsNotValid',
    59: 'MC_EDLSettingsNotFound', 60: 'MC_ExportSettingsNotFound', 61: 'MC_ImportSettingsNotFound', 62: 'MC_MissedParameter',
    63: 'MC_ImportFileFailed', 64: 'MC_ExportFileFailed', 65: 'MC_ShutDown', 66: 'MC_InvalidArgument', 67: 'MC_AddMarkerFailed',
    68: 'MC_ParseFileFailed', 69: 'MC_BinNotFound', 70: 'MC_InternalError', 71: 'MC_ProjectNotOpen', 72: 'MC_InvalidMobID',
    73: 'MC_MediaComposerIsBusy', 74: 'MC_EDLComposeFailed', 75: 'MC_EDLDecomposeFailed', 76: 'MC_EDLNotSuportedFrameRate',
    77: 'MC_BinIsLocked', 78: 'MC_LinkSettingsNotFound', 79: 'MC_MarkerNotFound', 80: 'MC_MarkerCollision',
    81: 'MC_WindowTypeInvalid', 82: 'MC_NoActiveWindowFound', 83: 'MC_WindowNotFound', 84: 'MC_WindowHiddenOrClosed',
    85: 'MC_WindowClosed', 86: 'MC_WindowVisible', 87: 'MC_WindowHidden', 88: 'MC_BinColumnNameAlreadyExist',
    89: 'MC_WindowNotInstalledOrEnabled', 90: 'MC_OTIOSettingsNotFound', 91: 'MC_OTIOComposeFailed',
    92: 'MC_OTIODecomposeFailed', 93: 'MC_OTIONotSuportedFrameRate', 94: 'MC_TranscriptNotFound', 95: 'MC_LicenseNotFound',
    96: 'MC_ExportOTIOFailed', 1000: 'MC_UnknownError'
  };

  // ExportFileOption from MCAPI_Types.proto: value, proto name, plain-English label. All start unchecked.
  var EXPORT_OPTIONS = [
    { value: 0, proto: 'Export_StopIf_MixedAudio', label: 'Stop if the sequence has mixed audio sample rates (the file may not play in other applications)' },
    { value: 1, proto: 'Export_StopIf_OfflineMedia', label: 'Stop if the sequence has offline media' },
    { value: 2, proto: 'Export_StopIf_UnknownFX', label: 'Stop if the sequence has unloaded or unknown effects' },
    { value: 3, proto: 'Export_StopIf_LongGOP', label: 'Stop if a clip has LongGOP media (otherwise that media is left out of embedded exports)' },
    { value: 4, proto: 'Export_StopIf_NonNative', label: 'Stop if a linked clip has non-native media (otherwise that media is left out of embedded exports)' },
    { value: 5, proto: 'Export_StopIf_32kHzAudio', label: 'Stop if the sequence has 32 kHz audio' },
    { value: 6, proto: 'Export_OMF_Audio_To_WAVE', label: 'OMF: if the setting\'s audio is not supported, carry on and convert the audio to WAVE' },
    { value: 7, proto: 'Export_OMF_Audio_To_AIFFC', label: 'OMF: if the setting\'s audio is not supported, carry on and convert the audio to AIFF-C' },
    { value: 8, proto: 'Export_Conver_Audio_To_PCM', label: 'Embedded AAF: if the setting\'s audio is not supported, carry on and convert the audio to PCM' },
    { value: 9, proto: 'Export_StopIf_Color_Will_Not_Seen_In_Quick_Time_Reference', label: 'Stop if color correction would not be visible in a QuickTime reference' },
    { value: 10, proto: 'Export_StopIf_Cannot_Export_Mixed_Resolution_Sequence', label: 'Stop if an AVI export with source compression meets a mixed-resolution sequence (it would take very long)' },
    { value: 11, proto: 'Export_Keep_Partial_Render', label: 'Keep the partial render if the export stops while rendering effects' },
    { value: 12, proto: 'Export_StopIf_Some_Audio_Clips_Do_Not_Match_Current_Hardware_Or_Software_Sample_Rate', label: 'Stop if some audio clips do not match the hardware or software sample rate (they would be silent)' },
    { value: 13, proto: 'Export_StopIf_Current_Master_Fader_Format_Cannot_Accomodate_Surround_Or_7_1_Surround_Tracks', label: 'Stop if the master fader format cannot hold surround or 7.1 tracks (fader gain and effects would not be applied)' },
    { value: 14, proto: 'Export_StopIf_Some_Clips_Dont_Have_High_Resolution_Video_Available', label: 'Stop if some clips have no high-resolution video (do not fall back to proxy)' }
  ];

  // TrackType (ExportEDL) and TrackType2 (ExportOTIO) share these values.
  var TRACK_TYPES = [
    { key: 'PICTURE', value: 0, label: 'Picture tracks', note: '' },
    { key: 'SOUND', value: 1, label: 'Sound tracks', note: '' },
    { key: 'TIMECODE', value: 2, label: 'Timecode tracks', note: 'The SDK says only picture, sound and data tracks are used; this type is ignored.' },
    { key: 'EDGECODE', value: 3, label: 'Edgecode tracks', note: 'The SDK says only picture, sound and data tracks are used; this type is ignored.' },
    { key: 'DATA', value: 4, label: 'Data tracks', note: '' }
  ];

  // Per format: the settings-list call, the request classes of the export call and what to call things in messages.
  var FORMATS = {
    file: {
      name: 'ExportFile', selectEl: byId('ex-preset-file'), what: 'export settings',
      listMethod: 'getListOfExportSettings', listRequest: 'GetListOfExportSettingsRequest', listBody: 'GetListOfExportSettingsRequestBody',
      about: 'ExportFile writes a media file with an export setting from Media Composer. Destination, subfolder and options apply to this format only.'
    },
    edl: {
      name: 'ExportEDL', selectEl: byId('ex-preset-edl'), what: 'EDL settings',
      listMethod: 'getListOfExportEDLSettings', listRequest: 'GetListOfExportEDLSettingsRequest', listBody: 'GetListOfExportEDLSettingsRequestBody',
      about: 'ExportEDL creates an EDL file and returns its path. The API has no destination or file name for it; Media Composer decides.'
    },
    otio: {
      name: 'ExportOTIO', selectEl: byId('ex-preset-otio'), what: 'OTIO settings',
      listMethod: 'getListOfExportOTIOSettings', listRequest: 'GetListOfExportOTIOSettingsRequest', listBody: 'GetListOfExportOTIOSettingsRequestBody',
      about: 'ExportOTIO creates an OTIO file and returns its path. The SDK lists it as added in Media Composer 25.12.2 and 2026.7. No destination or file name in the API.'
    }
  };
  var OTIO_OPTION_OK = 'ExportOTIO (OTIO file)';
  var OTIO_OPTION_OFF = 'ExportOTIO (unavailable)';

  var binItems = [];     // { mobId, name, checked }
  var binRows = [];      // { cb, item }
  var queue = [];        // { mobId, name, type, status, detail, taskId }
  var running = false;
  var listing = false;
  var browsing = false;
  var otioUnavailable = false;
  var presetStatus = { file: '', edl: '', otio: '' };
  var presetToken = { file: 0, edl: 0, otio: 0 };
  var progressText = '';
  var logExpanded = false;
  var optionBoxes = [];  // { cb, value }
  var trackInputs = [];  // { input, type }
  var queueButtons = []; // remove buttons, in queue order
  var lookupQueue = [];
  var lookupBusy = false;
  var eventHookInstalled = false;
  var activeWait = null;
  var earlyFinished = {};
  var currentItem = null;

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function trim(s) {
    return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function val(el) {
    return (el.value === undefined || el.value === null) ? '' : String(el.value);
  }

  function safeJson(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return String(obj);
    }
  }

  function log(line) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function debug(label, obj) {
    if (window.console && console.log) {
      console.log(label, obj);
    }
  }

  function logRequest(label, request) {
    var obj = null;
    try {
      obj = request && request.toObject ? request.toObject() : null;
    } catch (e) {
      obj = null;
    }
    debug(label, obj);
    log(label + '  request: ' + safeJson(obj));
  }

  function logWarnings(warnings) {
    for (var i = 0; i < warnings.length; i++) {
      log('  warning: ' + warnings[i]);
    }
  }

  function setText(el, text, tone) {
    el.textContent = text || '';
    el.classList.toggle('is-error', tone === 'error');
    el.classList.toggle('is-ok', tone === 'ok');
  }

  // ---- errors, in the same form as the Organize tab ----

  function mcErrorBody(err) {
    var text = err && err.message ? String(err.message) : '';
    var start = text.indexOf('{');
    if (start < 0) {
      return null;
    }
    try {
      var body = JSON.parse(text.substring(start));
      return (body && typeof body === 'object') ? body : null;
    } catch (e) {
      return null;
    }
  }

  function describeError(err) {
    if (!err) {
      return 'unknown error';
    }
    var text = err.message || String(err);
    if (err.code !== undefined && err.code !== null) {
      var name = GRPC_CODE_NAMES[err.code];
      text = 'gRPC code ' + err.code + (name ? ' (' + name + ')' : '') + ': ' + text;
    }
    var body = mcErrorBody(err);
    if (body && body.ErrorType !== undefined && COMMAND_ERROR_NAMES[body.ErrorType]) {
      text += '  [ErrorType ' + body.ErrorType + ' = ' + COMMAND_ERROR_NAMES[body.ErrorType] + ']';
    }
    return text;
  }

  function errorTypeText(code) {
    var n = Number(code);
    return 'ErrorType ' + n + (COMMAND_ERROR_NAMES[n] ? ' = ' + COMMAND_ERROR_NAMES[n] : '');
  }

  // A header error or a Failed status in an otherwise successful response (both fields are deprecated in the proto).
  function headerInfo(response) {
    var info = { warnings: [], failed: null };
    try {
      var header = response && response.getHeader ? response.getHeader() : null;
      if (!header) {
        return info;
      }
      info.warnings = header.getWarningsList() || [];
      if (header.hasError && header.hasError()) {
        var e = header.getError();
        var type = e.getCommandErrorType();
        if (type !== 0 && !e.getIsWarning()) {
          info.failed = 'response header error ' + type + (COMMAND_ERROR_NAMES[type] ? ' (' + COMMAND_ERROR_NAMES[type] + ')' : '') +
            ': ' + e.getCommandErrorMessage();
        }
      }
      if (!info.failed && header.getStatus() === 4) {
        info.failed = 'response header status is Failed (4)';
      }
    } catch (ex) {
      info.warnings = ['could not read the response header: ' + ex.message];
    }
    return info;
  }

  function evaluate(err, response) {
    if (err) {
      return { ok: false, text: describeError(err), warnings: [] };
    }
    var info = headerInfo(response);
    return { ok: !info.failed, text: info.failed || '', warnings: info.warnings };
  }

  function isBinNotFound(err, result) {
    var body = mcErrorBody(err);
    if (body && body.ErrorType === 69) {
      return true;
    }
    return /bin not found|MC_BinNotFound/i.test((result && result.text) || '');
  }

  // A dropped connection or a call that never answered: the result of the request is not known.
  function isUnknownOutcome(err) {
    return !!err && (err.timedOut === true || err.code === 14 || err.code === 1 || err.code === 4);
  }

  // ---- MCAPI plumbing ----

  function mcapiUnavailable() {
    if (typeof mcapi === 'undefined' || !mcapi) {
      return 'The Media Composer API object (mcapi) is not available. Open this panel from inside Media Composer (Tools > Avid Swiss Army Knife); a normal browser cannot export.';
    }
    if (typeof mcapi.getGatewayServerAddress !== 'function' || typeof mcapi.getAccessToken !== 'function') {
      return 'The mcapi object is present but lacks getGatewayServerAddress/getAccessToken. This panel needs a PanelSDK-enabled build of Media Composer.';
    }
    if (!window.McapiSdk) {
      return 'The gRPC-web bundle (sdk/mcapi-bundle.js) did not load. Rebuild it with "npm run build" in sdk-build/.';
    }
    return null;
  }

  // A request type or enum: window.McapiSdk first, then the global proto.mcapi namespace the generated code registers.
  function cls(name) {
    var sdk = window.McapiSdk;
    if (sdk && sdk[name]) {
      return sdk[name];
    }
    var ns = window.proto && window.proto.mcapi;
    if (ns && ns[name]) {
      return ns[name];
    }
    throw new Error(name + ' is not available in sdk/mcapi-bundle.js. Add it to sdk-build/entry.js and rebuild the bundle.');
  }

  function metadata() {
    return { accessToken: mcapi.getAccessToken() };
  }

  function newClient() {
    return new window.McapiSdk.MCAPIClient(mcapi.getGatewayServerAddress(), null, null);
  }

  // Runs fn(callback) and guarantees callback is called exactly once, even if the call hangs or throws.
  function guardedCall(label, timeoutMs, fn, callback) {
    var finished = false;
    var timer = setTimeout(function () {
      var e = new Error(label + ' timed out after ' + Math.round(timeoutMs / 1000) + ' s');
      e.timedOut = true;
      finish(e, null);
    }, timeoutMs);
    function finish(err, response) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      callback(err, response);
    }
    try {
      fn(finish);
    } catch (e) {
      finish(e, null);
    }
  }

  // One unary call: makeRequest() builds the request, method is the client method name.
  function callUnary(label, timeoutMs, makeRequest, method, callback) {
    guardedCall(label, timeoutMs, function (done) {
      var request = makeRequest();
      logRequest(label, request);
      newClient()[method](request, metadata(), done);
    }, callback);
  }

  // One server-stream call: onData(response) per message, callback(err) at the end.
  function callStream(label, makeRequest, method, onData, callback) {
    guardedCall(label, CALL_TIMEOUT_MS, function (done) {
      var request = makeRequest();
      logRequest(label, request);
      var stream = newClient()[method](request, metadata());
      stream.on('data', function (response) {
        try {
          onData(response);
        } catch (e) {
          log('  could not read a ' + label + ' message: ' + e.message);
        }
      });
      stream.on('error', function (e) {
        done(e, null);
      });
      stream.on('end', function () {
        done(null, null);
      });
    }, callback);
  }

  // ---- small DOM helpers ----

  function makeEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    if (text !== undefined && text !== null && text !== '') {
      el.textContent = text;
    }
    return el;
  }

  function makeButton(text, onclick) {
    var b = makeEl('button', '', text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  }

  function addOption(select, value, text) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    select.appendChild(o);
  }

  function queueIndexOf(mobId) {
    var key = String(mobId).toLowerCase();
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].mobId.toLowerCase() === key) {
        return i;
      }
    }
    return -1;
  }

  function displayName(item) {
    return item.name || item.mobId;
  }

  function pendingItems() {
    var out = [];
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].status !== 'done') {
        out.push(queue[i]);
      }
    }
    return out;
  }

  function currentFormat() {
    var f = val(formatEl);
    return FORMATS.hasOwnProperty(f) ? f : 'file';
  }

  // ---- summary and log ----

  function setSummary(text, kind) {
    summaryEl.textContent = text || '';
    summaryEl.className = text && kind ? ('summary-' + kind) : '';
    summaryEl.hidden = !text;
  }

  function setLogExpanded(open) {
    logExpanded = !!open;
    logEl.hidden = !logExpanded;
    detailsBtn.textContent = logExpanded ? 'Hide details' : 'Show details';
    detailsBtn.setAttribute('aria-expanded', logExpanded ? 'true' : 'false');
  }

  detailsBtn.onclick = function () {
    setLogExpanded(!logExpanded);
  };

  function reportEarly(message, kind) {
    log(message);
    setSummary(message, kind);
  }

  // ---- queue ----

  var STATUS_LABELS = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', unknown: 'Unknown result' };

  function renderQueue(focusIndex) {
    queueEl.innerHTML = '';
    queueButtons = [];
    setText(queueCountEl, '(' + queue.length + ')');
    queueEmptyEl.hidden = queue.length > 0;
    for (var i = 0; i < queue.length; i++) {
      queueEl.appendChild(renderQueueItem(queue[i], i));
    }
    refresh();
    if (focusIndex !== undefined && focusIndex !== null) {
      var target = queueButtons[Math.min(focusIndex, queueButtons.length - 1)];
      if (target && target.focus) {
        target.focus();
      } else if (listBtn.focus) {
        listBtn.focus();
      }
    }
  }

  function renderQueueItem(item, index) {
    var li = makeEl('li', 'ex-q-item ex-q-' + item.status);
    var main = makeEl('span', 'ex-q-main');
    var name = makeEl('span', 'ex-q-name', displayName(item));
    name.title = displayName(item);
    main.appendChild(name);
    if (item.name) {
      main.appendChild(makeEl('span', 'ex-q-id', item.mobId));
    }
    li.appendChild(main);
    li.appendChild(makeEl('span', 'ex-q-status', STATUS_LABELS[item.status] || item.status));
    var remove = makeButton('Remove', function () {
      if (running) {
        return;
      }
      var at = queueIndexOf(item.mobId);
      if (at >= 0) {
        queue.splice(at, 1);
        setText(dropStatusEl, 'Removed ' + displayName(item) + ' from the queue.');
        renderBinList();
        renderQueue(at);
      }
    });
    remove.className = 'ex-q-remove';
    remove.setAttribute('aria-label', 'Remove ' + displayName(item) + ' from the queue');
    remove.disabled = running;
    queueButtons.push(remove);
    li.appendChild(remove);
    if (item.detail) {
      li.appendChild(makeEl('span', 'ex-q-detail', item.detail));
    }
    return li;
  }

  // entries: { mobId, name, type }. Returns { added, duplicates }.
  function addToQueue(entries) {
    var added = 0;
    var duplicates = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (queueIndexOf(e.mobId) >= 0) {
        duplicates++;
        continue;
      }
      var item = { mobId: String(e.mobId), name: e.name || '', type: e.type || SEQUENCE_TYPE, status: 'queued', detail: '', taskId: '' };
      queue.push(item);
      added++;
      if (!item.name) {
        lookupQueue.push(item);
      }
    }
    renderBinList();
    renderQueue();
    pumpLookups();
    return { added: added, duplicates: duplicates };
  }

  // A drop carries only an id, not a name. GetMobInfo gives the Name column; until then the mob ID is shown.
  function pumpLookups() {
    if (lookupBusy || lookupQueue.length === 0) {
      return;
    }
    var item = lookupQueue.shift();
    if (queue.indexOf(item) < 0) {
      pumpLookups();
      return;
    }
    if (mcapiUnavailable()) {
      lookupQueue = [];
      return;
    }
    lookupBusy = true;
    var found = '';
    callStream('GetMobInfo', function () {
      var body = new (cls('GetMobInfoRequestBody'))();
      body.setMobId(item.mobId);
      body.setOnlyVisibleColumns(false);
      body.setIncludesEmptyColumns(false);
      var request = new (cls('GetMobInfoRequest'))();
      request.setBody(body);
      return request;
    }, 'getMobInfo', function (response) {
      var b = response.getBody();
      if (!found && String(b.getColumnName()).toLowerCase() === 'name') {
        found = b.getColumnValue();
      }
    }, function (err) {
      lookupBusy = false;
      if (err) {
        log('GetMobInfo ' + item.mobId + ' failed: ' + describeError(err) + '  (the mob ID is shown instead of a name)');
      } else if (!found) {
        log('GetMobInfo ' + item.mobId + ' returned no Name column  (the mob ID is shown instead of a name)');
      } else {
        item.name = found;
      }
      renderQueue();
      pumpLookups();
    });
  }

  clearBtn.onclick = function () {
    if (running) {
      return;
    }
    queue = [];
    lookupQueue = [];
    setText(dropStatusEl, 'Queue cleared.');
    setSummary('', '');
    renderBinList();
    renderQueue();
  };

  // ---- bin list ----

  function normalizeBinPath(p) {
    var trimmed = trim(p);
    if (!trimmed) {
      return '';
    }
    return /\.avb$/i.test(trimmed) ? trimmed : trimmed + BIN_EXTENSION;
  }

  function renderBinList() {
    binListEl.innerHTML = '';
    binRows = [];
    for (var i = 0; i < binItems.length; i++) {
      binListEl.appendChild(renderBinRow(binItems[i]));
    }
    refresh();
  }

  function renderBinRow(item) {
    var li = makeEl('li', 'ex-bin-row');
    var label = makeEl('label', 'ex-bin-label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    var inQueue = queueIndexOf(item.mobId) >= 0;
    cb.checked = !!item.checked && !inQueue;
    cb.onchange = function () {
      item.checked = !!cb.checked;
      refresh();
    };
    label.appendChild(cb);
    var name = makeEl('span', 'ex-bin-name', item.name || '(unnamed)');
    name.title = item.name;
    label.appendChild(name);
    label.appendChild(makeEl('span', 'ex-q-id', item.mobId));
    if (inQueue) {
      label.appendChild(makeEl('span', 'ex-tag', 'in queue'));
    }
    li.appendChild(label);
    binRows.push({ cb: cb, item: item });
    return li;
  }

  function checkedBinItems() {
    var out = [];
    for (var i = 0; i < binItems.length; i++) {
      if (binItems[i].checked && queueIndexOf(binItems[i].mobId) < 0) {
        out.push(binItems[i]);
      }
    }
    return out;
  }

  selAllBtn.onclick = function () {
    if (running) {
      return;
    }
    for (var i = 0; i < binItems.length; i++) {
      binItems[i].checked = queueIndexOf(binItems[i].mobId) < 0;
    }
    renderBinList();
  };

  selNoneBtn.onclick = function () {
    if (running) {
      return;
    }
    for (var i = 0; i < binItems.length; i++) {
      binItems[i].checked = false;
    }
    renderBinList();
  };

  addBtn.onclick = function () {
    if (running) {
      return;
    }
    var chosen = checkedBinItems();
    if (chosen.length === 0) {
      setText(dropStatusEl, 'Tick sequences in the list first.');
      return;
    }
    var entries = [];
    for (var i = 0; i < chosen.length; i++) {
      entries.push({ mobId: chosen[i].mobId, name: chosen[i].name, type: SEQUENCE_TYPE });
      chosen[i].checked = false;
    }
    var result = addToQueue(entries);
    setText(dropStatusEl, 'Added ' + plural(result.added, 'sequence', 'sequences') + ' to the queue.' +
      (result.duplicates > 0 ? ' ' + plural(result.duplicates, 'was', 'were') + ' already in it.' : ''));
  };

  // OpenBin (read-only) first, because GetListOfBinItems works on an already opened bin; then the sequences in it.
  function onListClick() {
    if (running || listing) {
      return;
    }
    var raw = trim(val(binPathEl));
    if (!raw) {
      setText(binStatusEl, 'Type a bin name or path first.');
      return;
    }
    var unavailable = mcapiUnavailable();
    if (unavailable) {
      setText(binStatusEl, unavailable);
      return;
    }
    var binRef = normalizeBinPath(raw);
    listing = true;
    binItems = [];
    renderBinList();
    setText(binStatusEl, 'Opening ' + binRef + ' ...');

    callUnary('OpenBin', CALL_TIMEOUT_MS, function () {
      var body = new (cls('OpenBinRequestBody'))();
      body.setBinPath(binRef);
      body.setReadOnly(true);
      var request = new (cls('OpenBinRequest'))();
      request.setBody(body);
      return request;
    }, 'openBin', function (openErr, openResponse) {
      var opened = evaluate(openErr, openResponse);
      var openNote = '';
      if (!opened.ok) {
        log('OpenBin ' + binRef + ' failed: ' + opened.text);
        if (isBinNotFound(openErr, opened)) {
          listing = false;
          setText(binStatusEl, 'Bin not found: ' + binRef + '. ' + opened.text, 'error');
          refresh();
          return;
        }
        openNote = ' OpenBin also failed (' + opened.text + '), so the bin may not be open.';
      }
      setText(binStatusEl, 'Listing sequences in ' + binRef + ' ...');
      var found = [];
      callStream('GetListOfBinItems', function () {
        var body = new (cls('GetListOfBinItemsRequestBody'))();
        body.setBinPath(binRef);
        body.setBinFlagsList([cls('GetListOfBinItemsRequestBody').BinItemFlags.SEQUENCES]);
        body.setOnlyVisibleFlag(false);
        body.setOnlySelectedFlag(false);
        var request = new (cls('GetListOfBinItemsRequest'))();
        request.setBody(body);
        return request;
      }, 'getListOfBinItems', function (response) {
        var b = response.getBody();
        found.push({ mobId: b.getMobId(), name: b.getMobName(), checked: false });
      }, function (err) {
        listing = false;
        if (err) {
          setText(binStatusEl, 'Could not list the sequences in ' + binRef + ': ' + describeError(err) + openNote, 'error');
        } else {
          binItems = found;
          setText(binStatusEl, found.length === 0
            ? 'No sequences in ' + binRef + '.' + openNote
            : plural(found.length, 'sequence', 'sequences') + ' in ' + binRef + '.' + openNote);
        }
        renderBinList();
      });
    });
  }

  listBtn.onclick = onListClick;

  // ---- drag and drop from Media Composer ----

  function readDrop(dataTransfer) {
    var raw = '';
    try {
      raw = dataTransfer ? dataTransfer.getData(ASSETLIST_MIME) : '';
    } catch (e) {
      raw = '';
    }
    return raw;
  }

  function onDrop(ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
    }
    dropEl.className = 'ex-drop';
    if (running) {
      setText(dropStatusEl, 'The queue is locked while an export is running.');
      return;
    }
    var raw = readDrop(ev && ev.dataTransfer);
    if (!raw) {
      setText(dropStatusEl, 'Nothing was added: the drop has no Media Composer assets (MIME type ' + ASSETLIST_MIME + ').');
      return;
    }
    var list;
    try {
      list = JSON.parse(raw);
    } catch (e) {
      setText(dropStatusEl, 'Nothing was added: the dropped data is not valid JSON (' + e.message + ').', 'error');
      return;
    }
    if (!(list instanceof Array)) {
      list = [list];
    }
    var entries = [];
    var skipped = [];
    var seen = {};
    var repeats = 0;
    for (var i = 0; i < list.length; i++) {
      var asset = list[i] || {};
      var type = asset.type === undefined || asset.type === null ? '' : String(asset.type);
      var id = asset.id === undefined || asset.id === null ? '' : String(asset.id);
      if (!id) {
        skipped.push('an item without an id');
      } else if (type && type.toLowerCase() !== SEQUENCE_TYPE) {
        skipped.push(id + ' (type ' + type + ')');
      } else if (seen.hasOwnProperty(id.toLowerCase())) {
        repeats++;
      } else {
        seen[id.toLowerCase()] = true;
        entries.push({ mobId: id, name: '', type: SEQUENCE_TYPE });
      }
    }
    var result = addToQueue(entries);
    var parts = ['Added ' + plural(result.added, 'sequence', 'sequences') + ' to the queue.'];
    var dup = result.duplicates + repeats;
    if (dup > 0) {
      parts.push(plural(dup, 'was', 'were') + ' already in it.');
    }
    if (skipped.length > 0) {
      parts.push('Skipped ' + plural(skipped.length, 'item', 'items') + ' that ' + (skipped.length === 1 ? 'is' : 'are') + ' not ' +
        (skipped.length === 1 ? 'a sequence' : 'sequences') + ': ' + skipped.join(', ') + '.');
    }
    setText(dropStatusEl, parts.join(' '));
  }

  dropEl.ondragenter = function (ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
    }
    if (!running) {
      dropEl.className = 'ex-drop ex-drop-over';
    }
  };
  dropEl.ondragover = function (ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
    }
  };
  dropEl.ondragleave = function () {
    dropEl.className = 'ex-drop';
  };
  dropEl.ondrop = onDrop;

  // ---- settings: presets, options, tracks ----

  function fillPresets(kind, names) {
    var select = FORMATS[kind].selectEl;
    var previous = val(select);
    select.innerHTML = '';
    addOption(select, '', '(default)');
    var seen = {};
    var kept = false;
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (!n || seen.hasOwnProperty(n)) {
        continue;
      }
      seen[n] = true;
      addOption(select, n, n);
      if (n === previous) {
        kept = true;
      }
    }
    select.value = kept ? previous : '';
  }

  function setOtioAvailable(ok) {
    otioUnavailable = !ok;
    var kids = formatEl.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute('value') === 'otio') {
        kids[i].textContent = ok ? OTIO_OPTION_OK : OTIO_OPTION_OFF;
      }
    }
  }

  function updateFormatNote() {
    var kind = currentFormat();
    setText(formatNoteEl, presetStatus[kind] || FORMATS[kind].about);
  }

  function loadPresets(kind) {
    var info = FORMATS[kind];
    presetToken[kind]++;
    var token = presetToken[kind];
    var unavailable = mcapiUnavailable();
    if (unavailable) {
      presetStatus[kind] = unavailable;
      updateFormatNote();
      return;
    }
    presetStatus[kind] = 'Loading ' + info.what + ' ...';
    updateFormatNote();
    var names = [];
    callUnary(info.name + ' settings list', CALL_TIMEOUT_MS, function () {
      var request = new (cls(info.listRequest))();
      request.setBody(new (cls(info.listBody))());
      return request;
    }, info.listMethod, function (err, response) {
      if (token !== presetToken[kind]) {
        return;
      }
      var result = evaluate(err, response);
      if (!result.ok) {
        log(info.listMethod + ' failed: ' + result.text);
        if (kind === 'otio') {
          setOtioAvailable(false);
          presetStatus[kind] = 'ExportOTIO is not available: ' + (err && err.code === 12
            ? 'this Media Composer does not implement it (gRPC UNIMPLEMENTED). '
            : 'the call to list its settings failed (' + result.text + '). ') +
            'The SDK says ExportOTIO was added in Media Composer 25.12.2 and 2026.7, so an older version cannot export OTIO.';
        } else {
          presetStatus[kind] = 'Could not load the ' + info.what + ' (' + result.text + '). "(default)" still works. Use Reload presets to try again.';
        }
      } else {
        try {
          names = response.getBody().getSettingNamesList() || [];
        } catch (e) {
          names = [];
        }
        if (kind === 'otio') {
          setOtioAvailable(true);
        }
        fillPresets(kind, names);
        presetStatus[kind] = '';
      }
      updateFormatNote();
      refresh();
    });
  }

  function applyFormat() {
    var kind = currentFormat();
    fileOptsEl.hidden = kind !== 'file';
    edlOptsEl.hidden = kind !== 'edl';
    otioOptsEl.hidden = kind !== 'otio';
    tracksEl.hidden = kind === 'file';
    updateFormatNote();
    refresh();
  }

  formatEl.onchange = function () {
    applyFormat();
    loadPresets(currentFormat());
  };

  reloadBtn.onclick = function () {
    if (running) {
      return;
    }
    loadPresets(currentFormat());
  };

  function buildOptionBoxes() {
    optionsListEl.innerHTML = '';
    optionBoxes = [];
    for (var i = 0; i < EXPORT_OPTIONS.length; i++) {
      var opt = EXPORT_OPTIONS[i];
      var label = makeEl('label', 'ex-check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = false;
      label.appendChild(cb);
      label.appendChild(makeEl('span', '', opt.label));
      label.title = opt.proto;
      optionsListEl.appendChild(label);
      optionBoxes.push({ cb: cb, value: opt.value });
    }
  }

  function buildTrackInputs() {
    tracksListEl.innerHTML = '';
    trackInputs = [];
    for (var i = 0; i < TRACK_TYPES.length; i++) {
      var type = TRACK_TYPES[i];
      var field = makeEl('div', 'ex-field');
      var label = makeEl('label', '', type.label);
      var id = 'ex-tr-' + type.key.toLowerCase();
      label.setAttribute('for', id);
      var input = makeEl('input', 'ex-input');
      input.id = id;
      input.type = 'text';
      input.setAttribute('placeholder', 'e.g. 1,2 or 1-3');
      input.setAttribute('autocomplete', 'off');
      field.appendChild(label);
      field.appendChild(input);
      if (type.note) {
        var hintId = id + '-hint';
        var hint = makeEl('p', 'ex-hint', type.note);
        hint.id = hintId;
        input.setAttribute('aria-describedby', hintId);
        field.appendChild(hint);
      }
      tracksListEl.appendChild(field);
      trackInputs.push({ input: input, type: type });
    }
  }

  // "1,2,4" or "1-3" -> sorted unique numbers. Track numbers start at 1.
  function parseTrackNumbers(text) {
    var tokens = trim(text).split(/[\s,;]+/);
    var seen = {};
    var numbers = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) {
        continue;
      }
      var m = /^(\d+)(?:-(\d+))?$/.exec(t);
      if (!m) {
        return { error: '"' + t + '" is not a track number. Use numbers like 1,2,4 or a range like 1-3.' };
      }
      var from = parseInt(m[1], 10);
      var to = m[2] === undefined ? from : parseInt(m[2], 10);
      if (from < 1 || to < from || to - from > 255) {
        return { error: '"' + t + '" is not a usable track range. Track numbers start at 1, and a range goes up.' };
      }
      for (var n = from; n <= to; n++) {
        if (!seen.hasOwnProperty(n)) {
          seen[n] = true;
          numbers.push(n);
        }
      }
    }
    numbers.sort(function (a, b) {
      return a - b;
    });
    return { numbers: numbers };
  }

  // Returns { tracks: [{ type, number }] } (empty = all tracks) or { error }.
  function readTracks() {
    var tracks = [];
    for (var i = 0; i < trackInputs.length; i++) {
      var parsed = parseTrackNumbers(val(trackInputs[i].input));
      if (parsed.error) {
        return { error: trackInputs[i].type.label + ': ' + parsed.error };
      }
      for (var n = 0; n < parsed.numbers.length; n++) {
        tracks.push({ key: trackInputs[i].type.key, value: trackInputs[i].type.value, number: parsed.numbers[n] });
      }
    }
    return { tracks: tracks };
  }

  // The settings as they are when a run starts; the run uses this copy only.
  function readConfig() {
    var format = currentFormat();
    var cfg = { format: format, preset: val(FORMATS[format].selectEl) };
    if (format === 'file') {
      cfg.fileName = trim(val(fileNameEl));
      cfg.destination = trim(val(destEl));
      cfg.inDirectory = trim(val(inDirEl));
      cfg.options = [];
      for (var i = 0; i < optionBoxes.length; i++) {
        if (optionBoxes[i].cb.checked) {
          cfg.options.push(optionBoxes[i].value);
        }
      }
    } else {
      var parsed = readTracks();
      if (parsed.error) {
        return { error: parsed.error };
      }
      cfg.tracks = parsed.tracks;
    }
    return cfg;
  }

  // ---- requests ----

  // More than one sequence in the queue: each file is named after its sequence, so none overwrites another.
  function fileNameFor(cfg, item, queueSize) {
    if (queueSize > 1) {
      return trim(String(item.name || '').replace(/[\\\/:*?"<>|]/g, '_'));
    }
    return cfg.fileName;
  }

  function buildExportFileRequest(item, cfg, queueSize) {
    var body = new (cls('ExportFileRequestBody'))();
    body.setMobId(item.mobId);
    body.setFileName(fileNameFor(cfg, item, queueSize));
    body.setExportSettingsName(cfg.preset);
    body.setDestinationPath(cfg.destination);
    body.setInDirectory(cfg.inDirectory);
    body.setOptionFlagsList(cfg.options);
    var request = new (cls('ExportFileRequest'))();
    request.setBody(body);
    return request;
  }

  function buildTrackList(listName, labelName, enumName, enumPrefix, tracks) {
    var list = new (cls(listName))();
    var enumObj = cls(enumName);
    for (var i = 0; i < tracks.length; i++) {
      var label = new (cls(labelName))();
      var enumValue = enumObj[enumPrefix + tracks[i].key];
      label.setType(enumValue === undefined ? tracks[i].value : enumValue);
      label.setNumber(tracks[i].number);
      list.addTrackLabels(label);
    }
    return list;
  }

  function buildExportEDLRequest(item, cfg) {
    var body = new (cls('ExportEDLRequestBody'))();
    body.setMobId(item.mobId);
    body.setEdlSettingsName(cfg.preset);
    body.setTrackList(buildTrackList('TrackList', 'TrackLabel', 'TrackType', 'TRACKTYPE_', cfg.tracks));
    var request = new (cls('ExportEDLRequest'))();
    request.setBody(body);
    return request;
  }

  function buildExportOTIORequest(item, cfg) {
    var body = new (cls('ExportOTIORequestBody'))();
    body.setMobId(item.mobId);
    body.setOtioSettingsName(cfg.preset);
    body.setTrackList(buildTrackList('TrackList2', 'TrackLabel2', 'TrackType2', 'TRACKTYPE2_', cfg.tracks));
    var request = new (cls('ExportOTIORequest'))();
    request.setBody(body);
    return request;
  }

  // ---- notifications: ExportFileStarted / ExportFileFinished ----

  function parseEventData(eventData) {
    if (eventData && typeof eventData === 'object') {
      return eventData;
    }
    try {
      return JSON.parse(eventData);
    } catch (e) {
      return null;
    }
  }

  function outcomeFromFinished(data) {
    var code = Number(data.errorCode || 0);
    if (code === 0) {
      return { status: 'done', detail: data.exportPath ? String(data.exportPath) : '(Media Composer reported no path)' };
    }
    return { status: 'failed', detail: 'ExportFileFinished reported ' + errorTypeText(code) + ': ' + (data.errorString || '(no message)') };
  }

  function onMcEvent(eventName, eventData) {
    if (!running) {
      return;
    }
    var data = parseEventData(eventData);
    if (eventName === 'ExportFileFinished' && data) {
      var id = String(data.taskId);
      log('ExportFileFinished  ' + safeJson(data));
      if (activeWait && activeWait.taskId === id) {
        activeWait.settle(outcomeFromFinished(data));
      } else {
        earlyFinished[id] = data;
      }
    } else if (eventName === 'ExportFileStarted' && data) {
      log('ExportFileStarted  ' + safeJson(data));
      if (currentItem && currentItem.taskId === String(data.taskId)) {
        currentItem.detail = 'Started in Media Composer, waiting for ExportFileFinished (task ' + currentItem.taskId + ')';
        renderQueue();
      }
    } else if (eventName === 'ProjectClosed' && activeWait) {
      activeWait.settle({ status: 'unknown', detail: 'The project was closed while waiting for ExportFileFinished. The export may or may not have finished.' });
    }
  }

  // Returns an error text if the notification hook cannot be installed.
  function ensureEventHook() {
    if (eventHookInstalled) {
      return null;
    }
    if (!mcapi.onEvent || typeof mcapi.onEvent.connect !== 'function') {
      return 'mcapi.onEvent is not available, so ExportFileFinished cannot be received.';
    }
    mcapi.onEvent.connect(onMcEvent);
    eventHookInstalled = true;
    return null;
  }

  // The Finished notification can arrive before the ExportFile call has returned its task id; earlyFinished keeps it.
  function waitForFinished(taskId, callback) {
    var settled = false;
    var timer = null;
    function settle(outcome) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (activeWait && activeWait.taskId === taskId) {
        activeWait = null;
      }
      delete earlyFinished[taskId];
      callback(outcome);
    }
    if (earlyFinished.hasOwnProperty(taskId)) {
      settle(outcomeFromFinished(earlyFinished[taskId]));
      return;
    }
    timer = setTimeout(function () {
      settle({
        status: 'unknown',
        detail: 'No ExportFileFinished notification within ' + Math.round(EXPORT_FINISHED_TIMEOUT_MS / 60000) +
          ' minutes. The export may still be running in Media Composer; check it there.'
      });
    }, EXPORT_FINISHED_TIMEOUT_MS);
    activeWait = { taskId: taskId, settle: settle };
  }

  // ---- running the queue ----

  function callFailure(err, label, what) {
    if (isUnknownOutcome(err)) {
      return {
        status: 'unknown',
        detail: 'The connection to Media Composer was lost or the ' + label + ' call timed out (' + describeError(err) + '). ' +
          what + ' Check Media Composer.'
      };
    }
    return { status: 'failed', detail: describeError(err) };
  }

  function runFileItem(cfg, item, queueSize, finished) {
    callUnary('ExportFile', CALL_TIMEOUT_MS, function () {
      return buildExportFileRequest(item, cfg, queueSize);
    }, 'exportFile', function (err, response) {
      if (err) {
        log('  ExportFile failed: ' + describeError(err));
        finished(callFailure(err, 'ExportFile', 'The export may or may not have started.'));
        return;
      }
      var result = evaluate(null, response);
      logWarnings(result.warnings);
      if (!result.ok) {
        log('  ExportFile failed: ' + result.text);
        finished({ status: 'failed', detail: result.text });
        return;
      }
      var taskId = '';
      var legacyPath = '';
      try {
        taskId = response.getHeader().getTaskId();
      } catch (e) {
        taskId = '';
      }
      try {
        legacyPath = response.getBody().getPath();
      } catch (e2) {
        legacyPath = '';
      }
      log('  ExportFile accepted, task id: ' + (taskId || '(none)'));
      if (!taskId) {
        finished(legacyPath
          ? { status: 'done', detail: legacyPath }
          : { status: 'unknown', detail: 'ExportFile returned no task id, so ExportFileFinished cannot be matched. The export may still be running in Media Composer.' });
        return;
      }
      item.taskId = String(taskId);
      item.detail = 'Started in Media Composer, waiting for ExportFileFinished (task ' + item.taskId + ')';
      renderQueue();
      waitForFinished(item.taskId, finished);
    });
  }

  function runListFileItem(cfg, item, finished) {
    var isOtio = cfg.format === 'otio';
    var label = isOtio ? 'ExportOTIO' : 'ExportEDL';
    callUnary(label, LIST_EXPORT_TIMEOUT_MS, function () {
      return isOtio ? buildExportOTIORequest(item, cfg) : buildExportEDLRequest(item, cfg);
    }, isOtio ? 'exportOTIO' : 'exportEDL', function (err, response) {
      if (err) {
        log('  ' + label + ' failed: ' + describeError(err));
        finished(callFailure(err, label, 'The file may or may not have been written.'));
        return;
      }
      var result = evaluate(null, response);
      logWarnings(result.warnings);
      if (!result.ok) {
        log('  ' + label + ' failed: ' + result.text);
        finished({ status: 'failed', detail: result.text });
        return;
      }
      var path = '';
      try {
        path = response.getBody().getPath();
      } catch (e) {
        path = '';
      }
      if (!path) {
        finished({ status: 'failed', detail: label + ' returned no file path.' });
        return;
      }
      log('  ' + label + ' wrote ' + path);
      finished({ status: 'done', detail: path });
    });
  }

  function summarize(stats, total) {
    var text = 'Exported ' + stats.done + ' of ' + plural(total, 'sequence', 'sequences') + ', ' +
      plural(stats.failed, 'failure', 'failures');
    if (stats.unknown > 0) {
      text += ', ' + plural(stats.unknown, 'unknown result', 'unknown results');
    }
    text += '.';
    var bad = stats.failed + stats.unknown;
    if (bad > 0) {
      text += ' Use Show details for the log.';
    }
    return { text: text, kind: bad > 0 ? 'error' : 'ok' };
  }

  function startRun() {
    if (running) {
      return;
    }
    logEl.textContent = '';
    setSummary('', '');
    setLogExpanded(false);
    detailsBtn.hidden = true;
    if (queue.length === 0) {
      reportEarly('The queue is empty. Drop sequences into it or add them from a bin first.', 'info');
      return;
    }
    var pending = pendingItems();
    if (pending.length === 0) {
      reportEarly('Everything in the queue is already exported. Clear the queue to start over.', 'info');
      return;
    }
    var cfg = readConfig();
    if (cfg.error) {
      reportEarly(cfg.error, 'error');
      return;
    }
    if (cfg.format === 'otio' && otioUnavailable) {
      reportEarly('ExportOTIO is unavailable on this Media Composer. Choose another format.', 'error');
      return;
    }
    var unavailable = mcapiUnavailable();
    if (unavailable) {
      reportEarly(unavailable, 'error');
      return;
    }
    if (cfg.format === 'file') {
      var hookError = ensureEventHook();
      if (hookError) {
        reportEarly(hookError, 'error');
        return;
      }
    }

    running = true;
    earlyFinished = {};
    activeWait = null;
    detailsBtn.hidden = false;
    var queueSize = queue.length;
    for (var p = 0; p < pending.length; p++) {
      pending[p].status = 'queued';
      pending[p].detail = '';
      pending[p].taskId = '';
    }
    log('Format: ' + FORMATS[cfg.format].name + ', preset: ' + (cfg.preset || '(default)') + ', ' + plural(pending.length, 'sequence', 'sequences'));
    if (queueSize > pending.length) {
      log('Skipping ' + (queueSize - pending.length) + ' already done.');
    }
    renderQueue();

    var stats = { done: 0, failed: 0, unknown: 0 };
    var index = 0;

    function finishRun() {
      running = false;
      currentItem = null;
      progressText = '';
      earlyFinished = {};
      var summary = summarize(stats, pending.length);
      log('');
      log('Done. ' + summary.text);
      setSummary(summary.text, summary.kind);
      renderBinList();
      renderQueue();
    }

    function next() {
      if (index >= pending.length) {
        finishRun();
        return;
      }
      var item = pending[index];
      index++;
      currentItem = item;
      item.status = 'running';
      item.detail = '';
      progressText = 'Exporting ' + index + ' of ' + pending.length + ': ' + displayName(item);
      log('');
      log('[' + index + '/' + pending.length + '] ' + displayName(item) + '  (' + item.mobId + ')');
      renderQueue();
      function finished(outcome) {
        item.status = outcome.status;
        item.detail = outcome.detail;
        if (outcome.status === 'done') {
          stats.done++;
        } else if (outcome.status === 'failed') {
          stats.failed++;
        } else {
          stats.unknown++;
        }
        log('  ' + outcome.status + ': ' + outcome.detail);
        renderQueue();
        next();
      }
      if (cfg.format === 'file') {
        runFileItem(cfg, item, queueSize, finished);
      } else {
        runListFileItem(cfg, item, finished);
      }
    }
    next();
  }

  runBtn.onclick = startRun;

  // ---- destination folder (same helper endpoint as the Organize tab) ----

  function requestJson(method, urlStr, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, urlStr, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        callback(null, data);
      } else {
        callback(new Error((data && data.error) ? data.error : ('HTTP ' + xhr.status)));
      }
    };
    xhr.onerror = function () {
      callback(new Error('Cannot reach the helper server. Is it running?'));
    };
    xhr.send();
  }

  browseBtn.onclick = function () {
    if (browsing || running) {
      return;
    }
    browsing = true;
    refresh();
    setText(formatNoteEl, 'Choose a folder in the dialog (it may be behind other windows) ...');
    requestJson('POST', '/api/browse', function (err, data) {
      browsing = false;
      updateFormatNote();
      refresh();
      if (err) {
        setText(formatNoteEl, 'Could not open the folder dialog: ' + err.message, 'error');
        return;
      }
      if (data.path) {
        destEl.value = data.path;
      }
    });
  };

  // ---- one place that decides what is enabled ----

  function setDisabled(el, value) {
    el.disabled = !!value;
  }

  function refresh() {
    var locked = running;
    var kind = currentFormat();
    var pending = pendingItems();

    setDisabled(binPathEl, locked);
    setDisabled(listBtn, locked || listing);
    setDisabled(selAllBtn, locked || binItems.length === 0);
    setDisabled(selNoneBtn, locked || binItems.length === 0);
    setDisabled(addBtn, locked || checkedBinItems().length === 0);
    for (var r = 0; r < binRows.length; r++) {
      binRows[r].cb.disabled = locked;
    }
    setDisabled(clearBtn, locked || queue.length === 0);
    for (var q = 0; q < queueButtons.length; q++) {
      queueButtons[q].disabled = locked;
    }
    dropEl.className = locked ? 'ex-drop ex-drop-locked' : (dropEl.className === 'ex-drop ex-drop-over' ? dropEl.className : 'ex-drop');

    setDisabled(formatEl, locked);
    setDisabled(reloadBtn, locked);
    for (var f in FORMATS) {
      if (FORMATS.hasOwnProperty(f)) {
        setDisabled(FORMATS[f].selectEl, locked);
      }
    }
    var multi = queue.length > 1;
    setDisabled(fileNameEl, locked || multi);
    setText(fileNameHintEl, multi
      ? 'With more than one sequence in the queue, each file is named after its sequence.'
      : 'Empty = Media Composer picks the default name.');
    setDisabled(destEl, locked);
    setDisabled(browseBtn, locked || browsing);
    setDisabled(inDirEl, locked);
    for (var o = 0; o < optionBoxes.length; o++) {
      optionBoxes[o].cb.disabled = locked;
    }
    for (var t = 0; t < trackInputs.length; t++) {
      trackInputs[t].input.disabled = locked;
    }

    var note = '';
    if (locked) {
      note = progressText;
    } else if (queue.length === 0) {
      note = 'Add sequences to the queue first.';
    } else if (pending.length === 0) {
      note = 'Everything in the queue is exported. Clear the queue to start over.';
    } else if (kind === 'otio' && otioUnavailable) {
      note = 'ExportOTIO is unavailable on this Media Composer.';
    }
    setText(runNoteEl, note);
    setDisabled(runBtn, locked || pending.length === 0 || (kind === 'otio' && otioUnavailable));
  }

  // ---- start ----

  buildOptionBoxes();
  buildTrackInputs();
  for (var k in FORMATS) {
    if (FORMATS.hasOwnProperty(k)) {
      fillPresets(k, []);
    }
  }
  setSummary('', '');
  detailsBtn.hidden = true;
  setLogExpanded(false);
  renderBinList();
  renderQueue();
  applyFormat();
  loadPresets(currentFormat());
}());
