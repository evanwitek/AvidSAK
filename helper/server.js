'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');
var execFile = require('child_process').execFile;
var createMaintenance = require('./maintenance');

var HOST = '127.0.0.1';
// MFP_PORT lets a second copy run for testing; the installed helper uses the default.
var PORT = Number(process.env.MFP_PORT) || 47831;
var PANEL_DIR = path.resolve(__dirname, '..', 'panel');
var CONFIG_PATH = path.join(__dirname, 'config.json');
var DEFAULT_DEPTH = 3;
var MAX_DEPTH = 10;
var BROWSE_TIMEOUT_MS = 5 * 60 * 1000;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// config.json is optional: without it there are no pre-approved roots and only Browse... picks are served.
function loadConfig() {
  var raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { allowedRoots: [] };
    }
    throw e;
  }
  var cfg = JSON.parse(raw);
  if (!cfg || !Array.isArray(cfg.allowedRoots)) {
    throw new Error('config.json must contain an "allowedRoots" array');
  }
  return cfg;
}

var config;
try {
  config = loadConfig();
} catch (e) {
  console.error('Could not read ' + CONFIG_PATH + ': ' + e.message);
  process.exit(1);
}

function normalizeForCompare(p) {
  var n = path.resolve(p);
  if (process.platform === 'win32') {
    n = n.toLowerCase();
  }
  return n;
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.resolve(p);
  }
}

function isUnder(child, root) {
  var c = normalizeForCompare(child);
  var r = normalizeForCompare(root);
  if (c === r) {
    return true;
  }
  var prefix = r.charAt(r.length - 1) === path.sep ? r : r + path.sep;
  return c.indexOf(prefix) === 0;
}

// Folders chosen with the OS folder dialog (POST /api/browse). In memory only: cleared when the helper restarts.
var pickedRoots = [];

function addPickedRoot(p) {
  var resolved = path.resolve(p);
  var key = normalizeForCompare(resolved);
  for (var i = 0; i < pickedRoots.length; i++) {
    if (normalizeForCompare(pickedRoots[i]) === key) {
      return;
    }
  }
  pickedRoots.push(resolved);
}

function allRoots() {
  var roots = config.allowedRoots.slice();
  var seen = {};
  roots.forEach(function (r) {
    seen[normalizeForCompare(r)] = true;
  });
  pickedRoots.forEach(function (r) {
    if (!seen[normalizeForCompare(r)]) {
      roots.push(r);
    }
  });
  return roots;
}

function isAllowed(target) {
  var resolved = path.resolve(target);
  var real = realOrResolved(resolved);
  var roots = allRoots();
  for (var i = 0; i < roots.length; i++) {
    var root = roots[i];
    if (isUnder(resolved, root) && isUnder(real, realOrResolved(root))) {
      return true;
    }
  }
  return false;
}

function corsHeaders(req) {
  var origin = req.headers.origin;
  var headers = {};
  if (origin) {
    try {
      var host = new url.URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
    } catch (e) {
      // ignore malformed origin
    }
  }
  return headers;
}

function sendJson(req, res, status, body) {
  var headers = corsHeaders(req);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Cache-Control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function buildNode(fullPath, name, depth) {
  var node = { name: name, path: fullPath, type: 'folder' };
  if (depth <= 0) {
    node.children = [];
    node.loaded = false;
    return node;
  }
  var entries = fs.readdirSync(fullPath, { withFileTypes: true });
  var folders = [];
  var files = [];
  entries.forEach(function (entry) {
    var childPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      try {
        folders.push(buildNode(childPath, entry.name, depth - 1));
      } catch (e) {
        folders.push({ name: entry.name, path: childPath, type: 'folder', children: [], loaded: false, error: e.code || 'ERROR' });
      }
    } else if (entry.isFile()) {
      var size = 0;
      try {
        size = fs.statSync(childPath).size;
      } catch (e) {
        size = 0;
      }
      files.push({ name: entry.name, path: childPath, type: 'file', size: size });
    }
  });
  function byName(a, b) {
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
  }
  folders.sort(byName);
  files.sort(byName);
  node.children = folders.concat(files);
  node.loaded = true;
  return node;
}

