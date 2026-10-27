'use strict';

// Maintenance endpoints for the helper.
//
// Everything here runs on this machine and touches Media Composer's files, processes or keyboard.
// The panel is a web page, so it cannot do any of that itself. Rules for every endpoint:
//   - mutations need a JSON body with confirm: true
//   - paths must be under an Avid data folder, or inside an Avid MediaFiles tree, or a folder that
//     looks like a Media Composer project (it holds .avp/.avb files)
//   - files are moved to a quarantine folder, never deleted (except the Attic clear step, which only
//     runs after a verified zip)
//
// The panel's Maintenance tab owns the labels; the ids below are what it sends.

var fs = require('fs');
var os = require('os');
var path = require('path');
var execFile = require('child_process').execFile;

var PS_TIMEOUT_MS = 5 * 60 * 1000;
var ARCHIVE_TIMEOUT_MS = 60 * 60 * 1000;
var MAX_BODY_BYTES = 1024 * 1024;

// Media Composer writes its public data here. "Public Documents" and "Documents" both exist on
// Windows depending on version and locale; take the first one that is present.
var AVID_ROOT_CANDIDATES = [
  'C:\\Users\\Public\\Documents\\Avid Media Composer',
  'C:\\Users\\Public\\Public Documents\\Avid Media Composer'
];

// Folder names from Avid KB "Rebuilding the Avid Cache folders".
// id -> folder name under the Avid data root. Renamed in place with an _old-<timestamp> suffix.
var CACHE_DIRS = {
  ama: 'AMA Management',
  imagecache: 'AvidImageCache',
  sourcebrowser: 'AvidSourceBrowserCache',
  fatal: 'Avid FatalErrorReports'
};

// Files Avid KB says to delete for site settings / MCState. Matched by file name without extension,
// lowercased, because the extension differs between versions.
var STATE_FILE_NAMES = {
  mcstate: ['mcstate'],
  sitesettings: ['mc state', 'site attributes', 'site settings', 'site_attributes', 'site_settings']
};

// Process restarts the panel may ask for. exe name -> label.
var RESTARTABLE = {
  'AvidBackgroundServicesManager': 'Avid Background Services Manager',
  'avid-api-gateway': 'Avid API Gateway'
};

// Console actions typed into Media Composer. Fixed text, fixed keys; the panel cannot send free text.
var KEY_ACTIONS = {
  'console-workgroup-on': { keys: '^6', text: 'workgroupoverride on' },
  'console-workgroup-off': { keys: '^6', text: 'workgroupoverride off' },
  'console-reinit': { keys: '^6', text: 'panelsdk reinit' },
  'play-in-out': { keys: '%6', text: null }
};

function stamp() {
  var d = new Date();
  function p(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function avidRoot() {
  for (var i = 0; i < AVID_ROOT_CANDIDATES.length; i++) {
    if (exists(AVID_ROOT_CANDIDATES[i])) {
      return AVID_ROOT_CANDIDATES[i];
    }
  }
  return AVID_ROOT_CANDIDATES[0];
}

function quarantineRoot() {
  var base = process.env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'AvidSwissArmyKnife', 'quarantine');
}

function ensureDir(p) {
  if (!exists(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function lower(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function isUnder(child, root) {
  var c = lower(path.resolve(child));
  var r = lower(path.resolve(root));
  if (c === r) {
    return true;
  }
  return c.indexOf(r + path.sep) === 0;
}

// A path this module is willing to touch.
function isAvidPath(p) {
  var resolved;
  try {
    resolved = path.resolve(p);
  } catch (e) {
    return false;
  }
  if (isUnder(resolved, avidRoot())) {
    return true;
  }
  if (lower(resolved).indexOf(lower(path.sep + 'avid mediafiles' + path.sep)) >= 0) {
    return true;
  }
  // A project folder: holds .avp or .avb files directly.
  try {
    var entries = fs.readdirSync(resolved);
    for (var i = 0; i < entries.length; i++) {
      if (/\.(avp|avb)$/i.test(entries[i])) {
        return true;
      }
    }
  } catch (e) {
    return false;
  }
  return false;
}

function isAvidMediaPath(p) {
  return lower(path.resolve(p)).indexOf(lower('Avid MediaFiles')) >= 0;
}

function sizeOfDir(dir) {
  var out = { path: dir, exists: false, files: 0, bytes: 0 };
  var stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    return out;
  }
  out.exists = true;
  if (stat.isFile()) {
    out.files = 1;
    out.bytes = stat.size;
    return out;
  }
  var stack = [dir];
  while (stack.length) {
    var current = stack.pop();
    var entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          out.files += 1;
          out.bytes += fs.statSync(full).size;
        } catch (e) {
          // a file that disappeared between listing and stat
        }
      }
    }
  }
  return out;
}

function moveToQuarantine(source, note) {
  var dir = path.join(quarantineRoot(), stamp());
  ensureDir(dir);
  var target = path.join(dir, path.basename(source));
  var n = 1;
  while (exists(target)) {
    target = path.join(dir, path.basename(source) + '.' + n);
    n += 1;
  }
  fs.renameSync(source, target);
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      moved: path.basename(target),
      from: source,
      note: note || '',
      at: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    // the manifest is a convenience, not part of the move
  }
  return target;
}

