(function () {
  // Two header conventions in the repo:
  //   newer: <header class="site-header"> + .site-nav + .site-actions
  //   older: <header class="site"> with .left>nav + .right
  // nav.js handles both: applies the active class on whichever pre-baked
  // 3-item nav already lives in the HTML, then wires mobile toggle clicks.
  // It does NOT rewrite innerHTML · that caused visible layout shift on
  // every navigation as the DOM mutated mid-paint.
  var header = document.querySelector('header.site-header, header.site');
  if (!header) return;

  var isLegacy = header.classList.contains('site') && !header.classList.contains('site-header');
  var nav = isLegacy ? header.querySelector('.left nav, nav') : header.querySelector('.site-nav');
  var actions = isLegacy ? header.querySelector('.right') : header.querySelector('.site-actions');
  if (!nav || !actions) return;

  // Active state only. Path-driven; idempotent; never rewrites innerHTML.
  // wave 101: /enterprise is its own top-level tab in the 5-item nav
  // (Use cases | Docs | Research | Enterprise | Pricing). Removing
  // `enterprise|customers|roi` from solRe stops /enterprise highlighting
  // the Use cases tab. Same for `baa|teams|tunnels|byoc|airgap` — those
  // belong under Enterprise routing, not Use cases. The Enterprise tab
  // itself uses entRe as an exact top-level match.
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  var devRe = /^\/(docs|compile|run|recall|serve|evolve|anatomy|k-score|spec|api|sdk|build-your-own|quickstart|integrations|articles|cookbook|architecture|launch|troubleshooting|faq|press|changelog)(\/|$)/;
  var solRe = /^\/(use-cases|healthcare|finance|legal|defense|edge|insure|health-insurance|whitepaper|motion)(\/|$)/;
  var resRe = /^\/(research|benchmarks|leaderboard)(\/|$)/;
  var entRe = /^\/(enterprise|customers|roi|baa|teams|tunnels|byoc|airgap|hipaa-mapping|soc2|security|subprocessors|trust|threat-model|slsa|sbom|compliance|compliance-packs|self-host|cloud)(\/|$)/;
  var prRe  = /^\/pricing(\/|$)/;
  var anchors = nav.querySelectorAll('a');
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var href = a.getAttribute('href') || '';
    var isActive =
      (href === '/use-cases' && solRe.test(path)) ||
      (href === '/docs'      && devRe.test(path)) ||
      (href === '/research'  && resRe.test(path)) ||
      (href === '/enterprise'&& entRe.test(path)) ||
      (href === '/pricing'   && prRe.test(path));
    if (isActive) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    } else {
      a.classList.remove('active');
      a.removeAttribute('aria-current');
    }
  }

  // Strip github star button · keep right side compact (theme + sign in + CTA).
  var gh = actions.querySelector('#gh-star, .gh-star');
  if (gh && gh.parentNode) gh.parentNode.removeChild(gh);

  // Auth-aware status pill. Validates the session before showing anything ·
  // localStorage alone is not trusted (stale keys from deleted tenants would
  // falsely render "signed in"). Single source of truth = /v1/account 200
  // with api_key in the payload. Cookie session OR x-api-key header
  // authenticates the call; on 401 we wipe stale keys so the pill stays off.
  //
  // wave 100 P1-3: writes go to ks_api_key only (cuts XSS exfil surface 75%);
  // reads still scan READ_FALLBACK so users who logged in pre-migration work,
  // and every successful auth proactively drains the LEGACY_KEYS aliases.
  var WRITE_KEY = 'ks_api_key';
  var READ_FALLBACK = ['kolm_api_key', 'apiKey', 'recipeApiKey', 'ks_api_key'];
  var LEGACY_KEYS = ['kolm_api_key', 'apiKey', 'recipeApiKey'];
  function readKey() {
    try { for (var i = 0; i < READ_FALLBACK.length; i++) { var v = localStorage.getItem(READ_FALLBACK[i]); if (v) return v; } } catch (e) {}
    return '';
  }
  function clearKeys() {
    try { READ_FALLBACK.forEach(function (n) { localStorage.removeItem(n); }); } catch (e) {}
  }
  var existingPill = actions.querySelector('.kolm-auth-pill');
  if (existingPill && existingPill.parentNode) existingPill.parentNode.removeChild(existingPill);
  function renderPill() {
    if (actions.querySelector('.kolm-auth-pill')) return;
    var pill = document.createElement('a');
    pill.href = '/dashboard';
    pill.className = 'kolm-auth-pill kolm-auth-pill--in';
    pill.setAttribute('aria-label', 'Signed in · open dashboard');
    pill.innerHTML = '<span class="dot"></span><span class="lbl">signed in</span>';
    actions.insertBefore(pill, actions.firstChild);
  }
  (function validateSession() {
    var localKey = readKey();
    var headers = { accept: 'application/json' };
    if (localKey) headers['x-api-key'] = localKey;
    try {
      fetch('/v1/account', { credentials: 'include', headers: headers })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) { clearKeys(); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (j) {
          // Canonical signed-in signal = presence of tenant `id` field.
          // /v1/account returns `{admin, tenant}` (no id) for unauth /
          // admin-token responses, and `{id, name, ..., api_key}` for
          // an authenticated real tenant.
          if (j && j.id) {
            if (j.api_key) {
              try {
                localStorage.setItem(WRITE_KEY, j.api_key);
                LEGACY_KEYS.forEach(function (n) { localStorage.removeItem(n); });
              } catch (e) {}
            }
            renderPill();
          } else if (localKey) {
            // 200 but no tenant id (admin token or anon response shape) ·
            // the localStorage key did not authenticate as a real tenant.
            clearKeys();
          }
        })
        .catch(function () {});
    } catch (e) {}
  })();

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
  // didn't get the pre-bake · covers legacy templates we haven't touched.)
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