function handleTree(req, res, query) {
  var target = query.path;
  if (!target) {
    return sendJson(req, res, 400, { error: 'Missing "path" query parameter' });
  }
  if (!path.isAbsolute(target)) {
    return sendJson(req, res, 400, { error: 'Path must be absolute' });
  }
  if (!isAllowed(target)) {
    return sendJson(req, res, 403, { error: 'Path is not under an allowed root' });
  }
  var depth = DEFAULT_DEPTH;
  if (query.depth !== undefined) {
    depth = parseInt(query.depth, 10);
    if (isNaN(depth) || depth < 0) {
      return sendJson(req, res, 400, { error: 'depth must be a non-negative integer' });
    }
    if (depth > MAX_DEPTH) {
      depth = MAX_DEPTH;
    }
  }
  var resolved = path.resolve(target);
  var stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return sendJson(req, res, 404, { error: 'Folder not found' });
    }
    throw e;
  }
  if (!stat.isDirectory()) {
    return sendJson(req, res, 400, { error: 'Path is not a folder' });
  }
  var name = path.basename(resolved) || resolved;
  sendJson(req, res, 200, buildNode(resolved, name, depth));
}

// The folder and file dialogs are the Windows Explorer-style picker: the IFileOpenDialog COM interface, with
// FOS_PICKFOLDERS for folders and without it (plus a file type filter) for files (the same dialog "Open" uses).
// It is declared in C# and compiled in the PowerShell process with Add-Type. The C# is kept to the C# 5 subset
// that Windows PowerShell 5.1 compiles.
var BROWSE_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  '',
  '[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]',
  'public class MfpFileOpenDialogCom { }',
  '',
  '[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'public interface IShellItem {',
  '  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);',
  '  void GetParent(out IShellItem ppsi);',
  '  void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);',
  '  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);',
  '  void Compare(IShellItem psi, uint hint, out int piOrder);',
  '}',
  '',
  '// IFileOpenDialog with the IModalWindow and IFileDialog methods flattened in vtable order.',
  '[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'public interface IFileOpenDialog {',
  '  [PreserveSig] int Show(IntPtr hwndOwner);',
  '  // rgFilterSpec points at an array of COMDLG_FILTERSPEC { LPCWSTR pszName; LPCWSTR pszSpec; }, built by hand in MakeFilters.',
  '  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);',
  '  void SetFileTypeIndex(uint iFileType);',
  '  void GetFileTypeIndex(out uint piFileType);',
  '  void Advise(IntPtr pfde, out uint pdwCookie);',
  '  void Unadvise(uint dwCookie);',
  '  void SetOptions(uint fos);',
  '  void GetOptions(out uint pfos);',
  '  void SetDefaultFolder(IShellItem psi);',
  '  void SetFolder(IShellItem psi);',
  '  void GetFolder(out IShellItem ppsi);',
  '  void GetCurrentSelection(out IShellItem ppsi);',
  '  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
  '  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);',
  '  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);',
  '  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);',
  '  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);',
  '  void GetResult(out IShellItem ppsi);',
  '  void AddPlace(IShellItem psi, int fdap);',
  '  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);',
  '  void Close(int hr);',
  '  void SetClientGuid(ref Guid guid);',
  '  void ClearClientData();',
  '  void SetFilter(IntPtr pFilter);',
  '  void GetResults(out IntPtr ppenum);',
  '  void GetSelectedItems(out IntPtr ppsai);',
  '}',
  '',
  'public static class MfpPicker {',
  '  const int HR_CANCELLED = unchecked((int)0x800704C7);',
  '  const uint FOS_PICKFOLDERS = 0x20;',
  '  const uint FOS_FORCEFILESYSTEM = 0x40;',
  '  const uint FOS_PATHMUSTEXIST = 0x800;',
  '  const uint FOS_FILEMUSTEXIST = 0x1000;',
  '  const uint SIGDN_FILESYSPATH = 0x80058000;',
  '  const uint WS_POPUP = 0x80000000;',
  '  const uint WS_EX_TOOLWINDOW = 0x80;',
  '  const uint WS_EX_TOPMOST = 0x8;',
  '',
  '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]',
  '  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hWnd);',
  '',
  '  public static IShellItem ItemFromPath(string path) {',
  '    Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");',
  '    IShellItem item;',
  '    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);',
  '    return item;',
  '  }',
  '',
  '  public static string PathOf(IShellItem item) {',
  '    string p;',
  '    item.GetDisplayName(SIGDN_FILESYSPATH, out p);',
  '    return p;',
  '  }',
  '',
  '  // Invisible, zero-size, topmost owner so the dialog opens in front of other windows. IntPtr.Zero if it cannot be made.',
  '  static IntPtr CreateOwner() {',
  '    try {',
  '      IntPtr h = CreateWindowEx(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, "STATIC", "", WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);',
  '      if (h != IntPtr.Zero) {',
  '        ShowWindow(h, 4);',
  '        SetForegroundWindow(h);',
  '      }',
  '      return h;',
  '    } catch (Exception) {',
  '      return IntPtr.Zero;',
  '    }',
  '  }',
  '',
  '  // Builds the COMDLG_FILTERSPEC array for SetFileTypes. Freed by FreeFilters.',
  '  static IntPtr MakeFilters(string[] names, string[] specs) {',
  '    IntPtr block = Marshal.AllocCoTaskMem(IntPtr.Size * 2 * names.Length);',
  '    for (int i = 0; i < names.Length; i++) {',
  '      Marshal.WriteIntPtr(block, IntPtr.Size * 2 * i, Marshal.StringToCoTaskMemUni(names[i]));',
  '      Marshal.WriteIntPtr(block, IntPtr.Size * (2 * i + 1), Marshal.StringToCoTaskMemUni(specs[i]));',
  '    }',
  '    return block;',
  '  }',
  '',
  '  static void FreeFilters(IntPtr block, int count) {',
  '    if (block == IntPtr.Zero) {',
  '      return;',
  '    }',
  '    for (int i = 0; i < count * 2; i++) {',
  '      Marshal.FreeCoTaskMem(Marshal.ReadIntPtr(block, IntPtr.Size * i));',
  '    }',
  '    Marshal.FreeCoTaskMem(block);',
  '  }',
  '',
  '  // Returns the chosen folder, or null if the user cancelled. Throws on any other failure.',
  '  public static string Pick(string title, string startPath) {',
  '    return Show(title, startPath, false);',
  '  }',
  '',
  '  // Returns the chosen file, or null if the user cancelled. Throws on any other failure.',
  '  // Filters: transcript text (*.txt), then every file. The first filter is selected.',
  '  public static string PickFile(string title, string startPath) {',
  '    return Show(title, startPath, true);',
  '  }',
  '',
  '  static string Show(string title, string startPath, bool files) {',
  '    IntPtr owner = CreateOwner();',
  '    IFileOpenDialog dlg = (IFileOpenDialog)new MfpFileOpenDialogCom();',
  '    IntPtr filters = IntPtr.Zero;',
  '    int filterCount = 0;',
  '    try {',
  '      uint opts;',
  '      dlg.GetOptions(out opts);',
  '      if (files) {',
  '        dlg.SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST);',
  '        string[] filterNames = new string[] { "Transcript text files (*.txt)", "All files (*.*)" };',
  '        string[] filterSpecs = new string[] { "*.txt", "*.*" };',
  '        filterCount = filterNames.Length;',
  '        filters = MakeFilters(filterNames, filterSpecs);',
  '        dlg.SetFileTypes((uint)filterCount, filters);',
  '        dlg.SetFileTypeIndex(1);',
  '      } else {',
  '        dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);',
  '      }',
  '      dlg.SetTitle(title);',
  '      if (!string.IsNullOrEmpty(startPath)) {',
  '        try {',
  '          IShellItem start = ItemFromPath(startPath);',
  '          dlg.SetFolder(start);',
  '          Marshal.ReleaseComObject(start);',
  '        } catch (Exception) {',
  '          // an unusable start folder only means the dialog opens where Windows chooses',
  '        }',
  '      }',
  '      int hr = dlg.Show(owner);',
  '      if (hr == HR_CANCELLED) {',
  '        return null;',
  '      }',
  '      if (hr != 0) {',
  '        Marshal.ThrowExceptionForHR(hr);',
  '      }',
  '      IShellItem result;',
  '      dlg.GetResult(out result);',
  '      try {',
  '        return PathOf(result);',
  '      } finally {',
  '        Marshal.ReleaseComObject(result);',
  '      }',
  '    } finally {',
  '      Marshal.ReleaseComObject(dlg);',
  '      FreeFilters(filters, filterCount);',
  '      if (owner != IntPtr.Zero) {',
  '        DestroyWindow(owner);',
  '      }',
  '    }',
  '  }',
  '}'
].join('\r\n');

// PowerShell script that shows the folder dialog (mode 'folder') or the file dialog (mode 'file'). It is sent
// with -EncodedCommand, so it needs no quoting. The start folder arrives in the MFP_START_PATH environment
// variable, never in the script text.
// Output: "PATH:<base64 of the UTF-8 path>", "CANCEL", or "ERROR:<message>".
function buildBrowseScript(mode) {
  var call = mode === 'file'
    ? "[MfpPicker]::PickFile('Choose a transcript or script file', $start)"
    : "[MfpPicker]::Pick('Choose a media folder', $start)";
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $src = @'",
    BROWSE_CSHARP,
    "'@",
    // Compiling the C# costs seconds, so the compiled DLL is cached in the per-user cache folder (MFP_CACHE_DIR,
    // %LOCALAPPDATA%\AvidSAK\cache). The file name carries a hash of the C#, so a changed source recompiles.
    // A cached DLL is loaded with plain .NET calls: they are much quicker than the Add-Type and Test-Path cmdlets,
    // which load PowerShell modules first. Any cache failure falls back to the in-memory compile.
    '  $loaded = $false',
    '  try {',
    '    $cacheDir = $env:MFP_CACHE_DIR',
    '    if ($cacheDir) {',
    '      $sha = [Security.Cryptography.SHA256]::Create()',
    '      $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src))) -replace "-", "").Substring(0, 16).ToLower()',
    "      $dll = [IO.Path]::Combine($cacheDir, 'MfpPicker-' + $hash + '.dll')",
    '      if (-not [IO.File]::Exists($dll)) {',
    '        [void][IO.Directory]::CreateDirectory($cacheDir)',
    "        $tmp = [IO.Path]::Combine($cacheDir, 'MfpPicker-' + $hash + '-' + $PID + '.tmp.dll')",
    '        Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $tmp',
    '        try {',
    '          [IO.File]::Move($tmp, $dll)',
    '        } catch {',
    '          try { [IO.File]::Delete($tmp) } catch { }',
    '        }',
    '      }',
    "      if (-not ('MfpPicker' -as [type]) -and [IO.File]::Exists($dll)) {",
    '        try {',
    '          [void][Reflection.Assembly]::LoadFrom($dll)',
    '        } catch {',
    '          try { [IO.File]::Delete($dll) } catch { }',
    '        }',
    '      }',
    "      $loaded = [bool]('MfpPicker' -as [type])",
    '    }',
    '  } catch {',
    "    $loaded = [bool]('MfpPicker' -as [type])",
    '  }',
    '  if (-not $loaded) {',
    '    Add-Type -TypeDefinition $src -Language CSharp',
    '  }',
    '  $start = $env:MFP_START_PATH',
    '  if (-not ($start -and (Test-Path -LiteralPath $start -PathType Container))) { $start = $null }',
    '  $picked = ' + call,
    '  if ($picked) {',
    "    Write-Output ('PATH:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picked)))",
    '  } else {',
    "    Write-Output 'CANCEL'",
    '  }',
    '} catch {',
    "  Write-Output ('ERROR:' + ($_.Exception.Message -replace '\\s+', ' '))",
    '  exit 1',
    '}'
  ].join('\r\n');
}
var BROWSE_SCRIPTS = { folder: buildBrowseScript('folder'), file: buildBrowseScript('file') };
var lastPicked = null;
var lastPickedFileDir = null;
// Files chosen with the file dialog (POST /api/browse-file). Only these can be read back with
// POST /api/read-file. In memory only: cleared when the helper restarts.
var pickedFiles = [];
var MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
// One dialog at a time, folder or file.
var browseInProgress = false;