function walkFiles(root, depth, match, out) {
  out = out || [];
  if (depth < 0) {
    return out;
  }
  var entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, depth - 1, match, out);
    } else if (entry.isFile() && match(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

// true when Media Composer is running. A failed tasklist call reports false: better to try than to
// block a repair because the check itself failed.
function mcRunning(callback) {
  execFile('tasklist', ['/FI', 'IMAGENAME eq avidmediacomposer.exe', '/NH'], { timeout: 15000 }, function (err, stdout) {
    if (err) {
      return callback(false);
    }
    callback(String(stdout || '').toLowerCase().indexOf('avidmediacomposer.exe') >= 0);
  });
}

function readJsonBody(req, callback) {  var chunks = [];
  var bytes = 0;
  var done = false;
  function finish(err, body) {
    if (done) {
      return;
    }
    done = true;
    callback(err, body);
  }
  req.on('data', function (chunk) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      finish(new Error('Request body is too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', finish);
  req.on('end', function () {
    var text = Buffer.concat(chunks).toString('utf8');
    if (!text) {
      return finish(null, {});
    }
    try {
      finish(null, JSON.parse(text));
    } catch (e) {
      finish(new Error('Request body is not valid JSON'));
    }
  });
}

function base64Script(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// PowerShell hands errors back as CLIXML when it has no console, which is unreadable in the panel.
// Scripts in this file print "ERROR:<text>" to stdout before exiting, which is the best message.
function psMessage(err, stdout, stderr) {
  var out = String(stdout || '');
  var marker = out.indexOf('ERROR:');
  if (marker >= 0) {
    return out.substring(marker + 6).replace(/_x000D__x000A_/g, ' ').trim();
  }
  var text = String(stderr || '');
  var parts = text.match(/<S S="Error">([^<]*)<\/S>/g);
  if (parts && parts.length) {
    var joined = parts.map(function (part) {
      return part.replace(/<[^>]+>/g, '');
    }).join(' ').replace(/_x000D__x000A_/g, ' ').replace(/\s+/g, ' ').trim();
    if (joined) {
      return joined;
    }
  }
  var line = text.trim().split(/\r?\n/)[0];
  if (line && line.indexOf('#< CLIXML') < 0) {
    return line;
  }
  return 'PowerShell failed' + (err && err.code !== undefined ? ' (exit ' + err.code + ')' : '');
}

function runPowerShell(script, env, timeoutMs, callback) {
  var childEnv = {};
  Object.keys(process.env).forEach(function (k) {
    childEnv[k] = process.env[k];
  });
  Object.keys(env || {}).forEach(function (k) {
    childEnv[k] = env[k];
  });
  execFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', base64Script(script)
  ], {
    env: childEnv,
    timeout: timeoutMs || PS_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err && err.killed) {
      return callback(new Error('PowerShell timed out after ' + Math.round((timeoutMs || PS_TIMEOUT_MS) / 60000) + ' minutes.'));
    }
    if (err) {
      return callback(new Error(psMessage(err, stdout, stderr)));
    }
    callback(null, String(stdout || ''));
  });
}

// ---- environment ----

var ENV_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'function DirInfo([string]$p) {',
  '  if (-not $p) { return [pscustomobject]@{ path = ""; exists = $false; files = 0; bytes = 0 } }',
  '  if (-not (Test-Path -LiteralPath $p)) { return [pscustomobject]@{ path = $p; exists = $false; files = 0; bytes = 0 } }',
  '  $item = Get-Item -LiteralPath $p',
  '  if ($item.PSIsContainer) {',
  '    $files = @(Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue)',
  '  } else {',
  '    $files = @($item)',
  '  }',
  '  $sum = 0',
  '  foreach ($f in $files) { $sum += $f.Length }',
  '  return [pscustomobject]@{ path = $p; exists = $true; files = $files.Count; bytes = $sum }',
  '}',
  '$root = $env:MFP_AVID_ROOT',
  '$mcProcs = @(Get-Process avidmediacomposer -ErrorAction SilentlyContinue | ForEach-Object {',
  '  [pscustomobject]@{ id = $_.Id; title = $_.MainWindowTitle; path = $_.Path; started = $_.StartTime.ToString("o") }',
  '})',
  '$exe = "C:\\Program Files\\Avid\\Avid Media Composer\\avidmediacomposer.exe"',
  '$version = ""',
  'if (Test-Path -LiteralPath $exe) { $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }',
  '$cacheNames = @($env:MFP_CACHE_NAMES -split "\\|")',
  '$caches = @()',
  'foreach ($n in $cacheNames) {',
  '  if ($n) {',
  '    $parts = $n -split "::"',
  '    $caches += (DirInfo (Join-Path $root $parts[1]) | Add-Member -NotePropertyName id -NotePropertyValue $parts[0] -PassThru)',
  '  }',
  '}',
  '$attic = @()',
  '$atticPath = Join-Path $root "Avid Attic"',
  'if (Test-Path -LiteralPath $atticPath) {',
  '  foreach ($d in @(Get-ChildItem -LiteralPath $atticPath -Directory -ErrorAction SilentlyContinue)) {',
  '    $attic += (DirInfo $d.FullName | Add-Member -NotePropertyName name -NotePropertyValue $d.Name -PassThru)',
  '  }',
  '}',
  '$drives = @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 -or $_.DriveType -eq 4 } | ForEach-Object {',
  '  [pscustomobject]@{ name = $_.DeviceID.TrimEnd(\':\'); root = ($_.DeviceID + \"\\\"); used = ($_.Size - $_.FreeSpace); free = $_.FreeSpace; display = $_.ProviderName }',
  '})',
  '$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {',
  '  [pscustomobject]@{ name = $_.Name; status = $_.Status; description = $_.InterfaceDescription }',
  '})',
  '$services = @(Get-Service -Name "*Avid*" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  [pscustomobject]@{ name = $_.Name; status = [string]$_.Status; start = [string]$_.StartType }',
  '})',
  '$defPath = @()',
  '$defProc = @()',
  'if (Get-Command Get-MpPreference -ErrorAction SilentlyContinue) {',
  '  $mp = Get-MpPreference',
  '  $defPath = @($mp.ExclusionPath)',
  '  $defProc = @($mp.ExclusionProcess)',
  '}',
  '$time = @()',
  'try { $time = @(w32tm /query /status 2>&1) } catch { $time = @("w32tm unavailable") }',
  '[pscustomobject]@{',
  '  machine = $env:COMPUTERNAME',
  '  user = $env:USERNAME',
  '  avidRoot = $root',
  '  avidRootExists = (Test-Path -LiteralPath $root)',
  '  mc = $mcProcs',
  '  mcVersion = $version',
  '  caches = $caches',
  '  attic = $attic',
  '  drives = $drives',
  '  adapters = $adapters',
  '  services = $services',
  '  defender = [pscustomobject]@{ paths = $defPath; processes = $defProc }',
  '  time = $time',
  '  quarantine = $env:MFP_QUARANTINE',
  '} | ConvertTo-Json -Depth 7 -Compress'
].join('\r\n');

function handleEnv(req, res, sendJson) {
  runPowerShell(ENV_SCRIPT, {
    MFP_AVID_ROOT: avidRoot(),
    MFP_QUARANTINE: quarantineRoot(),
    MFP_CACHE_NAMES: Object.keys(CACHE_DIRS).map(function (id) {
      return id + '::' + CACHE_DIRS[id];
    }).join('|')
  }, PS_TIMEOUT_MS, function (err, stdout) {
    if (err) {
      return sendJson(req, res, 500, { error: err.message });
    }
    var data;
    try {
      data = JSON.parse(stdout.trim() || '{}');
    } catch (e) {
      return sendJson(req, res, 500, { error: 'Could not read the environment report: ' + e.message });
    }
    // PowerShell turns one-item arrays into objects.
    data.mc = [].concat(data.mc || []);
    data.caches = [].concat(data.caches || []);
    data.attic = [].concat(data.attic || []);
    data.drives = [].concat(data.drives || []);
    data.adapters = [].concat(data.adapters || []);
    data.services = [].concat(data.services || []);
    if (data.defender) {
      data.defender.paths = [].concat(data.defender.paths || []);
      data.defender.processes = [].concat(data.defender.processes || []);
    }
    data.time = [].concat(data.time || []);
    data.quarantine = quarantineRoot();
    data.stateFiles = collectStateFiles().map(function (f) {
      var size = sizeOfDir(f.path);
      return { id: f.id, path: f.path, bytes: size.bytes };
    });
    sendJson(req, res, 200, data);
  });
}

// ---- caches / state files ----

function collectStateFiles() {
  var root = avidRoot();
  var found = [];
  var settings = path.join(root, 'Settings');
  var users = path.join(root, 'Avid Users');

  function add(file) {
    var name = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    for (var id in STATE_FILE_NAMES) {
      if (STATE_FILE_NAMES.hasOwnProperty(id) && STATE_FILE_NAMES[id].indexOf(name) >= 0) {
        found.push({ id: id, path: file });
      }
    }
  }

  walkFiles(settings, 1, function (name, full) {
    add(full);
    return false;
  });
  walkFiles(users, 5, function (name, full) {
    add(full);
    return /^mcstate$/i.test(name);
  });
  return found;
}

function handleCleanup(req, res, sendJson, body) {
  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }
  mcRunning(function (running) {
    if (running) {
      return sendJson(req, res, 409, { error: 'Quit Media Composer first: it writes these files while it runs.' });
    }
    performCleanup(req, res, sendJson, body);
  });
}

