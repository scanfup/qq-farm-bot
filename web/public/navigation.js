(() => {
  'use strict';
  const pages = { farm: '农场', pasture: '牧场', settings: '优先设置' };
  const sidebar = document.querySelector('#activitySidebar');
  const toggle = document.querySelector('#activityToggle');
  const close = document.querySelector('#activityClose');
  const backdrop = document.querySelector('#activityBackdrop');
  const mobile = window.matchMedia('(max-width: 999px)');
  let currentPage = null;
  let returnFocus = null;

  function setActivity(open, restoreFocus = true) {
    const show = mobile.matches && open;
    document.body.classList.toggle('activity-open', show);
    toggle.setAttribute('aria-expanded', String(show));
    backdrop.hidden = !show;
    sidebar.inert = mobile.matches && !show;
    if (sidebar.inert) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
    if (show) {
      returnFocus = document.activeElement;
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      close.focus({ preventScroll: true });
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function route() {
    const match = /^#\/(farm|pasture|friends|settings)\/?$/.exec(window.location.hash);
    const requested = match?.[1] || 'farm';
    const page = requested === 'friends' ? 'farm' : requested;
    if (!match || requested === 'friends') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/farm`);
    for (const element of document.querySelectorAll('[data-page]')) element.hidden = element.dataset.page !== page;
    for (const link of document.querySelectorAll('[data-route]')) {
      const active = link.dataset.route === page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `${pages[page]} · QQ 农场控制台`;
    if (currentPage !== null && currentPage !== page) {
      setActivity(false, false);
      document.querySelector('#pageMain').scrollTop = 0;
      window.scrollTo({ top: 0, behavior: 'auto' });
      const heading = document.querySelector(`[data-page="${page}"] h1`);
      heading?.setAttribute('tabindex', '-1');
      heading?.focus({ preventScroll: true });
    }
    currentPage = page;
  }

  toggle.addEventListener('click', () => setActivity(!document.body.classList.contains('activity-open')));
  close.addEventListener('click', () => setActivity(false));
  backdrop.addEventListener('click', () => setActivity(false));
  mobile.addEventListener('change', () => setActivity(false));
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', event => {
    if (!document.body.classList.contains('activity-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setActivity(false); }
    if (event.key !== 'Tab') return;
    const controls = [...sidebar.querySelectorAll('button, a[href], summary, input, select, [tabindex="0"]')]
      .filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  const lands = document.querySelector('#landsDisclosure');
  try { lands.open = window.localStorage.getItem('qqfarm.ui.landsExpanded') === 'true'; } catch (_) { /* Storage can be disabled. */ }
  lands.addEventListener('toggle', () => {
    try { window.localStorage.setItem('qqfarm.ui.landsExpanded', String(lands.open)); } catch (_) { /* Keep it usable without storage. */ }
  });
  setActivity(false, false);
  route();
})();
