(function () {
  'use strict';

  // Category tabs. Switching only toggles the hidden attribute of the panels, so nothing inside a panel
  // (including a run in progress in "Organize and Import") is reset or stopped.
  var tablist = document.getElementById('tabs');
  if (!tablist) {
    return;
  }
  var tabs = [];
  var kids = tablist.children || [];
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].getAttribute('role') === 'tab') {
      tabs.push(kids[i]);
    }
  }

  function panelOf(tab) {
    return document.getElementById(tab.getAttribute('aria-controls'));
  }

  function select(index, moveFocus) {
    for (var t = 0; t < tabs.length; t++) {
      var on = t === index;
      tabs[t].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[t].setAttribute('tabindex', on ? '0' : '-1');
      var panel = panelOf(tabs[t]);
      if (panel) {
        panel.hidden = !on;
      }
    }
    if (moveFocus && tabs[index].focus) {
      tabs[index].focus();
    }
  }

  function indexOfTab(tab) {
    for (var t = 0; t < tabs.length; t++) {
      if (tabs[t] === tab) {
        return t;
      }
    }
    return -1;
  }

  function onKey(ev) {
    var current = indexOfTab(ev.currentTarget || ev.target);
    if (current < 0) {
      return;
    }
    var key = ev.key;
    var target = -1;
    if (key === 'ArrowRight' || key === 'Right') {
      target = (current + 1) % tabs.length;
    } else if (key === 'ArrowLeft' || key === 'Left') {
      target = (current + tabs.length - 1) % tabs.length;
    } else if (key === 'Home') {
      target = 0;
    } else if (key === 'End') {
      target = tabs.length - 1;
    }
    if (target < 0) {
      return;
    }
    if (ev.preventDefault) {
      ev.preventDefault();
    }
    select(target, true);
  }

  function bind(index) {
    tabs[index].onclick = function () {
      select(index, false);
    };
    tabs[index].onkeydown = onKey;
  }

  for (var b = 0; b < tabs.length; b++) {
    bind(b);
  }
  if (tabs.length > 0) {
    select(0, false);
  }
}());