function performCleanup(req, res, sendJson, body) {
  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return sendJson(req, res, 400, { error: 'Pick at least one item' });
  }
  var root = avidRoot();
  var results = [];

  items.forEach(function (id) {
    if (CACHE_DIRS[id]) {
      var dir = path.join(root, CACHE_DIRS[id]);
      if (!exists(dir)) {
        results.push({ id: id, path: dir, ok: false, error: 'not found' });
        return;
      }
      var target = dir + '_old-' + stamp();
      try {
        fs.renameSync(dir, target);
        results.push({ id: id, path: dir, movedTo: target, ok: true });
      } catch (e) {
        results.push({ id: id, path: dir, ok: false, error: e.code || e.message });
      }
      return;
    }
    if (id === 'mcstate' || id === 'sitesettings') {
      var files = collectStateFiles().filter(function (f) {
        return f.id === id;
      });
      if (!files.length) {
        results.push({ id: id, ok: false, error: 'no files found' });
        return;
      }
      files.forEach(function (file) {
        try {
          var to = moveToQuarantine(file.path, 'maintenance ' + id);
          results.push({ id: id, path: file.path, movedTo: to, ok: true });
        } catch (e) {
          results.push({ id: id, path: file.path, ok: false, error: e.code || e.message });
        }
      });
      return;
    }
    results.push({ id: id, ok: false, error: 'unknown item' });
  });

  sendJson(req, res, 200, { results: results, quarantine: quarantineRoot() });
}

