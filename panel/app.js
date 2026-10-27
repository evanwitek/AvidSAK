(function () {
  'use strict';

  var browseBtn = document.getElementById('browse-btn');
  var rootPathEl = document.getElementById('root-path');
  var treeEl = document.getElementById('tree');
  var statusEl = document.getElementById('status');
  var outputEl = document.getElementById('output');
  var createBtn = document.getElementById('create-btn');
  var planEl = document.getElementById('plan');
  var rootCountEl = document.getElementById('root-count');
  var rootStateEl = document.getElementById('root-state');
  var selectAllBtn = document.getElementById('select-all-btn');
  var selectNoneBtn = document.getElementById('select-none-btn');
  var summaryEl = document.getElementById('summary');
  var detailsBtn = document.getElementById('details-btn');
  var confirmRowEl = document.getElementById('confirm-row');
  var confirmTextEl = document.getElementById('confirm-text');
  var confirmCancelBtn = document.getElementById('confirm-cancel');
  var confirmOkBtn = document.getElementById('confirm-ok');

  // A run that links more than CONFIRM_FILES files or creates more than CONFIRM_BINS bins asks for confirmation first.
  var CONFIRM_FILES = 20;
  var CONFIRM_BINS = 10;
  // The plan line lists at most this many bin names.
  var PLAN_NAMES_SHOWN = 6;

  // Name of the Media Composer link settings used for LinkFile. '' = the default active link settings
  // (per MCAPI_Types.proto: "If empty or incorrect, default link setting is used"). A non-empty name must
  // match one returned by GetListOfLinkSettings, otherwise the default is used.
  var LINK_SETTINGS_NAME = '';
  // How CreateBin opens the new bin: FLOATBIN, LASTACTIVEBINCONTAINER or FOLLOWBINSETTINGS.
  var CREATE_BIN_OPEN_OPTION = 'FOLLOWBINSETTINGS';
  // Only files with these extensions are linked; other files are counted as skipped.
  var MEDIA_EXTENSIONS = [
    '.mxf', '.mov', '.mp4', '.m4v', '.mkv', '.avi', '.mpg', '.mpeg', '.mts', '.m2ts', '.wmv', '.webm',
    '.r3d', '.braw', '.ari', '.arx', '.dng', '.dpx', '.exr', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.psd',
    '.wav', '.bwf', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.flac'
  ];
  // Give up on a single MCAPI call after this long so one hung call cannot stall the run.
  var CALL_TIMEOUT_MS = 60000;
  // Call OpenBin on each new bin before its LinkFile calls. The SDK docs do not say LinkFile needs an open bin
  // (only CreateClipsFromAvidMediaFilesFolder and a few others do), so this is a precaution; the result is logged.
  var OPEN_BIN_BEFORE_LINK = true;
  // bin file name on disk: CreateBin takes the bare name, but OpenBin and LinkFile only find the bin as <name>.avb.
  var BIN_FILE_EXTENSION = '.avb';
  var GRPC_CODE_NAMES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL',
    'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
  // CommandErrorType values from MCAPI_Types.proto that can come back in a response header.
  var COMMAND_ERROR_NAMES = {
    1: 'OS_WritePermissions', 2: 'OS_DirectoryPathNotFound', 3: 'OS_FilePathLocation', 4: 'OS_DuplicateName', 5: 'OS_ReadError',
    6: 'OS_DiskSpace', 7: 'OS_IllegalCharacters', 8: 'OS_CharactersLimit', 9: 'OS_FileNotFound',
    10: 'OS_TimeOut', 11: 'OS_FileOpenFailed', 12: 'OS_DirectoryCannotBeCreated', 50: 'MC_BinNotOpened', 51: 'MC_FileExists', 58: 'MC_AccessTokenIsNotValid',
    62: 'MC_MissedParameter', 63: 'MC_ImportFileFailed', 66: 'MC_InvalidArgument', 69: 'MC_BinNotFound', 70: 'MC_InternalError',
    71: 'MC_ProjectNotOpen', 73: 'MC_MediaComposerIsBusy', 77: 'MC_BinIsLocked', 78: 'MC_LinkSettingsNotFound',
    95: 'MC_LicenseNotFound', 1000: 'MC_UnknownError'
  };

  var currentRoot = null;
  var rootNode = null;
  var selected = {}; // folder path -> true
  var folderNodes = {}; // folder path -> node, for every folder row drawn
  var rows = {}; // folder path -> { node, cb, countEl, stateEl }
  var confirming = false;
  var runLogged = false; // true once a run has started: the "Show details" control is then available
  var logExpanded = false;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // kind: 'ok', 'error' or 'info'; empty text hides the summary line.
  function setSummary(text, kind) {
    summaryEl.textContent = text || '';
    summaryEl.className = text && kind ? ('summary-' + kind) : '';
    summaryEl.hidden = !text;
  }

  function setLogExpanded(open) {
    logExpanded = !!open;
    outputEl.hidden = !logExpanded;
    detailsBtn.textContent = logExpanded ? 'Hide details' : 'Show details';
    detailsBtn.setAttribute('aria-expanded', logExpanded ? 'true' : 'false');
  }

  function showDetailsControl(show) {
    runLogged = !!show;
    detailsBtn.hidden = !runLogged;
  }

  detailsBtn.onclick = function () {
    setLogExpanded(!logExpanded);
  };

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
        var msg = (data && data.error) ? data.error : ('HTTP ' + xhr.status);
        callback(new Error(msg));
      }
    };
    xhr.onerror = function () {
      callback(new Error('Cannot reach the helper server. Is it running?'));
    };
    xhr.send();
  }

  function getJson(urlStr, callback) {
    requestJson('GET', urlStr, callback);
  }

  function fetchTree(folderPath, depth, callback) {
    getJson('/api/tree?path=' + encodeURIComponent(folderPath) + '&depth=' + depth, callback);
  }

  function formatSize(bytes) {
    if (bytes < 1024) {
      return bytes + ' B';
    }
    if (bytes < 1048576) {
      return (bytes / 1024).toFixed(1) + ' KB';
    }
    if (bytes < 1073741824) {
      return (bytes / 1048576).toFixed(1) + ' MB';
    }
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function renderChildren(ul, node) {
    ul.innerHTML = '';
    var children = node.children || [];
    if (children.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'file';
      empty.textContent = '(empty)';
      ul.appendChild(empty);
      return;
    }
    for (var i = 0; i < children.length; i++) {
      ul.appendChild(renderNode(children[i]));
    }
    refreshAll();
  }

  // Loads a folder's children (one level) once; every caller waiting on the same folder gets callback(err).
  function loadNode(node, callback) {
    if (node.loaded !== false) {
      callback(null);
      return;
    }
    if (node.pending) {
      node.pending.push(callback);
      return;
    }
    node.pending = [callback];
    fetchTree(node.path, 1, function (err, data) {
      var waiting = node.pending;
      node.pending = null;
      if (!err) {
        node.children = data.children;
        node.loaded = true;
      }
      refreshAll();
      for (var i = 0; i < waiting.length; i++) {
        waiting[i](err);
      }
    });
  }

  function makeSpan(className, text) {
    var span = document.createElement('span');
    span.className = className;
    if (text) {
      span.textContent = text;
    }
    return span;
  }

  // One row per entry: expand toggle, checkbox, name, media count, state label. Files get the same columns
  // with empty toggle and checkbox cells. The picked folder is not a row; it is the header line above the tree.
  function renderNode(node) {
    var li = document.createElement('li');
    li.className = node.type;
    var row = document.createElement('div');
    row.className = 'row';
    li.appendChild(row);

    if (node.type === 'folder') {
      folderNodes[node.path] = node;

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle';
      toggle.textContent = '+';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Expand folder ' + node.name);
      row.appendChild(toggle);

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!selected[node.path];
      cb.setAttribute('aria-label', 'Create a bin from ' + node.name);
      cb.onclick = function (ev) {
        if (ev && ev.stopPropagation) {
          ev.stopPropagation();
        }
        if (cb.checked) {
          selected[node.path] = true;
          // A deeper folder is listed only to its own level; list it so its media count is known for the plan.
          if (node.loaded === false && !node.error) {
            loadNode(node, function (err) {
              if (err) {
                delete selected[node.path];
                setStatus('Error: ' + err.message);
                refreshAll();
              }
            });
          }
        } else {
          delete selected[node.path];
        }
        hideConfirm();
        refreshAll();
      };
      row.appendChild(cb);

      var label = makeSpan('node-label', node.name);
      label.title = node.name;
      row.appendChild(label);

      var countEl = makeSpan('count');
      row.appendChild(countEl);
      var stateEl = makeSpan('state');
      row.appendChild(stateEl);

      var childList = document.createElement('ul');
      childList.style.display = 'none';
      li.appendChild(childList);

      rows[node.path] = { node: node, cb: cb, countEl: countEl, stateEl: stateEl };

      var expanded = false;
      var loading = false;

      var setExpanded = function (value) {
        expanded = value;
        childList.style.display = value ? '' : 'none';
        toggle.textContent = value ? '-' : '+';
        toggle.setAttribute('aria-expanded', value ? 'true' : 'false');
        toggle.setAttribute('aria-label', (value ? 'Collapse folder ' : 'Expand folder ') + node.name);
      };

      var onToggle = function () {
        if (loading) {
          return;
        }
        if (expanded) {
          setExpanded(false);
          return;
        }
        var show = function () {
          if (!childList.firstChild) {
            renderChildren(childList, node);
          }
          setExpanded(true);
        };
        if (node.loaded === false) {
          loading = true;
          setStatus('Loading ' + node.path + ' ...');
          loadNode(node, function (err) {
            loading = false;
            if (err) {
              setStatus('Error: ' + err.message);
              return;
            }
            setStatus('');
            show();
          });
        } else {
          show();
        }
      };

      toggle.onclick = onToggle;
      label.onclick = onToggle;
    } else {
      row.appendChild(makeSpan('toggle-spacer'));
      row.appendChild(makeSpan('cb-spacer'));
      var fileLabel = makeSpan('node-label', node.name);
      fileLabel.title = node.name;
      row.appendChild(fileLabel);
      row.appendChild(makeSpan('size', formatSize(node.size || 0)));
      row.appendChild(makeSpan('state'));
    }
    return li;
  }

  // Count and state label of one folder row. plan.clashes marks ticked folders whose bin name is already taken.
  function refreshRow(entry, path, plan) {
    var node = entry.node;
    var count = '';
    var state = '';
    var tone = 'off';
    var tip = '';
    if (node.error) {
      count = '-';
      state = 'unreadable, no bin';
      tip = 'The helper could not read this folder.';
    } else if (node.loaded === false) {
      count = '-';
      state = 'not scanned';
      tip = 'Expand or tick the folder to count its media.';
    } else {
      var n = mediaCount(node);
      count = n + ' media';
      if (n === 0) {
        state = 'no media, no bin';
        tip = 'A folder only gets a bin if it has media directly inside it.';
      } else if (!selected[path]) {
        state = 'not ticked';
        tip = 'Tick the folder to create a bin from it.';
      } else if (plan.clashes[path]) {
        state = 'name clash';
        tone = 'clash';
        tip = 'Skipped: another ticked folder already uses this bin name (case ignored). Folders are not merged.';
      } else {
        state = 'bin';
        tone = 'bin';
        tip = 'A bin named "' + folderBinName(path) + '" will be created.';
      }
    }
    entry.countEl.textContent = count;
    entry.stateEl.textContent = state;
    entry.stateEl.className = 'state state-' + tone;
    entry.stateEl.title = tip;
    entry.cb.checked = !!selected[path];
    entry.cb.disabled = running;
  }

  // What a click on the action button would do, from the current ticks and the media already listed in the tree.
  // The run itself lists every folder again; this is only the preview.
  function computePlan() {
    var plan = { bins: [], files: 0, selectedCount: 0, noMedia: 0, unknown: 0, clashCount: 0, clashes: {} };
    var paths = [];
    for (var p in selected) {
      if (selected.hasOwnProperty(p) && !(currentRoot && samePath(p, currentRoot))) {
        paths.push(p);
      }
    }
    paths.sort();
    plan.selectedCount = paths.length;
    var seen = {};
    for (var i = 0; i < paths.length; i++) {
      var node = folderNodes[paths[i]];
      if (!node) {
        plan.unknown++;
        continue;
      }
      if (node.error) {
        plan.noMedia++;
        continue;
      }
      if (node.loaded === false) {
        plan.unknown++;
        continue;
      }
      var count = mediaCount(node);
      if (count === 0) {
        plan.noMedia++;
        continue;
      }
      var name = folderBinName(paths[i]);
      var key = name.toLowerCase();
      if (seen.hasOwnProperty(key)) {
        plan.clashes[paths[i]] = true;
        plan.clashCount++;
        continue;
      }
      seen[key] = true;
      plan.bins.push(name);
      plan.files += count;
    }
    return plan;
  }

  function planText(plan) {
    if (!currentRoot) {
      return 'Click Browse... to choose a folder.';
    }
    var text;
    if (plan.bins.length === 0) {
      if (plan.selectedCount === 0) {
        text = 'Nothing selected. Tick folders that have media to create bins.';
      } else if (plan.unknown > 0 && plan.unknown === plan.selectedCount) {
        text = '';
      } else {
        text = 'Nothing to create: the ticked folders have no media or share a bin name.';
      }
    } else {
      var names = plan.bins.slice(0, PLAN_NAMES_SHOWN).join(', ');
      if (plan.bins.length > PLAN_NAMES_SHOWN) {
        names += ' and ' + (plan.bins.length - PLAN_NAMES_SHOWN) + ' more';
      }
      text = 'Will create ' + plural(plan.bins.length, 'bin', 'bins') + ' (' + names + ') and link ' +
        plural(plan.files, 'file', 'files') + '.';
    }
    var skips = [];
    if (plan.noMedia > 0) {
      skips.push(plural(plan.noMedia, 'folder', 'folders') + ' with no media');
    }
    if (plan.clashCount > 0) {
      skips.push(plural(plan.clashCount, 'folder', 'folders') + ' with a name clash');
    }
    if (skips.length > 0 && plan.bins.length > 0) {
      text += ' Skipping ' + skips.join(' and ') + '.';
    }
    if (plan.unknown > 0) {
      text += (text ? ' ' : '') + 'Counting files in ' + plural(plan.unknown, 'folder', 'folders') + ' ...';
    }
    return text;
  }

  function updateControls(plan) {
    createBtn.disabled = running || confirming || !currentRoot || plan.bins.length === 0 || plan.unknown > 0;
    selectAllBtn.disabled = running || !currentRoot;
    selectNoneBtn.disabled = running || !currentRoot;
    browseBtn.disabled = running || browsing;
  }

  function refreshAll() {
    var plan = computePlan();
    for (var p in rows) {
      if (rows.hasOwnProperty(p)) {
        refreshRow(rows[p], p, plan);
      }
    }
    planEl.textContent = planText(plan);
    updateControls(plan);
    return plan;
  }

  function needsConfirm(plan) {
    return plan.files > CONFIRM_FILES || plan.bins.length > CONFIRM_BINS;
  }

  function showConfirm(plan) {
    confirming = true;
    confirmTextEl.textContent = 'This creates ' + plural(plan.bins.length, 'bin', 'bins') + ' and links ' +
      plural(plan.files, 'file', 'files') + ' in Media Composer. Continue?';
    confirmRowEl.hidden = false;
    refreshAll();
    if (confirmCancelBtn.focus) {
      confirmCancelBtn.focus();
    }
  }

  function hideConfirm() {
    if (!confirming) {
      return;
    }
    confirming = false;
    confirmRowEl.hidden = true;
  }

  function selectDirectChildren(on) {
    var kids = (rootNode && rootNode.children) || [];
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.type !== 'folder') {
        continue;
      }
      if (!on) {
        delete selected[kid.path];
      } else if (kid.loaded !== false && !kid.error && folderHasMedia(kid)) {
        selected[kid.path] = true;
      }
    }
  }

  selectAllBtn.onclick = function () {
    if (running) {
      return;
    }
    selectDirectChildren(true);
    hideConfirm();
    refreshAll();
  };

  // Clears every tick, including deeper folders ticked by hand, so the plan line reads "Nothing selected".
  selectNoneBtn.onclick = function () {
    if (running) {
      return;
    }
    selected = {};
    hideConfirm();
    refreshAll();
  };

  function loadRoot(rootPath, onError) {
    currentRoot = rootPath;
    rootNode = null;
    selected = {};
    folderNodes = {};
    rows = {};
    hideConfirm();
    treeEl.innerHTML = '';
    outputEl.textContent = '';
    setSummary('', '');
    showDetailsControl(false);
    setLogExpanded(false);
    rootPathEl.textContent = rootPath || '(no folder selected)';
    rootPathEl.title = rootPath || '';
    rootCountEl.textContent = '';
    rootStateEl.textContent = rootPath ? 'picked folder' : '';
    rootStateEl.title = rootPath ? 'The picked folder is never a bin; its subfolders are.' : '';
    refreshAll();
    if (!rootPath) {
      return;
    }
    setStatus('Loading ...');
    fetchTree(rootPath, 2, function (err, data) {
      if (err) {
        setStatus('Error: ' + err.message);
        if (onError) {
          onError(err);
        }
        return;
      }
      setStatus('');
      rootNode = data;
      rootCountEl.textContent = mediaCount(data) + ' media';
      // Preselect the direct child folders that have media directly inside them (only those get a bin).
      // The picked folder itself is never selectable.
      var kids = data.children || [];
      var noMedia = [];
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].type !== 'folder') {
          continue;
        }
        if (kids[k].loaded !== false && !kids[k].error && folderHasMedia(kids[k])) {
          selected[kids[k].path] = true;
        } else {
          noMedia.push(kids[k].name);
        }
      }
      if (noMedia.length > 0) {
        log('No media directly inside, unticked, no bin: ' + noMedia.join(', '));
      }
      renderChildren(treeEl, data);
      refreshAll();
    });
  }

  function normalizeSlashes(p) {
    return p.replace(/\\/g, '/');
  }

  // Bin name = the folder's own name (last path segment); the bin is created at the project root.
  function folderBinName(folderPath) {
    var p = normalizeSlashes(folderPath).replace(/\/+$/, '');
    return p.substring(p.lastIndexOf('/') + 1) || p;
  }

  // True if the folder node lists at least one media file directly inside it (same filter as LinkFile).
  function mediaCount(node) {
    var children = node.children || [];
    var n = 0;
    for (var i = 0; i < children.length; i++) {
      if (children[i].type === 'file' && isMediaFile(children[i].name)) {
        n++;
      }
    }
    return n;
  }

  function folderHasMedia(node) {
    return mediaCount(node) > 0;
  }

  function samePath(a, b) {
    return normalizeSlashes(a).replace(/\/+$/, '').toLowerCase() === normalizeSlashes(b).replace(/\/+$/, '').toLowerCase();
  }

  function log(line) {
    outputEl.textContent += line + '\n';
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function debug(label, obj) {
    if (window.console && console.log) {
      console.log(label, obj);
    }
  }

  function safeJson(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return String(obj);
    }
  }

  // Media Composer puts a JSON body in the gRPC message, e.g. {"ErrorMessage": "Bin not found. Bin: X", "ErrorType": 9}.
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

  // gRPC error from the client: err.code is the gRPC status number, err.message the server's text.
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

  // True if a failed call says its bin could not be found (gRPC body text/ErrorType 69, or a header error 69).
  function isBinNotFound(err, result) {
    var body = mcErrorBody(err);
    if (body && body.ErrorType === 69) {
      return true;
    }
    return /bin not found|MC_BinNotFound/i.test((result && result.text) || '');
  }

  function describeErrorFull(err) {
    var meta = null;
    if (err && err.metadata) {
      meta = err.metadata;
    }
    return safeJson({
      code: err ? err.code : null,
      codeName: (err && GRPC_CODE_NAMES[err.code]) || null,
      message: err ? (err.message || String(err)) : null,
      metadata: meta
    });
  }

  // Reads the response header: warnings, and a failure if the header carries a non-warning error or status Failed.
  // The header's status and error fields are marked deprecated in the proto, so most failures arrive as gRPC errors.
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

  // Result of one MCAPI call: ok, a text for the log, and any warnings.
  function evaluate(err, response) {
    if (err) {
      return { ok: false, text: describeError(err), warnings: [] };
    }
    var info = headerInfo(response);
    return { ok: !info.failed, text: info.failed || '', warnings: info.warnings };
  }

  function responseObject(response) {
    try {
      return response && response.toObject ? response.toObject() : null;
    } catch (e) {
      return null;
    }
  }

  var dumped = {}; // label -> true once its first failure has been logged in full

  // Logs the full request and the error or response for the first failure of each kind, so it can be pasted back.
  function dumpFailure(label, requestObj, err, response) {
    if (dumped[label]) {
      return;
    }
    dumped[label] = true;
    var token = '';
    try {
      token = mcapi.getAccessToken() ? 'set' : 'EMPTY';
    } catch (e) {
      token = 'unavailable';
    }
    log('  ---- first ' + label + ' failure, full details (copy this) ----');
    log('  request: ' + safeJson(requestObj));
    log('  access token: ' + token + ', gateway: ' + (typeof mcapi !== 'undefined' && mcapi.getGatewayServerAddress ? mcapi.getGatewayServerAddress() : '?'));
    if (err) {
      log('  gRPC error: ' + describeErrorFull(err));
    }
    if (response) {
      log('  response: ' + safeJson(responseObject(response)));
    }
    log('  ----');
  }

  function logWarnings(warnings) {
    for (var i = 0; i < warnings.length; i++) {
      log('  warning: ' + warnings[i]);
    }
  }

  // The helper returns Windows paths with backslashes; this keeps file_path exactly in that form.
  function toWindowsPath(p) {
    return p.replace(/\//g, '\\');
  }

  function isAbsoluteWindowsPath(p) {
    return /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
  }

  function isMediaFile(name) {
    var dot = name.lastIndexOf('.');
    if (dot < 0) {
      return false;
    }
    return MEDIA_EXTENSIONS.indexOf(name.substring(dot).toLowerCase()) >= 0;
  }

  function mcapiAvailable() {
    if (typeof mcapi === 'undefined' || !mcapi) {
      return 'The Media Composer API object (mcapi) is not available. Open this panel from inside Media Composer (Tools > Avid Swiss Army Knife); a normal browser cannot create bins or link files.';
    }
    if (typeof mcapi.getGatewayServerAddress !== 'function' || typeof mcapi.getAccessToken !== 'function') {
      return 'The mcapi object is present but lacks getGatewayServerAddress/getAccessToken. This panel needs a PanelSDK-enabled build of Media Composer.';
    }
    if (!window.McapiSdk) {
      return 'The gRPC-web bundle (sdk/mcapi-bundle.js) did not load. Rebuild it with "npm run build" in sdk-build/.';
    }
    return null;
  }

  // Runs fn(callback) and guarantees callback is called exactly once, even if the call hangs or throws.
  function guardedCall(label, fn, callback) {
    var finished = false;
    var timer = setTimeout(function () {
      finish(new Error(label + ' timed out after ' + (CALL_TIMEOUT_MS / 1000) + ' s'), null);
    }, CALL_TIMEOUT_MS);
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

  function metadata() {
    return { accessToken: mcapi.getAccessToken() };
  }

  function listLinkSettings(client, callback) {
    var sdk = window.McapiSdk;
    guardedCall('GetListOfLinkSettings', function (done) {
      var request = new sdk.GetListOfLinkSettingsRequest();
      request.setBody(new sdk.GetListOfLinkSettingsRequestBody());
      client.getListOfLinkSettings(request, metadata(), done);
    }, function (err, response) {
      if (err) {
        callback(err, []);
      } else {
        callback(null, response.getBody().getSettingNamesList());
      }
    });
  }

  // The four calls below report back as callback(err, response, requestObject).
  function createBin(client, parentPath, binName, callback) {
    var sdk = window.McapiSdk;
    var requestObj = null;
    guardedCall('CreateBin', function (done) {
      var body = new sdk.CreateBinRequestBody();
      body.setFolderPath(parentPath);
      body.setBinName(binName);
      body.setOption(sdk.CreateBinRequestBody.OpenBinOption[CREATE_BIN_OPEN_OPTION]);
      var request = new sdk.CreateBinRequest();
      request.setBody(body);
      requestObj = request.toObject();
      debug('CreateBin', requestObj);
      client.createBin(request, metadata(), done);
    }, function (err, response) {
      callback(err, response, requestObj);
    });
  }

  function openBin(client, binPath, callback) {
    var sdk = window.McapiSdk;
    var requestObj = null;
    guardedCall('OpenBin', function (done) {
      var body = new sdk.OpenBinRequestBody();
      body.setBinPath(binPath);
      body.setReadOnly(false);
      var request = new sdk.OpenBinRequest();
      request.setBody(body);
      requestObj = request.toObject();
      debug('OpenBin', requestObj);
      client.openBin(request, metadata(), done);
    }, function (err, response) {
      callback(err, response, requestObj);
    });
  }

  function getBinInfo(client, binPath, callback) {
    var sdk = window.McapiSdk;
    var requestObj = null;
    guardedCall('GetBinInfo', function (done) {
      var body = new sdk.GetBinInfoRequestBody();
      body.setBinPath(binPath);
      var request = new sdk.GetBinInfoRequest();
      request.setBody(body);
      requestObj = request.toObject();
      debug('GetBinInfo', requestObj);
      client.getBinInfo(request, metadata(), done);
    }, function (err, response) {
      callback(err, response, requestObj);
    });
  }

  function linkFile(client, filePath, binPath, settingsName, callback) {
    var sdk = window.McapiSdk;
    var requestObj = null;
    guardedCall('LinkFile', function (done) {
      var body = new sdk.LinkFileRequestBody();
      body.setFilePath(filePath);
      body.setDestinationBin(binPath);
      body.setLinkSettingsName(settingsName);
      var request = new sdk.LinkFileRequest();
      request.setBody(body);
      requestObj = request.toObject();
      debug('LinkFile', requestObj);
      client.linkFile(request, metadata(), done);
    }, function (err, response) {
      callback(err, response, requestObj);
    });
  }

  // GetBins request classes: exported by sdk/mcapi-bundle.js after a rebuild of sdk-build/entry.js, and already
  // reachable without a rebuild through the global proto.mcapi namespace the generated code registers.
  function getBinsClasses() {
    var sdk = window.McapiSdk;
    if (sdk.GetBinsRequest && sdk.GetBinsRequestBody) {
      return { Request: sdk.GetBinsRequest, Body: sdk.GetBinsRequestBody };
    }
    var ns = window.proto && window.proto.mcapi;
    if (ns && ns.GetBinsRequest && ns.GetBinsRequestBody) {
      return { Request: ns.GetBinsRequest, Body: ns.GetBinsRequestBody };
    }
    return null;
  }

  // GetBins (server stream) for the open project: callback(err, absolutePaths).
  function listBins(client, callback) {
    var classes = getBinsClasses();
    if (!classes || typeof client.getBins !== 'function') {
      callback(new Error('GetBins is not available in sdk/mcapi-bundle.js'), []);
      return;
    }
    var paths = [];
    guardedCall('GetBins', function (done) {
      var body = new classes.Body();
      if (body.addRequestFlag && classes.Body.GetBinsFlag) {
        body.addRequestFlag(classes.Body.GetBinsFlag.BINTYPE);
      }
      var request = new classes.Request();
      request.setBody(body);
      debug('GetBins', request.toObject ? request.toObject() : null);
      var stream = client.getBins(request, metadata());
      stream.on('data', function (response) {
        try {
          paths.push(response.getBody().getAbsolutePath());
        } catch (e) {
          paths.push('(unreadable entry: ' + e.message + ')');
        }
      });
      stream.on('error', function (e) {
        done(e, null);
      });
      stream.on('end', function () {
        done(null, null);
      });
    }, function (err) {
      callback(err, paths);
    });
  }

  function baseName(p) {
    var s = normalizeSlashes(p);
    return s.substring(s.lastIndexOf('/') + 1);
  }

  // Runs steps one after another; each step is function(next). Reports progress through onProgress(done, total).
  function runSteps(steps, onProgress, onFinished) {
    var index = 0;
    function next() {
      onProgress(index, steps.length);
      if (index >= steps.length) {
        onFinished();
        return;
      }
      var step = steps[index];
      index++;
      step(next);
    }
    next();
  }

  // Builds the ordered step list. Each plan is a folder with at least one media file directly inside it:
  // CreateBin at the project root (folder_path '', bin_name = folder name), OpenBin on "<name>.avb", then one
  // LinkFile per media file with destination_bin "<name>.avb" (the bin's file name on disk; the bare name is not
  // found by OpenBin/LinkFile). Every call's response is checked; failures are logged with code and message.
  function buildSteps(client, folderPlans, settingsName, stats) {
    var steps = [];
    var binNotFoundReported = false;

    var binRefOf = function (plan) {
      return plan.binName + BIN_FILE_EXTENSION;
    };

    // Only on "Bin not found" for the .avb path: asks Media Composer what it knows about the bin and which bins exist.
    var diagnoseBin = function (plan, next) {
      var ref = binRefOf(plan);
      var wanted = ref.toLowerCase();
      log('GetBinInfo ' + ref + '  (diagnostic)');
      getBinInfo(client, ref, function (err, response, requestObj) {
        var result = evaluate(err, response);
        if (!result.ok) {
          log('  ERROR: ' + result.text);
          dumpFailure('GetBinInfo', requestObj, err, response);
        } else {
          log('  response: ' + safeJson(responseObject(response)));
        }
        log('GetBins    (bins of the open project)');
        listBins(client, function (listErr, paths) {
          var matches = [];
          if (listErr) {
            log('  ERROR: ' + describeError(listErr));
          }
          log('  ' + paths.length + ' bin(s) returned');
          for (var i = 0; i < paths.length; i++) {
            if (baseName(paths[i]).toLowerCase() === wanted) {
              matches.push(paths[i]);
            }
            if (i < 30) {
              log('  absolute_path: ' + paths[i]);
            }
          }
          if (paths.length > 30) {
            log('  ... ' + (paths.length - 30) + ' more not shown');
          }
          log('  bins named ' + ref + ': ' + (matches.length ? matches.join(' | ') : 'NONE'));
          log('  ----');
          next();
        });
      });
    };

    // Reported once per run, after the full request and gRPC error were printed for the first failure.
    var binNotFound = function (plan, where, next) {
      if (binNotFoundReported) {
        next();
        return;
      }
      binNotFoundReported = true;
      log('  ---- ' + where + ' says Bin not found for "' + binRefOf(plan) + '" although CreateBin succeeded. ' +
        'Copy the request and error above and send them back. ----');
      diagnoseBin(plan, next);
    };

    var addBinSteps = function (plan) {
      steps.push(function (next) {
        log('CreateBin  ' + plan.binName);
        createBin(client, '', plan.binName, function (err, response, requestObj) {
          var result = evaluate(err, response);
          if (!result.ok) {
            stats.binErrors++;
            log('  ERROR: ' + result.text + '  (continuing; the bin may already exist)');
            dumpFailure('CreateBin', requestObj, err, response);
          } else {
            stats.binsCreated++;
            log('  ok');
          }
          logWarnings(result.warnings);
          next();
        });
      });
      if (!OPEN_BIN_BEFORE_LINK) {
        return;
      }
      steps.push(function (next) {
        var ref = binRefOf(plan);
        log('OpenBin    ' + ref);
        openBin(client, ref, function (err, response, requestObj) {
          var result = evaluate(err, response);
          if (result.ok) {
            var body = response.getBody ? response.getBody() : null;
            if (body && body.getIsLockedByOther && body.getIsLockedByOther()) {
              log('  WARNING: the bin is locked by ' + body.getLockOwner() + '; linking into it will probably fail.');
            } else {
              log('  ok');
            }
            logWarnings(result.warnings);
            next();
            return;
          }
          log('  ERROR: ' + result.text);
          dumpFailure('OpenBin', requestObj, err, response);
          logWarnings(result.warnings);
          if (isBinNotFound(err, result)) {
            plan.binMissing = true;
            binNotFound(plan, 'OpenBin', next);
            return;
          }
          log('  WARNING: OpenBin did not accept the bin; LinkFile will be tried anyway.');
          next();
        });
      });
    };

    var addLinkStep = function (plan, filePath) {
      steps.push(function (next) {
        var winPath = toWindowsPath(filePath);
        var ref = binRefOf(plan);
        if (plan.binMissing) {
          log('LinkFile   ' + winPath + '  ->  ' + ref + '  SKIPPED: bin not found');
          stats.linkErrors++;
          next();
          return;
        }
        log('LinkFile   ' + winPath + '  ->  ' + ref);
        if (!isAbsoluteWindowsPath(winPath)) {
          log('  WARNING: file_path is not an absolute Windows path; the SDK expects one.');
        }
        linkFile(client, winPath, ref, settingsName, function (err, response, requestObj) {
          var result = evaluate(err, response);
          var mobId = '';
          if (result.ok) {
            try {
              mobId = response.getBody().getMobId();
            } catch (e) {
              mobId = '';
            }
            if (!mobId) {
              result = { ok: false, text: 'LinkFile returned no mob_id (no clip was reported as created)', warnings: result.warnings };
            }
          }
          if (result.ok) {
            stats.linked++;
            log('  ok  mob_id=' + mobId);
            logWarnings(result.warnings);
            next();
            return;
          }
          stats.linkErrors++;
          log('  ERROR: ' + result.text);
          logWarnings(result.warnings);
          dumpFailure('LinkFile', requestObj, err, response);
          if (isBinNotFound(err, result)) {
            binNotFound(plan, 'LinkFile', next);
            return;
          }
          next();
        });
      });
    };

    for (var i = 0; i < folderPlans.length; i++) {
      addBinSteps(folderPlans[i]);
      for (var f = 0; f < folderPlans[i].files.length; f++) {
        addLinkStep(folderPlans[i], folderPlans[i].files[f]);
      }
    }
    return steps;
  }

  // Lists the media files directly inside each selected folder, one /api/tree call per folder.
  function collectFolderPlans(folders, callback) {
    var plans = [];
    var index = 0;
    function next() {
      if (index >= folders.length) {
        callback(plans);
        return;
      }
      var folder = folders[index];
      index++;
      fetchTree(folder, 1, function (err, data) {
        var plan = { folder: folder, binName: folderBinName(folder), files: [], skipped: 0, nestedFolders: 0, listError: null };
        if (err) {
          plan.listError = err.message;
        } else {
          var children = data.children || [];
          for (var i = 0; i < children.length; i++) {
            if (children[i].type !== 'file') {
              plan.nestedFolders++;
              continue;
            }
            if (isMediaFile(children[i].name)) {
              plan.files.push(children[i].path);
            } else {
              plan.skipped++;
            }
          }
        }
        plans.push(plan);
        next();
      });
    }
    next();
  }

  var running = false;

  // One line for the top of the output area; the raw log stays complete below it.
  function summarize(stats) {
    var errors = stats.binErrors + stats.linkErrors + stats.listErrors;
    var skipped = [];
    if (stats.noMedia > 0) {
      skipped.push(plural(stats.noMedia, 'folder', 'folders') + ' with no media');
    }
    if (stats.collisions > 0) {
      skipped.push(plural(stats.collisions, 'folder', 'folders') + ' with a name clash');
    }
    if (stats.badNames > 0) {
      skipped.push(plural(stats.badNames, 'folder', 'folders') + ' with an unusable name');
    }
    var text = 'Created ' + plural(stats.binsCreated, 'bin', 'bins') + ', linked ' + plural(stats.linked, 'file', 'files');
    if (skipped.length > 0) {
      text += ', skipped ' + skipped.join(' and ');
    }
    text += ', ' + plural(errors, 'error', 'errors') + '.';
    if (errors > 0) {
      text += ' Use Show details for the log.';
    }
    return { text: text, kind: errors > 0 ? 'error' : 'ok' };
  }

  // The action button: asks for confirmation first when the planned run is large, otherwise starts it.
  function onCreateClick() {
    if (running) {
      return;
    }
    if (currentRoot && !confirming) {
      var plan = computePlan();
      if (plan.bins.length > 0 && needsConfirm(plan)) {
        showConfirm(plan);
        return;
      }
    }
    startRun();
  }

  // A message for the summary line and the log, for a click that cannot start a run.
  function reportEarly(message, kind) {
    log(message);
    setSummary(message, kind);
  }

  function startRun() {
    if (running) {
      return;
    }
    var rootAtClick = currentRoot;
    var folders = [];
    for (var p in selected) {
      if (selected.hasOwnProperty(p) && !(rootAtClick && samePath(p, rootAtClick))) {
        folders.push(p);
      }
    }
    folders.sort();
    outputEl.textContent = '';
    setSummary('', '');
    showDetailsControl(false);
    setLogExpanded(false);
    dumped = {};
    if (!rootAtClick) {
      reportEarly('No folder selected. Click Browse... to choose a media folder first.', 'info');
      return;
    }
    if (folders.length === 0) {
      reportEarly('No folders ticked. Only subfolders with media directly inside them get a bin; the picked folder itself is never a bin.', 'info');
      return;
    }
    var unavailable = mcapiAvailable();
    if (unavailable) {
      reportEarly(unavailable, 'error');
      setStatus('Media Composer API not available');
      return;
    }

    var client;
    try {
      client = new window.McapiSdk.MCAPIClient(mcapi.getGatewayServerAddress(), null, null);
    } catch (e) {
      reportEarly('Could not create the Media Composer API client: ' + describeError(e), 'error');
      return;
    }

    running = true;
    hideConfirm();
    showDetailsControl(true);
    refreshAll();
    setStatus('Preparing ...');

    var stats = {
      binsCreated: 0, binErrors: 0, linked: 0, linkErrors: 0, listErrors: 0, skipped: 0,
      nestedFolders: 0, collisions: 0, badNames: 0, rootMediaSkipped: 0, noMedia: 0
    };

    function finishRun() {
      running = false;
      refreshAll();
      setStatus('');
      log('');
      log('Done. Bins created: ' + stats.binsCreated + ', bin errors: ' + stats.binErrors +
        ', files linked: ' + stats.linked + ', link errors: ' + stats.linkErrors +
        ', folders not listed: ' + stats.listErrors + ', non-media files skipped: ' + stats.skipped +
        ', duplicate-name folders skipped: ' + stats.collisions + ', invalid-name folders skipped: ' + stats.badNames +
        ', folders with no media skipped (no bin): ' + stats.noMedia);
      log('Media in picked folder skipped: ' + stats.rootMediaSkipped + ' (the picked folder is never a bin, so its own media has no bin).');
      if (stats.nestedFolders > 0) {
        log('Subfolders not linked: ' + stats.nestedFolders + '. Only media directly inside a selected folder is linked; select a subfolder to get its own bin.');
      }
      var summary = summarize(stats);
      setSummary(summary.text, summary.kind);
    }

    // Counts the media files directly inside the picked folder; they have no bin and are skipped.
    function countRootMedia(callback) {
      fetchTree(rootAtClick, 1, function (err, data) {
        if (err) {
          log('Could not list the picked folder to count its own media: ' + err.message);
        } else {
          var kids = data.children || [];
          for (var i = 0; i < kids.length; i++) {
            if (kids[i].type === 'file' && isMediaFile(kids[i].name)) {
              stats.rootMediaSkipped++;
            }
          }
        }
        callback();
      });
    }

    // One bin per plan (a folder with media), named after the folder. Drops plans whose bin name is unusable or
    // already taken by an earlier plan.
    function acceptPlans(list) {
      var seen = {}; // lower-cased bin name -> folder path that claimed it
      var accepted = [];
      for (var i = 0; i < list.length; i++) {
        var name = list[i].binName;
        var key = name.toLowerCase();
        if (!name || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
          stats.badNames++;
          log('SKIPPED ' + list[i].folder + ': "' + name + '" cannot be used as a bin name.');
        } else if (seen.hasOwnProperty(key)) {
          stats.collisions++;
          log('SKIPPED ' + list[i].folder + ': bin name "' + name + '" is already used by ' + seen[key] + ' (folders are not merged).');
        } else {
          seen[key] = list[i].folder;
          accepted.push(list[i]);
        }
      }
      return accepted;
    }

    listLinkSettings(client, function (settingsErr, names) {
      var settingsName = LINK_SETTINGS_NAME;
      if (settingsErr) {
        log('Could not read the link settings list (' + describeError(settingsErr) + '); using "' + settingsName + '".');
      } else {
        log('Link settings in Media Composer: ' + (names.length ? names.join(', ') : '(none)'));
        if (settingsName && names.indexOf(settingsName) < 0) {
          log('Link settings "' + settingsName + '" not found; using the Media Composer default instead.');
          settingsName = '';
        }
      }
      log('Using link settings: ' + (settingsName || '(Media Composer default)'));

      setStatus('Listing files ...');
      function onPlans(plans) {
        // A folder only gets a bin if it has at least one media file directly inside it.
        var withMedia = [];
        for (var i = 0; i < plans.length; i++) {
          if (plans[i].listError) {
            stats.listErrors++;
            log('ERROR listing ' + plans[i].folder + ': ' + plans[i].listError + '  (folder skipped)');
          } else if (plans[i].files.length === 0) {
            stats.noMedia++;
            log('SKIPPED ' + plans[i].folder + ': no media directly inside, no bin created.');
          } else {
            withMedia.push(plans[i]);
          }
        }
        var usable = acceptPlans(withMedia);
        for (var u = 0; u < usable.length; u++) {
          stats.skipped += usable[u].skipped;
          stats.nestedFolders += usable[u].nestedFolders;
          if (usable[u].nestedFolders > 0) {
            log('NOTE ' + usable[u].folder + ': ' + usable[u].nestedFolders + ' subfolder(s) not linked (direct media only).');
          }
        }
        debug('Plan', usable);
        var steps = buildSteps(client, usable, settingsName, stats);
        log('');
        runSteps(steps, function (done, total) {
          setStatus(done < total ? ('Working: step ' + (done + 1) + ' of ' + total) : '');
        }, finishRun);
      }

      countRootMedia(function () {
        collectFolderPlans(folders, onPlans);
      });
    });
  }

  createBtn.onclick = onCreateClick;

  confirmOkBtn.onclick = function () {
    hideConfirm();
    startRun();
  };

  confirmCancelBtn.onclick = function () {
    hideConfirm();
    refreshAll();
    if (createBtn.focus) {
      createBtn.focus();
    }
  };

  var browsing = false;

  // Asks the helper to open the Windows folder dialog. The helper answers when the dialog closes.
  function onBrowseClick() {
    if (browsing || running) {
      return;
    }
    browsing = true;
    refreshAll();
    setStatus('Choose a folder in the dialog (it may be behind other windows) ...');
    requestJson('POST', '/api/browse', function (err, data) {
      browsing = false;
      refreshAll();
      if (err) {
        setStatus('Could not open the folder dialog: ' + err.message);
        return;
      }
      if (!data.path) {
        setStatus('');
        return;
      }
      loadRoot(data.path);
    });
  }

  browseBtn.onclick = onBrowseClick;

  var BROWSE_PROMPT = 'No folder selected. Click Browse... to choose a media folder.';

  // Reopens the folder picked earlier in this helper session. With none, shows no tree and asks the user to
  // click Browse; pre-approved roots from config.json are never opened automatically.
  function init() {
    setStatus('Loading ...');
    getJson('/api/roots', function (err, data) {
      if (err) {
        setStatus('Error: ' + err.message);
        return;
      }
      var start = data.lastPicked || null;
      if (!start) {
        setStatus(BROWSE_PROMPT);
        return;
      }
      loadRoot(start, function (loadErr) {
        setStatus('Could not open ' + start + ': ' + loadErr.message + '. Click Browse... to choose a folder.');
      });
    });
  }

  setSummary('', '');
  showDetailsControl(false);
  setLogExpanded(false);
  confirmRowEl.hidden = true;
  refreshAll();
  init();
}());
