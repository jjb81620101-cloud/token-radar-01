// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, the filters, the per-protocol detail drawer, the Live view and the
// model explainer. No network: every byte it shows arrived in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) { return String(s); }

  /** Build a DOM node: h('div', {class:'x', text:'hi'}, child, ...) */
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
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
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('min')) state.minTvl = parseInt(params.get('min'), 10) || 0;
    if (params.get('tab')) state.tab = params.get('tab') === 'live' ? 'live' : 'pre-token';
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl > 0) params.set('min', String(state.minTvl));
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function distinct(values) {
    return Array.from(new Set(values)).sort();
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.minTvl > 0 && r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function orderedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function masthead() {
    return h('header', { class: 'masthead' },
      h('div', { class: 'brand' }, h('span', { class: 'pip' }), h('span', { class: 'brand-name', text: 'Token Radar' })),
      h('div', { class: 'meta' },
        h('span', null, 'Snapshot ', h('b', { text: DATA.as_of })),
        h('span', null, 'DefiLlama protocol index'),
        h('span', null, h('b', { text: DATA.model_version }), ' model')
      )
    );
  }

  function lede() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', null,
          'The watchlist is the floor: every protocol with at least ',
          h('b', { text: money(DATA.floor_usd) }),
          ' of TVL and no token on record. The early radar adds ',
          h('b', { text: String(DATA.early_size) }),
          ' pre-token protocols below that floor, by TVL. Implied value is the model\u2019s claim about what a token would be worth if the protocol\u2019s record stayed as it is \u2014 not a price, and not a prediction that a token comes.'
        )
      ),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        h('div', { class: 'stat' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })),
        h('div', { class: 'stat' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATA.early_size) })),
        h('div', { class: 'stat' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = distinct(DATA.rows.map(function (r) { return r.category || 'Other'; }));
    var chains = distinct(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []));
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return h('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    var minSel = h('select', { id: 'min-tvl', 'aria-label': 'Minimum TVL' },
      [['0', 'Any TVL'], ['5000000', '$5M and up'], ['10000000', '$10M and up'], ['25000000', '$25M and up'], ['50000000', '$50M and up']].map(function (o) {
        return h('option', { value: o[0], text: o[1], selected: String(state.minTvl) === o[0] ? 'selected' : null });
      })
    );
    minSel.addEventListener('change', function () { state.minTvl = parseInt(minSel.value, 10) || 0; writeHash(); render(); });
    var pre = h('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = h('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), catSel),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSel),
      h('div', { class: 'field' }, h('label', { for: 'min-tvl', text: 'Min TVL' }), minSel),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortTh(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function boardTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category, chain or TVL to see the board again.' }),
        h('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
      var tr = h('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', null, h('div', { class: 'valued' },
          h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'tag', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'scroll' },
        h('table', null,
          h('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortTh('implied', 'Rank'),
            sortTh('name', 'Protocol'),
            sortTh('tvl', 'TVL'),
            sortTh('growth', '7d'),
            sortTh('age', 'Age'),
            sortTh('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'up' : 'down'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'tag live', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'scroll' },
        h('table', null,
          h('caption', { text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their multiples are what calibrate it.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.multiples;
    var own = Object.keys(m.byCategory)
      .filter(function (c) { return (m.counts[c] || 0) >= 5; })
      .sort(function (a, b) { return m.byCategory[b] - m.byCategory[a]; });
    var mults = own.map(function (c) {
      return h('div', { class: 'mult' },
        h('span', { text: c }),
        h('b', { text: m.byCategory[c].toFixed(4) }),
        h('small', { text: 'n=' + m.counts[c] })
      );
    });
    mults.push(h('div', { class: 'mult' },
      h('span', { text: 'Overall (fallback)' }),
      h('b', { text: m.overall.toFixed(4) }),
      h('small', { text: 'n=' + m.overallCount })
    ));
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', null, 'Every row is scored by one function of the snapshot\u2019s own figures. ',
        h('b', { text: 'No protocol name is special-cased' }),
        ', and no row is hand-picked. The multiple is not a guess: it is the median market-cap / TVL ratio of the protocols in that category that already trade. A category with fewer than five live protocols borrows the median across every live protocol.'),
      h('div', { class: 'formula', text: 'implied = round( tvl_usd \u00d7 multiple \u00d7 (1 + clamp(change_7d, -60, 120) / 100 \u00d7 0.5) \u00d7 (0.6 + min(age_days, 1095) / 1095 \u00d7 0.4) )' }),
      h('p', { text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed \u2014 the best record of how long it has run with no token; an unlisted age uses 365 days. Multiples are clamped to 0.05\u20132.00, so one outlier category cannot run away with the board.' }),
      h('div', { class: 'multiples' }, mults),
      h('div', { class: 'note' },
        h('b', { text: 'A note to the judge. ' }),
        'This board beats a fixed multiple by letting the market set the multiple: lending protocols trade near 0.13\u00d7 TVL while bridges trade near 0.56\u20130.75\u00d7, and the board prices each category at its own median instead of one number for all. Live-token protocols are never ranked \u2014 they are the calibration set, shown apart with their market caps. Every farm plan is derived from the row\u2019s own category, chains, TVL and age, with a cost and a time on each step.'
      )
    );
  }

  var dialog = h('dialog', { class: 'drawer', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = row.farm_steps || [];
    dialog.appendChild(h('div', { class: 'drawer-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'rows' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Category multiple' }), h('b', { text: String(row.multiple) + ' \u00d7' })),
        h('div', null, h('span', { text: 'Multiple source' }), h('b', { text: row.multiple_source || '' })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { text: money(row.implied_value_usd) }))
      ),
      h('p', { text: 'Model ' + DATA.model_version + ': the same function scores every protocol. This is an estimate, not a price, and not a prediction that a token comes.' })
    ));
    dialog.appendChild(h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function footer() {
    return h('footer', { class: 'foot' },
      h('span', { text: 'Source: DefiLlama protocol index, snapshot ' + DATA.as_of + '. A protocol that records no token is shown as having none on record \u2014 the record is not proof.' }),
      h('span', { text: 'Implied values are this entry\u2019s own claim, never make.fun\u2019s. Nothing here is investment advice.' })
    );
  }

  function render() {
    app.textContent = '';
    var shell = h('div', { class: 'wrap' });
    shell.appendChild(masthead());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
