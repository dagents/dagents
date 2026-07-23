/* ============================================================
   app.js — shared shell interactions
   - sidebar render + collapse
   - topbar (search ⌘K, mobile menu, avatar)
   - drawer open/close
   - tiny helpers (qs, qsa)
   Each screen page sets window.OD_NAV = { active: 'dashboard' }
   before loading this script.
   ============================================================ */
(function () {
  'use strict';

  const SVG = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"/><circle cx="5" cy="9" r="2"/><circle cx="19" cy="9" r="2"/></svg>',
    flows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="15" y="4" width="6" height="5" rx="1.5"/><rect x="9" y="15" width="6" height="5" rx="1.5"/><path d="M6 9v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9"/><path d="M12 13v2"/></svg>',
    lab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v6.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9.5V3"/><path d="M8 14h8"/></svg>',
    workspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 4 12l7 7"/><path d="M20 12H4"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
  };

  const NAV = [
    { id: 'dashboard', label: '资源看板', href: 'dashboard.html', badge: '1.04M' },
    { id: 'agents',    label: 'Agents',   href: 'agents.html',    badge: '1.04M' },
    { id: 'flows',     label: 'AgentFlows', href: 'agentflows.html', badge: '328' },
    { id: 'lab',       label: 'Lab',      href: 'lab.html' },
    { id: 'workspace', label: 'Workspace', href: null, isSection: true },
    { id: 'settings',  label: '设置',      href: 'settings.html' },
  ];

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  var _navBound = false; // guard: only bind delegation once per .nav element

  function getActive() {
    return (window.OD_NAV && window.OD_NAV.active) || 'dashboard';
  }

  function renderSidebar() {
    var nav = qs('.nav');
    if (!nav) return;
    var active = getActive();

    var html = '<button class="collapse-btn collapse-top" id="collapse-btn" type="button" aria-label="折叠侧栏" title="折叠侧栏">' +
      '<span id="collapse-ic">' + SVG.collapse + '</span>' +
      '<span id="collapse-tx">折叠</span>' +
    '</button>';

    // main nav links
    NAV.filter(function(it) { return !it.isSection && it.id !== 'settings'; }).forEach(function(it) {
      var cur = it.id === active ? ' aria-current="page"' : '';
      var badge = it.badge ? '<span class="nav-badge">' + it.badge + '</span>' : '';
      html += '<a class="nav-link" href="' + it.href + '"' + cur + ' data-nav="' + it.id + '">' +
        '<span class="nav-icon">' + (SVG[it.id] || '') + '</span>' +
        '<span class="nav-label">' + it.label + '</span>' +
        badge + '</a>';
    });

    // workspace section label + 新增 Task action
    var addTaskActive = active === 'new-task' ? ' is-active' : '';
    html += '<div class="nav-section-head">' +
      '<span class="nav-section-label nav-section-label--workspace">Workspace</span>' +
      '<a class="nav-add-task' + addTaskActive + '" href="new-task.html" data-nav="new-task" title="新增 Task" aria-label="新增 Task">' +
        SVG.plus +
      '</a>' +
    '</div>';

    // project list
    if (window.OD_WS_PROJECTS) {
      var openProj = '';
      try { openProj = localStorage.getItem('od:ws-proj') || ''; } catch(e) {}
      if (!openProj && active === 'workspace' && window.OD_WS_PROJECTS[0]) {
        openProj = window.OD_WS_PROJECTS[0].key;
      }
      window.OD_WS_PROJECTS.forEach(function(p) {
        var expanded = p.key === openProj;
        var tasks = (window.OD_WS_THREADS && window.OD_WS_THREADS[p.key]) || [];
        var taskRows = '';
        if (expanded) {
          taskRows = tasks.map(function(t) {
            var preview = t.body.replace(/<[^>]*>/g, '').slice(0, 36);
            return '<a class="nav-task" href="workspace.html?p=' + p.key + '" title="' + escapeHtml(preview) + '">' +
              '<span class="nav-task-dot"></span>' +
              '<span class="nav-task-text">' + escapeHtml(t.name) + ': ' + escapeHtml(preview) + (t.body.length > 80 ? '…' : '') + '</span>' +
            '</a>';
          }).join('');
        }
        html += '<div class="nav-project' + (expanded ? ' expanded' : '') + '" data-proj="' + p.key + '">' +
          '<button class="nav-project-head" type="button" aria-expanded="' + expanded + '" data-proj-toggle="' + p.key + '">' +
            '<span class="nav-chev">' + SVG.chevron + '</span>' +
            '<span class="nav-proj-glyph">' + p.glyph + '</span>' +
            '<span class="nav-proj-name">' + escapeHtml(p.name) + '</span>' +
            (p.unread ? '<span class="nav-badge nav-badge-unread">' + p.unread + '</span>' : '') +
          '</button>' +
          '<div class="nav-project-body">' + taskRows + '</div>' +
        '</div>';
      });
    }

    // spacer + settings at bottom
    html += '<div class="nav-spacer"></div>';
    var settingsItem = NAV.find(function(it) { return it.id === 'settings'; });
    if (settingsItem) {
      var cur = settingsItem.id === active ? ' aria-current="page"' : '';
      html += '<a class="nav-link" href="' + settingsItem.href + '"' + cur + ' data-nav="' + settingsItem.id + '">' +
        '<span class="nav-icon">' + (SVG[settingsItem.id] || '') + '</span>' +
        '<span class="nav-label">' + settingsItem.label + '</span>' +
      '</a>';
    }

    nav.innerHTML = html;

    // bind delegated click handler (only once per .nav element)
    if (!_navBound) {
      bindNavDelegation(nav);
      _navBound = true;
    }
  }

  function bindNavDelegation(nav) {
    nav.addEventListener('click', function(e) {
      // collapse button
      var collapseEl = e.target.closest('#collapse-btn');
      if (collapseEl) {
        var app = qs('.app');
        if (app) {
          var isCollapsed = app.getAttribute('data-collapsed') === 'true';
          app.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
          var tx = qs('#collapse-tx'); var ic = qs('#collapse-ic');
          if (tx) tx.textContent = isCollapsed ? '折叠' : '展开';
          if (ic) ic.style.transform = isCollapsed ? '' : 'rotate(180deg)';
        }
        e.preventDefault();
        return;
      }

      // project toggle
      var projBtn = e.target.closest('[data-proj-toggle]');
      if (projBtn) {
        e.preventDefault();
        e.stopPropagation();
        var key = projBtn.dataset.projToggle;
        var current = '';
        try { current = localStorage.getItem('od:ws-proj') || ''; } catch(err) {}
        var willOpen = current !== key;
        try { localStorage.setItem('od:ws-proj', willOpen ? key : ''); } catch(err) {}
        var proj = projBtn.closest('.nav-project');
        var body = proj ? proj.querySelector('.nav-project-body') : null;
        if (proj && body) {
          if (willOpen) {
            qsa('.nav-project.expanded').forEach(function(p) {
              p.classList.remove('expanded');
              var h = p.querySelector('.nav-project-head');
              if (h) h.setAttribute('aria-expanded', 'false');
            });
            var tasks = (window.OD_WS_THREADS && window.OD_WS_THREADS[key]) || [];
            body.innerHTML = tasks.map(function(t) {
              var preview = t.body.replace(/<[^>]*>/g, '').slice(0, 36);
              return '<a class="nav-task" href="workspace.html?p=' + key + '" title="' + escapeHtml(preview) + '">' +
                '<span class="nav-task-dot"></span>' +
                '<span class="nav-task-text">' + escapeHtml(t.name) + ': ' + escapeHtml(preview) + (t.body.length > 80 ? '…' : '') + '</span>' +
              '</a>';
            }).join('');
            proj.classList.add('expanded');
            projBtn.setAttribute('aria-expanded', 'true');
          } else {
            proj.classList.remove('expanded');
            projBtn.setAttribute('aria-expanded', 'false');
          }
        }
        return;
      }

      // task click — SPA switch on workspace page
      var taskLink = e.target.closest('.nav-task');
      if (taskLink) {
        var path = location.pathname;
        if (path.endsWith('workspace.html') || path.endsWith('/')) {
          e.preventDefault();
          var href = taskLink.getAttribute('href') || '';
          var match = href.match(/p=([^&]+)/);
          if (match) {
            var taskKey = match[1];
            var url = new URL(location.href);
            url.searchParams.set('p', taskKey);
            history.replaceState(null, '', url);
            window.dispatchEvent(new CustomEvent('od:ws-select', { detail: { key: taskKey } }));
          }
        }
        return;
      }

      // mobile menu close on nav-link click
      var navLink = e.target.closest('.nav-link');
      if (navLink) {
        var appEl = qs('.app');
        if (appEl) appEl.setAttribute('data-mobile-nav', 'closed');
      }
    });
  }

  function bindMobileMenu() {
    var app = qs('.app');
    var menuBtn = qs('.mobile-menu-btn');
    if (!app || !menuBtn) return;
    menuBtn.addEventListener('click', function() {
      var open = app.getAttribute('data-mobile-nav') === 'open';
      app.setAttribute('data-mobile-nav', open ? 'closed' : 'open');
    });
  }

  function bindSearch() {
    var input = qs('.topbar-search input');
    if (!input) return;
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); }
      if (e.key === 'Escape' && document.activeElement === input) input.blur();
    });
  }

  function bindDrawer() {
    var backdrop = qs('.drawer-backdrop');
    document.addEventListener('click', function(e) {
      var opener = e.target.closest('[data-drawer-open]');
      if (opener) {
        var sel = opener.getAttribute('data-drawer-open');
        var drawer = qs(sel);
        if (drawer) { drawer.classList.add('open'); if (backdrop) backdrop.classList.add('open'); document.body.style.overflow = 'hidden'; }
      }
      var closer = e.target.closest('[data-drawer-close]');
      if (closer || (e.target === backdrop)) {
        qsa('.drawer.open').forEach(function(d) { d.classList.remove('open'); });
        if (backdrop) backdrop.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        qsa('.drawer.open').forEach(function(d) { d.classList.remove('open'); });
        if (backdrop) backdrop.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
  }

  // public helpers
  window.OD = {
    qs: qs,
    qsa: qsa,
    svg: SVG,
    initSidebar: function() {
      _navBound = false; // reset so delegation re-binds to new .nav
      renderSidebar();
    },
    fmt: function(n) {
      if (n == null) return '—';
      if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return Number(n).toLocaleString('en-US');
    },
    money: function(n) {
      if (n == null) return '—';
      if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
      return '$' + Number(n).toFixed(2);
    },
    pct: function(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; },
  };

  function init() {
    renderSidebar();
    bindMobileMenu();
    bindSearch();
    bindDrawer();
    var app = qs('.app');
    if (app) app.setAttribute('data-collapsed', 'false');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