// ---- Avid Attic ----

function handleAttic(req, res, sendJson, body) {
  var attic = path.join(avidRoot(), 'Avid Attic');
  var action = body.action || 'list';

  if (action === 'list') {
    var projects = [];
    try {
      var entries = fs.readdirSync(attic, { withFileTypes: true });
      entries.forEach(function (entry) {
        if (entry.isDirectory()) {
          projects.push(sizeOfDir(path.join(attic, entry.name)));
        }
      });
    } catch (e) {
      return sendJson(req, res, 200, { path: attic, exists: false, projects: [] });
    }
    return sendJson(req, res, 200, { path: attic, exists: true, projects: projects });
  }

  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }
  var wanted = Array.isArray(body.projects) ? body.projects : [];
  if (!wanted.length) {
    return sendJson(req, res, 400, { error: 'Pick at least one project' });
  }

  // zip first, verify, and only delete when asked
  var dir = path.join(quarantineRoot(), stamp());
  ensureDir(dir);
  var script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $src = $env:MFP_ATTIC_PROJECT',
    '  $dst = $env:MFP_ATTIC_ZIP',
    '  Compress-Archive -Path (Join-Path $src "*") -DestinationPath $dst -CompressionLevel Optimal',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERROR:' + ($_.Exception.Message -replace '\\s+', ' '))",
    '  exit 1',
    '}'
  ].join('\r\n');

  var results = [];
  var index = 0;

  function next() {
    if (index >= wanted.length) {
      return done();
    }
    var name = String(wanted[index]);
    index += 1;
    var projectPath = path.join(attic, name);
    if (!isUnder(projectPath, attic) || name.indexOf('..') >= 0 || !exists(projectPath)) {
      results.push({ name: name, ok: false, error: 'not a project folder in the Avid Attic' });
      return next();
    }
    var zipPath = path.join(dir, 'AvidAttic-' + name.replace(/[^A-Za-z0-9._-]+/g, '_') + '-' + stamp() + '.zip');
    runPowerShell(script, {
      MFP_ATTIC_PROJECT: projectPath,
      MFP_ATTIC_ZIP: zipPath
    }, ARCHIVE_TIMEOUT_MS, function (err, stdout) {
      if (err) {
        results.push({ name: name, ok: false, error: err.message });
        return next();
      }
      if (String(stdout).indexOf('OK') < 0) {
        results.push({ name: name, ok: false, error: String(stdout).trim() });
        return next();
      }
      var size = 0;
      try {
        size = fs.statSync(zipPath).size;
      } catch (e) {
        size = 0;
      }
      if (size <= 0) {
        results.push({ name: name, ok: false, error: 'the archive is empty' });
        return next();
      }
      if (body.action === 'archive-clear') {
        try {
          removeTree(projectPath);
          results.push({ name: name, ok: true, zip: zipPath, bytes: size, cleared: true });
        } catch (e) {
          results.push({ name: name, ok: true, zip: zipPath, bytes: size, cleared: false, error: e.code || e.message });
        }
      } else {
        results.push({ name: name, ok: true, zip: zipPath, bytes: size, cleared: false });
      }
      next();
    });
  }

  function done() {
    sendJson(req, res, 200, { results: results, quarantine: dir });
  }

  next();
}