function addPickedFile(p) {
  var key = normalizeForCompare(p);
  for (var i = 0; i < pickedFiles.length; i++) {
    if (normalizeForCompare(pickedFiles[i]) === key) {
      return;
    }
  }
  pickedFiles.push(path.resolve(p));
}

function isPickedFile(p) {
  var key = normalizeForCompare(p);
  for (var i = 0; i < pickedFiles.length; i++) {
    if (normalizeForCompare(pickedFiles[i]) === key) {
      return true;
    }
  }
  return false;
}

// mode is 'folder' or 'file'. callback(err, chosenPathOrNull)
function runDialog(mode, startPath, callback) {
  var label = mode === 'file' ? 'file' : 'folder';
  var env = {};
  Object.keys(process.env).forEach(function (k) {
    env[k] = process.env[k];
  });
  env.MFP_START_PATH = startPath || '';
  env.MFP_CACHE_DIR = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'AvidSAK', 'cache') : '';
  var encoded = Buffer.from(BROWSE_SCRIPTS[mode], 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
    env: env,
    timeout: BROWSE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  }, function (err, stdout, stderr) {
    var lines = String(stdout || '').split(/\r?\n/);
    var result = null;
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (line === 'CANCEL' || line.indexOf('PATH:') === 0 || line.indexOf('ERROR:') === 0) {
        result = line;
        break;
      }
    }
    if (result === 'CANCEL') {
      return callback(null, null);
    }
    if (result && result.indexOf('PATH:') === 0) {
      return callback(null, Buffer.from(result.substring(5), 'base64').toString('utf8'));
    }
    if (err && err.killed) {
      return callback(new Error('The ' + label + ' dialog timed out after ' + (BROWSE_TIMEOUT_MS / 60000) + ' minutes.'));
    }
    if (result) {
      return callback(new Error('The ' + label + ' dialog failed: ' + result.substring(6)));
    }
    var detail = String(stderr || '').trim().split(/\r?\n/)[0];
    callback(new Error('The ' + label + ' dialog failed' + (err && err.code ? ' (' + err.code + ')' : '') + (detail ? ': ' + detail : '.')));
  });
}

