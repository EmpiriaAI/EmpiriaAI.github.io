/* ============================================================
   Trajectory Dialogue

   One vertical time axis, two lanes. Left carries everything the
   harness handed the model (system prompt, injected context, user
   turns, tool results); right carries everything the model produced
   (reasoning, assistant text, tool calls). Across the 45-trajectory
   corpus that split lands at 48.5% / 51.5%, so neither lane sits idle.

   The unit of layout is a TURN, not an event. One model turn is one
   band: its reasoning and prose on top, then one sub-row per tool call
   with the result that answered it directly across the axis. A turn
   that fires six calls at once renders as six aligned sub-rows inside
   a single band — 14.3% of the calls in this corpus are part of such a
   batch, up to six wide, and splitting them would report parallel work
   as sequential.

   The rail on the right holds three things a reader needs beside the
   trajectory rather than inside it: where the run came from, an agent
   to ask about it, and the annotations that come out of reading it.

   No build step, no dependencies — same contract as the rest of the
   site. Card bodies are built on first expand, so a 1,300-event
   trajectory costs one light header each up front.
   ============================================================ */

(function () {
  'use strict';

  var IN_TYPES   = { system: 1, context: 1, user: 1, tool_result: 1 };
  var STANDALONE = { system: 1, context: 1, user: 1 };
  var HEAD_TYPES = { thinking: 1, assistant: 1 };
  var BAD = { error: 1, timeout: 1, rejected: 1 };

  var LABEL = {
    system: 'System prompt', context: '注入上下文', inject: '每轮注入',
    user: '用户', interrupt: '用户中断', notify: '后台通知', command: '斜杠命令',
    tool_result: '工具结果', thinking: '推理', assistant: '助手输出', tool_call: '工具调用'
  };

  /* The exported `user` and `system` streams are not what their names say.
     Across the corpus only 69.4% of `user` events are a person typing — the
     rest are interrupt markers, background task callbacks and slash-command
     expansions the harness wrote. And only 1.7% of `system` events are the
     real system prompt; the other 98.3% is per-turn boilerplate re-injected
     every round (a token counter appears 218 times, an output-style note
     216). Categorising them keeps the turn count honest and lets the
     boilerplate be filtered out instead of drowning the input lane. */
  var CATEGORY = {
    system: 'system', context: 'context', inject: 'inject',
    user: 'user', interrupt: 'signal', notify: 'signal', command: 'signal',
    tool_result: 'tool_result', thinking: 'thinking',
    assistant: 'assistant', tool_call: 'tool_call'
  };

  function kindOf(event, seenSystem) {
    /* the fixed importer exports `kind` directly; keep deriving it for
       snapshots produced before that change */
    if (event.kind) return event.kind;
    var text = event.content || '';
    if (event.type === 'user') {
      if (text.indexOf('[Request interrupted by user') === 0) return 'interrupt';
      if (text.indexOf('<task-notification>') !== -1) return 'notify';
      if (text.indexOf('<command-name>') !== -1 ||
          text.indexOf('<command-message>') !== -1) return 'command';
      return 'user';
    }
    if (event.type === 'system') return seenSystem ? 'inject' : 'system';
    return event.type;
  }

  var OPEN_BY_DEFAULT = { user: 1, assistant: 1 };
  var TAGS = ['卡住', '重复劳动', '工具误用', '环境问题', '判分问题', '好样本', '可出题'];

  var STORE = {
    theme:   'empiria.dlg.theme',
    density: 'empiria.dlg.density',
    llm:     'empiria.dlg.llm',
    notes:   'empiria.dlg.notes'
  };

  var trajectories = (window.EMPIRIA_RAW_TRAJECTORIES || [])
    .concat(window.EMPIRIA_FEEDBACK_SNAPSHOTS || []);

  var el = {};
  ['pickerButton', 'pickerPanel', 'pickerLabel', 'pickerMeta', 'pickerList',
   'pickerSearch', 'runKicker', 'runTitle', 'runSub', 'runMetrics', 'countIn',
   'countOut', 'filters', 'failOnly', 'failCount', 'search', 'expandAll',
   'collapseAll', 'lanes', 'empty', 'minimap', 'rail', 'railTabs', 'railClose',
   'sourceBody', 'endpointBox', 'endpointState', 'cfgBase', 'cfgModel', 'cfgKey',
   'cfgSave', 'cfgClear', 'cfgDump', 'presets', 'scopeBar', 'scopeCost', 'chat',
   'composer', 'composerInput', 'noteCount', 'noteHint', 'noteForm', 'noteTarget',
   'tagRow', 'noteText', 'noteSave', 'noteDelete', 'noteList', 'noteExport',
   'themeToggle', 'densityToggle', 'selectionInfo', 'selectionCount', 'selectionClear'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var state = {
    current: null, bands: [], rows: [], cards: [], hidden: {},
    selection: [], lastPicked: null, scope: 'L1', messages: []
  };

  /* ── storage helpers (never throw on a locked-down browser) ── */

  function readStore(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (err) { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* ignore */ }
  }

  /* ── small helpers ───────────────────────────────────── */

  function firstLine(text, max) {
    var line = String(text || '').replace(/\s+/g, ' ').trim();
    return line.length > max ? line.slice(0, max) + '…' : line;
  }
  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch (err) { return String(text || ''); }
  }
  function tokens(n) {
    if (n == null) return '—';
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  }
  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  /* shortId repeats across the snapshots of one conversation, so the deep
     link key carries the snapshot ordinal too. */
  function keyOf(trajectory) {
    return (trajectory.shortId || trajectory.id) +
      (trajectory.snapshotOrdinal ? '-s' + trajectory.snapshotOrdinal : '');
  }
  function eventsOf(trajectory) {
    if (trajectory.events) return Promise.resolve(trajectory.events);
    if (!trajectory.lazyData) return Promise.resolve([]);
    if (!trajectory.loadingPromise) {
      trajectory.loadingPromise = fetch(trajectory.lazyData)
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          trajectory.events = payload.events || [];
          return trajectory.events;
        });
    }
    return trajectory.loadingPromise;
  }

  /* ── theme & density ─────────────────────────────────── */

  var THEMES = ['system', 'light', 'dark'];
  var THEME_GLYPH = { system: '◐', light: '☀', dark: '☾' };

  function applyTheme(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    el.themeToggle.textContent = THEME_GLYPH[mode];
    el.themeToggle.title = '外观：' + ({ system: '跟随系统', light: '浅色', dark: '深色' })[mode];
    writeStore(STORE.theme, mode);
  }
  el.themeToggle.addEventListener('click', function () {
    var next = THEMES[(THEMES.indexOf(readStore(STORE.theme, 'system')) + 1) % THEMES.length];
    applyTheme(next);
  });
  applyTheme(readStore(STORE.theme, 'system'));

  function applyDensity(mode) {
    document.documentElement.setAttribute('data-density', mode);
    el.densityToggle.title = '行距：' + (mode === 'compact' ? '紧凑' : '舒适');
    writeStore(STORE.density, mode);
  }
  el.densityToggle.addEventListener('click', function () {
    applyDensity(readStore(STORE.density, 'comfortable') === 'compact' ? 'comfortable' : 'compact');
  });
  applyDensity(readStore(STORE.density, 'comfortable'));

  /* ── picker ──────────────────────────────────────────── */

  function renderPicker(filter) {
    var needle = (filter || '').toLowerCase();
    el.pickerList.textContent = '';
    trajectories.forEach(function (trajectory) {
      var hay = [trajectory.title, trajectory.shortId, trajectory.taskType, trajectory.model]
        .join(' ').toLowerCase();
      if (needle && hay.indexOf(needle) === -1) return;
      var item = make('button', 'dlg-picker-item');
      item.type = 'button';
      if (trajectory === state.current) item.setAttribute('aria-current', 'true');
      item.appendChild(make('strong', null, trajectory.title || trajectory.shortId));
      item.appendChild(make('span', null,
        (trajectory.eventCount || (trajectory.events || []).length) + ' ev'));
      item.appendChild(make('em', null,
        [keyOf(trajectory), trajectory.taskType, trajectory.model].filter(Boolean).join(' · ')));
      item.addEventListener('click', function () { closePicker(); select(trajectory); });
      el.pickerList.appendChild(item);
    });
  }
  function openPicker() {
    el.pickerPanel.hidden = false;
    el.pickerButton.setAttribute('aria-expanded', 'true');
    renderPicker(el.pickerSearch.value);
    el.pickerSearch.focus();
  }
  function closePicker() {
    el.pickerPanel.hidden = true;
    el.pickerButton.setAttribute('aria-expanded', 'false');
  }
  el.pickerButton.addEventListener('click', function () {
    if (el.pickerPanel.hidden) openPicker(); else closePicker();
  });
  el.pickerSearch.addEventListener('input', function () { renderPicker(this.value); });
  document.addEventListener('click', function (event) {
    if (!el.pickerPanel.hidden && !event.target.closest('.dlg-picker')) closePicker();
  });

  /* ── cards ───────────────────────────────────────────── */

  function buildBody(card, event) {
    var body = make('div', 'dlg-body');
    if (event.type === 'tool_call') {
      body.appendChild(make('p', 'dlg-sub', '参数'));
      body.appendChild(make('pre', 'dlg-pre', pretty(event.content)));
    } else if (event.type === 'tool_result') {
      if (event.summary) {
        body.appendChild(make('p', 'dlg-sub', '摘要'));
        body.appendChild(make('p', null, event.summary));
      }
      body.appendChild(make('p', 'dlg-sub', '原始输出'));
      body.appendChild(make('pre', 'dlg-pre raw', event.content || ''));
    } else if (event.type === 'system' || event.type === 'context') {
      body.appendChild(make('pre', 'dlg-pre raw', event.content || ''));
    } else {
      body.appendChild(make('p', null, event.content || ''));
    }
    card.appendChild(body);
    card.dataset.built = '1';
  }

  function setOpen(card, open) {
    if (!card.classList.contains('collapsible')) return;
    if (open && !card.dataset.built) buildBody(card, card._event);
    card.classList.toggle('open', open);
  }

  function buildCard(event, badge, kind) {
    kind = kind || event.type;
    var card = make('div', 'dlg-card kind-' + kind +
      (IN_TYPES[event.type] ? ' at-in' : ' at-out'));
    card._event = event;
    card._kind = kind;
    card._type = CATEGORY[kind] || kind;
    card._bad = !!(event.status && BAD[event.status]);
    card._haystack = [event.title, event.content, event.summary].join(' ').toLowerCase();

    var head = make('button', 'dlg-head');
    head.type = 'button';
    head.appendChild(make('span', 'dlg-tag', LABEL[kind] || kind));
    if (badge) head.appendChild(make('span', 'dlg-badge', badge));
    if (kind === 'tool_call' || kind === 'tool_result') {
      head.appendChild(make('span', 'dlg-name', event.title || ''));
    }
    var peek = kind === 'tool_call' ? firstLine(event.content, 200)
             : event.summary ? firstLine(event.summary, 200)
             : firstLine(event.content, 200);
    head.appendChild(make('span', 'dlg-peek', peek));
    if (event.status) head.appendChild(make('span', 'dlg-status st-' + event.status, event.status));

    /* a short user turn is already fully visible in the header */
    var collapsible = kind !== 'user' || (event.content || '').length > 400;
    if (collapsible) {
      card.classList.add('collapsible');
      head.appendChild(make('i', 'dlg-chev', '▾'));
      head.addEventListener('click', function () {
        setOpen(card, !card.classList.contains('open'));
      });
    }
    card.appendChild(head);
    if (!collapsible || OPEN_BY_DEFAULT[kind]) { buildBody(card, event); card.classList.add('open'); }
    return card;
  }

  /* ── bands ───────────────────────────────────────────── */

  function newBand(className) {
    var band = make('div', 'dlg-band' + (className ? ' ' + className : ''));
    band._rows = [];
    band._index = state.bands.length;
    return band;
  }

  function addRow(band, opts) {
    var index = band._rows.length + (band._offset || 0) + 1;
    var gut = make('button', 'dlg-gut' + (opts.batch ? ' in-batch' : '') +
      (opts.inCard && opts.outCard ? ' is-pair' : ''));
    gut.type = 'button';
    gut.style.gridRow = String(index);
    var dot = make('i');
    var bad = (opts.inCard && opts.inCard._bad) || (opts.outCard && opts.outCard._bad);
    if (bad) dot.style.background = 'var(--' + (opts.inCard || opts.outCard)._event.status + ')';
    else if (opts.chapter) dot.style.background = 'var(--lane-in-soft)';
    gut.appendChild(dot);
    if (opts.call) gut.appendChild(make('span', null, '#' + opts.call));
    gut.addEventListener('click', function (event) { pick(band, event.shiftKey); });
    band.appendChild(gut);

    var cards = [];
    [opts.inCard, opts.outCard].forEach(function (card) {
      if (!card) return;
      card.style.gridRow = String(index);
      band.appendChild(card);
      cards.push(card);
      state.cards.push(card);
    });
    var row = { gut: gut, cards: cards };
    band._rows.push(row);
    state.rows.push(row);
    return row;
  }

  /* ── render ──────────────────────────────────────────── */

  function render(events) {
    state.bands = []; state.rows = []; state.cards = []; state.selection = [];
    el.lanes.textContent = ''; el.minimap.textContent = '';

    var counts = {}, callNumbers = {}, nextCall = 0, turn = 0, bad = 0;
    var frag = document.createDocumentFragment();
    var marks = [];

    var seenSystem = false;
    var kinds = events.map(function (event) {
      var kind = kindOf(event, seenSystem);
      if (kind === 'system') seenSystem = true;
      var cat = CATEGORY[kind] || kind;
      counts[cat] = (counts[cat] || 0) + 1;
      if (event.status && BAD[event.status]) bad += 1;
      return kind;
    });

    function push(band) { frag.appendChild(band); state.bands.push(band); }

    function markFor(event, card, kind) {
      kind = kind || event.type;
      var mark = make('b');
      if (event.status && BAD[event.status]) mark.className = 'm-' + event.status;
      else if (kind === 'interrupt') mark.className = 'm-interrupt';
      else if (kind === 'user') mark.className = 'm-user';
      else if (!IN_TYPES[event.type]) mark.className = 'm-out';
      mark.title = LABEL[kind] || kind;
      mark.addEventListener('click', function () { card.scrollIntoView({ block: 'center' }); });
      marks.push(mark);
    }

    var injectSeen = {};
    var i = 0;
    while (i < events.length) {
      var event = events[i];

      if (STANDALONE[event.type]) {
        var kind = kinds[i];

        /* the same boilerplate is re-injected every round; fold repeats
           into the card that already shows it */
        if (kind === 'inject') {
          var seenKey = (event.content || '').slice(0, 200);
          var prior = injectSeen[seenKey];
          if (prior) {
            prior._repeats = (prior._repeats || 1) + 1;
            prior._badge.textContent = '×' + prior._repeats;
            prior._badge.hidden = false;
            i += 1;
            continue;
          }
        }

        var isUser = kind === 'user';   /* interrupts and callbacks are not turns */
        if (isUser) turn += 1;
        var solo = newBand(isUser ? 'is-chapter' : null);
        solo._turn = turn;
        if (isUser) {
          var rule = make('div', 'dlg-chapter-rule', '轮次 ' + turn);
          rule.style.gridRow = '1';
          solo.appendChild(rule);
          solo._offset = 1;
        }
        var soloCard = buildCard(event, null, kind);
        if (kind === 'inject') {
          soloCard._badge = make('span', 'dlg-badge dim');
          soloCard._badge.hidden = true;
          soloCard.querySelector('.dlg-head')
            .insertBefore(soloCard._badge, soloCard.querySelector('.dlg-peek'));
          injectSeen[(event.content || '').slice(0, 200)] = soloCard;
        }
        addRow(solo, { inCard: soloCard, chapter: isUser });
        markFor(event, soloCard, kind);
        push(solo);
        i += 1;
        continue;
      }

      /* one model turn: reasoning and prose, then the calls it fired and
         the results that answered them */
      var band = newBand();
      band._turn = turn;
      var consumed = 0;

      while (i < events.length && HEAD_TYPES[events[i].type]) {
        var headCard = buildCard(events[i]);
        addRow(band, { outCard: headCard });
        markFor(events[i], headCard);
        i += 1; consumed += 1;
      }
      var calls = [];
      while (i < events.length && events[i].type === 'tool_call') { calls.push(events[i]); i += 1; consumed += 1; }
      var results = [];
      while (i < events.length && events[i].type === 'tool_result') { results.push(events[i]); i += 1; consumed += 1; }

      if (calls.length > 1) band.classList.add('has-batch');

      var byId = {}, used = {};
      results.forEach(function (r) { if (r.toolCallId) byId[r.toolCallId] = r; });

      calls.forEach(function (call, j) {
        nextCall += 1;
        callNumbers[call.toolCallId] = nextCall;
        var result = call.toolCallId && byId[call.toolCallId];
        if (result) used[call.toolCallId] = 1;
        var callCard = buildCard(call, calls.length > 1 ? '并行 ' + (j + 1) + '/' + calls.length : null);
        var resultCard = result ? buildCard(result) : null;
        callCard._call = nextCall;
        if (resultCard) resultCard._call = nextCall;
        addRow(band, { outCard: callCard, inCard: resultCard, call: nextCall, batch: calls.length > 1 });
        markFor(call, callCard);
        if (result) markFor(result, resultCard);
      });

      results.forEach(function (result) {
        if (result.toolCallId && used[result.toolCallId]) return;
        var orphan = buildCard(result);
        orphan._call = callNumbers[result.toolCallId] || null;
        addRow(band, { inCard: orphan, call: orphan._call });
        markFor(result, orphan);
      });

      if (!consumed) {           /* unknown type — never spin */
        var fallback = buildCard(event);
        addRow(band, IN_TYPES[event.type] ? { inCard: fallback } : { outCard: fallback });
        markFor(event, fallback);
        i += 1;
      }
      push(band);
    }

    el.lanes.appendChild(frag);
    var mapFrag = document.createDocumentFragment();
    marks.forEach(function (m) { mapFrag.appendChild(m); });
    el.minimap.appendChild(mapFrag);

    var inCount = 0, outCount = 0;
    Object.keys(counts).forEach(function (type) {
      if (type === 'thinking' || type === 'assistant' || type === 'tool_call') outCount += counts[type];
      else inCount += counts[type];
    });
    el.countIn.textContent = inCount;
    el.countOut.textContent = outCount;
    el.failCount.textContent = bad;
    Array.prototype.forEach.call(el.filters.querySelectorAll('button'), function (button) {
      button.querySelector('b').textContent = counts[button.dataset.type] || 0;
    });

    paintNotes();
    applyFilters();
    updateScopeCost();
  }

  /* ── run header + provenance rail ────────────────────── */

  function metrics(trajectory) {
    var usage = trajectory.tokenUsage || {};
    var rows = [
      ['事件', trajectory.eventCount || (trajectory.events || []).length],
      ['工具调用', trajectory.toolCallCount != null ? trajectory.toolCallCount : '—'],
      ['错误率', trajectory.errorRate != null ? (trajectory.errorRate * 100).toFixed(1) + '%' : '—'],
      ['Tokens', tokens(usage.total || trajectory.estimatedTokens)],
      ['价值档', trajectory.valueTier || '—']
    ];
    el.runMetrics.textContent = '';
    rows.forEach(function (pair) {
      var wrap = document.createElement('div');
      wrap.appendChild(make('dt', null, pair[0]));
      wrap.appendChild(make('dd', null, String(pair[1])));
      el.runMetrics.appendChild(wrap);
    });
  }

  function factGroup(title, pairs, extra) {
    var group = make('section', 'dlg-fact-group');
    group.appendChild(make('h3', null, title));
    var list = make('dl', 'dlg-facts');
    pairs.forEach(function (pair) {
      if (pair[1] == null || pair[1] === '') return;
      list.appendChild(make('dt', null, pair[0]));
      list.appendChild(make('dd', pair[2] ? 'prose' : null, String(pair[1])));
    });
    group.appendChild(list);
    if (extra) group.appendChild(extra);
    return group;
  }

  function renderSource(trajectory) {
    var env = trajectory.environment || {};
    var usage = trajectory.tokenUsage || {};
    var pipeline = trajectory.pipelineDetail || {};
    el.sourceBody.textContent = '';

    el.sourceBody.appendChild(factGroup('运行来源', [
      ['轨迹 ID', keyOf(trajectory)],
      ['会话 ID', env.conversationId],
      ['请求 ID', env.requestId || usage.requestId],
      ['Runtime', env.runtime],
      ['模型', env.model || trajectory.model],
      ['服务层级', env.serviceTier || usage.serviceTier],
      ['来源文件', env.sourceFile],
      ['数据源', trajectory.dataSource],
      ['判定器', env.verifier],
      ['结果', env.outcome || trajectory.situation],
      ['快照', env.snapshot || trajectory.snapshotLabel]
    ]));

    if (usage.total) {
      var bar = make('div', 'dlg-tokenbar');
      [['cachedInput', 'var(--lane-in)'], ['uncachedInput', 'var(--ink-4)'],
       ['output', 'var(--accent)']].forEach(function (spec) {
        var piece = make('i');
        piece.style.background = spec[1];
        piece.style.width = ((usage[spec[0]] || 0) / usage.total * 100) + '%';
        bar.appendChild(piece);
      });
      el.sourceBody.appendChild(factGroup('Token 账', [
        ['总计', usage.total.toLocaleString()],
        ['缓存输入', (usage.cachedInput || 0).toLocaleString()],
        ['未缓存输入', (usage.uncachedInput || 0).toLocaleString()],
        ['缓存写入', (usage.cacheWrite || 0).toLocaleString()],
        ['输出', (usage.output || 0).toLocaleString()],
        ['推理 tokens', (usage.thinkingTokens || 0).toLocaleString()],
        ['计量来源', usage.source]
      ], bar));
    }

    if (env.taskSummary) {
      el.sourceBody.appendChild(factGroup('任务摘要', [['交付物', env.taskSummary, true]]));
    }

    if (pipeline.classification) {
      var c = pipeline.classification, q = pipeline.quality || {}, d = pipeline.difficulty || {};
      var seg = pipeline.segmentSummary || {}, routing = pipeline.routing || {};
      el.sourceBody.appendChild(factGroup('质量流水线', [
        ['任务类型', c.taskType], ['结果判定', c.situation],
        ['价值档', routing.valueTier], ['路由类别', routing.effectiveCategory],
        ['质量', q.flag], ['最长错误链', q.maxErrorChain],
        ['无进展步数', q.maxNoProgress], ['重复比', q.repeatRatio],
        ['难度', d.flag], ['高质量片段比', seg.highQualityRatio != null ? (seg.highQualityRatio * 100).toFixed(1) + '%' : null],
        ['分段数', seg.segmentCount],
        ['分类理由', c.taskTypeReasoning, true],
        ['判定理由', c.situationReasoning, true]
      ]));
    }
  }

  /* ── selection ───────────────────────────────────────── */

  function pick(band, extend) {
    if (extend && state.lastPicked != null) {
      var lo = Math.min(state.lastPicked, band._index);
      var hi = Math.max(state.lastPicked, band._index);
      state.selection = [];
      for (var k = lo; k <= hi; k += 1) state.selection.push(k);
    } else {
      var at = state.selection.indexOf(band._index);
      if (at === -1) state.selection.push(band._index);
      else state.selection.splice(at, 1);
      state.lastPicked = band._index;
    }
    paintSelection();
    updateScopeCost();
    if (!el.rail.hidden && currentRail() === 'notes') syncNoteForm();
  }

  function paintSelection() {
    state.bands.forEach(function (band) {
      band.classList.toggle('is-selected', state.selection.indexOf(band._index) !== -1);
    });
    el.selectionInfo.hidden = state.selection.length === 0;
    el.selectionCount.textContent = state.selection.length;
  }
  el.selectionClear.addEventListener('click', function () {
    state.selection = []; paintSelection(); updateScopeCost(); syncNoteForm();
  });

  /* ── context assembly for the agent ──────────────────── */

  function bandDigest(band, level) {
    var lines = [];
    band._rows.forEach(function (row) {
      row.cards.forEach(function (card) {
        var e = card._event, kind = card._kind;
        if (kind === 'inject') return;
        if (kind === 'tool_call') {
          lines.push('  → ' + (e.title || 'tool') + ' #' + (card._call || '?') +
            '  ' + firstLine(e.content, level === 'L1' ? 90 : 260));
        } else if (kind === 'tool_result') {
          var head = '  ← #' + (card._call || '?') + ' [' + (e.status || 'ok') + ']';
          if (level === 'L1') lines.push(head);
          else lines.push(head + ' ' + firstLine(e.summary || e.content, 400));
        } else if (kind === 'system' || kind === 'context') {
          lines.push('  [' + LABEL[kind] + ' ' + (e.content || '').length + ' 字符]');
        } else {
          lines.push('  ' + LABEL[kind] + '：' + firstLine(e.content, level === 'L1' ? 400 : 1600));
        }
      });
    });
    if (!lines.length) return '';
    return '[b' + band._index + ']' + (band.classList.contains('is-chapter') ? ' 轮次 ' + band._turn : '') +
      '\n' + lines.join('\n');
  }

  function buildContext() {
    var t = state.current || {};
    var head = [
      '# 轨迹 ' + (t.title || ''),
      '标识 ' + keyOf(t) + ' · 模型 ' + (t.model || '?') + ' · 任务类型 ' + (t.taskType || '?') +
      ' · 事件 ' + (t.eventCount || (t.events || []).length) + ' · 错误率 ' +
      (t.errorRate != null ? (t.errorRate * 100).toFixed(1) + '%' : '?'),
      '每个块前的 [bN] 是块编号，工具调用的 #N 是调用编号；回答时请用它们指认位置。',
      ''
    ].join('\n');

    var chosen = state.scope === 'SEL'
      ? state.bands.filter(function (b) { return state.selection.indexOf(b._index) !== -1; })
      : state.bands;
    var level = state.scope === 'L1' ? 'L1' : 'L2';
    var body = chosen.map(function (b) { return bandDigest(b, level); })
      .filter(Boolean).join('\n\n');
    return head + body;
  }

  function updateScopeCost() {
    if (!state.bands.length) { el.scopeCost.textContent = '≈ 0k tok'; return; }
    var chars = buildContext().length;
    el.scopeCost.textContent = '≈ ' + (chars / 2.2 / 1000).toFixed(1) + 'k tok';
  }

  el.scopeBar.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    state.scope = button.dataset.scope;
    Array.prototype.forEach.call(el.scopeBar.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b === button));
    });
    updateScopeCost();
  });

  /* ── agent panel ─────────────────────────────────────── */

  var SYSTEM_PROMPT =
    '你在分析一条 AI coding agent 的执行轨迹。轨迹已被压缩：左侧是喂给模型的输入' +
    '（系统提示、注入上下文、真人指令、工具结果），右侧是模型的产出（推理、回复、工具调用）。' +
    '回答用中文，结论先行，务必用 [bN] 或 #N 指认你依据的具体位置，不要臆造轨迹里没有的内容。';

  var PRESETS = {
    summary: '摘要这条轨迹：它要解决什么、实际做了什么、最后到哪一步、结论是否可信。',
    stuck:   '找出这条轨迹里卡住、失败或反复试错的地方，逐个说明触发原因和 agent 的应对是否合理。',
    repeat:  '找出重复劳动：重复执行的命令、重复读取的文件、绕圈子的搜索，并估算浪费了多少步。',
    task:    '把这条轨迹改造成一道可自动判分的编程任务：题面、初始环境、隐藏测试的判定点、oracle 解法路径、以及为什么这道题公平。'
  };

  function llmConfig() {
    return readStore(STORE.llm, { base: 'https://colabapi.com/v1', model: 'gpt-5.4', key: '' });
  }
  function paintConfig() {
    var cfg = llmConfig();
    el.cfgBase.value = cfg.base || '';
    el.cfgModel.value = cfg.model || '';
    el.cfgKey.value = cfg.key || '';
    el.endpointState.textContent = cfg.key ? (cfg.model || '已配置') : '未配置 · 只组装不发送';
    el.endpointState.className = cfg.key ? 'ok' : '';
  }
  el.cfgSave.addEventListener('click', function () {
    writeStore(STORE.llm, {
      base: el.cfgBase.value.trim() || 'https://colabapi.com/v1',
      model: el.cfgModel.value.trim() || 'gpt-5.4',
      key: el.cfgKey.value.trim()
    });
    paintConfig();
  });
  el.cfgClear.addEventListener('click', function () {
    var cfg = llmConfig(); cfg.key = ''; writeStore(STORE.llm, cfg); paintConfig();
  });

  function requestBody(question) {
    var cfg = llmConfig();
    return {
      model: cfg.model || 'gpt-5.4',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildContext() + '\n\n---\n\n' + question }
      ],
      temperature: 0.2,
      stream: false
    };
  }

  el.cfgDump.addEventListener('click', function () {
    download(keyOf(state.current) + '.request.json',
      JSON.stringify(requestBody('（把问题填在这里）'), null, 2), 'application/json');
  });

  function addMessage(role, text) {
    var wrap = make('div', 'dlg-msg' + (role === 'me' ? ' me' : ''));
    wrap.appendChild(make('span', 'role', role === 'me' ? '我' : role === 'sys' ? '系统' : 'AI'));
    var body = make('p');
    /* [bN] and #N in a reply jump to that place in the trajectory */
    String(text).split(/(\[b\d+\]|#\d+)/).forEach(function (piece) {
      var band = /^\[b(\d+)\]$/.exec(piece);
      var call = /^#(\d+)$/.exec(piece);
      if (band || call) {
        var jump = make('button', 'jump', piece);
        jump.type = 'button';
        jump.addEventListener('click', function () {
          var target = band
            ? state.bands[Number(band[1])]
            : state.cards.filter(function (c) { return c._call === Number(call[1]); })[0];
          if (target) target.scrollIntoView({ block: 'center' });
        });
        body.appendChild(jump);
      } else if (piece) {
        body.appendChild(document.createTextNode(piece));
      }
    });
    wrap.appendChild(body);
    el.chat.appendChild(wrap);
    el.chat.scrollTop = el.chat.scrollHeight;
    return wrap;
  }

  function ask(question) {
    if (!question) return;
    addMessage('me', question);
    var cfg = llmConfig();
    var body = requestBody(question);

    if (!cfg.key) {
      addMessage('sys',
        '未配置 API Key，请求体已组装但未发送（' +
        (JSON.stringify(body).length / 1024).toFixed(1) + ' KB，约 ' +
        (JSON.stringify(body).length / 2.2 / 1000).toFixed(1) + 'k tok）。\n' +
        '点「导出请求体」可下载，交给后端转发；或在接口设置里填 Key 直连。');
      return;
    }

    var pending = addMessage('ai', '…');
    fetch(cfg.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var text = data && data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content;
        pending.remove();
        addMessage('ai', text || ('没有返回内容：' + JSON.stringify(data).slice(0, 400)));
      })
      .catch(function (err) {
        pending.remove();
        addMessage('sys', '请求失败：' + err.message +
          '\n（静态页直连需要中转站允许跨域；否则走后端转发。）');
      });
  }

  el.presets.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (button) ask(PRESETS[button.dataset.preset]);
  });
  el.composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = el.composerInput.value.trim();
    el.composerInput.value = '';
    ask(text);
  });
  el.composerInput.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      el.composer.requestSubmit();
    }
  });

  /* ── notes ───────────────────────────────────────────── */

  function allNotes() { return readStore(STORE.notes, {}); }
  function runNotes() { return allNotes()[keyOf(state.current)] || {}; }

  function saveRunNotes(map) {
    var all = allNotes();
    all[keyOf(state.current)] = map;
    writeStore(STORE.notes, all);
    paintNotes();
  }

  function paintNotes() {
    var map = runNotes();
    var keys = Object.keys(map);
    el.noteCount.textContent = keys.length;
    state.bands.forEach(function (band) {
      band.classList.toggle('has-note', !!map[band._index]);
    });
    el.noteList.textContent = '';
    keys.sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
      var entry = map[key];
      var item = make('button', 'dlg-note-item');
      item.type = 'button';
      item.appendChild(make('b', null, '[b' + key + '] ' + (entry.tags || []).join(' · ')));
      item.appendChild(make('span', null, entry.note || ''));
      item.addEventListener('click', function () {
        var band = state.bands[Number(key)];
        if (band) { band.scrollIntoView({ block: 'center' }); state.selection = [Number(key)]; paintSelection(); syncNoteForm(); }
      });
      el.noteList.appendChild(item);
    });
  }

  function syncNoteForm() {
    var one = state.selection.length === 1 ? state.selection[0] : null;
    el.noteForm.hidden = one == null;
    el.noteHint.hidden = one != null;
    if (one == null) return;
    var entry = runNotes()[one] || { tags: [], note: '' };
    el.noteTarget.textContent = '[b' + one + ']';
    el.noteText.value = entry.note || '';
    Array.prototype.forEach.call(el.tagRow.querySelectorAll('button'), function (button) {
      button.setAttribute('aria-pressed',
        String((entry.tags || []).indexOf(button.textContent) !== -1));
    });
  }

  TAGS.forEach(function (tag) {
    var button = make('button', null, tag);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', function () {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    });
    el.tagRow.appendChild(button);
  });

  el.noteSave.addEventListener('click', function () {
    var one = state.selection.length === 1 ? state.selection[0] : null;
    if (one == null) return;
    var tags = Array.prototype.filter.call(el.tagRow.querySelectorAll('button'), function (b) {
      return b.getAttribute('aria-pressed') === 'true';
    }).map(function (b) { return b.textContent; });
    var map = runNotes();
    map[one] = { tags: tags, note: el.noteText.value.trim(), at: new Date().toISOString() };
    saveRunNotes(map);
  });

  el.noteDelete.addEventListener('click', function () {
    var one = state.selection.length === 1 ? state.selection[0] : null;
    if (one == null) return;
    var map = runNotes();
    delete map[one];
    saveRunNotes(map);
    syncNoteForm();
  });

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  el.noteExport.addEventListener('click', function () {
    var all = allNotes();
    var lines = [];
    Object.keys(all).forEach(function (run) {
      Object.keys(all[run]).forEach(function (band) {
        var entry = all[run][band];
        lines.push(JSON.stringify({
          run: run, band: Number(band), tags: entry.tags || [],
          note: entry.note || '', annotated_at: entry.at
        }));
      });
    });
    download('trajectory-notes.jsonl', lines.join('\n') + '\n', 'application/x-ndjson');
  });

  /* ── rail ────────────────────────────────────────────── */

  function currentRail() {
    var on = el.railTabs.querySelector('[aria-pressed="true"]');
    return on ? on.dataset.rail : 'source';
  }
  function openRail(which) {
    el.rail.hidden = false;
    document.body.classList.add('rail-open');
    Array.prototype.forEach.call(el.railTabs.querySelectorAll('button'), function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.rail === which));
    });
    Array.prototype.forEach.call(el.rail.querySelectorAll('.dlg-rail-panel'), function (panel) {
      panel.hidden = panel.dataset.rail !== which;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.dlg-tool[data-rail]'), function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.rail === which));
    });
    if (which === 'notes') syncNoteForm();
    if (which === 'agent') { paintConfig(); updateScopeCost(); }
  }
  function closeRail() {
    el.rail.hidden = true;
    document.body.classList.remove('rail-open');
    Array.prototype.forEach.call(document.querySelectorAll('.dlg-tool[data-rail]'), function (button) {
      button.setAttribute('aria-pressed', 'false');
    });
  }
  document.querySelectorAll('.dlg-tool[data-rail]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!el.rail.hidden && currentRail() === button.dataset.rail) closeRail();
      else openRail(button.dataset.rail);
    });
  });
  el.railTabs.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (button) openRail(button.dataset.rail);
  });
  el.railClose.addEventListener('click', closeRail);

  /* ── filters ─────────────────────────────────────────── */

  function applyFilters() {
    var needle = el.search.value.trim().toLowerCase();
    var failMode = el.failOnly.getAttribute('aria-pressed') === 'true';
    var keepCalls = {};
    if (failMode) {
      state.cards.forEach(function (card) {
        if (card._bad && card._call) keepCalls[card._call] = 1;
      });
    }
    state.cards.forEach(function (card) {
      var ok = !state.hidden[card._type];
      if (ok && failMode) ok = card._bad || (card._call && keepCalls[card._call]);
      if (ok && needle) ok = card._haystack.indexOf(needle) !== -1;
      card.hidden = !ok;
    });
    state.rows.forEach(function (row) {
      row.gut.hidden = !row.cards.some(function (card) { return !card.hidden; });
    });
    var shown = 0;
    state.bands.forEach(function (band) {
      var live = band._rows.some(function (row) { return !row.gut.hidden; });
      band.hidden = !live;
      if (live) shown += 1;
    });
    el.empty.hidden = shown > 0;
  }

  el.filters.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    var on = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!on));
    state.hidden[button.dataset.type] = on;
    applyFilters();
  });
  el.failOnly.addEventListener('click', function () {
    this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'));
    applyFilters();
  });
  el.search.addEventListener('input', applyFilters);
  el.expandAll.addEventListener('click', function () {
    state.cards.forEach(function (card) { if (!card.hidden) setOpen(card, true); });
  });
  el.collapseAll.addEventListener('click', function () {
    state.cards.forEach(function (card) { setOpen(card, false); });
  });

  /* ── keyboard ────────────────────────────────────────── */

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); el.search.focus(); el.search.select(); return;
    }
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'Escape') { closeRail(); return; }
    if (event.key !== 'n' && event.key !== 'N') return;
    var failures = state.cards.filter(function (card) { return card._bad && !card.hidden; });
    if (!failures.length) return;
    var top = window.scrollY + 140;
    var next = event.key === 'n'
      ? failures.filter(function (c) { return c.offsetTop > top + 10; })[0]
      : failures.filter(function (c) { return c.offsetTop < top - 10; }).pop();
    (next || failures[0]).scrollIntoView({ block: 'center' });
  });

  /* ── select a trajectory ─────────────────────────────── */

  function select(trajectory) {
    state.current = trajectory;
    state.messages = [];
    el.chat.textContent = '';
    el.pickerLabel.textContent = trajectory.title || trajectory.shortId;
    el.pickerMeta.textContent = keyOf(trajectory);
    el.runKicker.textContent = String(trajectory.trajectoryClass || 'trajectory').toUpperCase();
    el.runTitle.textContent = trajectory.title || trajectory.shortId;
    el.runSub.textContent = [
      trajectory.model, trajectory.agent || 'Claude Code',
      trajectory.dataSource, trajectory.taskType, trajectory.snapshotLabel
    ].filter(Boolean).join(' · ');
    metrics(trajectory);
    renderSource(trajectory);

    el.lanes.textContent = '';
    el.empty.hidden = true;

    var url = new URL(location.href);
    url.searchParams.set('run', keyOf(trajectory));
    history.replaceState(null, '', url);

    eventsOf(trajectory).then(render);
  }

  /* ── boot ────────────────────────────────────────────── */

  Array.prototype.forEach.call(el.filters.querySelectorAll('button'), function (button) {
    state.hidden[button.dataset.type] = button.getAttribute('aria-pressed') !== 'true';
  });
  paintConfig();
  el.pickerMeta.textContent = trajectories.length + ' 条';

  var wanted = new URL(location.href).searchParams.get('run');
  var start = wanted && trajectories.filter(function (t) {
    return keyOf(t) === wanted || t.id === wanted || t.shortId === wanted;
  })[0];
  select(start || trajectories[0]);
})();