function removeTree(target) {
  if (fs.rmSync) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.readdirSync(target, { withFileTypes: true }).forEach(function (entry) {
    var full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      removeTree(full);
    } else {
      fs.unlinkSync(full);
    }
  });
  fs.rmdirSync(target);
}

// ---- bin locks ----

function handleLocks(req, res, sendJson, body) {
  var project = body.projectPath;
  if (!project || !path.isAbsolute(project)) {
    return sendJson(req, res, 400, { error: 'projectPath must be an absolute folder' });
  }
  if (!exists(project)) {
    return sendJson(req, res, 400, { error: 'Project folder not found: ' + project });
  }
  if (!isAvidPath(project)) {
    return sendJson(req, res, 403, { error: 'Not an Avid project folder (no .avp or .avb inside): ' + project });
  }
  var locks = walkFiles(project, 3, function (name) {
    return /\.lck$/i.test(name);
  }).map(function (file) {
    var owner = '';
    try {
      owner = fs.readFileSync(file, 'utf8').replace(/\u0000/g, '').trim().slice(0, 400);
    } catch (e) {
      owner = '';
    }
    var stat = null;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      stat = null;
    }
    return {
      path: file,
      name: path.basename(file).replace(/\.lck$/i, ''),
      owner: owner,
      modified: stat ? stat.mtime.toISOString() : null
    };
  });
  sendJson(req, res, 200, { projectPath: project, locks: locks, quarantine: quarantineRoot() });
}

function handleReleaseLocks(req, res, sendJson, body) {
  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }
  var project = body.projectPath;
  var files = Array.isArray(body.files) ? body.files : [];
  if (!project || !files.length) {
    return sendJson(req, res, 400, { error: 'projectPath and files are required' });
  }
  var results = [];
  files.forEach(function (file) {
    var full = path.isAbsolute(file) ? file : path.join(project, file);
    if (!/\.lck$/i.test(full) || !isUnder(full, project) || !exists(full)) {
      results.push({ file: full, ok: false, error: 'not a lock file in this project' });
      return;
    }
    try {
      results.push({ file: full, ok: true, movedTo: moveToQuarantine(full, 'released bin lock') });
    } catch (e) {
      results.push({ file: full, ok: false, error: e.code || e.message });
    }
  });
  sendJson(req, res, 200, { results: results, quarantine: quarantineRoot() });
}

