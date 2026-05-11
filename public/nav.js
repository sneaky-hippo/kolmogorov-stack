(function () {
  // Two header conventions in the repo:
  //   newer: <header class="site-header"> + .site-nav + .site-actions
  //   older: <header class="site"> with .left>nav + .right
  // nav.js handles both: applies the active class on whichever pre-baked
  // 3-item nav already lives in the HTML, then wires mobile toggle clicks.
  // It does NOT rewrite innerHTML — that caused visible layout shift on
  // every navigation as the DOM mutated mid-paint.
  var header = document.querySelector('header.site-header, header.site');
  if (!header) return;

  var isLegacy = header.classList.contains('site') && !header.classList.contains('site-header');
  var nav = isLegacy ? header.querySelector('.left nav, nav') : header.querySelector('.site-nav');
  var actions = isLegacy ? header.querySelector('.right') : header.querySelector('.site-actions');
  if (!nav || !actions) return;

  // Active state only. Path-driven; idempotent; never rewrites innerHTML.
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  var devRe = /^\/(docs|compile|run|recall|serve|evolve|anatomy|k-score|spec|api|sdk|build-your-own|quickstart|integrations|articles|cookbook|architecture|benchmarks|leaderboard|launch|troubleshooting|faq|press|changelog)(\/|$)/;
  var solRe = /^\/(use-cases|healthcare|finance|legal|defense|edge|enterprise|customers|roi|whitepaper|motion|baa)(\/|$)/;
  var prRe  = /^\/pricing(\/|$)/;
  var anchors = nav.querySelectorAll('a');
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var href = a.getAttribute('href') || '';
    var isActive =
      (href === '/use-cases' && solRe.test(path)) ||
      (href === '/docs'      && devRe.test(path)) ||
      (href === '/pricing'   && prRe.test(path));
    if (isActive) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    } else {
      a.classList.remove('active');
      a.removeAttribute('aria-current');
    }
  }

  // Strip github star button — keep right side compact (theme + sign in + CTA).
  var gh = actions.querySelector('#gh-star, .gh-star');
  if (gh && gh.parentNode) gh.parentNode.removeChild(gh);

  // Auth-aware status pill. Reads kolm_api_key (and aliases) from localStorage
  // and renders a tiny "signed in" indicator next to the actions so the user
  // never feels like a navigation dropped them. Idempotent — re-runs replace
  // the existing pill rather than stacking.
  var KEY_NAMES = ['kolm_api_key', 'apiKey', 'recipeApiKey', 'ks_api_key'];
  function readKey() {
    try { for (var i = 0; i < KEY_NAMES.length; i++) { var v = localStorage.getItem(KEY_NAMES[i]); if (v) return v; } } catch (e) {}
    return '';
  }
  var existingPill = actions.querySelector('.kolm-auth-pill');
  if (existingPill && existingPill.parentNode) existingPill.parentNode.removeChild(existingPill);
  if (readKey()) {
    var pill = document.createElement('a');
    pill.href = '/dashboard';
    pill.className = 'kolm-auth-pill kolm-auth-pill--in';
    pill.setAttribute('aria-label', 'Signed in — open dashboard');
    pill.innerHTML = '<span class="dot"></span><span class="lbl">signed in</span>';
    actions.insertBefore(pill, actions.firstChild);
  }

  // Theme toggle is pre-baked. Wire the click handler.
  var tt = actions.querySelector('.theme-toggle');
  if (tt && !tt.__kolm_wired) {
    tt.__kolm_wired = true;
    tt.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      var nxt = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', nxt);
      try { localStorage.setItem('kolm-theme', nxt); } catch (e) {}
    });
  }

  // Mobile nav-toggle is pre-baked. Wire its handler. (Only create if a page
  // didn't get the pre-bake — covers legacy templates we haven't touched.)
  var btn = header.querySelector('.nav-toggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-label', 'Toggle navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    if (!nav.id) nav.id = 'site-nav';
    btn.setAttribute('aria-controls', nav.id);
    actions.insertBefore(btn, actions.firstChild);
  }
  if (btn.__kolm_wired) return;
  btn.__kolm_wired = true;
  if (!nav.id) nav.id = 'site-nav';
  if (!btn.getAttribute('aria-controls')) btn.setAttribute('aria-controls', nav.id);

  function setOpen(open) {
    btn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('nav-open', open);
  }
  btn.addEventListener('click', function () {
    setOpen(btn.getAttribute('aria-expanded') !== 'true');
  });
  nav.addEventListener('click', function (e) {
    if (e.target && e.target.tagName === 'A') setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) setOpen(false);
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 920 && nav.classList.contains('is-open')) setOpen(false);
  });
})();