// The panel is served by this helper (same origin). Refuse requests that come from other websites.
function originAllowed(req) {
  var origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    var host = new url.URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch (e) {
    return false;
  }
}

function sendMethodNotAllowed(req, res) {
  var bh = corsHeaders(req);
  bh['Allow'] = 'POST, OPTIONS';
  bh['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(405, bh);
  res.end(JSON.stringify({ error: 'Method not allowed; use POST' }));
}

// Origin, platform and "one dialog at a time" checks shared by both dialogs. Returns true if the request may go on.
function checkDialogRequest(req, res, label) {
  req.resume();
  if (!originAllowed(req)) {
    sendJson(req, res, 403, { error: 'Forbidden origin' });
    return false;
  }
  if (process.platform !== 'win32') {
    sendJson(req, res, 501, { error: 'The ' + label + ' dialog is only available on Windows.' });
    return false;
  }
  if (browseInProgress) {
    sendJson(req, res, 409, { error: 'A ' + label + ' dialog is already open. Look for it behind other windows.' });
    return false;
  }
  return true;
}

function handleBrowse(req, res) {
  if (!checkDialogRequest(req, res, 'folder')) {
    return;
  }
  browseInProgress = true;
  runDialog('folder', lastPicked, function (err, chosen) {
    browseInProgress = false;
    if (err) {
      console.error(err.message);
      return sendJson(req, res, 500, { error: err.message });
    }
    if (chosen === null) {
      return sendJson(req, res, 200, { path: null });
    }
    var resolved = path.resolve(chosen);
    var isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch (e) {
      isDir = false;
    }
    if (!isDir) {
      return sendJson(req, res, 500, { error: 'The chosen path is not a folder: ' + resolved });
    }
    lastPicked = resolved;
    addPickedRoot(resolved);
    console.log('Picked root: ' + resolved);
    sendJson(req, res, 200, { path: resolved });
  });
}

// POST /api/browse-file: the file dialog. Answers {path} or {path: null} (cancelled). The file's folder is
// not added to the roots served by /api/tree; the file itself becomes readable by /api/read-file.
function handleBrowseFile(req, res) {
  if (!checkDialogRequest(req, res, 'file')) {
    return;
  }
  browseInProgress = true;
  runDialog('file', lastPickedFileDir, function (err, chosen) {
    browseInProgress = false;
    if (err) {
      console.error(err.message);
      return sendJson(req, res, 500, { error: err.message });
    }
    if (chosen === null) {
      return sendJson(req, res, 200, { path: null });
    }
    var resolved = path.resolve(chosen);
    var isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch (e) {
      isFile = false;
    }
    if (!isFile) {
      return sendJson(req, res, 500, { error: 'The chosen path is not a file: ' + resolved });
    }
    lastPickedFileDir = path.dirname(resolved);
    addPickedFile(resolved);
    console.log('Picked file: ' + resolved);
    sendJson(req, res, 200, { path: resolved });
  });
}

// Decodes a transcript file: UTF-8 (BOM stripped) or UTF-16 LE with a BOM. Returns {text} or {error}.
function decodeTextFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: buf.toString('utf16le', 2) };
  }
  var start = (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
  for (var i = start; i < buf.length; i++) {
    if (buf[i] === 0) {
      return { error: 'The file does not look like a text file (it contains NUL bytes).' };
    }
  }
  return { text: buf.toString('utf8', start) };
}