// ---- MXF folders ----

function mxfFiles(folder) {
  return walkFiles(folder, 1, function (name) {
    return /\.mxf$/i.test(name);
  }).map(function (file) {
    var stat = null;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      stat = null;
    }
    return { path: file, name: path.basename(file), bytes: stat ? stat.size : 0, modified: stat ? stat.mtime.getTime() : 0 };
  });
}

function nextFolderName(folder) {
  var parent = path.dirname(folder);
  var base = path.basename(folder);
  var host = base.match(/^(.*)\.(\d+)$/);
  if (host) {
    var n = parseInt(host[2], 10) + 1;
    return path.join(parent, host[1] + '.' + n);
  }
  if (/^\d+$/.test(base)) {
    var i = parseInt(base, 10) + 1;
    while (exists(path.join(parent, String(i)))) {
      i += 1;
    }
    return path.join(parent, String(i));
  }
  return path.join(parent, base + '-2');
}

function handleMxf(req, res, sendJson, body) {
  var folder = body.folder;
  if (!folder || !path.isAbsolute(folder)) {
    return sendJson(req, res, 400, { error: 'folder must be an absolute path' });
  }
  if (!exists(folder)) {
    return sendJson(req, res, 400, { error: 'Folder not found: ' + folder });
  }
  if (!isAvidMediaPath(folder)) {
    return sendJson(req, res, 403, { error: 'Not inside an Avid MediaFiles tree: ' + folder });
  }

  if (body.action === 'count') {
    var files = mxfFiles(folder);
    var databases = fs.readdirSync(folder).filter(function (name) {
      return /^msm(MMOB\.mdb|FMID\.pmr)$/i.test(name);
    });
    return sendJson(req, res, 200, {
      folder: folder,
      count: files.length,
      bytes: files.reduce(function (sum, f) {
        return sum + f.bytes;
      }, 0),
      databases: databases,
      limit: body.limit || 5000,
      oldest: files.sort(function (a, b) {
        return a.modified - b.modified;
      }).slice(0, 5).map(function (f) {
        return { name: f.name, modified: new Date(f.modified).toISOString() };
      })
    });
  }

  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }

  if (body.action === 'split') {
    var limit = parseInt(body.limit, 10);
    if (isNaN(limit) || limit < 1) {
      limit = 5000;
    }
    var all = mxfFiles(folder);
    if (all.length <= limit) {
      return sendJson(req, res, 200, { moved: [], message: 'Nothing to split: ' + all.length + ' files, limit ' + limit + '.' });
    }
    var overflow = all.sort(function (a, b) {
      return a.modified - b.modified;
    }).slice(0, all.length - limit);
    var destination = nextFolderName(folder);
    ensureDir(destination);
    var moved = [];
    overflow.forEach(function (file) {
      try {
        fs.renameSync(file.path, path.join(destination, file.name));
        moved.push(file.name);
      } catch (e) {
        moved.push(file.name + ' (failed: ' + (e.code || e.message) + ')');
      }
    });
    return sendJson(req, res, 200, {
      moved: moved,
      destination: destination,
      remaining: all.length - overflow.length,
      message: 'Moved ' + moved.length + ' files to ' + destination + '.'
    });
  }

  if (body.action === 'quarantine-databases') {
    return mcRunning(function (running) {
      if (running) {
        return sendJson(req, res, 409, { error: 'Quit Media Composer first: it recreates these databases on exit.' });
      }
      var names = fs.readdirSync(folder).filter(function (name) {
        return /^msm(MMOB\.mdb|FMID\.pmr)$/i.test(name);
      });
      if (!names.length) {
        return sendJson(req, res, 200, { results: [], message: 'No msmMMOB.mdb or msmFMID.pmr in this folder.' });
      }
      var results = names.map(function (name) {
        var full = path.join(folder, name);
        try {
          return { file: full, ok: true, movedTo: moveToQuarantine(full, 'media database') };
        } catch (e) {
          return { file: full, ok: false, error: e.code || e.message };
        }
      });
      sendJson(req, res, 200, { results: results, quarantine: quarantineRoot() });
    });
  }

  sendJson(req, res, 400, { error: 'Unknown action: ' + body.action });
}

// ---- processes, keys, reveal ----

