(function () {
  'use strict';

  // Collapsible tool sections. Every details.tool-section with an id keeps its open/closed state for
  // the life of the panel session: switching tabs keeps the DOM, and a page refresh restores the state
  // from sessionStorage. A new panel session starts with the defaults in index.html.
  var STORAGE_KEY = 'avidSwissArmyKnife.sections.v1';
  var SECTION_SELECTOR = 'details.tool-section[id]';

  function readState() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return {};
      }
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Remembering the state is a convenience; sections still work without storage.
    }
  }

  function closestPanel(node) {
    while (node && node !== document) {
      if (node.className && (' ' + node.className + ' ').indexOf(' tabpanel ') !== -1) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  var sections = [];
  var nodes = document.querySelectorAll(SECTION_SELECTOR);
  for (var i = 0; i < nodes.length; i++) {
    sections.push(nodes[i]);
  }

  var state = readState();
  for (i = 0; i < sections.length; i++) {
    var id = sections[i].id;
    if (Object.prototype.hasOwnProperty.call(state, id) && typeof state[id] === 'boolean') {
      sections[i].open = state[id];
    }
  }

  function saveState() {
    var next = {};
    for (var s = 0; s < sections.length; s++) {
      next[sections[s].id] = sections[s].open;
    }
    writeState(next);
  }

  var controls = [];
  var buttons = document.querySelectorAll('.sections-all');
  for (var b = 0; b < buttons.length; b++) {
    var panel = closestPanel(buttons[b]);
    if (panel) {
      controls.push({ button: buttons[b], panel: panel });
    }
  }

  function updateButtons() {
    for (var c = 0; c < controls.length; c++) {
      var list = controls[c].panel.querySelectorAll(SECTION_SELECTOR);
      var open = false;
      for (var s = 0; s < list.length; s++) {
        if (list[s].open) {
          open = true;
          break;
        }
      }
      controls[c].button.textContent = open ? 'Collapse all' : 'Expand all';
      controls[c].button.title = open ? 'Collapse every section on this tab' : 'Expand every section on this tab';
    }
  }

  function toggleAll(control) {
    var list = control.panel.querySelectorAll(SECTION_SELECTOR);
    var open = false;
    for (var s = 0; s < list.length; s++) {
      if (list[s].open) {
        open = true;
        break;
      }
    }
    for (s = 0; s < list.length; s++) {
      list[s].open = !open;
    }
    saveState();
    updateButtons();
  }

  for (var c = 0; c < controls.length; c++) {
    (function (control) {
      control.button.onclick = function () {
        toggleAll(control);
      };
    }(controls[c]));
  }

  function onToggle() {
    saveState();
    updateButtons();
  }

  for (i = 0; i < sections.length; i++) {
    sections[i].addEventListener('toggle', onToggle);
  }

  updateButtons();
}());
