// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail overlay with the
// model's own arithmetic and the protocol's farm plan, plus the live-token tab. No network:
// every byte it shows is already in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;
  app.setAttribute('aria-busy', 'false');

  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    return 'x' + n.toFixed(2);
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // The model's arithmetic, recomputed in the page from the snapshot figures, so the number the
  // table shows and the number board.json carries are visibly the same calculation.
  function impliedOf(row) {
    var base = Math.pow(10, DATA.fit.intercept + DATA.fit.slope * Math.log10(row.tvl_usd));
    var g = Math.min(120, Math.max(-60, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (g / 100) * DATA.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var maturity = DATA.maturity_floor + (Math.min(Math.max(age, 0), DATA.maturity_days) / DATA.maturity_days) * DATA.maturity_range;
    return Math.max(1, Math.round(base * growthMult * maturity));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var h = window.location.hash || '';
    var m;
    if ((m = h.match(/^#\/detail\/([A-Za-z0-9._-]+)$/))) { state.selected = m[1]; return; }
    if ((m = h.match(/^#\/filter\/(.+)$/))) { state.category = decodeURIComponent(m[1]); state.tab = 'pre-token'; state.selected = null; return; }
    if (h === '#/live') { state.tab = 'live'; state.selected = null; return; }
    state.selected = null;
  }
  function writeHash() {
    var h = '';
    if (state.selected) h = '#/detail/' + state.selected;
    else if (state.tab === 'live') h = '#/live';
    else if (state.category !== 'all') h = '#/filter/' + encodeURIComponent(state.category);
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
  }

  function rows() {
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!state.q) return true;
      var q = state.q.toLowerCase();
      return r.name.toLowerCase().indexOf(q) >= 0 || r.slug.toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var va = key === 'implied' ? a.implied_value_usd : key === 'tvl' ? a.tvl_usd : key === 'growth' ? (a.change_7d === null ? 0 : a.change_7d) : key === 'age' ? (a.age_days === null ? -1 : a.age_days) : a.rank;
      var vb = key === 'implied' ? b.implied_value_usd : key === 'tvl' ? b.tvl_usd : key === 'growth' ? (b.change_7d === null ? 0 : b.change_7d) : key === 'age' ? (b.age_days === null ? -1 : b.age_days) : b.rank;
      if (va === vb) return a.rank - b.rank;
      return (va < vb ? -1 : 1) * dir;
    });
  }

  function header() {
    return el('header', { class: 'hero' },
      el('h1', null, 'TOKEN RADAR', el('span', { class: 'dot', text: '.' })),
      el('p', { class: 'lede' },
        el('strong', { text: DATA.board_size + ' pre-token protocols, ranked by fitted implied value' }),
        document.createTextNode(' — every protocol on the snapshot watchlist, plus every other pre-token protocol that is not an exchange, a wrapped, staked or bridged product, or a versioned pool. An implied value is this radar\u2019s own claim from the snapshot\u2019s figures, never a promise that a token launches.')));
  }

  function kpis() {
    function kpi(n, l) {
      return el('div', { class: 'kpi' }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l }));
    }
    return el('div', { class: 'kpis' },
      kpi('758', 'protocols audited'),
      kpi(String(DATA.watchlist_size), 'watchlist covered'),
      kpi(String(DATA.board_size), 'rows ranked'),
      kpi(String(DATA.live_size), 'live tokens tracked'),
      kpi('R\u00b2 ' + DATA.fit.r2.toFixed(2), 'model fit (log space)'));
  }

  function modelPanel() {
    var f = DATA.fit;
    var h = DATA.holdout;
    return el('section', { class: 'model' },
      el('h2', { text: 'How the value is priced — radar-2' }),
      el('p', null,
        'Fitted at run time on the snapshot\u2019s own ', el('b', { text: String(f.n) + ' clean comps' }),
        ' (protocols that already trade, minus exchanges, bridges and staking products): ',
        el('code', { text: 'log10(implied) = ' + f.intercept.toFixed(3) + ' + ' + f.slope.toFixed(3) + ' \u00d7 log10(TVL)' }),
        ', then a growth prior of \u00b125% and a maturity prior of 0.85\u20131.15.'),
      el('p', null,
        'Holdout (5-fold, same folds for both): fitted R\u00b2 ', el('b', { text: h.fitted_r2.toFixed(2) }),
        ' vs the house constant-multiple model ', el('b', { text: h.starter_r2.toFixed(2) }),
        '; median error ', el('b', { text: (h.fitted_mdape * 100).toFixed(0) + '%' }),
        ' vs ', el('b', { text: (h.starter_mdape * 100).toFixed(0) + '%' }),
        '.'),
      el('p', { class: 'warn' },
        'Honest limit: token multiples genuinely span 1,000\u00d7 across comps, so every row also shows its prediction interval — the fitted value times or divided by the fit\u2019s own residual spread. A point value without that interval would be false precision.'));
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', placeholder: 'Search a protocol or slug\u2026', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    var select = el('select', { 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')' }); }));
    select.value = state.category;
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    var count = el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' of ' + DATA.rows.length + ' rows' : DATA.live.length + ' live tokens' });
    return el('div', { class: 'controls' }, search, select, el('div', { class: 'tabs' }, pre, live), count);
  }

  function sortHeader(key, label) {
    var arrow = state.sort === key ? (state.dir === -1 ? ' \u25bc' : ' \u25b2') : '';
    return el('th', { class: 'num' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } }, label + arrow));
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) return el('div', { class: 'empty', text: 'No protocol matches that filter. Clear the search or pick another category.' });
    var body = el('tbody', null);
    list.forEach(function (r) {
      var onWatch = r.watchlist === true;
      var tr = el('tr', { class: onWatch ? 'watch' : '', tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'rank num', text: String(r.rank) }),
        el('td', { class: 'name' }, el('b', { text: r.name }), el('span', { text: r.slug + (onWatch ? ' \u00b7 watchlist' : '') })),
        el('td', { text: r.category || 'Other' }),
        el('td', { text: (r.chains || []).slice(0, 2).join(', ') || 'n/a' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + ((r.change_7d === null ? 0 : r.change_7d) >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.implied_value_usd) }), el('div', { class: 'range', text: fmtUsd(r.implied_low_usd) + ' \u2013 ' + fmtUsd(r.implied_high_usd) })));
      body.appendChild(tr);
    });
    return el('table', { class: 'board' },
      el('thead', null, el('tr', null,
        el('th', { class: 'num' }, el('button', { type: 'button', onclick: function () { state.sort = 'rank'; state.dir = 1; render(); } }, 'Rank')),
        el('th', null, 'Protocol'),
        el('th', null, 'Category'),
        el('th', null, 'Chains'),
        sortHeader('tvl', 'TVL'),
        sortHeader('growth', '7d'),
        sortHeader('age', 'Age'),
        sortHeader('implied', 'Implied value'))),
      body);
  }

  function liveTable() {
    var body = el('tbody', null);
    DATA.live.forEach(function (r) {
      body.appendChild(el('tr', null,
        el('td', { class: 'name' }, el('b', { text: r.name }), el('span', { text: r.slug })),
        el('td', { text: r.category || 'Other' }),
        el('td', { text: (r.chains || []).slice(0, 2).join(', ') || 'n/a' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + ((r.change_7d === null ? 0 : r.change_7d) >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.mcap_usd) }))));
    });
    return el('div', null,
      el('p', { class: 'lede', text: 'These tokens already trade, so the board shows the market\u2019s own value, never a model\u2019s. They are here so the pre-token board can be read against the market, not mixed into it.' }),
      el('table', { class: 'board' },
        el('thead', null, el('tr', null,
          el('th', null, 'Protocol'), el('th', null, 'Category'), el('th', null, 'Chains'),
          el('th', { class: 'num' }, 'TVL'), el('th', { class: 'num' }, '7d'), el('th', { class: 'num' }, 'Market cap'))),
        body));
  }

  function detailSheet(r) {
    var check = impliedOf(r);
    var match = check === r.implied_value_usd ? 'matches board.json' : 'differs from board.json by $' + Math.abs(check - r.implied_value_usd).toLocaleString('en-US');
    var steps = el('ol', { class: 'farm' });
    r.farm_steps.forEach(function (s, i) {
      steps.appendChild(el('li', null, el('b', { text: 'Step ' + (i + 1) + '. ' }), document.createTextNode(s)));
    });
    return el('div', { class: 'overlay', onclick: function (e) { if (e.target === e.currentTarget) closeDetail(); } },
      el('div', { class: 'sheet', role: 'dialog', 'aria-label': r.name + ' detail' },
        el('button', { class: 'close', type: 'button', text: 'Close \u00d7', onclick: function () { closeDetail(); } }),
        el('h2', null, '#' + r.rank + ' ' + r.name),
        el('p', { class: 'sub', text: r.slug + ' \u00b7 ' + (r.category || 'Other') + ' \u00b7 ' + ((r.chains || []).join(', ') || 'n/a') + ' \u00b7 listed ' + (r.listed_at || 'unknown date') }),
        el('div', { class: 'kv' },
          el('div', null, el('div', { class: 'k', text: 'Implied value' }), el('div', { class: 'v', text: fmtUsd(r.implied_value_usd) })),
          el('div', null, el('div', { class: 'k', text: 'Comp range' }), el('div', { class: 'v', text: fmtUsd(r.implied_low_usd) + ' \u2013 ' + fmtUsd(r.implied_high_usd) })),
          el('div', null, el('div', { class: 'k', text: 'TVL' }), el('div', { class: 'v', text: fmtUsd(r.tvl_usd) })),
          el('div', null, el('div', { class: 'k', text: '7d / Age' }), el('div', { class: 'v', text: fmtPct(r.change_7d) + ' / ' + fmtAge(r.age_days) }))),
        el('h3', { text: 'How the value is built' }),
        el('p', { class: 'math' },
          'Fitted base ', el('code', { text: fmtUsd(r.fitted_base_usd) }),
          ' \u00d7 growth ', el('code', { text: fmtMult(r.growth_multiplier) }),
          ' \u00d7 maturity ', el('code', { text: fmtMult(r.maturity_multiplier) }),
          ' = ', el('code', { text: fmtUsd(r.implied_value_usd) }),
          '. Recomputed in this page: ', el('code', { text: fmtUsd(check) }),
          ' — ' + match + '.'),
        el('h3', { text: 'Farm plan — six steps, each with its cost and time' }),
        steps));
  }

  function openDetail(slug) {
    state.selected = slug;
    writeHash();
    render();
  }
  function closeDetail() {
    state.selected = null;
    writeHash();
    render();
  }

  function render() {
    while (app.firstChild) app.removeChild(app.firstChild);
    var wrap = el('div', { class: 'wrap' }, header(), kpis(), modelPanel(), controls());
    if (state.tab === 'live') wrap.appendChild(liveTable());
    else wrap.appendChild(boardTable());
    wrap.appendChild(el('footer', null,
      'Snapshot: DefiLlama protocols, as of ' + DATA.as_of + ' (floor $50,000,000). ' +
      'Implied values are this radar\u2019s own claims from the snapshot\u2019s figures; they do not predict whether or when a token launches. ' +
      'A protocol is called pre-token only because its record carries no token — its record may still miss one. ' +
      'Model radar-2: power law fitted on ' + DATA.fit.n + ' clean comps, growth prior \u00b1' + Math.round(DATA.growth_weight * 100) + '%, maturity prior ' + DATA.maturity_floor.toFixed(2) + '\u2013' + (DATA.maturity_floor + DATA.maturity_range).toFixed(2) + '.'));
    app.appendChild(wrap);
    if (state.selected) {
      var found = null;
      DATA.rows.forEach(function (r) { if (r.slug === state.selected) found = r; });
      if (found) app.appendChild(detailSheet(found));
      else { state.selected = null; writeHash(); }
    }
  }

  window.addEventListener('hashchange', function () { readHash(); render(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.selected) closeDetail(); });
  readHash();
  render();
})();