function handleService(req, res, sendJson, body) {
  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }
  var name = String(body.name || '');
  if (!RESTARTABLE[name]) {
    return sendJson(req, res, 400, { error: 'Not a restartable Avid process: ' + name });
  }
  var exe = 'C:\\Program Files\\Avid\\Avid Media Composer\\' + name + '.exe';
  var script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$p = Get-Process -Name $env:MFP_PROC -ErrorAction SilentlyContinue',
    'if ($p) { $p | Stop-Process -Force; Start-Sleep -Milliseconds 800 }',
    'if (Test-Path -LiteralPath $env:MFP_EXE) { Start-Process -FilePath $env:MFP_EXE; Write-Output "STARTED" }',
    'else { Write-Output ("MISSING:" + $env:MFP_EXE) }'
  ].join('\r\n');
  runPowerShell(script, { MFP_PROC: name, MFP_EXE: exe }, 60000, function (err, stdout) {
    if (err) {
      return sendJson(req, res, 500, { error: err.message });
    }
    sendJson(req, res, 200, { name: name, output: String(stdout).trim() });
  });
}

function handleKeys(req, res, sendJson, body) {
  if (body.confirm !== true) {
    return sendJson(req, res, 400, { error: 'This operation needs confirm: true' });
  }
  var action = KEY_ACTIONS[body.action];
  if (!action) {
    return sendJson(req, res, 400, { error: 'Unknown action: ' + body.action });
  }
  var script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $p = Get-Process avidmediacomposer -ErrorAction Stop | Select-Object -First 1',
    '  $shell = New-Object -ComObject WScript.Shell',
    '  if (-not $shell.AppActivate($p.Id)) { Write-Output "ERROR:Could not bring Media Composer to the front"; exit 1 }',
    '  Start-Sleep -Milliseconds 400',
    '  $shell.SendKeys($env:MFP_KEYS)',
    '  Start-Sleep -Milliseconds 350',
    '  if ($env:MFP_TEXT) {',
    '    $shell.SendKeys($env:MFP_TEXT)',
    '    Start-Sleep -Milliseconds 200',
    '    $shell.SendKeys("{ENTER}")',
    '  }',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERROR:' + ($_.Exception.Message -replace '\\s+', ' '))",
    '  exit 1',
    '}'
  ].join('\r\n');
  runPowerShell(script, {
    MFP_KEYS: action.keys,
    MFP_TEXT: action.text || '',
    MFP_ACTION: body.action
  }, 30000, function (err, stdout) {
    if (err) {
      return sendJson(req, res, 500, { error: err.message });
    }
    var text = String(stdout).trim();
    if (text.indexOf('ERROR:') === 0) {
      return sendJson(req, res, 500, { error: text.substring(6) });
    }
    sendJson(req, res, 200, { action: body.action, output: text });
  });
}

function handleReveal(req, res, sendJson, body) {
  var target = body.path;
  if (!target || !path.isAbsolute(target) || !exists(target)) {
    return sendJson(req, res, 400, { error: 'path must be an existing absolute path' });
  }
  execFile('explorer.exe', ['/select,', target], { timeout: 15000 }, function () {
    sendJson(req, res, 200, { path: target });
  });
}

// ---- router ----

module.exports = function createMaintenance(ctx) {
  var sendJson = ctx.sendJson;

  return function handle(req, res, pathname, query) {
    if (req.method === 'GET' && pathname === '/api/maint/env') {
      return handleEnv(req, res, sendJson);
    }
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'Method not allowed; use POST' });
    }
    // Same trust rule as /api/browse: only pages served from this machine may change anything.
    var origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return sendJson(req, res, 403, { error: 'Forbidden origin' });
    }
    readJsonBody(req, function (err, body) {
      if (err) {
        return sendJson(req, res, 400, { error: err.message });
      }
      try {
        if (pathname === '/api/maint/cleanup') {
          return handleCleanup(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/attic') {
          return handleAttic(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/locks') {
          return handleLocks(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/release-locks') {
          return handleReleaseLocks(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/mxf') {
          return handleMxf(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/service') {
          return handleService(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/keys') {
          return handleKeys(req, res, sendJson, body);
        }
        if (pathname === '/api/maint/reveal') {
          return handleReveal(req, res, sendJson, body);
        }
        sendJson(req, res, 404, { error: 'Unknown maintenance endpoint' });
      } catch (e) {
        sendJson(req, res, 500, { error: e.message || 'Internal error' });
      }
    });
  };
};