// POST /api/read-file?path=...: the text of a file the user chose with /api/browse-file in this helper session.
// Any other path is refused, so this is not a general file reader.
function handleReadFile(req, res, query) {
  req.resume();
  if (!originAllowed(req)) {
    return sendJson(req, res, 403, { error: 'Forbidden origin' });
  }
  var target = query.path;
  if (!target) {
    return sendJson(req, res, 400, { error: 'Missing "path" query parameter' });
  }
  if (!path.isAbsolute(target)) {
    return sendJson(req, res, 400, { error: 'Path must be absolute' });
  }
  var resolved = path.resolve(target);
  if (!isPickedFile(resolved)) {
    return sendJson(req, res, 403, { error: 'Only a file chosen with Browse... in this helper session can be read. Choose the file again.' });
  }
  var stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return sendJson(req, res, 404, { error: 'File not found: ' + resolved });
    }
    return sendJson(req, res, 500, { error: 'Cannot read the file: ' + (e.code || e.message) });
  }
  if (!stat.isFile()) {
    return sendJson(req, res, 400, { error: 'Path is not a file' });
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    return sendJson(req, res, 413, { error: 'The file is larger than ' + (MAX_READ_FILE_BYTES / 1024 / 1024) + ' MB.' });
  }
  fs.readFile(resolved, function (err, buf) {
    if (err) {
      return sendJson(req, res, 500, { error: 'Cannot read the file: ' + (err.code || err.message) });
    }
    var decoded = decodeTextFile(buf);
    if (decoded.error) {
      return sendJson(req, res, 415, { error: decoded.error });
    }
    sendJson(req, res, 200, { path: resolved, name: path.basename(resolved), size: stat.size, text: decoded.text });
  });
}

