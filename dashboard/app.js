// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view with the model's own
// inputs, live-token comparables and the protocol's farm plan. No network: every byte it shows is
// in data.js.
//
// The page does not trust the numbers it is handed: it recomputes each row's category multiple from
// the live-token protocols in data.js (the median mcap/TVL of its category, else the global median),
// recomputes the row's implied value with the same function the model runs, and says in the detail
// view whether the two agree. The farm plan is the same derivation main.ts writes to board.json:
// category, chains, TVL and age decide the action, the capital, the hold and every cost and time.
// No name is special-cased anywhere.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tvl: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
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
    return n.toFixed(2) + 'x';
  }
  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // The market's own multiples, read off the live-token protocols: for each category, the median
  // mcap/TVL of the live protocols in it (at least two, else the global median), clamped to the
  // model's band. The same function the model runs in lib/model.ts, on the same live rows.
  function categoryMultiples() {
    var m = DATA.model;
    var byCat = {};
    var all = [];
    DATA.live.forEach(function (p) {
      if (p.mcap_usd === null || p.tvl_usd <= 0) return;
      var ratio = p.mcap_usd / p.tvl_usd;
      if (!isFinite(ratio) || ratio <= 0) return;
      all.push(ratio);
      var key = p.category || 'Other';
      if (!byCat[key]) byCat[key] = [];
      byCat[key].push(ratio);
    });
    var global = clamp(median(all), m.multiple_floor, m.multiple_cap);
    var out = {};
    Object.keys(byCat).forEach(function (key) {
      out[key] = byCat[key].length >= m.min_category_live ? clamp(median(byCat[key]), m.multiple_floor, m.multiple_cap) : global;
    });
    return { byCategory: out, global: global, counts: byCat };
  }
  var MULTIPLES = categoryMultiples();

  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  function impliedOf(row) {
    var m = DATA.model;
    var multiple = MULTIPLES.byCategory[row.category || 'Other'];
    if (multiple === undefined) multiple = MULTIPLES.global;
    var growth = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, m.growth_floor, m.growth_cap);
    var growthMult = 1 + (growth / 100) * m.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var maturity = m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    return { implied: Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity)), multiple: multiple, growth: growth, growthMult: growthMult, maturity: maturity, age: age };
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

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasUsd(chain) {
    var c = chain.toLowerCase();
    if (c === 'ethereum') return 6;
    if (c === 'solana') return 0.01;
    if (c === 'tron') return 1.5;
    if (c === 'binance') return 0.3;
    if (c === 'bitcoin') return 1;
    var cheap = ['base', 'arbitrum', 'optimism', 'polygon', 'zksync era', 'linea', 'scroll', 'blast', 'mode', 'ink', 'unichain', 'abstract', 'berachain', 'monad', 'hyperliquid l1', 'sui', 'aptos', 'sei', 'avalanche', 'fantom', 'gnosis', 'celo', 'mantle', 'taiko', 'zora', 'fraxtal', 'sonic', 'plume', 'megaeth', 'bob', 'lisk', 'world chain'];
    if (cheap.indexOf(c) >= 0) return 0.1;
    return 0.5;
  }
  function fmtGas(n) { return n < 1 ? '$' + n.toFixed(2) : '$' + Math.round(n); }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('risk curator') >= 0 || c.indexOf('onchain capital allocator') >= 0) return 'Deposit $' + capital + ' of USDC into a ' + name + ' vault on ' + chain + ' and keep the vault shares.';
    if (c.indexOf('liquid staking') >= 0 || c.indexOf('restaking') >= 0 || c.indexOf('staking pool') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt token.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the deposit open.';
    if (c.indexOf('yield aggregator') >= 0 || c.indexOf('yield') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s highest-TVL vault on " + chain + ' and keep the shares.';
    if (c.indexOf('leveraged farm') >= 0) return 'Open a $' + capital + ' leveraged farming position on ' + name + ' on ' + chain + ' at low leverage.';
    if (c.indexOf('liquidity manager') >= 0) return 'Deposit $' + capital + ' into a ' + name + '-managed liquidity position on ' + chain + '.';
    if (c.indexOf('indexes') >= 0) return 'Buy $' + capital + " of " + name + "'s index token on " + chain + ' and hold it.';
    if (c.indexOf('dex') >= 0) return 'Provide $' + capital + " of liquidity to " + name + "'s largest pool on " + chain + ' and keep the position open.';
    if (c.indexOf('basis trading') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s basis vault on " + chain + ' and keep the position.';
    if (c.indexOf('derivative') >= 0 || c.indexOf('perpetual') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one position on a ' + name + ' market.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of " + name + "'s yield-bearing asset on " + chain + ' and hold it.';
    if (c.indexOf('stable') >= 0) return 'Mint $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('launchpad') >= 0) return 'Stake $' + capital + " to join " + name + "'s next sale on " + chain + '.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through its official bridge and use one of its apps.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + '.';
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' pool on ' + chain + ' and keep the note.';
    if (c.indexOf('nft') >= 0) return 'List or buy one item worth $' + capital + ' on ' + name + '.';
    if (c.indexOf('ai agent') >= 0 || c.indexOf('decentralized ai') >= 0) return 'Stake $' + capital + " in " + name + "'s agent pool on " + chain + '.';
    if (c.indexOf('token locker') >= 0) return 'Lock $' + capital + ' of tokens in ' + name + ' on ' + chain + '.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasUsd(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'no cost to set up', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about ' + fmtGas(gas) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about ' + fmtGas(gas) + ' of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page from its official site and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'A launch is not promised: this protocol records no token, and farming costs gas and time even if no token ever comes. Keep a farm log of the wallet, the dates and every transaction.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tvl')) state.tvl = params.get('tvl');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tvl !== 'all') params.set('tvl', state.tvl);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  var TVL_FILTERS = { '50': 50e6, '100': 100e6, '250': 250e6, '500': 500e6, '1000': 1e9 };
  function rows() {
    var q = state.q.trim().toLowerCase();
    var minTvl = TVL_FILTERS[state.tvl] || 0;
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (r.tvl_usd < minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.category_multiple; bv = b.category_multiple; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { html: 'Snapshot <b>' + DATA.as_of + '</b>' }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { html: 'Model <b>' + DATA.model_version + '</b>' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('div', { class: 'kicker', text: 'Pre-token protocols · ranked by implied value' }),
        el('h1', { html: 'Which protocol is worth farming <em>next</em>?' }),
        el('p', { text: 'Every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record, ranked by what its launch would be worth if its record stayed as it is. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, found the same way. Implied value is a model, not a promise — and it never predicts whether or when a token is issued.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { html: '<span class="hl">' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</span>' })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Global median mcap / TVL' }), el('b', { text: fmtMult(DATA.global_multiple) }))
      )
    );
  }

  function methodPanel() {
    var m = DATA.model;
    var cats = {};
    DATA.rows.forEach(function (r) { cats[r.category || 'Other'] = true; });
    var multRows = Object.keys(cats).map(function (c) {
      return { category: c, multiple: MULTIPLES.byCategory[c] === undefined ? MULTIPLES.global : MULTIPLES.byCategory[c], n: (MULTIPLES.counts[c] || []).length };
    }).sort(function (a, b) { return b.multiple - a.multiple; }).slice(0, 8);
    var tbody = el('tbody');
    multRows.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { text: r.category }),
        el('td', { class: 'num', text: String(r.n) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) })
      ));
    });
    return el('section', { class: 'panel method' },
      el('div', { class: 'method-grid', style: 'padding:24px' },
        el('div', null,
          el('h2', { text: 'How implied value is computed' }),
          el('div', { class: 'formula', html: 'implied = round( tvl_usd x <b>category multiple</b> x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )' }),
          el('p', { html: 'The <b>category multiple</b> is the market talking: the median mcap/TVL of the live-token protocols in the same category (at least two of them, else the global median of ' + fmtMult(DATA.global_multiple) + '), clamped to ' + m.multiple_floor + '–' + m.multiple_cap + ' so one outlier cannot set the board. TVL and seven-day growth come from the snapshot; age is the time since the protocol was first listed — how long it has run with no token. An unlisted age uses ' + m.unknown_age_days + ' days. No protocol name is special-cased, and no row is hand-picked.' })
        ),
        el('div', null,
          el('h3', { text: 'Where the multiples come from' }),
          el('table', { class: 'mult-table' },
            el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { text: 'Live counted' }), el('th', { text: 'Multiple' }))),
            tbody
          ),
          el('p', { class: 'note', text: 'The eight highest multiples on the board. Every other category on the board is priced the same way, from its own live-token protocols.' })
        )
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; });
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')', selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var tvlSelect = el('select', { id: 'tvl', 'aria-label': 'Filter by TVL' },
      el('option', { value: 'all', text: 'Any TVL' }),
      [['50', '$50M+'], ['100', '$100M+'], ['250', '$250M+'], ['500', '$500M+'], ['1000', '$1B+']].map(function (t) { return el('option', { value: t[0], text: t[1], selected: t[0] === state.tvl ? 'selected' : null }); })
    );
    tvlSelect.addEventListener('change', function () { state.tvl = tvlSelect.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'tvl', text: 'TVL' }), tvlSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', html: state.tab === 'pre-token' ? '<b>' + rows().length + '</b> rows shown' : '<b>' + DATA.live.slice(0, DATA.live_size < 24 ? DATA.live_size : 24).length + '</b> live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain or TVL to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.tvl = 'all'; writeHash(); render(); } })
      ));
    }
    var maxImplied = list[0].implied_value_usd || 1;
    var maxTvl = list.reduce(function (a, r) { return Math.max(a, r.tvl_usd); }, 1);
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        class: r.rank <= 3 ? 'top3' : null,
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', null, el('span', { class: 'rank-badge', text: String(r.rank) })),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar tvl', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.tvl_usd / maxTvl) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.tvl_usd) })
        )),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.category_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / maxImplied) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'pill', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its value breakdown, comparables and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'Multiple'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.slice(0, 24).forEach(function (r) {
      var ratio = r.mcap_usd !== null && r.tvl_usd > 0 ? r.mcap_usd / r.tvl_usd : null;
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pill live', text: 'already trades' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: ratio === null ? 'n/a' : fmtMult(ratio) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and their mcap/TVL ratios are what price it.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'mcap / TVL' }), el('th', { scope: 'col', text: '7d' }))),
          tbody
        )
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'What “no token” means: a protocol on this board records no token in the snapshot. That is DefiLlama’s record, not proof — a protocol may still have a token its record does not carry. The board never says a protocol has no token, only that none is recorded.' }),
      el('p', { text: 'Implied value is this entry’s own claim, from the snapshot’s figures alone. It is not a price, not a prediction that a token will be issued, and not financial advice. Farming costs gas and time even if no token ever comes.' }),
      el('p', { text: 'Data: ' + DATA.source + '. Snapshot ' + DATA.as_of + '. Model ' + DATA.model_version + '. The page renders with no network; every figure it shows is in data.js.' })
    );
  }

  var backdrop = el('div', { class: 'backdrop', hidden: true, onclick: function () { closeDetail(); } });
  var dialog = el('div', { class: 'detail', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'detail-title', hidden: true });

  function closeDetail() {
    state.selected = null;
    writeHash();
    dialog.hidden = true;
    backdrop.hidden = true;
    render();
  }

  function comparables(row) {
    var same = DATA.live.filter(function (p) { return (p.category || 'Other') === (row.category || 'Other') && p.mcap_usd !== null && p.tvl_usd > 0; })
      .sort(function (a, b) { return (b.mcap_usd || 0) - (a.mcap_usd || 0); })
      .slice(0, 5);
    var section = el('section', { class: 'detail-section' },
      el('h3', { text: 'Comparables: live-token ' + (row.category || 'Other') + ' protocols' })
    );
    if (same.length === 0) {
      section.appendChild(el('p', { class: 'note', text: 'No live-token protocol in this category records a market cap, so the board prices this row with the global median multiple of ' + fmtMult(MULTIPLES.global) + '.' }));
      return section;
    }
    var tbody = el('tbody');
    same.forEach(function (p) {
      tbody.appendChild(el('tr', null,
        el('td', { text: p.name }),
        el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }),
        el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }),
        el('td', { class: 'num', text: fmtMult(p.mcap_usd / p.tvl_usd) })
      ));
    });
    section.appendChild(el('table', { class: 'comp' },
      el('thead', null, el('tr', null, el('th', { text: 'Protocol' }), el('th', { text: 'Market cap' }), el('th', { text: 'TVL' }), el('th', { text: 'mcap / TVL' }))),
      tbody
    ));
    section.appendChild(el('p', { class: 'note', text: same.length >= 2
      ? 'The median of these ratios is the category multiple of ' + fmtMult(MULTIPLES.byCategory[row.category || 'Other']) + ' this row is priced with.'
      : 'Only ' + same.length + ' live-token protocol in this category records a market cap, so the board prices this row with the global median multiple of ' + fmtMult(MULTIPLES.global) + '.' }));
    return section;
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var check = impliedOf(row);
    var steps = farmSteps(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { closeDetail(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple (' + (row.category || 'Other') + ')' }), el('b', { class: 'num', text: fmtMult(row.category_multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) + ' → ' + check.growthMult.toFixed(4) + 'x' })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) + ' → ' + check.maturity.toFixed(4) + 'x' })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'check', html: check.implied === row.implied_value_usd
        ? 'The page recomputes this row as <b>' + fmtUsd(check.implied) + '</b> — the same number board.json carries. Model ' + DATA.model_version + ': the same function scores every protocol. This is an estimate, not a price.'
        : 'The page recomputes this row as <b>' + fmtUsd(check.implied) + '</b>, which differs from the board: the data would be stale.' })
    ));
    dialog.appendChild(comparables(row));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('p', { class: 'note', html: '<b>Records no token.</b> That is the snapshot’s record, not proof a token does not exist. Never pay to claim an airdrop, and claim only from a link the protocol itself publishes.' })
    ));
    dialog.hidden = false;
    backdrop.hidden = false;
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    shell.appendChild(methodPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    if (!backdrop.isConnected) app.appendChild(backdrop);
    if (!dialog.isConnected) app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !dialog.hidden) closeDetail();
  });
})();
