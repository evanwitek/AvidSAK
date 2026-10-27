(function () {
  'use strict';

  // Script Import tab: pick a transcript text file (Browse... asks the helper for the Windows file dialog) and
  // inject it into the transcript of the clip loaded in Media Composer with SetTranscriptInfo. Plain ES5; the MCAPI
  // request classes come from window.McapiSdk or from the global proto.mcapi namespace, as on the Export tab.
  var panelEl = document.getElementById('panel-script');
  if (!panelEl) {
    return;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  var browseBtn = byId('sc-browse-btn');
  var fileNameEl = byId('sc-file-name');
  var fileInfoEl = byId('sc-file-info');
  var fileStatusEl = byId('sc-file-status');
  var injectBtn = byId('sc-inject-btn');
  var injectNoteEl = byId('sc-inject-note');
  var summaryEl = byId('sc-summary');
  var detailsBtn = byId('sc-details-btn');
  var logEl = byId('sc-log');

  var CALL_TIMEOUT_MS = 60000;
  // Written into STTEntryBase.model_name so a transcript made here can be told apart from a speech-to-text one.
  var MODEL_NAME = 'Avid Swiss Army Knife script import';
  var NO_FILE_TEXT = '(no file selected)';
  // "HH:MM:SS:FF" (or ";" before the frames for drop frame), then a tab, then the text.
  var TIMECODE_LINE = /^(\d{1,2}:\d{2}:\d{2}[:;]\d{2})\t(.*)$/;
  var TIMECODE_ONLY = /^\d{1,2}:\d{2}:\d{2}[:;]\d{2}\s*$/;

  var GRPC_CODE_NAMES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL',
    'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
  // The CommandErrorType values this tab can meet; the rest print as a bare number.
  var COMMAND_ERROR_NAMES = {
    53: 'MC_MobNotFound', 58: 'MC_AccessTokenIsNotValid', 62: 'MC_MissedParameter', 66: 'MC_InvalidArgument',
    70: 'MC_InternalError', 71: 'MC_ProjectNotOpen', 72: 'MC_InvalidMobID', 73: 'MC_MediaComposerIsBusy', 94: 'MC_TranscriptNotFound'
  };

  var filePath = '';
  var browsing = false;
  var injecting = false;
  var logExpanded = false;

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function trim(s) {
    return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function setText(el, text, tone) {
    el.textContent = text || '';
    el.classList.toggle('is-error', tone === 'error');
    el.classList.toggle('is-ok', tone === 'ok');
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

  // ---- errors, in the same form as the other tabs ----

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

  // A dropped connection or a call that never answered: the result of the request is not known.
  function isUnknownOutcome(err) {
    return !!err && (err.timedOut === true || err.code === 14 || err.code === 1 || err.code === 4);
  }

  // ---- MCAPI plumbing ----

  function mcapiUnavailable() {
    if (typeof mcapi === 'undefined' || !mcapi) {
      return 'The Media Composer API object (mcapi) is not available. Open this panel from inside Media Composer (Tools > Avid Swiss Army Knife); a normal browser cannot inject a transcript.';
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
  function guardedCall(label, fn, callback) {
    var finished = false;
    var timer = setTimeout(function () {
      var e = new Error(label + ' timed out after ' + Math.round(CALL_TIMEOUT_MS / 1000) + ' s');
      e.timedOut = true;
      finish(e, null);
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

  // One unary call. describe(request) gives the line for the log; the full request goes to the browser console.
  function callUnary(label, makeRequest, method, describe, callback) {
    guardedCall(label, function (done) {
      var request = makeRequest();
      var obj = null;
      try {
        obj = request && request.toObject ? request.toObject() : null;
      } catch (e) {
        obj = null;
      }
      debug(label, obj);
      log(label + '  request: ' + describe(request));
      newClient()[method](request, metadata(), done);
    }, callback);
  }

  // One server-stream call: onData(response) per message, callback(err) at the end.
  function callStream(label, makeRequest, method, describe, onData, callback) {
    guardedCall(label, function (done) {
      var request = makeRequest();
      log(label + '  request: ' + describe(request));
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

  // ---- helper server ----

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

  // ---- the transcript file ----

  // Plain text, one segment per line. A line is either "HH:MM:SS:FF<TAB>text" or just "text"; blank lines are
  // skipped. A segment's end timecode is the next segment's start timecode when both have one.
  // Returns { segments: [{ text, start, end }], skipped: [line numbers] }.
  function parseTranscript(text) {
    var lines = String(text).split(/\r\n|\r|\n/);
    var segments = [];
    var skipped = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!trim(line)) {
        continue;
      }
      var m = TIMECODE_LINE.exec(line);
      var start = '';
      var body = line;
      if (m) {
        start = m[1];
        body = m[2];
      } else if (TIMECODE_ONLY.test(line)) {
        skipped.push(i + 1);
        continue;
      }
      body = trim(body.replace(/\t+/g, ' '));
      if (!body) {
        skipped.push(i + 1);
        continue;
      }
      segments.push({ text: body, start: start, end: '' });
    }
    for (var s = 0; s + 1 < segments.length; s++) {
      if (segments[s].start && segments[s + 1].start) {
        segments[s].end = segments[s + 1].start;
      }
    }
    return { segments: segments, skipped: skipped };
  }

  function baseName(p) {
    var parts = String(p).split(/[\\\/]/);
    return parts[parts.length - 1] || p;
  }

  // ---- finding the clip: the mob loaded in a Media Composer monitor ----

  // The SDK has no "selected in bin" or "open in timeline" call; GetViewerMobs says what each monitor has loaded and
  // marks the active monitor. Prefer that one; with a single loaded mob use it; otherwise ask the user to decide.
  function pickViewerMob(mobs) {
    if (mobs.length === 0) {
      return { error: 'No clip is loaded in a Media Composer monitor. Load the clip into the Source monitor (or click the monitor that holds it) and try again.' };
    }
    var active = [];
    for (var i = 0; i < mobs.length; i++) {
      if (mobs[i].active) {
        active.push(mobs[i]);
      }
    }
    if (active.length === 1) {
      return { mob: active[0] };
    }
    if (mobs.length === 1) {
      return { mob: mobs[0] };
    }
    return { error: 'More than one monitor has something loaded and Media Composer did not mark exactly one as active (' + mobs.length +
      ' loaded, ' + active.length + ' active). Click the monitor that holds the clip you want and try again.' };
  }

  var VIEWER_NAMES = ['Source', 'Record', 'Popup', 'Center'];

  function findTarget(callback) {
    var mobs = [];
    callUnary('GetViewerMobs', function () {
      var request = new (cls('GetViewerMobsRequest'))();
      request.setBody(new (cls('GetViewerMobsRequestBody'))());
      return request;
    }, 'getViewerMobs', function () {
      return '{}';
    }, function (err, response) {
      if (err) {
        callback('Could not ask Media Composer which clip is loaded: ' + describeError(err), null);
        return;
      }
      var info = headerInfo(response);
      for (var w = 0; w < info.warnings.length; w++) {
        log('  warning: ' + info.warnings[w]);
      }
      if (info.failed) {
        callback('Could not ask Media Composer which clip is loaded: ' + info.failed, null);
        return;
      }
      try {
        var list = response.getBody().getMobsList() || [];
        for (var i = 0; i < list.length; i++) {
          mobs.push({
            mobId: list[i].getMobId(),
            viewer: list[i].getViewType(),
            active: list[i].hasActive && list[i].hasActive() ? list[i].getActive() : false
          });
        }
      } catch (e) {
        callback('Could not read the GetViewerMobs answer: ' + e.message, null);
        return;
      }
      for (var m = 0; m < mobs.length; m++) {
        log('  monitor ' + (VIEWER_NAMES[mobs[m].viewer] || mobs[m].viewer) + ': ' + mobs[m].mobId + (mobs[m].active ? ' (active)' : ''));
      }
      var picked = pickViewerMob(mobs);
      if (picked.error) {
        callback(picked.error, null);
      } else {
        callback(null, picked.mob);
      }
    });
  }

  // The Name column of GetMobInfo, for STTEntryBase.clip_name. Best effort: '' on any failure.
  function lookupName(mobId, callback) {
    var found = '';
    callStream('GetMobInfo', function () {
      var body = new (cls('GetMobInfoRequestBody'))();
      body.setMobId(mobId);
      body.setOnlyVisibleColumns(false);
      body.setIncludesEmptyColumns(false);
      var request = new (cls('GetMobInfoRequest'))();
      request.setBody(body);
      return request;
    }, 'getMobInfo', function () {
      return 'mobId ' + mobId;
    }, function (response) {
      var b = response.getBody();
      if (!found && String(b.getColumnName()).toLowerCase() === 'name') {
        found = b.getColumnValue();
      }
    }, function (err) {
      if (err) {
        log('  GetMobInfo failed: ' + describeError(err) + '  (the clip name is left empty)');
      } else if (!found) {
        log('  GetMobInfo returned no Name column  (the clip name is left empty)');
      }
      callback(found);
    });
  }

  // ---- SetTranscriptInfo ----

  function buildRequest(mobId, clipName, segments) {
    var base = new (cls('STTEntryBase'))();
    base.setClipName(clipName);
    base.setModelName(MODEL_NAME);
    var body = new (cls('SetTranscriptInfoRequestBody'))();
    body.setMobId(mobId);
    body.setBase(base);
    for (var i = 0; i < segments.length; i++) {
      var seg = new (cls('STTEntrySegment'))();
      seg.setSegId(i);
      seg.setSegTranscript(segments[i].text);
      if (segments[i].start) {
        seg.setSegStarttc(segments[i].start);
      }
      if (segments[i].end) {
        seg.setSegEndtc(segments[i].end);
      }
      body.addSegments(seg);
    }
    var request = new (cls('SetTranscriptInfoRequest'))();
    request.setBody(body);
    return request;
  }

  function describeSetRequest(request) {
    var body = request.getBody();
    var segs = body.getSegmentsList();
    var first = segs.length > 0 ? segs[0] : null;
    return 'mobId ' + body.getMobId() + ', clipName "' + body.getBase().getClipName() + '", modelName "' + body.getBase().getModelName() +
      '", ' + plural(segs.length, 'segment', 'segments') +
      (first ? ', first: ' + (first.hasSegStarttc && first.hasSegStarttc() ? first.getSegStarttc() + ' ' : '') + JSON.stringify(first.getSegTranscript()) : '');
  }

  function finishInject(text, kind) {
    injecting = false;
    log('');
    log(text);
    setSummary(text, kind);
    refresh();
  }

  function startInject() {
    if (injecting || browsing) {
      return;
    }
    logEl.textContent = '';
    setSummary('', '');
    setLogExpanded(false);
    detailsBtn.hidden = true;
    if (!filePath) {
      reportEarly('Choose a transcript file with Browse... first.', 'info');
      return;
    }
    var unavailable = mcapiUnavailable();
    if (unavailable) {
      reportEarly(unavailable, 'error');
      return;
    }
    injecting = true;
    detailsBtn.hidden = false;
    refresh();
    log('File: ' + filePath);

    requestJson('POST', '/api/read-file?path=' + encodeURIComponent(filePath), function (readErr, data) {
      if (readErr) {
        finishInject('Could not read ' + baseName(filePath) + ': ' + readErr.message, 'error');
        return;
      }
      var parsed = parseTranscript(data.text);
      log('Read ' + data.size + ' bytes: ' + plural(parsed.segments.length, 'segment', 'segments') +
        (parsed.skipped.length > 0 ? ', ' + plural(parsed.skipped.length, 'line', 'lines') + ' with a timecode but no text skipped (line ' + parsed.skipped.join(', ') + ')' : ''));
      if (parsed.segments.length === 0) {
        finishInject(baseName(filePath) + ' has no text lines, so there is nothing to inject.', 'error');
        return;
      }
      findTarget(function (targetErr, mob) {
        if (targetErr) {
          finishInject(targetErr, 'error');
          return;
        }
        log('Target mob: ' + mob.mobId);
        lookupName(mob.mobId, function (clipName) {
          log('Clip name: ' + (clipName || '(unknown)'));
          callUnary('SetTranscriptInfo', function () {
            return buildRequest(mob.mobId, clipName, parsed.segments);
          }, 'setTranscriptInfo', describeSetRequest, function (err, response) {
            var label = (clipName || mob.mobId);
            if (err) {
              log('  SetTranscriptInfo failed: ' + describeError(err));
              if (isUnknownOutcome(err)) {
                finishInject('The connection to Media Composer was lost or SetTranscriptInfo timed out (' + describeError(err) +
                  '). The transcript may or may not have been set; check Media Composer.', 'error');
              } else {
                finishInject('Could not inject the transcript into ' + label + ': ' + describeError(err) + ' Use Show details for the log.', 'error');
              }
              return;
            }
            var info = headerInfo(response);
            for (var w = 0; w < info.warnings.length; w++) {
              log('  warning: ' + info.warnings[w]);
            }
            if (info.failed) {
              finishInject('Could not inject the transcript into ' + label + ': ' + info.failed + ' Use Show details for the log.', 'error');
              return;
            }
            finishInject('Injected ' + plural(parsed.segments.length, 'segment', 'segments') + ' from ' + baseName(filePath) + ' into ' + label +
              '. Open the transcript window in Media Composer to see it.', 'ok');
          });
        });
      });
    });
  }

  injectBtn.onclick = startInject;

  // ---- Browse... (file dialog in the helper) ----

  browseBtn.onclick = function () {
    if (browsing || injecting) {
      return;
    }
    browsing = true;
    refresh();
    setText(fileStatusEl, 'Choose a file in the dialog (it may be behind other windows) ...');
    requestJson('POST', '/api/browse-file', function (err, data) {
      browsing = false;
      setText(fileStatusEl, '');
      if (err) {
        setText(fileStatusEl, 'Could not open the file dialog: ' + err.message, 'error');
        refresh();
        return;
      }
      if (data.path) {
        filePath = data.path;
        setSummary('', '');
        logEl.textContent = '';
        detailsBtn.hidden = true;
        setLogExpanded(false);
      }
      refresh();
    });
  };

  // ---- one place that decides what is enabled and what is shown ----

  function refresh() {
    fileNameEl.textContent = filePath || NO_FILE_TEXT;
    fileNameEl.title = filePath || '';
    var info = '';
    if (filePath && !/\.txt$/i.test(filePath)) {
      info = 'Not a .txt file: it is read as plain text, one segment per line.';
    }
    setText(fileInfoEl, info);
    browseBtn.disabled = browsing || injecting;
    injectBtn.disabled = !filePath || browsing || injecting;
    var note = '';
    if (injecting) {
      note = 'Injecting ...';
    } else if (!filePath) {
      note = 'Choose a transcript file first.';
    }
    setText(injectNoteEl, note);
  }

  // ---- start ----

  setSummary('', '');
  detailsBtn.hidden = true;
  setLogExpanded(false);
  refresh();
}());