function serveStatic(req, res, pathname) {
  var rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return sendJson(req, res, 400, { error: 'Bad request path' });
  }
  if (rel === '/' || rel === '') {
    rel = '/index.html';
  }
  var filePath = path.resolve(PANEL_DIR, '.' + rel);
  if (!isUnder(filePath, PANEL_DIR)) {
    return sendJson(req, res, 403, { error: 'Forbidden' });
  }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      return sendJson(req, res, 404, { error: 'Not found' });
    }
    var headers = corsHeaders(req);
    headers['Content-Type'] = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    headers['Content-Length'] = stat.size;
    headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    var stream = fs.createReadStream(filePath);
    stream.on('error', function () {
      res.destroy();
    });
    stream.pipe(res);
  });
}

var maintenance = createMaintenance({ sendJson: sendJson });

var server = http.createServer(function (req, res) {
  try {
    var u = new url.URL(req.url, 'http://' + HOST + ':' + PORT);
    var query = {};
    u.searchParams.forEach(function (value, key) {
      query[key] = value;
    });
    var parsed = { pathname: u.pathname, query: query };
    if (req.method === 'OPTIONS') {
      var h = corsHeaders(req);
      h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      h['Access-Control-Allow-Headers'] = 'Content-Type';
      res.writeHead(204, h);
      return res.end();
    }
    if (parsed.pathname.indexOf('/api/maint/') === 0) {
      return maintenance(req, res, parsed.pathname, parsed.query);
    }
    if (parsed.pathname === '/api/browse' || parsed.pathname === '/api/browse-file' || parsed.pathname === '/api/read-file') {
      if (req.method !== 'POST') {
        return sendMethodNotAllowed(req, res);
      }
      if (parsed.pathname === '/api/browse') {
        return handleBrowse(req, res);
      }
      if (parsed.pathname === '/api/browse-file') {
        return handleBrowseFile(req, res);
      }
      return handleReadFile(req, res, parsed.query);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'Method not allowed' });
    }
    if (parsed.pathname === '/api/roots') {
      return sendJson(req, res, 200, {
        allowedRoots: allRoots(),
        configuredRoots: config.allowedRoots,
        pickedRoots: pickedRoots,
        lastPicked: lastPicked
      });
    }
    if (parsed.pathname === '/api/tree') {
      return handleTree(req, res, parsed.query);
    }
    if (parsed.pathname.indexOf('/api/') === 0) {
      return sendJson(req, res, 404, { error: 'Unknown API endpoint' });
    }
    serveStatic(req, res, parsed.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      sendJson(req, res, 500, { error: e.message || 'Internal server error' });
    } else {
      res.destroy();
    }
  }
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' on ' + HOST + ' is already in use. Another copy of the helper may already be running; stop it and try again.');
  } else {
    console.error('Server error: ' + e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  console.log('Media Folder Panel helper listening on http://' + HOST + ':' + PORT + '/');
  console.log('Pre-approved roots: ' + (config.allowedRoots.length ? config.allowedRoots.join(', ') : '(none; use Browse... in the panel)'));
});
