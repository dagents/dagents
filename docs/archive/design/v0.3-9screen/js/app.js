/* ============================================================
   app.js — shared shell interactions (Open WebUI-inspired)
   - sidebar: brand, actions, nav, chat history, collapse
   - topbar: breadcrumbs, search, avatar, icon buttons
   - drawer open/close
   - mobile menu
   Each screen page sets window.OD_NAV = { active: 'agents' }
   before loading this script.
   ============================================================ */
(function () {
  'use strict';

  var SVG = {
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    'panel-left-close': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    'message-square': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>',
    'git-branch': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
    'layout-dashboard': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    'sliders-horizontal': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>',
    timer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
    'chevron-down': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  };

  var NAV = [
    { id: 'chat',       label: 'Chat',        href: '../design-redo-open-webui/pages/main.html', icon: 'message-square' },
    { id: 'agents',     label: 'Agents',      href: 'agents.html',     icon: 'cpu' },
    { id: 'flows',      label: 'AgentFlows',  href: 'agentflows.html', icon: 'git-branch' },
    { id: 'workspace',  label: 'Workspace',   href: 'workspace.html',  icon: 'layout-dashboard' },
  ];

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function(c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

  function getActive() {
    return (window.OD_NAV && window.OD_NAV.active) || 'chat';
  }

  function renderSidebar() {
    var sidebar = qs('.app-sidebar');
    if (!sidebar) return;
    var active = getActive();

    var html = '';

    // ─── Sidebar header: brand + collapse ───
    html += '<div class="sidebar-header">';
    html += '  <div class="sidebar-brand">';
    html += '    <div class="sidebar-logo">' + SVG.bot + '</div>';
    html += '    <span class="sidebar-brand-text">DAgent Console</span>';
    html += '  </div>';
    html += '  <button class="sidebar-collapse-btn" id="btn-toggle-sidebar" title="Collapse sidebar" aria-label="折叠侧栏">' + SVG['panel-left-close'] + '</button>';
    html += '</div>';

    // ─── Sidebar actions: New Chat + Search ───
    html += '<div class="sidebar-actions">';
    html += '  <a href="../design-redo-open-webui/pages/main.html" class="sidebar-action sidebar-action-primary">' + SVG.pencil + '<span>New Chat</span></a>';
    html += '  <button class="sidebar-action sidebar-action-ghost" id="btn-sidebar-search">' + SVG.search + '<span>Search</span></button>';
    html += '</div>';

    // ─── Sidebar navigation ───
    html += '<nav class="sidebar-nav">';
    NAV.forEach(function(it) {
      var cur = it.id === active ? ' aria-current="page"' : '';
      var iconSvg = SVG[it.icon] || '';
      html += '<a class="sidebar-nav-link" href="' + it.href + '"' + cur + ' data-nav="' + it.id + '">' + iconSvg + '<span>' + it.label + '</span></a>';
    });
    html += '</nav>';

    // ─── Chat history ───
    html += '<div class="sidebar-history">';
    html += '  <div class="sidebar-history-mask"></div>';
    html += '  <div class="sidebar-history-scroll no-scrollbar">';
    html += '    <div class="sidebar-history-label">Today</div>';
    // Render workspace projects as chat history items
    if (window.OD_WS_PROJECTS) {
      var tasks = window.OD_WS_THREADS || {};
      var allThreads = [];
      Object.keys(tasks).forEach(function(key) {
        (tasks[key] || []).forEach(function(t) {
          allThreads.push({ name: t.name, preview: t.body.replace(/<[^>]*>/g, '').slice(0, 40) });
        });
      });
      allThreads.slice(0, 8).forEach(function(t, i) {
        html += '<a class="sidebar-history-item" href="workspace.html">' + SVG['message-square'] + '<span class="history-title">' + escapeHtml(t.name) + '</span><button class="history-delete" title="Delete" aria-label="Delete">' + SVG.trash + '</button></a>';
      });
      if (allThreads.length === 0) {
        html += '<div style="padding:var(--space-4) var(--space-3);font-size:var(--text-sm);color:var(--meta)">No conversations yet</div>';
      }
    } else {
      html += '<a class="sidebar-history-item" href="#">' + SVG['message-square'] + '<span class="history-title">Multi-agent routing design</span><button class="history-delete" title="Delete" aria-label="Delete">' + SVG.trash + '</button></a>';
      html += '<a class="sidebar-history-item" href="#">' + SVG['message-square'] + '<span class="history-title">Token budget analysis</span><button class="history-delete" title="Delete" aria-label="Delete">' + SVG.trash + '</button></a>';
      html += '<a class="sidebar-history-item" href="#">' + SVG['message-square'] + '<span class="history-title">Agent performance review</span><button class="history-delete" title="Delete" aria-label="Delete">' + SVG.trash + '</button></a>';
    }
    html += '  </div>';
    html += '</div>';

    sidebar.innerHTML = html;
    bindSidebarEvents(sidebar);
  }

  function renderTopbar() {
    var topbar = qs('.app-topbar');
    if (!topbar || topbar.getAttribute('data-rendered') === 'true') return;
    topbar.setAttribute('data-rendered', 'true');

    var active = getActive();
    var navItem = NAV.find(function(n) { return n.id === active; });
    var pageName = navItem ? navItem.label : 'DAgent';

    var html = '';
    // Left: mobile menu
    html += '<div class="topbar-left">';
    html += '  <button class="topbar-icon-btn mobile-menu-btn" id="mobile-menu-btn" aria-label="Menu">' + SVG.menu + '</button>';
    html += '</div>';
    // Center: breadcrumbs
    html += '<div class="topbar-center">';
    html += '  <div class="crumbs"><span class="crumb">DAgent</span><span class="sep">/</span><span class="crumb-current">' + pageName + '</span></div>';
    html += '</div>';
    // Right: actions
    html += '<div class="topbar-right">';
    html += '  <button class="topbar-icon-btn" title="Settings" aria-label="Settings">' + SVG.settings + '</button>';
    html += '  <button class="topbar-icon-btn" title="Notifications" aria-label="Notifications">' + SVG.bell + '</button>';
    html += '  <button class="topbar-avatar" title="Profile">R</button>';
    html += '</div>';

    topbar.innerHTML = html;
  }

  function bindSidebarEvents(sidebar) {
    // Collapse toggle
    var collapseBtn = qs('#btn-toggle-sidebar', sidebar);
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var app = qs('.app');
        if (app) {
          var isCollapsed = app.getAttribute('data-collapsed') === 'true';
          app.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
        }
      });
    }

    // History delete buttons (delegated)
    var historyScroll = qs('.sidebar-history-scroll', sidebar);
    if (historyScroll) {
      historyScroll.addEventListener('click', function(e) {
        var delBtn = e.target.closest('.history-delete');
        if (delBtn) {
          e.preventDefault();
          e.stopPropagation();
          var item = delBtn.closest('.sidebar-history-item');
          if (item) {
            item.style.opacity = '0';
            item.style.transform = 'translateX(-10px)';
            setTimeout(function() { item.remove(); }, 150);
          }
        }
      });
    }

    // Nav link click — close mobile menu
    sidebar.addEventListener('click', function(e) {
      var navLink = e.target.closest('.sidebar-nav-link');
      if (navLink) {
        var app = qs('.app');
        if (app) app.setAttribute('data-mobile-nav', 'closed');
      }
    });
  }

  function bindMobileMenu() {
    var app = qs('.app');
    var menuBtn = qs('#mobile-menu-btn');
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
    NAV: NAV,
    initSidebar: function() {
      renderSidebar();
    },
    initTopbar: function() {
      renderTopbar();
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
    renderTopbar();
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
