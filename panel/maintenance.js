(function () {
  'use strict';

  // Maintenance tab: a health check plus the repairs Avid's own knowledge base recommends.
  //
  // Two halves:
  //   - Media Composer half: PanelSDK calls for app/project/volume/command state, and DoCommand for
  //     menu items (command ids come from GetListOfCommands on every load; they only last one launch).
  //   - Helper half: file system, drives, services and console keys, through /api/maint/*.
  //
  // Nothing here deletes media. Files are moved to a quarantine folder, cache folders are renamed.
  // Plain ES5, no modules, same shape as app.js and export.js.

  var panelEl = document.getElementById('panel-maintenance');
  if (!panelEl) {
    return;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  var bannerEl = byId('mt-banner');
  var checkBtn = byId('mt-check-btn');
  var envBtn = byId('mt-env-btn');
  var summaryEl = byId('mt-summary');
  var reportEl = byId('mt-report');

  var volumeSelect = byId('mt-volume');
  var scanPathEl = byId('mt-scan-path');
  var scanBtn = byId('mt-scan-btn');
  var refreshDirsBtn = byId('mt-refresh-dirs-btn');
  var volRefreshBtn = byId('mt-vol-refresh');
  var scanNoteEl = byId('mt-scan-note');
  var volumesEl = byId('mt-volumes');

  var cacheRefreshBtn = byId('mt-cache-refresh');
  var cacheGoBtn = byId('mt-cache-go');
  var cacheListEl = byId('mt-cache-list');
  var cacheStatusEl = byId('mt-cache-status');

  var atticRefreshBtn = byId('mt-attic-refresh');
  var atticArchiveBtn = byId('mt-attic-archive');
  var atticClearBtn = byId('mt-attic-clear');
  var atticListEl = byId('mt-attic-list');
  var atticStatusEl = byId('mt-attic-status');

  var projectPathEl = byId('mt-project-path');
  var projectFillBtn = byId('mt-project-fill');
  var binsBtn = byId('mt-bins-btn');
  var lockScanBtn = byId('mt-lock-scan');
  var lockReleaseBtn = byId('mt-lock-release');
  var binsStatusEl = byId('mt-bins-status');
  var binsEl = byId('mt-bins');
  var lockListEl = byId('mt-lock-list');
  var lockStatusEl = byId('mt-lock-status');

  var mxfFolderEl = byId('mt-mxf-folder');
  var mxfLimitEl = byId('mt-mxf-limit');
  var mxfCheckBtn = byId('mt-mxf-check');
  var mxfSplitBtn = byId('mt-mxf-split');
  var dbCleanBtn = byId('mt-db-clean');
  var mxfStatusEl = byId('mt-mxf-status');
  var mxfReportEl = byId('mt-mxf-report');

  var cmdLoadBtn = byId('mt-cmd-load');
  var cmdSearchEl = byId('mt-cmd-search');
  var cmdStatusEl = byId('mt-cmd-status');
  var cmdListEl = byId('mt-cmd-list');

  var svcRefreshBtn = byId('mt-svc-refresh');
  var svcNameEl = byId('mt-svc-name');
  var svcRestartBtn = byId('mt-svc-restart');
  var envEl = byId('mt-env');
  var sysStatusEl = byId('mt-sys-status');

  var detailsBtn = byId('mt-details-btn');
  var logEl = byId('mt-log');

  var CALL_TIMEOUT_MS = 60000;
  var LONG_CALL_TIMEOUT_MS = 30 * 60 * 1000;
  var HELPER_TIMEOUT_MS = 30 * 60 * 1000;

  var GRPC_CODE_NAMES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL',
    'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

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

  var BUSY_NAMES = { 0: 'idle', 1: 'playing', 2: 'modal dialog open', 3: 'busy' };

  // The items the helper understands (see helper/maintenance.js, CACHE_DIRS and STATE_FILE_NAMES).
  var CACHE_ITEMS = [
    { id: 'ama', label: 'AMA Management', note: 'database for linked media; rebuilt on next launch' },
    { id: 'imagecache', label: 'AvidImageCache', note: 'bin thumbnails' },
    { id: 'sourcebrowser', label: 'AvidSourceBrowserCache', note: 'source browser thumbnails' },
    { id: 'fatal', label: 'Avid FatalErrorReports', note: 'crash reports' },
    { id: 'mcstate', label: 'MCState files', note: 'window layout, last user and project' },
    { id: 'sitesettings', label: 'Site settings', note: 'MC State, Site Attributes, Site Settings; resets site defaults' }
  ];

  // Processes the helper is allowed to restart (helper RETAINABLE list must match).
  var RESTARTABLE = [
    { name: 'AvidBackgroundServicesManager', label: 'Avid Background Services Manager' },
    { name: 'avid-api-gateway', label: 'Avid API Gateway (drops this panel connection)' }
  ];

  // Command names that matter on this tab, used as the default filter.
  var MAINTENANCE_COMMAND_RE = /media|cache|refresh|relink|render|database|index|scan|clean|offline|consolidat|transcod|unload|bin|update|rebuild/i;

  var envData = null;
  var volumes = [];
  var commands = [];

  // ---- small DOM helpers ----

  function setText(el, text) {
    el.textContent = text || '';
  }

  function clear(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) {
      return n + ' B';
    }
    if (n < 1048576) {
      return (n / 1024).toFixed(1) + ' KB';
    }
    if (n < 1073741824) {
      return (n / 1048576).toFixed(1) + ' MB';
    }
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  // Free space on media volumes arrives in KB.
  function formatFreeKb(kb) {
    return formatSize((Number(kb) || 0) * 1024);
  }

  function badge(status) {
    var map = { ok: 'mt-ok', warn: 'mt-warn', bad: 'mt-bad', unknown: 'mt-unknown' };
    var label = { ok: 'OK', warn: 'Check', bad: 'Problem', unknown: 'Unknown' };
    return el('span', 'mt-badge ' + (map[status] || 'mt-unknown'), label[status] || status);
  }

  // table(headers, rows) where a row is an array of cells: string, Node, or {text, node, className, status}
  function table(headers, rows) {
    var wrap = el('div', 'mt-scroll');
    var t = el('table', 'mt-table');
    var thead = el('thead');
    var htr = el('tr');
    headers.forEach(function (h) {
      htr.appendChild(el('th', null, h));
    });
    thead.appendChild(htr);
    t.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (row) {
      var tr = el('tr');
      row.forEach(function (cell) {
        var td = el('td');
        if (cell && cell.node) {
          td.appendChild(cell.node);
          if (cell.className) {
            td.className = cell.className;
          }
        } else if (cell && typeof cell === 'object') {
          if (cell.status) {
            td.appendChild(badge(cell.status));
            td.appendChild(document.createTextNode(' ' + (cell.text || '')));
          } else {
            td.textContent = cell.text || '';
          }
          if (cell.className) {
            td.className = cell.className;
          }
        } else {
          td.textContent = cell === undefined || cell === null ? '' : String(cell);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  function emptyNote(text) {
    return el('p', 'mt-empty', text);
  }

  function log(line) {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
    detailsBtn.hidden = false;
  }

  function toggleDetails(force) {
    var open = force === undefined ? logEl.hidden : force;
    logEl.hidden = !open;
    detailsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    detailsBtn.textContent = open ? 'Hide details' : 'Show details';
  }

  // A destructive button: first click arms it, second click within 6 s runs it.
  var armed = {};

  function confirmThen(button, label, fn) {
    var key = button.id;
    if (armed[key]) {
      clearTimeout(armed[key].timer);
      delete armed[key];
      button.textContent = button.getAttribute('data-label') || button.textContent;
      fn();
      return;
    }
    button.setAttribute('data-label', button.textContent);
    button.textContent = label;
    armed[key] = {
      timer: setTimeout(function () {
        var original = button.getAttribute('data-label') || label;
        delete armed[key];
        button.textContent = original;
      }, 6000)
    };
  }

  function setBusy(button, busy, busyText) {
    if (busy) {
      button.setAttribute('data-label', button.textContent);
      button.textContent = busyText || 'Working...';
      button.disabled = true;
    } else {
      var original = button.getAttribute('data-label');
      if (original) {
        button.textContent = original;
      }
      button.disabled = false;
    }
  }

  // ---- helper requests ----

  function requestJson(method, urlStr, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, urlStr, true);
    xhr.timeout = HELPER_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', 'application/json');
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
      if (xhr.status >= 200 && xhr.status < 300) {
        callback(null, data || {});
        return;
      }
      var message = (data && data.error) ? data.error : ('helper returned HTTP ' + xhr.status);
      callback(new Error(message), data);
    };
    xhr.ontimeout = function () {
      callback(new Error('The helper did not answer within ' + Math.round(HELPER_TIMEOUT_MS / 60000) + ' minutes.'));
    };
    xhr.send(body === undefined || body === null ? null : JSON.stringify(body));
  }

  function getEnv(callback) {
    requestJson('GET', '/api/maint/env', null, callback);
  }

  // ---- MCAPI plumbing, same shape as export.js ----

  function safeJson(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return String(obj);
    }
  }

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
      return { ok: false, text: describeError(err), warnings: [], err: err };
    }
    var info = headerInfo(response);
    info.warnings.forEach(function (w) {
      log('  warning: ' + w);
    });
    return { ok: !info.failed, text: info.failed || '', warnings: info.warnings };
  }

  function mcapiUnavailable() {
    if (typeof mcapi === 'undefined' || !mcapi) {
      return 'The Media Composer API object (mcapi) is not available. Open this panel from inside Media Composer (Tools > Avid Swiss Army Knife). The file system, drive and console checks still work in a browser.';
    }
    if (typeof mcapi.getGatewayServerAddress !== 'function' || typeof mcapi.getAccessToken !== 'function') {
      return 'The mcapi object is present but lacks getGatewayServerAddress/getAccessToken. This panel needs a PanelSDK-enabled build of Media Composer.';
    }
    if (!window.McapiSdk) {
      return 'The gRPC-web bundle (sdk/mcapi-bundle.js) did not load. Rebuild it with "npm run build" in sdk-build/.';
    }
    return null;
  }

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

  function callUnary(label, timeoutMs, makeRequest, method, callback) {
    guardedCall(label, timeoutMs, function (done) {
      var request = makeRequest();
      if (window.console && console.log) {
        console.log(label, request && request.toObject ? request.toObject() : request);
      }
      newClient()[method](request, metadata(), done);
    }, callback);
  }

  function callStream(label, makeRequest, method, onData, callback) {
    guardedCall(label, LONG_CALL_TIMEOUT_MS, function (done) {
      var request = makeRequest();
      var stream = newClient()[method](request, metadata());
      stream.on('data', function (response) {
        try {
          onData(response);
        } catch (e) {
          log('  could not read a ' + label + ' message: ' + e.message);
        }
      });
      stream.on('error', function (err) {
        done(err, null);
      });
      stream.on('end', function () {
        done(null, null);
      });
    }, callback);
  }

  // Runs tasks in order: tasks is an array of function(next).
  function series(tasks, done) {
    var index = 0;
    function next() {
      if (index >= tasks.length) {
        done();
        return;
      }
      var task = tasks[index];
      index += 1;
      task(next);
    }
    next();
  }

  // ---- environment ----

  function stateFileBytes(id) {
    if (!envData || !envData.stateFiles) {
      return 0;
    }
    return envData.stateFiles.reduce(function (sum, f) {
      return f.id === id ? sum + (Number(f.bytes) || 0) : sum;
    }, 0);
  }

  function cacheBytes(id) {
    if (!envData) {
      return 0;
    }
    if (id === 'mcstate' || id === 'sitesettings') {
      return stateFileBytes(id);
    }
    var hit = (envData.caches || []).filter(function (c) {
      return c.id === id;
    })[0];
    return hit ? Number(hit.bytes) || 0 : 0;
  }

  function renderCaches() {
    clear(cacheListEl);
    CACHE_ITEMS.forEach(function (item) {
      var row = el('div', 'ex-bin-row');
      var label = el('label', 'ex-bin-label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = item.id;
      cb.id = 'mt-cache-' + item.id;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + item.label));
      label.setAttribute('for', cb.id);
      row.appendChild(label);
      row.appendChild(el('span', 'mt-check-note', formatSize(cacheBytes(item.id)) + ' - ' + item.note));
      cacheListEl.appendChild(row);
    });
    if (!envData) {
      cacheListEl.appendChild(emptyNote('Click "Check sizes" to read the cache folders from disk.'));
    }
  }

  function renderAttic() {
    clear(atticListEl);
    if (!envData) {
      atticListEl.appendChild(emptyNote('Click "Check sizes" to read the Avid Attic from disk.'));
      return;
    }
    var projects = envData.attic || [];
    if (!projects.length) {
      atticListEl.appendChild(emptyNote('No projects in ' + ((envData.avidRoot || 'the Avid data folder') + '\\Avid Attic') + '.'));
      return;
    }
    projects.sort(function (a, b) {
      return (b.bytes || 0) - (a.bytes || 0);
    });
    projects.forEach(function (project) {
      var row = el('div', 'ex-bin-row');
      var label = el('label', 'ex-bin-label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = project.name;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + project.name));
      row.appendChild(label);
      row.appendChild(el('span', 'mt-check-note', formatSize(project.bytes) + ', ' + project.files + ' files'));
      atticListEl.appendChild(row);
    });
  }

  function renderDriveTable() {
    if (!envData) {
      return emptyNote('No environment data yet.');
    }
    var rows = (envData.drives || []).map(function (d) {
      var total = (Number(d.used) || 0) + (Number(d.free) || 0);
      var percent = total > 0 ? Math.round((Number(d.free) || 0) / total * 100) : 0;
      return [
        d.name + ':',
        d.root,
        d.display ? 'network' : 'local',
        formatSize(d.free),
        { text: percent + '% free', status: percent < 10 ? 'warn' : 'ok' }
      ];
    });
    if (!rows.length) {
      return emptyNote('No drives reported.');
    }
    return table(['Drive', 'Root', 'Type', 'Free', 'State'], rows);
  }

  function defenderMissing() {
    if (!envData || !envData.defender || (!envData.defender.paths.length && !envData.defender.processes.length)) {
      return null;
    }
    var all = (envData.defender.paths || []).concat(envData.defender.processes || []).join(';').toLowerCase();
    var wanted = ['avidmediacomposer.exe', 'avidiomanager.exe', 'avidbackgroundservicesmanager', 'avid-api-gateway.exe'];
    return wanted.filter(function (name) {
      return all.indexOf(name) < 0;
    });
  }

  function renderEnv() {
    clear(envEl);
    if (!envData) {
      envEl.appendChild(emptyNote('Click "Refresh environment".'));
      return;
    }
    var mc = (envData.mc || [])[0];
    var rows = [
      ['Machine', (envData.machine || '?') + ' \\ ' + (envData.user || '?')],
      ['Media Composer', mc ? ('running, process ' + mc.id + (mc.title ? ' - ' + mc.title : '')) : 'not running'],
      ['Media Composer version', envData.mcVersion || 'not found'],
      ['Avid data folder', (envData.avidRoot || '?') + (envData.avidRootExists ? '' : ' (missing)')],
      ['Quarantine folder', envData.quarantine || '?'],
      ['Time sync', (envData.time || []).slice(0, 4).join(' / ') || 'not reported']
    ];
    envEl.appendChild(table(['Item', 'Value'], rows));

    envEl.appendChild(el('h3', 'mt-subhead', 'Drives'));
    envEl.appendChild(renderDriveTable());

    var down = (envData.adapters || []).filter(function (a) {
      return String(a.status).toLowerCase() !== 'up';
    });
    envEl.appendChild(el('h3', 'mt-subhead', 'Network adapters'));
    envEl.appendChild(down.length
      ? table(['Adapter', 'Status', 'Description'], down.map(function (a) {
        return [a.name, { text: a.status, status: 'warn' }, a.description];
      }))
      : emptyNote('Every adapter reports Up.'));

    var services = envData.services || [];
    envEl.appendChild(el('h3', 'mt-subhead', 'Avid services'));
    envEl.appendChild(services.length
      ? table(['Service', 'Status', 'Start'], services.map(function (s) {
        return [s.name, { text: s.status, status: String(s.status).toLowerCase() === 'running' ? 'ok' : 'warn' }, s.start];
      }))
      : emptyNote('No Avid services found.'));

    var missing = defenderMissing();
    envEl.appendChild(el('h3', 'mt-subhead', 'Windows Defender exclusions'));
    if (missing === null) {
      envEl.appendChild(emptyNote('Defender settings are not readable (not installed, or not an administrator).'));
    } else if (!missing.length) {
      envEl.appendChild(el('p', 'mt-empty', 'The main Media Composer executables are excluded from scanning.'));
    } else {
      envEl.appendChild(table(['Missing exclusion'], missing.map(function (name) {
        return [{ text: name, status: 'warn' }];
      })));
      envEl.appendChild(el('p', 'ex-hint', 'Add these under Windows Security > Virus & threat protection > Exclusions. Avid lists more executables in its security guide.'));
    }

    envEl.appendChild(el('h3', 'mt-subhead', 'Processes the helper can restart'));
    envEl.appendChild(table(['Process', 'Executable'], RESTARTABLE.map(function (p) {
      return [p.label, p.name];
    })));
  }

  function refreshEnv(callback) {
    getEnv(function (err, data) {
      if (err) {
        log('environment: ' + err.message);
        if (callback) {
          callback(err);
        }
        return;
      }
      envData = data;
      renderEnv();
      renderCaches();
      renderAttic();
      if (callback) {
        callback(null);
      }
    });
  }

  // ---- health check ----

  var healthRows = [];

  function addRow(check, status, detail) {
    healthRows.push({ check: check, status: status, detail: detail });
  }

  function renderHealth() {
    clear(reportEl);
    if (!healthRows.length) {
      return;
    }
    reportEl.appendChild(table(['Check', 'State', 'Detail'], healthRows.map(function (row) {
      return [row.check, { status: row.status }, row.detail];
    })));
  }

  function summarizeHealth() {
    var bad = 0;
    var warn = 0;
    var ok = 0;
    healthRows.forEach(function (row) {
      if (row.status === 'bad') {
        bad += 1;
      } else if (row.status === 'warn') {
        warn += 1;
      } else if (row.status === 'ok') {
        ok += 1;
      }
    });
    setText(summaryEl, ok + ' OK, ' + warn + ' to check, ' + bad + ' problem' + (bad === 1 ? '' : 's') + '.');
    summaryEl.className = 'ex-status';
  }

  function envHealthRows() {
    if (!envData) {
      addRow('Environment (helper)', 'unknown', 'The helper did not answer. Is it running on 127.0.0.1:47831?');
      return;
    }
    var mc = (envData.mc || [])[0];
    addRow('Media Composer process', mc ? 'ok' : 'warn', mc ? 'PID ' + mc.id + (mc.title ? ' - ' + mc.title : '') : 'not running');
    addRow('Media Composer version', envData.mcVersion ? 'ok' : 'unknown', envData.mcVersion || 'avidmediacomposer.exe not found');

    var totalCache = 0;
    CACHE_ITEMS.forEach(function (item) {
      totalCache += cacheBytes(item.id);
    });
    addRow('Cache and state files', totalCache > 2 * 1073741824 ? 'warn' : 'ok',
      formatSize(totalCache) + ' in the Avid data folder');

    var atticTotal = (envData.attic || []).reduce(function (sum, p) {
      return sum + (Number(p.bytes) || 0);
    }, 0);
    addRow('Avid Attic', atticTotal > 20 * 1073741824 ? 'warn' : 'ok',
      formatSize(atticTotal) + ' in ' + (envData.attic || []).length + ' project folders');

    var low = (envData.drives || []).filter(function (d) {
      var total = (Number(d.used) || 0) + (Number(d.free) || 0);
      return total > 0 && (Number(d.free) || 0) / total < 0.1;
    });
    addRow('Drive space', low.length ? 'warn' : 'ok',
      low.length ? ('under 10% free on ' + low.map(function (d) { return d.name + ':'; }).join(', ')) : 'every drive has at least 10% free');

    var down = (envData.adapters || []).filter(function (a) {
      return String(a.status).toLowerCase() !== 'up';
    });
    addRow('Network adapters', down.length ? 'warn' : 'ok',
      down.length ? (down.length + ' not up: ' + down.map(function (a) { return a.name; }).join(', ')) : 'all up');

    var stopped = (envData.services || []).filter(function (s) {
      return String(s.status).toLowerCase() !== 'running' && String(s.start).toLowerCase() === 'automatic';
    });
    addRow('Avid services', stopped.length ? 'warn' : 'ok',
      stopped.length ? ('not running: ' + stopped.map(function (s) { return s.name; }).join(', ')) : 'automatic Avid services are running');

    var missing = defenderMissing();
    addRow('Defender exclusions', missing === null ? 'unknown' : (missing.length ? 'warn' : 'ok'),
      missing === null ? 'Defender settings not readable' : (missing.length ? (missing.length + ' Avid executable(s) not excluded') : 'Avid executables excluded'));

    var timeText = (envData.time || []).join(' ');
    addRow('Time sync', !timeText ? 'unknown' : (/error|unable|not available|failed/i.test(timeText) ? 'warn' : 'ok'),
      (envData.time || [])[0] || 'w32tm did not report');
  }

  function mcHealthRows(done) {
    var problem = mcapiUnavailable();
    if (problem) {
      addRow('Media Composer API', 'unknown', problem);
      done();
      return;
    }
    var steps = [];

    steps.push(function (next) {
      callUnary('Echo', CALL_TIMEOUT_MS, function () {
        var req = new (cls('EchoRequest'))();
        var body = new (cls('EchoRequestBody'))();
        body.setMessage('maintenance');
        req.setBody(body);
        return req;
      }, 'echo', function (err) {
        addRow('Media Composer API', err ? 'bad' : 'ok', err ? describeError(err) : 'answered');
        next();
      });
    });

    steps.push(function (next) {
      callUnary('GetAppInfo', CALL_TIMEOUT_MS, function () {
        return new (cls('GetAppInfoRequest'))();
      }, 'getAppInfo', function (err, response) {
        if (err) {
          addRow('Application', 'bad', describeError(err));
          return next();
        }
        try {
          var body = response.getBody();
          var busy = body.getAppBusyStatus();
          addRow('Application', busy === 2 || busy === 3 ? 'warn' : 'ok',
            body.getAppName() + ' ' + body.getAppVersion() + ', ' + (BUSY_NAMES[busy] || ('state ' + busy)) +
            (body.getSdkVersion ? ', SDK ' + body.getSdkVersion() : ''));
        } catch (e) {
          addRow('Application', 'unknown', e.message);
        }
        next();
      });
    });

    steps.push(function (next) {
      callUnary('GetHostInfo', CALL_TIMEOUT_MS, function () {
        return new (cls('GetHostInfoRequest'))();
      }, 'getHostInfo', function (err, response) {
        if (err) {
          addRow('Host', 'unknown', describeError(err));
          return next();
        }
        try {
          var body = response.getBody();
          addRow('Host', 'ok', body.getUserName() + ' on ' + body.getWorkstationName());
        } catch (e) {
          addRow('Host', 'unknown', e.message);
        }
        next();
      });
    });

    steps.push(function (next) {
      callUnary('GetOpenProjectInfo', CALL_TIMEOUT_MS, function () {
        return new (cls('GetOpenProjectInfoRequest'))();
      }, 'getOpenProjectInfo', function (err, response) {
        if (err) {
          addRow('Open project', codeOf(err) === 12 ? 'warn' : 'bad',
            codeOf(err) === 12 ? 'GetOpenProjectInfo is not implemented on this Media Composer' : describeError(err));
          return next();
        }
        try {
          var body = response.getBody();
          var projectPath = body.getPath();
          addRow('Open project', projectPath ? 'ok' : 'warn',
            (projectPath || 'no project open') + (body.getProjectType() ? ', ' + body.getProjectType() : ''));
          if (projectPath && !projectPathEl.value) {
            projectPathEl.value = projectPath;
          }
        } catch (e) {
          addRow('Open project', 'unknown', e.message);
        }
        next();
      });
    });

    steps.push(function (next) {
      loadVolumes(function (err) {
        if (err) {
          addRow('Media volumes', 'bad', err.message);
          return next();
        }
        var low = volumes.filter(function (v) {
          return Number(v.freeKb) > 0 && Number(v.freeKb) * 1024 < 10 * 1073741824;
        });
        addRow('Media volumes', low.length ? 'warn' : 'ok',
          volumes.length + ' volume(s)' + (low.length ? ', under 10 GB free: ' + low.map(function (v) { return v.name; }).join(', ') : ''));
        next();
      });
    });

    steps.push(function (next) {
      callUnary('GetListOfJobQueues', CALL_TIMEOUT_MS, function () {
        return new (cls('GetListOfJobQueuesRequest'))();
      }, 'getListOfJobQueues', function (err, response) {
        if (err) {
          addRow('Background job queues', codeOf(err) === 12 ? 'unknown' : 'warn',
            codeOf(err) === 12 ? 'not implemented on this Media Composer' : describeError(err));
          return next();
        }
        try {
          var queues = response.getBody().getJobQueuesList();
          addRow('Background job queues', 'ok', queues.length + ' queue(s)' +
            (queues.length ? ': ' + queues.map(function (q) { return q.getName(); }).join(', ') : ''));
        } catch (e) {
          addRow('Background job queues', 'unknown', e.message);
        }
        next();
      });
    });

    steps.push(function (next) {
      callUnary('GetListOfWindows', CALL_TIMEOUT_MS, function () {
        return new (cls('GetListOfWindowsRequest'))();
      }, 'getListOfWindows', function (err, response) {
        if (err) {
          addRow('Windows', 'unknown', describeError(err));
          return next();
        }
        try {
          var list = response.getBody().getWindowsList();
          var visible = list.filter(function (w) {
            return w.getVisibility();
          });
          addRow('Windows', 'ok', list.length + ' window(s), ' + visible.length + ' visible');
        } catch (e) {
          addRow('Windows', 'unknown', e.message);
        }
        next();
      });
    });

    series(steps, done);
  }

  function codeOf(err) {
    return err && err.code !== undefined ? err.code : null;
  }

  function runHealthCheck() {
    healthRows = [];
    clear(reportEl);
    setText(summaryEl, 'Running the health check...');
    setBusy(checkBtn, true, 'Checking...');
    log('--- health check ---');
    refreshEnv(function () {
      envHealthRows();
      mcHealthRows(function () {
        renderHealth();
        summarizeHealth();
        setBusy(checkBtn, false);
      });
    });
  }

  // ---- media volumes and database refresh ----

  function loadVolumes(callback) {
    var problem = mcapiUnavailable();
    if (problem) {
      if (callback) {
        callback(new Error(problem));
      }
      return;
    }
    callUnary('GetMediaVolumeList', CALL_TIMEOUT_MS, function () {
      return new (cls('GetMediaVolumeListRequest'))();
    }, 'getMediaVolumeList', function (err, response) {
      if (err) {
        log('GetMediaVolumeList: ' + describeError(err));
        if (callback) {
          callback(new Error(describeError(err)));
        }
        return;
      }
      volumes = [];
      try {
        response.getBody().getVolumesList().forEach(function (v) {
          volumes.push({
            name: v.getName(),
            shared: v.getIsShared(),
            freeKb: v.getFreeSpace() === undefined ? 0 : Number(String(v.getFreeSpace()))
          });
        });
      } catch (e) {
        if (callback) {
          callback(new Error('Could not read the volume list: ' + e.message));
        }
        return;
      }
      renderVolumes();
      if (callback) {
        callback(null);
      }
    });
  }

  function volumeRoot(name) {
    if (!name) {
      return '';
    }
    if (/[\\/]$/.test(name)) {
      return name;
    }
    return name + '\\';
  }

  function isDriveVolume(name) {
    return /^[A-Za-z]:$/.test(name) || /[\\/]$/.test(name);
  }

  function renderVolumes() {
    clear(volumeSelect);
    clear(volumesEl);
    if (!volumes.length) {
      volumeSelect.appendChild(el('option', null, '(no media volumes)'));
      volumesEl.appendChild(emptyNote('Media Composer did not report any Avid media volumes.'));
      return;
    }
    volumes.forEach(function (v) {
      var option = el('option', null, v.name + (v.shared ? ' (shared)' : ''));
      option.value = v.name;
      volumeSelect.appendChild(option);
    });
    volumesEl.appendChild(table(['Volume', 'Type', 'Free'], volumes.map(function (v) {
      return [
        v.name,
        v.shared ? 'shared' : 'local',
        { text: formatFreeKb(v.freeKb), status: v.freeKb * 1024 < 10 * 1073741824 ? 'warn' : 'ok' }
      ];
    })));
    fillMxfFolderFromVolume();
  }

  function fillMxfFolderFromVolume() {
    if (mxfFolderEl.value) {
      return;
    }
    var name = volumeSelect.value;
    if (!name || !isDriveVolume(name)) {
      return;
    }
    mxfFolderEl.value = volumeRoot(name) + 'Avid MediaFiles\\MXF\\1';
  }

  function scanDestination() {
    var path = scanPathEl.value.trim();
    if (/^[A-Za-z]:/.test(path) || path.indexOf('\\\\') === 0 || path.indexOf('/') === 0) {
      return path;
    }
    var volume = volumeSelect.value;
    if (!volume) {
      return '';
    }
    return volumeRoot(volume) + 'Avid MediaFiles\\' + path.replace(/^\\+/, '');
  }

  function scanFolder() {
    var problem = mcapiUnavailable();
    if (problem) {
      setText(scanNoteEl, problem);
      return;
    }
    var destination = scanDestination();
    if (!destination) {
      setText(scanNoteEl, 'Pick a media volume, or type the full folder path in the field.');
      return;
    }
    setText(scanNoteEl, 'Scanning ' + destination + '... This can take a while.');
    setBusy(scanBtn, true, 'Scanning...');
    log('ScanAvidMediaFilesFolder: ' + destination);
    callUnary('ScanAvidMediaFilesFolder', LONG_CALL_TIMEOUT_MS, function () {
      var req = new (cls('ScanAvidMediaFilesFolderRequest'))();
      var body = new (cls('ScanAvidMediaFilesFolderRequestBody'))();
      body.setDestinationPath(destination);
      req.setBody(body);
      return req;
    }, 'scanAvidMediaFilesFolder', function (err, response) {
      setBusy(scanBtn, false);
      var result = evaluate(err, response);
      if (result.ok) {
        setText(scanNoteEl, 'Scan requested for ' + destination + '. Media Composer rebuilds the databases in the background.');
      } else {
        setText(scanNoteEl, 'Scan failed: ' + result.text);
      }
    });
  }

  // Finds a command by name and runs it. Command ids are per launch, so this always reads them first.
  function runCommandByName(pattern, noteEl) {
    var problem = mcapiUnavailable();
    if (problem) {
      setText(noteEl, problem);
      return;
    }
    setText(noteEl, 'Looking for a Media Composer command matching ' + pattern + '...');
    callUnary('GetListOfCommands', CALL_TIMEOUT_MS, function () {
      return new (cls('GetListOfCommandsRequest'))();
    }, 'getListOfCommands', function (err, response) {
      if (err) {
        setText(noteEl, 'Could not read the command list: ' + describeError(err));
        return;
      }
      var matches = [];
      try {
        response.getBody().getCommandsList().forEach(function (cmd) {
          if (pattern.test(cmd.getName()) && cmd.getEnabled && cmd.getEnabled() !== false) {
            matches.push(cmd);
          }
        });
      } catch (e) {
        setText(noteEl, 'Could not read the command list: ' + e.message);
        return;
      }
      if (!matches.length) {
        setText(noteEl, 'No enabled command matches ' + pattern + ' in the current window. Use the menu directly, or click into the Project window and try again.');
        return;
      }
      var command = matches[0];
      log('DoCommand ' + command.getName() + ' (id ' + command.getCommandId() + ')');
      callUnary('DoCommand', CALL_TIMEOUT_MS, function () {
        var req = new (cls('DoCommandRequest'))();
        var body = new (cls('DoCommandRequestBody'))();
        body.setCommandId(command.getCommandId());
        req.setBody(body);
        return req;
      }, 'doCommand', function (doErr, doResponse) {
        var result = evaluate(doErr, doResponse);
        setText(noteEl, result.ok
          ? ('Sent "' + command.getName() + '". The result arrives as a Media Composer notification.')
          : ('"' + command.getName() + '" failed: ' + result.text));
      });
    });
  }

  // ---- caches and attic ----

  function checkedValues(container) {
    var boxes = container.querySelectorAll('input[type="checkbox"]');
    var values = [];
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) {
        values.push(boxes[i].value);
      }
    }
    return values;
  }

  function rebuildCaches() {
    var items = checkedValues(cacheListEl);
    if (!items.length) {
      setText(cacheStatusEl, 'Tick at least one item first.');
      return;
    }
    setText(cacheStatusEl, 'Rebuilding ' + items.length + ' item(s)...');
    setBusy(cacheGoBtn, true, 'Rebuilding...');
    requestJson('POST', '/api/maint/cleanup', { items: items, confirm: true }, function (err, data) {
      setBusy(cacheGoBtn, false);
      if (err) {
        setText(cacheStatusEl, err.message);
        log('cleanup: ' + err.message);
        return;
      }
      var lines = (data.results || []).map(function (r) {
        return (r.ok ? 'OK  ' : 'FAIL ') + r.id + ' - ' + (r.movedTo || r.error || '');
      });
      setText(cacheStatusEl, lines.length + ' result(s). Details below.');
      lines.forEach(log);
      log('Quarantine: ' + data.quarantine);
      refreshEnv();
    });
  }

  function archiveAttic(clear) {
    var projects = checkedValues(atticListEl);
    if (!projects.length) {
      setText(atticStatusEl, 'Tick at least one Attic project first.');
      return;
    }
    setText(atticStatusEl, (clear ? 'Archiving and clearing ' : 'Archiving ') + projects.length + ' project(s)...');
    setBusy(clear ? atticClearBtn : atticArchiveBtn, true, 'Archiving...');
    requestJson('POST', '/api/maint/attic', {
      action: clear ? 'archive-clear' : 'archive',
      projects: projects,
      confirm: true
    }, function (err, data) {
      setBusy(clear ? atticClearBtn : atticArchiveBtn, false);
      if (err) {
        setText(atticStatusEl, err.message);
        log('attic: ' + err.message);
        return;
      }
      var ok = 0;
      (data.results || []).forEach(function (r) {
        if (r.ok) {
          ok += 1;
        }
        log((r.ok ? 'OK  ' : 'FAIL ') + r.name + ' - ' + (r.zip || r.error || '') + (r.cleared ? ' (cleared)' : ''));
      });
      setText(atticStatusEl, ok + ' of ' + (data.results || []).length + ' project(s) archived. Quarantine: ' + data.quarantine);
      refreshEnv();
    });
  }

  // ---- bins and locks ----

  function listBins() {
    var problem = mcapiUnavailable();
    if (problem) {
      setText(binsStatusEl, problem);
      return;
    }
    setBusy(binsBtn, true, 'Listing...');
    setText(binsStatusEl, 'Reading bins...');
    clear(binsEl);
    var paths = [];
    callStream('GetBins', function () {
      var req = new (cls('GetBinsRequest'))();
      var body = new (cls('GetBinsRequestBody'))();
      body.setRequestFlagList([]);
      req.setBody(body);
      return req;
    }, 'getBins', function (response) {
      try {
        var p = response.getBody().getAbsolutePath();
        if (p) {
          paths.push(p);
        }
      } catch (e) {
        log('GetBins message: ' + e.message);
      }
    }, function (err) {
      if (err) {
        setBusy(binsBtn, false);
        setText(binsStatusEl, 'GetBins failed: ' + describeError(err));
        return;
      }
      if (!paths.length) {
        setBusy(binsBtn, false);
        setText(binsStatusEl, 'Media Composer reported no bins in the open project.');
        return;
      }
      setText(binsStatusEl, paths.length + ' bin(s). Reading lock state...');
      var rows = [];
      var index = 0;
      function nextBin() {
        if (index >= paths.length) {
          setBusy(binsBtn, false);
          clear(binsEl);
          binsEl.appendChild(table(['Bin', 'Open', 'Lock', 'Size'], rows));
          setText(binsStatusEl, paths.length + ' bin(s) checked.');
          return;
        }
        var full = paths[index];
        index += 1;
        var name = full.replace(/^.*[\\/]/, '');
        callUnary('GetBinInfo', CALL_TIMEOUT_MS, function () {
          var req = new (cls('GetBinInfoRequest'))();
          var body = new (cls('GetBinInfoRequestBody'))();
          body.setBinPath(name);
          req.setBody(body);
          return req;
        }, 'getBinInfo', function (infoErr, response) {
          if (infoErr) {
            rows.push([name, { text: 'unknown', status: 'unknown' }, '', '']);
          } else {
            try {
              var body = response.getBody();
              rows.push([
                name,
                { text: body.getIsOpen() ? 'open' : 'closed', status: body.getIsOpen() ? 'ok' : 'unknown' },
                { text: body.getLockState() ? ('locked by ' + (body.getLockOwner() || '?')) : 'unlocked', status: body.getLockState() ? 'warn' : 'ok' },
                formatSize(body.getSize())
              ]);
            } catch (e) {
              rows.push([name, { text: 'unknown', status: 'unknown' }, e.message, '']);
            }
          }
          nextBin();
        });
      }
      nextBin();
    });
  }

  function fillProjectPath() {
    var problem = mcapiUnavailable();
    if (problem) {
      setText(binsStatusEl, problem);
      return;
    }
    callUnary('GetOpenProjectInfo', CALL_TIMEOUT_MS, function () {
      return new (cls('GetOpenProjectInfoRequest'))();
    }, 'getOpenProjectInfo', function (err, response) {
      if (err) {
        setText(binsStatusEl, 'Could not read the open project: ' + describeError(err));
        return;
      }
      try {
        var projectPath = response.getBody().getPath();
        if (projectPath) {
          projectPathEl.value = projectPath;
          setText(binsStatusEl, 'Project folder: ' + projectPath);
        } else {
          setText(binsStatusEl, 'No project is open.');
        }
      } catch (e) {
        setText(binsStatusEl, e.message);
      }
    });
  }

  function scanLocks(finalStatus) {
    var projectPath = projectPathEl.value.trim();
    if (!projectPath) {
      setText(lockStatusEl, 'Set the project folder first (or click "Use open project").');
      return;
    }
    setText(lockStatusEl, 'Scanning ' + projectPath + ' for .lck files...');
    requestJson('POST', '/api/maint/locks', { projectPath: projectPath }, function (err, data) {
      if (err) {
        setText(lockStatusEl, err.message);
        return;
      }
      clear(lockListEl);
      var locks = data.locks || [];
      if (!locks.length) {
        setText(lockStatusEl, finalStatus || 'No .lck files in this project.');
        return;
      }
      locks.forEach(function (lock) {
        var row = el('div', 'ex-bin-row');
        var label = el('label', 'ex-bin-label');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = lock.path;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + lock.name));
        row.appendChild(label);
        row.appendChild(el('span', 'mt-check-note', (lock.owner || 'no owner recorded') +
          (lock.modified ? ' - ' + lock.modified.slice(0, 19).replace('T', ' ') : '')));
        lockListEl.appendChild(row);
      });
      setText(lockStatusEl, finalStatus || (locks.length + ' lock file(s). Check the ones whose editor is no longer in the bin.'));
    });
  }

  function releaseLocks() {
    var files = checkedValues(lockListEl);
    if (!files.length) {
      setText(lockStatusEl, 'Tick the lock files to release first.');
      return;
    }
    var projectPath = projectPathEl.value.trim();
    setText(lockStatusEl, 'Releasing ' + files.length + ' lock(s)...');
    requestJson('POST', '/api/maint/release-locks', { projectPath: projectPath, files: files, confirm: true }, function (err, data) {
      if (err) {
        setText(lockStatusEl, err.message);
        return;
      }
      var ok = 0;
      (data.results || []).forEach(function (r) {
        if (r.ok) {
          ok += 1;
        }
        log((r.ok ? 'OK  ' : 'FAIL ') + r.file + ' - ' + (r.movedTo || r.error || ''));
      });
      var message = ok + ' of ' + (data.results || []).length + ' released. They are in ' + data.quarantine + '.';
      setText(lockStatusEl, message);
      scanLocks(message);
    });
  }

  // ---- MXF folders ----

  function checkMxf(finalStatus) {
    var folder = mxfFolderEl.value.trim();
    if (!folder) {
      setText(mxfStatusEl, 'Enter the MXF folder first, for example D:\\Avid MediaFiles\\MXF\\1.');
      return;
    }
    setText(mxfStatusEl, 'Counting files in ' + folder + '...');
    clear(mxfReportEl);
    requestJson('POST', '/api/maint/mxf', { action: 'count', folder: folder, limit: Number(mxfLimitEl.value) || 5000 }, function (err, data) {
      if (err) {
        setText(mxfStatusEl, err.message);
        return;
      }
      var limit = Number(data.limit) || 5000;
      var over = data.count > limit;
      setText(mxfStatusEl, finalStatus || (data.count + ' MXF file(s), ' + formatSize(data.bytes) +
        (over ? ' - over the limit of ' + limit + ', split the folder.' : ' - within the limit of ' + limit + '.')));
      var rows = [
        ['Folder', data.folder],
        ['MXF files', String(data.count)],
        ['Size', formatSize(data.bytes)],
        ['Databases', (data.databases || []).length ? data.databases.join(', ') : 'none (they are created by a scan)']
      ];
      mxfReportEl.appendChild(table(['Item', 'Value'], rows));
      if ((data.oldest || []).length) {
        mxfReportEl.appendChild(table(['Oldest files', 'Modified'], data.oldest.map(function (f) {
          return [f.name, f.modified ? f.modified.slice(0, 19).replace('T', ' ') : ''];
        })));
      }
    });
  }

  function splitMxf() {
    var folder = mxfFolderEl.value.trim();
    if (!folder) {
      setText(mxfStatusEl, 'Enter the MXF folder first.');
      return;
    }
    setText(mxfStatusEl, 'Moving the oldest files out of ' + folder + '...');
    requestJson('POST', '/api/maint/mxf', {
      action: 'split',
      folder: folder,
      limit: Number(mxfLimitEl.value) || 5000,
      confirm: true
    }, function (err, data) {
      if (err) {
        setText(mxfStatusEl, err.message);
        return;
      }
      setText(mxfStatusEl, data.message || 'Done.');
      if (data.destination) {
        log('Split destination: ' + data.destination);
        mxfFolderEl.value = folder;
      }
      checkMxf(data.message);
    });
  }

  function quarantineDatabases() {
    var folder = mxfFolderEl.value.trim();
    if (!folder) {
      setText(mxfStatusEl, 'Enter the MXF folder first.');
      return;
    }
    setText(mxfStatusEl, 'Moving msmMMOB.mdb and msmFMID.pmr to quarantine...');
    requestJson('POST', '/api/maint/mxf', { action: 'quarantine-databases', folder: folder, confirm: true }, function (err, data) {
      if (err) {
        setText(mxfStatusEl, err.message);
        return;
      }
      if (data.message) {
        setText(mxfStatusEl, data.message);
        checkMxf(data.message);
      } else {
        var ok = 0;
        (data.results || []).forEach(function (r) {
          if (r.ok) {
            ok += 1;
          }
          log((r.ok ? 'OK  ' : 'FAIL ') + r.file + ' - ' + (r.movedTo || r.error || ''));
        });
        var message = ok + ' database file(s) moved to ' + data.quarantine + '. Quit Media Composer and rescan, or use Rescan folder.';
        setText(mxfStatusEl, message);
        checkMxf(message);
      }
    });
  }

  // ---- commands ----

  function loadCommands() {
    var problem = mcapiUnavailable();
    if (problem) {
      setText(cmdStatusEl, problem);
      return;
    }
    setBusy(cmdLoadBtn, true, 'Loading...');
    setText(cmdStatusEl, 'Reading the command list...');
    callUnary('GetListOfCommands', CALL_TIMEOUT_MS, function () {
      return new (cls('GetListOfCommandsRequest'))();
    }, 'getListOfCommands', function (err, response) {
      setBusy(cmdLoadBtn, false);
      if (err) {
        setText(cmdStatusEl, 'GetListOfCommands failed: ' + describeError(err));
        return;
      }
      commands = [];
      try {
        response.getBody().getCommandsList().forEach(function (cmd) {
          commands.push({
            id: cmd.getCommandId(),
            name: cmd.getName(),
            category: cmd.getCategory() || '',
            enabled: cmd.getEnabled ? cmd.getEnabled() !== false : true
          });
        });
      } catch (e) {
        setText(cmdStatusEl, 'Could not read the command list: ' + e.message);
        return;
      }
      setText(cmdStatusEl, commands.length + ' command(s). Command ids last until Media Composer quits.');
      renderCommands();
    });
  }

  function renderCommands() {
    clear(cmdListEl);
    if (!commands.length) {
      cmdListEl.appendChild(emptyNote('Load the commands to see Media Composer menu items.'));
      return;
    }
    var query = cmdSearchEl.value.trim();
    var pattern = query ? null : MAINTENANCE_COMMAND_RE;
    var matches = commands.filter(function (cmd) {
      if (pattern) {
        return pattern.test(cmd.name) || pattern.test(cmd.category);
      }
      var haystack = (cmd.name + ' ' + cmd.category).toLowerCase();
      return haystack.indexOf(query.toLowerCase()) >= 0;
    });
    if (!matches.length) {
      cmdListEl.appendChild(emptyNote('No command matches "' + query + '".'));
      return;
    }
    var shown = matches.slice(0, 300);
    var rows = shown.map(function (cmd) {
      var run = el('button', null, 'Run');
      run.type = 'button';
      run.disabled = !cmd.enabled;
      run.onclick = function () {
        runCommand(cmd, run);
      };
      return [
        { node: el('span', 'mt-command-name', cmd.name) },
        cmd.category || '',
        { node: run }
      ];
    });
    cmdListEl.appendChild(table(['Command', 'Category', ''], rows));
    if (matches.length > shown.length) {
      cmdListEl.appendChild(emptyNote('Showing the first ' + shown.length + ' of ' + matches.length + '. Narrow the filter to see more.'));
    }
  }

  function runCommand(command, button) {
    setBusy(button, true, '...');
    callUnary('DoCommand', CALL_TIMEOUT_MS, function () {
      var req = new (cls('DoCommandRequest'))();
      var body = new (cls('DoCommandRequestBody'))();
      body.setCommandId(command.id);
      req.setBody(body);
      return req;
    }, 'doCommand', function (err, response) {
      setBusy(button, false);
      var result = evaluate(err, response);
      setText(cmdStatusEl, result.ok
        ? ('Sent "' + command.name + '". The result arrives as a notification.')
        : ('"' + command.name + '" failed: ' + result.text));
    });
  }

  // ---- system: services and console keys ----

  function populateServices() {
    clear(svcNameEl);
    RESTARTABLE.forEach(function (p) {
      var option = el('option', null, p.label);
      option.value = p.name;
      svcNameEl.appendChild(option);
    });
  }

  function restartService() {
    var name = svcNameEl.value;
    setText(sysStatusEl, 'Restarting ' + name + '...');
    setBusy(svcRestartBtn, true, 'Restarting...');
    requestJson('POST', '/api/maint/service', { name: name, confirm: true }, function (err, data) {
      setBusy(svcRestartBtn, false);
      if (err) {
        setText(sysStatusEl, err.message);
        return;
      }
      setText(sysStatusEl, data.name + ': ' + (data.output || 'restarted'));
      refreshEnv();
    });
  }

  function sendKeys(action, button) {
    setText(sysStatusEl, 'Sending ' + action + ' to Media Composer...');
    setBusy(button, true, 'Sending...');
    requestJson('POST', '/api/maint/keys', { action: action, confirm: true }, function (err, data) {
      setBusy(button, false);
      if (err) {
        setText(sysStatusEl, err.message + ' Bring Media Composer to the front and try again.');
        return;
      }
      setText(sysStatusEl, 'Sent ' + action + '. Check the Media Composer window.');
      log('keys: ' + action + ' - ' + (data.output || ''));
    });
  }

  // ---- wiring ----

  checkBtn.onclick = function () {
    runHealthCheck();
  };
  envBtn.onclick = function () {
    setBusy(envBtn, true, 'Reading...');
    refreshEnv(function () {
      setBusy(envBtn, false);
      setText(sysStatusEl, 'Environment refreshed.');
    });
  };
  volRefreshBtn.onclick = function () {
    setBusy(volRefreshBtn, true, 'Loading...');
    loadVolumes(function (err) {
      setBusy(volRefreshBtn, false);
      setText(scanNoteEl, err ? err.message : (volumes.length + ' volume(s).'));
    });
  };
  scanBtn.onclick = scanFolder;
  refreshDirsBtn.onclick = function () {
    runCommandByName(/refresh.*media.*director/i, scanNoteEl);
  };
  volumeSelect.onchange = function () {
    mxfFolderEl.value = '';
    fillMxfFolderFromVolume();
  };

  cacheRefreshBtn.onclick = function () {
    setBusy(cacheRefreshBtn, true, 'Reading...');
    refreshEnv(function () {
      setBusy(cacheRefreshBtn, false);
      setText(cacheStatusEl, envData ? 'Sizes updated.' : 'Could not read the Avid data folder.');
    });
  };
  cacheGoBtn.onclick = function () {
    confirmThen(cacheGoBtn, 'Click again to rebuild', rebuildCaches);
  };

  atticRefreshBtn.onclick = function () {
    setBusy(atticRefreshBtn, true, 'Reading...');
    refreshEnv(function () {
      setBusy(atticRefreshBtn, false);
      setText(atticStatusEl, envData ? ((envData.attic || []).length + ' Attic project(s).') : 'Could not read the Avid Attic.');
    });
  };
  atticArchiveBtn.onclick = function () {
    confirmThen(atticArchiveBtn, 'Click again to archive', function () {
      archiveAttic(false);
    });
  };
  atticClearBtn.onclick = function () {
    confirmThen(atticClearBtn, 'Click again to archive and clear', function () {
      archiveAttic(true);
    });
  };

  projectFillBtn.onclick = fillProjectPath;
  binsBtn.onclick = listBins;
  lockScanBtn.onclick = scanLocks;
  lockReleaseBtn.onclick = function () {
    confirmThen(lockReleaseBtn, 'Click again to release', releaseLocks);
  };

  mxfCheckBtn.onclick = checkMxf;
  mxfSplitBtn.onclick = function () {
    confirmThen(mxfSplitBtn, 'Click again to split', splitMxf);
  };
  dbCleanBtn.onclick = function () {
    confirmThen(dbCleanBtn, 'Click again to quarantine', quarantineDatabases);
  };

  cmdLoadBtn.onclick = loadCommands;
  cmdSearchEl.oninput = renderCommands;

  svcRefreshBtn.onclick = function () {
    setBusy(svcRefreshBtn, true, 'Reading...');
    refreshEnv(function () {
      setBusy(svcRefreshBtn, false);
    });
  };
  svcRestartBtn.onclick = function () {
    confirmThen(svcRestartBtn, 'Click again to restart', restartService);
  };

  byId('mt-keys-workgroup-on').onclick = function () {
    sendKeys('console-workgroup-on', byId('mt-keys-workgroup-on'));
  };
  byId('mt-keys-workgroup-off').onclick = function () {
    sendKeys('console-workgroup-off', byId('mt-keys-workgroup-off'));
  };
  byId('mt-keys-reinit').onclick = function () {
    sendKeys('console-reinit', byId('mt-keys-reinit'));
  };
  byId('mt-keys-play').onclick = function () {
    sendKeys('play-in-out', byId('mt-keys-play'));
  };

  detailsBtn.onclick = function () {
    toggleDetails();
  };

  // ---- start ----

  populateServices();
  renderCaches();
  renderAttic();
  renderEnv();
  cmdListEl.appendChild(emptyNote('Load the commands to see Media Composer menu items.'));
  setText(sysStatusEl, '');
  var apiProblem = mcapiUnavailable();
  setText(bannerEl, apiProblem || '');
  if (apiProblem) {
    volumeSelect.appendChild(el('option', null, '(Media Composer API not available)'));
  }

  refreshEnv(function () {
    log('helper ready, Avid data folder: ' + ((envData && envData.avidRoot) || 'unknown'));
  });

  if (!mcapiUnavailable()) {
    loadVolumes(function () {});
    fillProjectPath();
  }
}());
