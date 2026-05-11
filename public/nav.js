(function () {
  // Two header conventions in the repo:
  //   newer: <header class="site-header"> + .site-nav + .site-actions
  //   older: <header class="site"> with .left>nav + .right
  // nav.js handles both: normalizes nav to canonical 3 items, then wires mobile toggle.
  var header = document.querySelector('header.site-header, header.site');
  if (!header) return;

  var isLegacy = header.classList.contains('site') && !header.classList.contains('site-header');
  var nav = isLegacy ? header.querySelector('.left nav, nav') : header.querySelector('.site-nav');
  var actions = isLegacy ? header.querySelector('.right') : header.querySelector('.site-actions');
  if (!nav || !actions) return;

  // canonical 3-item nav. Solutions = use-cases hub, Developers = docs/dev surfaces, Pricing.
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  var devRe = /^\/(docs|compile|run|recall|serve|evolve|anatomy|k-score|spec|api|sdk|build-your-own|quickstart|integrations|articles|cookbook|architecture|benchmarks|leaderboard|launch|troubleshooting|faq|press|changelog)(\/|$)/;
  var solRe = /^\/(use-cases|healthcare|finance|legal|defense|edge|enterprise|customers|roi|whitepaper|motion|baa)(\/|$)/;
  var prRe  = /^\/pricing(\/|$)/;
  var items = [
    { href: '/use-cases', label: 'Solutions',  active: solRe.test(path) },
    { href: '/docs',      label: 'Developers', active: devRe.test(path) },
    { href: '/pricing',   label: 'Pricing',    active: prRe.test(path)  }
  ];
  nav.innerHTML = items.map(function (n) {
    var a = n.active ? ' class="active" aria-current="page"' : '';
    return '<a href="' + n.href + '"' + a + '>' + n.label + '</a>';
  }).join('');

  // Strip github star button — keep right side to theme toggle + sign in + primary CTA.
  var gh = actions.querySelector('#gh-star, .gh-star');
  if (gh && gh.parentNode) gh.parentNode.removeChild(gh);

  // Theme toggle is pre-baked in HTML to avoid first-paint layout shift.
  // Wire the click handler on whichever button is present.
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

  if (header.querySelector('.nav-toggle')) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-toggle';
  btn.setAttribute('aria-label', 'Toggle navigation');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><span></span><span></span>';

  if (!nav.id) nav.id = 'site-nav';
  btn.setAttribute('aria-controls', nav.id);
  actions.insertBefore(btn, actions.firstChild);

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
