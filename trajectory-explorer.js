(function () {
  'use strict';

  var trajectories = (window.EMPIRIA_RAW_TRAJECTORIES || [])
    .concat(window.EMPIRIA_SWE_TRAJECTORIES || [])
    .concat(window.EMPIRIA_TB_TRAJECTORIES || [])
    .concat(window.EMPIRIA_FEEDBACK_SNAPSHOTS || []);
  if (!trajectories.length) return;

  var selectedIndex = 0;
  var activeCategory = (function () {
    var order = ['feedback', 'swe', 'terminal'];
    var wanted = new URLSearchParams(location.search).get('category');
    if (order.indexOf(wanted) >= 0) return wanted;
    var present = order.filter(function (category) {
      return trajectories.some(function (t) { return t.trajectoryClass === category; });
    });
    return present[0] || 'feedback';
  })();
  var highQualityOnly = false;
  var deduplicateSessions = false;
  var timelineMode = 'linear';
  var timelineFullscreen = false;
  var sidebarVisible = true;
  var pageScrollY = 0;
  var activeFilters = new Set(['user', 'thinking', 'assistant', 'tool_call', 'tool_result']);
  var elements = {
    topCategoryNav: document.getElementById('topCategoryNav'),
    main: document.querySelector('.trajectory-main'),
    sidebar: document.getElementById('analyticsSidebar'),
    sidebarGroups: document.getElementById('sidebarGroups'),
    sidebarRunCount: document.getElementById('sidebarRunCount'),
    sidebarOpen: document.getElementById('sidebarOpen'),
    sidebarClose: document.getElementById('sidebarClose'),
    runView: document.getElementById('runView'),
    categoryEmpty: document.getElementById('categoryEmpty'),
    pipelinePanel: document.getElementById('pipelinePanel'),
    pipelineCleanFacts: document.getElementById('pipelineCleanFacts'),
    pipelineClassificationFacts: document.getElementById('pipelineClassificationFacts'),
    pipelineReasonList: document.getElementById('pipelineReasonList'),
    pipelineRoutingFacts: document.getElementById('pipelineRoutingFacts'),
    pipelineQualityFacts: document.getElementById('pipelineQualityFacts'),
    pipelineDifficultyFacts: document.getElementById('pipelineDifficultyFacts'),
    pipelineSegmentFacts: document.getElementById('pipelineSegmentFacts'),
    pipelineSegments: document.getElementById('pipelineSegments'),
    pipelineThinkingFacts: document.getElementById('pipelineThinkingFacts'),
    pipelineDatasetFacts: document.getElementById('pipelineDatasetFacts'),
    runSearch: document.getElementById('runSearch'),
    search: document.getElementById('trajectorySearch'),
    filters: document.getElementById('trajectoryFilters'),
    timelineWorkspace: document.getElementById('timelineWorkspace'),
    timelineToolbar: document.getElementById('timelineToolbar'),
    timeline: document.getElementById('rawTimeline'),
    linearViewButton: document.getElementById('linearViewButton'),
    dialogueViewButton: document.getElementById('dialogueViewButton'),
    embeddedDialogue: document.getElementById('embeddedDialogue'),
    dialogueFrame: document.getElementById('dialogueFrame'),
    timelineFullscreen: document.getElementById('timelineFullscreen'),
    empty: document.getElementById('rawEmpty'),
    expand: document.getElementById('expandVisible'),
    collapse: document.getElementById('collapseAll'),
    highQualityOnly: document.getElementById('highQualityOnly'),
    deduplicateSessions: document.getElementById('deduplicateSessions'),
    environmentPanel: document.getElementById('environmentPanel'),
    environmentGrid: document.getElementById('environmentGrid'),
    lifecycle: document.getElementById('environmentLifecycle'),
    taskFacts: document.getElementById('taskFacts'),
    verificationList: document.getElementById('verificationList')
  };

  var classLabels = { feedback: 'Feedback trajectories', swe: 'SWE environments', terminal: 'Terminal-Bench' };
  var typeLabels = { user: 'User', thinking: 'Thinking', assistant: 'Assistant', tool_call: 'Tool call', tool_result: 'Tool result', context: 'Context', system: 'System' };

  function text(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value == null || value === '' ? '—' : value;
  }

  function number(value) {
    return typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : (value || '—');
  }

  function duration(seconds) {
    if (typeof seconds !== 'number') return '—';
    var minutes = Math.floor(seconds / 60);
    var remainder = Math.round(seconds % 60);
    return minutes ? minutes + 'm ' + String(remainder).padStart(2, '0') + 's' : remainder + 's';
  }

  function titleCase(value) {
    return String(value || '—').replace(/_/g, ' ').replace(/\b\w/g, function (char) { return char.toUpperCase(); });
  }

  function yesNo(value) {
    if (value == null) return '—';
    return value ? 'Yes' : 'No';
  }

  function percent(value) {
    return typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '—';
  }

  function reasons(value) {
    return value && value.length ? value.join(' · ') : 'None';
  }

  function optionalNumber(value) {
    return value == null ? 'Not reported' : number(value);
  }

  function highQualityNodeMap(trajectory) {
    var source = window.EMPIRIA_FEEDBACK_PIPELINE || {};
    var detail = trajectory.pipelineDetail || source.trajectories && source.trajectories[trajectory.id];
    var map = {};
    if (!detail) return map;
    (detail.segments || []).forEach(function (segment) {
      if (segment.label !== 'high_quality') return;
      (segment.nodes || []).forEach(function (node) {
        var sourceIndices = segment.nodeSources && segment.nodeSources[node] || [];
        sourceIndices.forEach(function (sourceIndex) {
          map[sourceIndex] = { node: node, pattern: segment.pattern, reason: segment.reason };
        });
      });
    });
    return map;
  }

  function isEnvTask(trajectory) {
    return trajectory.trajectoryClass === 'swe' || trajectory.trajectoryClass === 'terminal';
  }

  function trajectoryStatus(trajectory) {
    var environment = trajectory.environment || {};
    var successful = trajectory.situation === 'successful' || environment.resolved === 'true' || environment.reward === '1.0';
    return { successful: successful, label: successful ? 'Successful' : 'Error' };
  }

  function trajectorySourceLabel(trajectory) {
    if (trajectory.trajectoryClass === 'feedback') return 'Feedback';
    if (trajectory.trajectoryClass === 'swe') return 'SWE';
    if (trajectory.trajectoryClass === 'terminal') return 'Terminal-Bench';
    return titleCase(trajectory.trajectoryClass);
  }

  function categoryItems(category) {
    return trajectories.filter(function (trajectory) { return trajectory.trajectoryClass === category; });
  }

  function categoryCount(category) {
    return applySnapshotDedup(categoryItems(category)).length;
  }

  function applySnapshotDedup(items) {
    if (!deduplicateSessions) return items;
    var bestBySession = new Map();
    items.forEach(function (trajectory) {
      if (!trajectory.snapshotLabel || !trajectory.conversationId) return;
      var current = bestBySession.get(trajectory.conversationId);
      if (!current || trajectory.messageCount > current.messageCount ||
          (trajectory.messageCount === current.messageCount && trajectory.eventCount > current.eventCount) ||
          (trajectory.messageCount === current.messageCount && trajectory.eventCount === current.eventCount && trajectory.snapshotOrdinal > current.snapshotOrdinal)) {
        bestBySession.set(trajectory.conversationId, trajectory);
      }
    });
    return items.filter(function (trajectory) {
      return !trajectory.snapshotLabel || bestBySession.get(trajectory.conversationId) === trajectory;
    });
  }

  function selectedTrajectory() {
    return trajectories[selectedIndex];
  }

  function dialogueKey(trajectory) {
    return (trajectory.shortId || trajectory.id) +
      (trajectory.snapshotOrdinal ? '-s' + trajectory.snapshotOrdinal : '');
  }

  function dialogueUrl(trajectory) {
    return 'trajectory-dialogue.html?embed=1&run=' + encodeURIComponent(dialogueKey(trajectory));
  }

  function syncDialogue(trajectory) {
    var url = dialogueUrl(trajectory);
    elements.dialogueFrame.dataset.src = url;
    if (timelineMode === 'dialogue' && elements.dialogueFrame.getAttribute('src') !== url) {
      elements.dialogueFrame.src = url;
    }
  }

  function setTimelineMode(mode) {
    timelineMode = mode === 'dialogue' ? 'dialogue' : 'linear';
    var dialogue = timelineMode === 'dialogue';
    elements.linearViewButton.setAttribute('aria-pressed', String(!dialogue));
    elements.dialogueViewButton.setAttribute('aria-pressed', String(dialogue));
    elements.timeline.hidden = dialogue;
    elements.embeddedDialogue.hidden = !dialogue;
    elements.timelineToolbar.hidden = dialogue;
    if (dialogue) {
      elements.empty.hidden = true;
      syncDialogue(selectedTrajectory());
      text('timelineStatus', 'Two-lane view');
    } else {
      renderTimeline();
    }
  }

  function setSidebarVisible(visible) {
    sidebarVisible = visible;
    var mobile = window.innerWidth <= 820;
    elements.main.classList.toggle('sidebar-collapsed', !visible && !mobile);
    elements.sidebar.classList.toggle('open', visible && mobile);
    elements.sidebarOpen.setAttribute('aria-expanded', String(visible));
  }

  function setTimelineFullscreen(active) {
    timelineFullscreen = Boolean(active);
    if (timelineFullscreen) pageScrollY = window.scrollY;
    document.body.classList.toggle('timeline-fullscreen', timelineFullscreen);
    elements.timelineFullscreen.setAttribute('aria-pressed', String(timelineFullscreen));
    elements.timelineFullscreen.firstChild.nodeValue = timelineFullscreen ? 'Exit fullscreen ' : 'Fullscreen ';
    if (!timelineFullscreen) window.scrollTo(0, pageScrollY);
  }

  function loadTrajectoryEvents(trajectory) {
    if (Array.isArray(trajectory.events)) return Promise.resolve(trajectory);
    if (!trajectory.lazyData) return Promise.reject(new Error('Trajectory data source is missing'));
    if (trajectory.loadingPromise) return trajectory.loadingPromise;
    trajectory.loadingPromise = fetch(trajectory.lazyData).then(function (response) {
      if (!response.ok) throw new Error('Unable to load trajectory data (' + response.status + ')');
      return response.json();
    }).then(function (payload) {
      trajectory.events = payload.events || [];
      return trajectory;
    }).finally(function () {
      trajectory.loadingPromise = null;
    });
    return trajectory.loadingPromise;
  }

  function setSelectedById(id) {
    var index = trajectories.findIndex(function (trajectory) { return trajectory.id === id; });
    if (index < 0) return;
    selectedIndex = index;
    activeCategory = trajectories[index].trajectoryClass;
    highQualityOnly = false;
    var trajectory = trajectories[index];
    if (Array.isArray(trajectory.events)) {
      renderAll();
    } else {
      renderCategoryNav(); renderSidebar();
      elements.runView.hidden = false; elements.categoryEmpty.hidden = true;
      renderHeader(trajectory); renderMetrics(trajectory); renderPipelineDetails(trajectory); renderEnvironment(trajectory);
      renderTaskAndVerification(trajectory); renderTokens(trajectory); updateFilterCounts(trajectory);
      elements.search.value = '';
      elements.timeline.innerHTML = '<p class="trajectory-loading">Loading full trajectory…</p>';
      elements.empty.hidden = true;
      text('visibleCount', '0'); text('eventCount', 'of ' + number(trajectory.eventCount) + ' events'); text('timelineStatus', 'Loading');
      loadTrajectoryEvents(trajectory).then(function () {
        if (selectedTrajectory() !== trajectory) return;
        renderPipelineDetails(trajectory);      /* some panels read the loaded body */
        renderTimeline();
      }).catch(function (error) {
        if (selectedTrajectory() !== trajectory) return;
        elements.timeline.innerHTML = '<p class="trajectory-load-error">' + error.message + '</p>';
        text('timelineStatus', 'Load error');
      });
    }
    if (window.innerWidth <= 820) elements.sidebar.classList.remove('open');
  }

  function renderCategoryNav() {
    Array.prototype.forEach.call(elements.topCategoryNav.querySelectorAll('[data-category]'), function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.category === activeCategory));
    });
  }

  function renderSidebar() {
    var query = elements.runSearch.value.trim().toLowerCase();
    var outcomeChecks = Array.prototype.slice.call(document.querySelectorAll('[data-run-filter]'));
    var allowSuccess = outcomeChecks.find(function (input) { return input.dataset.runFilter === 'successful'; }).checked;
    var allowFailed = outcomeChecks.find(function (input) { return input.dataset.runFilter === 'failed'; }).checked;
    elements.sidebarGroups.textContent = '';
    var visibleRuns = 0;
    var snapshotItems = categoryItems('feedback').filter(function (trajectory) { return Boolean(trajectory.snapshotLabel); });
    var snapshotSessions = new Set(snapshotItems.map(function (trajectory) { return trajectory.conversationId; })).size;
    text('deduplicateHint', deduplicateSessions ? snapshotSessions + ' longest snapshots · ' + (snapshotItems.length - snapshotSessions) + ' hidden' : snapshotItems.length + ' snapshots → ' + snapshotSessions + ' longest');

    ['feedback', 'swe', 'terminal'].slice().sort(function (a, b) {
      return (a === activeCategory ? -1 : 0) - (b === activeCategory ? -1 : 0);
    }).forEach(function (category) {
      var section = document.createElement('section');
      section.className = 'sidebar-group';
      var heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'sidebar-group-heading';
      heading.dataset.category = category;
      heading.setAttribute('aria-pressed', String(activeCategory === category));
      heading.innerHTML = '<span>' + classLabels[category] + '</span><b>' + categoryCount(category) + '</b>';
      heading.addEventListener('click', function () {
        activeCategory = category;
        highQualityOnly = false;
        var first = applySnapshotDedup(categoryItems(category))[0];
        if (first) selectedIndex = trajectories.indexOf(first);
        renderAll();
      });
      section.appendChild(heading);

      var list = document.createElement('div');
      list.className = 'sidebar-run-list';
      var items = applySnapshotDedup(categoryItems(category)).filter(function (trajectory) {
        var status = trajectoryStatus(trajectory);
        if (status.successful && !allowSuccess) return false;
        if (!status.successful && !allowFailed) return false;
        var haystack = [trajectory.title, trajectory.id, trajectory.shortId, trajectory.snapshotLabel, trajectory.taskType,
          trajectory.environment && trajectory.environment.repository, trajectory.environment && trajectory.environment.task,
          trajectory.environment && trajectory.environment.taskSummary].join(' ').toLowerCase();
        return !query || haystack.indexOf(query) !== -1;
      });

      if (!items.length) {
        var none = document.createElement('p');
        none.className = 'sidebar-empty';
        none.textContent = category === 'terminal' ? 'Awaiting Terminal-Bench trajectories' : 'No matching runs';
        list.appendChild(none);
      }

      function appendRun(trajectory) {
        visibleRuns += 1;
        var status = trajectoryStatus(trajectory);
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'sidebar-run';
        button.setAttribute('aria-pressed', String(trajectory === selectedTrajectory()));
        var runDescriptor = [trajectory.shortId, trajectory.snapshotLabel, trajectory.model || 'unknown model'].filter(Boolean).join(' · ');
        button.innerHTML = '<span class="sidebar-run-status ' + (status.successful ? 'success' : 'error') + '"></span>' +
          '<span class="sidebar-run-copy"><strong>' + trajectory.title + '</strong><small>' + runDescriptor + '</small></span>';
        button.addEventListener('click', function () { setSelectedById(trajectory.id); });
        list.appendChild(button);
      }

      items.forEach(appendRun);
      section.appendChild(list);
      elements.sidebarGroups.appendChild(section);
    });
    text('sidebarRunCount', visibleRuns + (visibleRuns === 1 ? ' trajectory' : ' trajectories'));
  }

  function appendFacts(root, facts) {
    root.textContent = '';
    facts.forEach(function (fact) {
      if (fact[1] == null || fact[1] === '') return;
      var row = document.createElement('div');
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = fact[0];
      dd.textContent = fact[1];
      if (fact[2]) dd.className = fact[2];
      row.appendChild(dt); row.appendChild(dd); root.appendChild(row);
    });
  }

  function renderHeader(trajectory) {
    var env = trajectory.environment || {};
    var status = trajectoryStatus(trajectory);
    text('runBreadcrumb', trajectorySourceLabel(trajectory) + ' / ' + trajectory.shortId);
    text('trajectoryName', trajectory.title);
    text('runSubtitle', trajectory.trajectoryClass === 'swe' && env.provShape
      ? [env.repository, env.task, env.provShape].filter(Boolean).join('  ·  ')
      : trajectory.trajectoryClass === 'terminal'
      ? [env.repository, env.patchTarget, env.calGrade && 'graded ' + env.calGrade].filter(Boolean).join('  ·  ')
      : (env.issue || env.taskName || trajectory.taskType || 'Agent trajectory'));
    var badge = document.getElementById('trajectoryResult');
    badge.textContent = status.label;
    badge.className = 'run-status ' + (status.successful ? 'success' : 'error');
    var meta = [trajectory.model, trajectory.agent || env.agent, trajectory.dataSource, trajectory.snapshotLabel, trajectory.id].filter(Boolean);
    document.getElementById('runMetaLine').textContent = meta.join(' · ');
    syncDialogue(trajectory);
  }

  function renderMetrics(trajectory) {
    var env = trajectory.environment || {};
    var tokens = trajectory.tokenUsage || {};
    var counts = trajectory.counts || {};
    var agentSteps = trajectory.agentStepCount;
    if (agentSteps == null && isEnvTask(trajectory)) {
      agentSteps = Math.max(0, (trajectory.messageCount || 0) - (counts.system || 0) - (counts.user || 0));
    }
    text('metricPrimaryLabel', isEnvTask(trajectory) ? 'Reward' : 'Value tier');
    text('metricOutcomeLabel', isEnvTask(trajectory) ? 'Verification' : 'Outcome');
    text('metricReward', isEnvTask(trajectory) ? env.reward : trajectory.valueTier);
    text('metricDuration', env.duration != null ? duration(env.duration) : '—');
    text('metricSteps', trajectory.agentStepCount != null ? trajectory.agentStepCount : counts.thinking);
    text('metricTools', number(trajectory.toolCallCount));
    text('metricTokens', number(tokens.total));
    text('metricVerification', isEnvTask(trajectory) ? (env.tests || env.verdict) : titleCase(trajectory.situation));
  }

  function renderEnvironment(trajectory) {
    var env = trajectory.environment || {};
    text('environmentFamily', env.family || titleCase(trajectory.trajectoryClass));
    var facts;
    if (isEnvTask(trajectory)) {
      facts = [
        ['Benchmark', env.benchmark], ['Task', env.task], ['Repository', env.repository], ['Base commit', env.baseCommit],
        ['Version', env.version], ['Difficulty', env.difficulty], ['Runtime', env.runtime], ['OS / architecture', [env.os, env.architecture].filter(Boolean).join(' · ')], ['Image', env.image],
        ['Workspace', env.workdir], ['Resources', [env.cpu, env.memory, env.storage].filter(Boolean).join(' · ')],
        ['Internet', env.internet], ['Agent', env.agent], ['Model', env.model], ['Service tier', env.serviceTier], ['Verifier', env.verifier]
      ];
    } else {
      facts = [
      ['Family', env.family], ['Source file', env.sourceFile], ['Snapshot', env.snapshot], ['Runtime', env.runtime], ['Model', env.model],
      ['Service tier', env.serviceTier], ['Request ID', env.requestId],
        ['Verifier', env.verifier], ['Report', env.report], ['Data source', trajectory.dataSource],
        ['Conversation ID', env.conversationId || trajectory.conversationId || trajectory.id], ['Run ID', trajectory.snapshotLabel ? trajectory.id : null]
      ];
    }
    appendFacts(elements.environmentGrid, facts);

    if (isEnvTask(trajectory)) {
      elements.lifecycle.hidden = false;
      var stages = [
        ['Environment setup', env.environmentSetupDuration], ['Agent setup', env.agentSetupDuration], ['Execution', env.agentDuration], ['Verification', env.verifierDuration]
      ];
      var total = stages.reduce(function (sum, stage) { return sum + (stage[1] || 0); }, 0);
      elements.lifecycle.innerHTML = stages.map(function (stage) {
        return '<div style="--share:' + ((stage[1] || 0) / total * 100).toFixed(2) + '%"><span>' + stage[0] + '</span><i></i><b>' + duration(stage[1]) + '</b></div>';
      }).join('');
    } else {
      elements.lifecycle.hidden = true;
      elements.lifecycle.textContent = '';
    }
  }

  function renderTaskAndVerification(trajectory) {
    var env = trajectory.environment || {};
    text('taskStatement', env.issue || trajectory.title);
    appendFacts(elements.taskFacts, isEnvTask(trajectory) ? [
      ['Task type', trajectory.taskType], ['Category', env.taskCategory || trajectory.category], ['Model', trajectory.model || env.model],
      ['Service tier', env.serviceTier || trajectory.serviceTier || 'Not reported'],
      ['Created', env.created || env.provAuthorDate], ['Base commit', env.baseCommit],
      ['Commit subject', env.commitSubject],
      ['Patch target', env.patchTarget || (env.goldFiles || []).join(', ')],
      ['Regression test', env.regressionTest || (env.hiddenTests || []).join(', ')],
      ['Withheld from agent', (env.provWithheld || []).join(', ')]
    ] : [
      ['Category', trajectory.category], ['Task type', trajectory.taskType], ['Value tier', trajectory.valueTier],
      ['Model', trajectory.model], ['Data source', trajectory.dataSource], ['Messages', number(trajectory.messageCount)]
    ]);

    appendFacts(elements.verificationList, isEnvTask(trajectory) ? [
      ['Reward', env.reward, env.resolved === 'true' ? 'success-text' : 'error-text'],
      ['Resolved', env.resolved, env.resolved === 'true' ? 'success-text' : 'error-text'],
      ['Verdict', env.verdict],
      ['Patch exists', env.patchExists, 'success-text'], ['Patch applied', env.patchApplied, 'success-text'],
      ['FAIL_TO_PASS', env.failToPass, 'success-text'], ['PASS_TO_PASS', env.passToPass, 'success-text'],
      ['Tests', env.tests, env.resolved === 'true' ? 'success-text' : null],
      ['Verifier rc', env.verifierRc == null ? null : String(env.verifierRc)], ['Graded by', env.gradedBy],
      ['Exception', env.exception || (env.resolved === 'true' ? 'None' : env.stoppedBecause),
        env.resolved === 'true' ? 'success-text' : 'error-text']
    ] : [
      ['Outcome', titleCase(trajectory.situation), trajectoryStatus(trajectory).successful ? 'success-text' : 'error-text'],
      ['Value tier', trajectory.valueTier], ['Error rate', trajectory.errorRate == null ? '—' : (trajectory.errorRate * 100).toFixed(1) + '%'],
      ['Tool calls', number(trajectory.toolCallCount)], ['Events', number(Array.isArray(trajectory.events) ? trajectory.events.length : trajectory.eventCount)], ['Report', env.report]
    ]);
  }

  function appendReasons(root, entries) {
    root.textContent = '';
    entries.forEach(function (entry) {
      if (!entry[1]) return;
      var item = document.createElement('article');
      var label = document.createElement('p');
      var copy = document.createElement('span');
      label.textContent = entry[0];
      copy.textContent = entry[1];
      item.appendChild(label);
      item.appendChild(copy);
      root.appendChild(item);
    });
  }

  var FEEDBACK_HEADINGS = ['Cleaning quality', 'Task classification', 'Value & routing',
    'Quality analysis', 'Difficulty', 'Thinking cleanup', 'Quality segments', 'Dataset snapshot'];
  var SWE_HEADINGS = ['Commit provenance', 'Task construction', 'Two-arm gate',
    'Suite-flip evidence', 'Gold patch & hidden tests', 'Run outcome',
    'Gate arms (raw pytest tails)', 'Pack & budgets'];

  function setPipelineHeadings(headings, panelTitle) {
    headings.forEach(function (label, index) { text('pipeH' + (index + 1), label); });
    text('pipelinePanelTitle', panelTitle);
  }

  function list(value) { return value && value.length ? (Array.isArray(value) ? value.join(', ') : value) : null; }

  function renderSweProvenance(trajectory) {
    var env = trajectory.environment || {};
    var ev = env.provEvidence || {};
    var judge = env.provJudge || {};
    var behavior = judge.behavior_summary || {};
    elements.pipelinePanel.hidden = false;
    setPipelineHeadings(SWE_HEADINGS, 'Provenance & gate evidence');
    text('pipelineSourceLabel', 'Mining pipeline · ' + (env.provRoute || 'swebench'));
    text('pipelineSummaryStatus',
      (env.gateOracleRc === 0 && env.gateEmptyRc !== 0 ? 'Gate passed' : 'Gate incomplete')
      + ' · ' + (env.provShape || '—'));

    appendFacts(elements.pipelineCleanFacts, [
      ['Repository', env.repository], ['Repo URL', env.provRepoUrl], ['Bucket', env.provBucket],
      ['Commit', env.baseCommit], ['Parent', env.provParent], ['Subject', env.commitSubject],
      ['Author', env.provAuthor], ['Authored', env.provAuthorDate],
      ['Merge commit', env.provIsMerge == null ? null : yesNo(env.provIsMerge)],
      ['Issue refs', list(env.provIssueRefs) || 'None'], ['Issue tracker', env.provIssueTracker]
    ]);
    appendFacts(elements.pipelineClassificationFacts, [
      ['Instance ID', env.provInstanceId], ['Shape', env.provShape], ['Route', env.provRoute],
      ['Statement origin', env.provStatementOrigin], ['Test origin', env.provTestOrigin],
      ['Withheld from agent', list(env.provWithheld)], ['Harbor ref', env.provHarborRef],
      ['Image digest', env.provImageDigest], ['Gold patch digest', env.provGoldDigest],
      ['Test patch digest', env.provTestDigest], ['Base tarball', env.baseTarball]
    ]);
    appendReasons(elements.pipelineReasonList, [
      ['User scenario', behavior.user_scenario], ['Wrong behavior', behavior.wrong_behavior],
      ['Expected behavior', behavior.expected_behavior],
      ['Judge verdict', judge.verdict || judge.decision], ['Judge reason', judge.reason || judge.rationale]
    ]);
    appendFacts(elements.pipelineRoutingFacts, [
      ['Empty-patch rc', env.gateEmptyRc == null ? null : String(env.gateEmptyRc)],
      ['Empty-patch reward', env.gateEmptyReward == null ? null : String(env.gateEmptyReward)],
      ['Gold-patch rc', env.gateOracleRc == null ? null : String(env.gateOracleRc)],
      ['Gold-patch reward', env.gateOracleReward == null ? null : String(env.gateOracleReward)],
      ['Empty arm summary', env.gateEmptySummary], ['Gold arm summary', env.gateOracleSummary]
    ]);
    appendFacts(elements.pipelineQualityFacts, [
      ['base_rc', ev.base_rc], ['broken_rc', ev.broken_rc], ['fixed_rc', ev.fixed_rc],
      ['gold_patch_rc', ev.gold_patch_rc], ['test_patch_rc', ev.test_patch_rc], ['tree_rc', ev.tree_rc],
      ['Evidence source', ev.source]
    ]);
    appendFacts(elements.pipelineDifficultyFacts, [
      ['Gold files', list(env.goldFiles)], ['Lines added', number(env.goldAdd)], ['Lines removed', number(env.goldDel)],
      ['Patch lines (task.toml)', number(env.patchLines)], ['Hidden tests', list(env.hiddenTests)],
      ['Mined gold files', list(env.provGoldFiles)], ['Mined test files', list(env.provTestFiles)],
      ['Difficulty label', env.difficulty], ['Domain', env.domain]
    ]);
    appendFacts(elements.pipelineThinkingFacts, [
      ['Verdict', env.verdict], ['Agent steps', number(env.steps)], ['Stopped because', env.stoppedBecause],
      ['Verifier rc', env.verifierRc == null ? null : String(env.verifierRc)],
      ['Suite rc', env.suiteRc == null ? null : String(env.suiteRc)],
      ['Graded by', env.gradedBy], ['codex exit rc', env.codexRc == null ? null : String(env.codexRc)],
      ['Agent wall clock', env.agentDuration == null ? null : duration(env.agentDuration)],
      ['Verifier wall clock', env.verifierDuration == null ? null : duration(env.verifierDuration)],
      ['Commands with output', env.outputCoverage]
    ]);
    appendFacts(elements.pipelineSegmentFacts, [
      ['Empty arm', 'rc ' + env.gateEmptyRc + ' · reward ' + env.gateEmptyReward],
      ['Gold arm', 'rc ' + env.gateOracleRc + ' · reward ' + env.gateOracleReward]
    ]);
    elements.pipelineSegments.textContent = '';
    [['Empty patch (no fix applied)', env.gateEmptyTail], ['Gold patch applied', env.gateOracleTail]]
      .forEach(function (pair) {
        if (!pair[1]) return;
        var item = document.createElement('article');
        var head = document.createElement('header');
        var title = document.createElement('strong'); title.textContent = pair[0];
        head.appendChild(title);
        var pre = document.createElement('pre'); var code = document.createElement('code');
        code.textContent = pair[1]; pre.appendChild(code);
        item.appendChild(head); item.appendChild(pre);
        elements.pipelineSegments.appendChild(item);
      });
    appendFacts(elements.pipelineDatasetFacts, [
      ['Benchmark', env.benchmark], ['Variant', env.version], ['Keywords', list(env.keywords)],
      ['Agent timeout', env.agentTimeout == null ? null : duration(env.agentTimeout)],
      ['Verifier timeout', env.verifierTimeout == null ? null : duration(env.verifierTimeout)],
      ['Resources', [env.cpu, env.memory, env.storage].filter(Boolean).join(' · ')],
      ['Internet', env.internet], ['Verifier command', env.verifier],
      ['Language', env.language], ['Source file', env.sourceFile]
    ]);
  }

  var TB_HEADINGS = ['Task source', 'Calibration', 'Two-arm gate', 'This attempt',
    'Hidden tests', 'Every attempt on this task', 'Hidden suite (raw)', 'Environment'];

  /* Terminal-Bench tasks here come from a calibration run: each task was
     attempted by a strong and a weak model, and the grade says whether the
     pair separates. The panel shows where this attempt sits in that picture. */
  function renderTbCalibration(trajectory) {
    var env = trajectory.environment || {};
    elements.pipelinePanel.hidden = false;
    setPipelineHeadings(TB_HEADINGS, 'Calibration & gate evidence');
    text('pipelineSourceLabel', 'Calibration · ' + (env.benchmark || 'Harbor'));
    text('pipelineSummaryStatus', 'Graded ' + (env.calGrade || '—') +
      (env.calJudgeSuspect ? ' · judge suspect' : ''));
    appendFacts(elements.pipelineCleanFacts, [
      ['Repository', env.repository], ['Carved file', env.patchTarget],
      ['Lines removed', env.carvedLines == null ? null : number(env.carvedLines)],
      ['Language', env.language], ['Task variant', env.version], ['Task', env.taskName]
    ]);
    appendFacts(elements.pipelineClassificationFacts, [
      ['Grade', env.calGrade], ['Strong model', env.calStrong], ['Weak model', env.calWeak],
      ['Judge suspect', env.calJudgeSuspect == null ? null : yesNo(env.calJudgeSuspect)]
    ]);
    appendReasons(elements.pipelineReasonList, [['Why this grade', env.calWhy]]);
    appendFacts(elements.pipelineRoutingFacts, [
      ['Empty-patch rc', env.gateEmptyRc == null ? null : String(env.gateEmptyRc)],
      ['Empty-patch reward', env.gateEmptyReward == null ? null : String(env.gateEmptyReward)],
      ['Oracle rc', env.gateOracleRc == null ? null : String(env.gateOracleRc)],
      ['Oracle reward', env.gateOracleReward == null ? null : String(env.gateOracleReward)]
    ]);
    appendFacts(elements.pipelineQualityFacts, [
      ['Model', trajectory.model], ['Trial', env.calTrial], ['Verdict', env.verdict],
      ['Said DONE', env.calSaidDone == null ? null : yesNo(env.calSaidDone)],
      ['Agent rc', env.calAgentRc == null ? null : String(env.calAgentRc)],
      ['Verifier rc', env.verifierRc == null ? null : String(env.verifierRc)],
      ['Hidden suite', env.tests], ['Exception', env.exception],
      ['Wall clock', env.duration == null ? null : duration(env.duration)],
      ['Ran as', env.agentUser]
    ]);
    appendFacts(elements.pipelineDifficultyFacts, [
      ['Hidden test files', list(env.hiddenTests)], ['Graded by', env.gradedBy]
    ]);
    appendFacts(elements.pipelineThinkingFacts, (env.calAttempts || []).map(function (entry) {
      var cut = entry.indexOf(' ');
      return [entry.slice(0, cut), entry.slice(cut + 1)];
    }));
    appendFacts(elements.pipelineSegmentFacts, [
      ['Session matched by', env.calMatchScore == null ? null : String(env.calMatchScore)]
    ]);
    elements.pipelineSegments.textContent = '';
    var log = (trajectory.events || []).filter(function (event) {
      return event.kind === 'evaluation' && /^Verifier/.test(event.title || '');
    })[0];
    if (log) {
      var item = document.createElement('article');
      var head = document.createElement('header');
      var strong = document.createElement('strong'); strong.textContent = 'Hidden suite output';
      head.appendChild(strong);
      var pre = document.createElement('pre'); var code = document.createElement('code');
      code.textContent = log.content.slice(-4000); pre.appendChild(code);
      item.appendChild(head); item.appendChild(pre);
      elements.pipelineSegments.appendChild(item);
    }
    appendFacts(elements.pipelineDatasetFacts, [
      ['Image', env.image], ['Resources', [env.cpu, env.memory, env.storage].filter(Boolean).join(' · ')],
      ['Internet', env.internet], ['Workspace', env.workdir], ['Data source', trajectory.dataSource],
      ['Source record', env.sourceFile]
    ]);
  }

  function renderPipelineDetails(trajectory) {
    if (trajectory.trajectoryClass === 'swe' && (trajectory.environment || {}).provShape) {
      renderSweProvenance(trajectory); return;
    }
    if (trajectory.trajectoryClass === 'terminal' && (trajectory.environment || {}).calGrade) {
      renderTbCalibration(trajectory); return;
    }
    var source = window.EMPIRIA_FEEDBACK_PIPELINE || {};
    var detail = trajectory.pipelineDetail || source.trajectories && source.trajectories[trajectory.id];
    if (trajectory.trajectoryClass !== 'feedback' || !detail) {
      elements.pipelinePanel.hidden = true;
      elements.pipelinePanel.open = false;
      return;
    }

    var clean = detail.clean || {};
    var classification = detail.classification || {};
    var routing = detail.routing || {};
    var quality = detail.quality || {};
    var difficulty = detail.difficulty || {};
    var segmentSummary = detail.segmentSummary || {};
    var thinking = detail.thinkingClean || {};
    var dataset = detail.dataset || source.dataset || {};

    elements.pipelinePanel.hidden = false;
    setPipelineHeadings(FEEDBACK_HEADINGS, 'Pipeline details');
    text('pipelineSourceLabel', 'Feedback metadata');
    text('pipelineSummaryStatus', (clean.passed ? 'Clean pass' : 'Rejected') + ' · ' + titleCase(classification.situation));

    appendFacts(elements.pipelineCleanFacts, [
      ['Passed', yesNo(clean.passed), clean.passed ? 'success-text' : 'error-text'],
      ['Trimmed trailing', yesNo(clean.trimmedTrailing)],
      ['Non-system messages', number(clean.nonSystemMessages)],
      ['Complete tool pairs', number(clean.completeToolPairs)],
      ['Estimated tokens', number(clean.estimatedTokens)],
      ['Raw error rate', percent(clean.errorRate)],
      ['Dangerous hits', number(clean.dangerousHits)],
      ['Reject reason', clean.rejectReason || 'None']
    ]);

    appendFacts(elements.pipelineClassificationFacts, [
      ['Safe', yesNo(classification.isSafe), classification.isSafe ? 'success-text' : 'error-text'],
      ['Task type', classification.taskType],
      ['Outcome', titleCase(classification.situation), classification.situation === 'successful' ? 'success-text' : 'error-text']
    ]);
    appendReasons(elements.pipelineReasonList, [
      ['Safety reasoning', classification.isSafeReasoning],
      ['Task-type reasoning', classification.taskTypeReasoning],
      ['Outcome reasoning', classification.situationReasoning]
    ]);

    appendFacts(elements.pipelineRoutingFacts, [
      ['Category', routing.category], ['Effective category', routing.effectiveCategory],
      ['Task-type source', routing.taskTypeSource], ['Value tier', routing.valueTier],
      ['Search main type', routing.searchMainType || 'Not applicable'], ['Rescued via', routing.rescuedVia || 'None'],
      ['Routing votes', routing.votes], ['Main traces kept', number(routing.mainKept)],
      ['Tie broken', yesNo(routing.tieBroken)], ['Any rescued', yesNo(routing.anyRescued)]
    ]);

    appendFacts(elements.pipelineQualityFacts, [
      ['Flag', titleCase(quality.flag), quality.flag === 'keep' ? 'success-text' : 'error-text'],
      ['Tool steps', number(quality.toolSteps)], ['Error ratio', percent(quality.errorRatio)],
      ['Max error chain', number(quality.maxErrorChain)], ['Max no-progress', number(quality.maxNoProgress)],
      ['Repeat ratio', percent(quality.repeatRatio)], ['Top repeat', number(quality.topRepeat)],
      ['Reasons', reasons(quality.reasons)]
    ]);

    appendFacts(elements.pipelineDifficultyFacts, [
      ['Flag', titleCase(difficulty.flag), difficulty.flag === 'keep' ? 'success-text' : 'error-text'],
      ['User turns', number(difficulty.userTurns)], ['Distinct tasks', number(difficulty.distinctTaskCount)],
      ['Tool calls total', number(difficulty.toolCallsTotal)], ['Longest loop ratio', percent(difficulty.longestLoopRatio)],
      ['Reasons', reasons(difficulty.reasons)]
    ]);

    appendFacts(elements.pipelineSegmentFacts, [
      ['Outcome confirmed', titleCase(segmentSummary.outcomeConfirmed), segmentSummary.outcomeConfirmed === 'success' ? 'success-text' : ''],
      ['Segments', number(segmentSummary.segmentCount)], ['High-quality ratio', percent(segmentSummary.highQualityRatio)],
      ['Low-quality ratio', percent(segmentSummary.lowQualityRatio)], ['High-quality nodes', number(segmentSummary.highNodes)],
      ['Low-quality nodes', number(segmentSummary.lowNodes)], ['Total nodes', number(segmentSummary.totalNodes)]
    ]);
    elements.pipelineSegments.textContent = '';
    (detail.segments || []).forEach(function (segment, index) {
      var item = document.createElement('article');
      var header = document.createElement('div');
      var title = document.createElement('strong');
      var nodes = document.createElement('span');
      var copy = document.createElement('p');
      var jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = 'Show in timeline';
      title.textContent = String(index + 1).padStart(2, '0') + ' · ' + titleCase(segment.pattern);
      nodes.textContent = 'Nodes ' + (segment.nodes || []).join('–');
      copy.textContent = segment.reason;
      jump.addEventListener('click', function () {
        highQualityOnly = true;
        elements.highQualityOnly.setAttribute('aria-pressed', 'true');
        renderTimeline();
        var first = elements.timeline.querySelector('[data-quality-node="' + segment.nodes[0] + '"]');
        if (first) {
          first.querySelector('details').open = true;
          first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      header.appendChild(title); header.appendChild(nodes);
      item.appendChild(header); item.appendChild(copy); item.appendChild(jump);
      elements.pipelineSegments.appendChild(item);
    });

    appendFacts(elements.pipelineThinkingFacts, [
      ['Status', thinking.status], ['Category', thinking.category], ['With thinking', number(thinking.withThinking)],
      ['Dropped', optionalNumber(thinking.dropped)], ['Near duplicates', optionalNumber(thinking.nearDuplicates)]
    ]);

    appendFacts(elements.pipelineDatasetFacts, [
      ['Source file', dataset.sourceFile], ['Trajectories', number(dataset.trajectoryCount)],
      ['Unique conversations', number(dataset.uniqueConversations)],
      ['Tool calls', number(dataset.toolCallCount)], ['Estimated tokens', number(dataset.estimatedTokens)],
      ['Tool-call range', number(dataset.minToolCalls) + '–' + number(dataset.maxToolCalls)],
      ['Estimated-token range', number(dataset.minEstimatedTokens) + '–' + number(dataset.maxEstimatedTokens)],
      ['Task types', dataset.taskTypeDistribution], ['Outcomes', dataset.outcomeDistribution],
      ['Value tiers', dataset.valueTierDistribution]
    ]);
  }

  function renderTokens(trajectory) {
    var tokens = trajectory.tokenUsage || { cachedInput: 0, uncachedInput: 0, output: 0, total: 0 };
    if (trajectory.tokenUsageEstimated) {
      text('tokenPanelKicker', 'Estimated usage');
      text('tokenTotal', number(tokens.total)); text('tokenCached', 'Not reported');
      text('tokenUncached', 'Not reported'); text('tokenOutput', 'Not reported');
      text('tokenCachedPct', '—'); text('tokenUncachedPct', '—'); text('tokenOutputPct', '—');
      document.getElementById('tokenCachedBar').style.width = '0';
      document.getElementById('tokenUncachedBar').style.width = '0';
      document.getElementById('tokenOutputBar').style.width = '0';
      text('tokenUsageNote', 'Estimated from cleaned trajectory text; no API usage record was available.');
      return;
    }
    text('tokenPanelKicker', 'Usage');
    var total = tokens.total || 1;
    text('tokenTotal', number(tokens.total)); text('tokenCached', number(tokens.cachedInput));
    text('tokenUncached', number(tokens.uncachedInput)); text('tokenOutput', number(tokens.output));
    text('tokenCachedPct', (tokens.cachedInput / total * 100).toFixed(1) + '%');
    text('tokenUncachedPct', (tokens.uncachedInput / total * 100).toFixed(1) + '%');
    text('tokenOutputPct', (tokens.output / total * 100).toFixed(1) + '%');
    document.getElementById('tokenCachedBar').style.width = tokens.cachedInput / total * 100 + '%';
    document.getElementById('tokenUncachedBar').style.width = tokens.uncachedInput / total * 100 + '%';
    document.getElementById('tokenOutputBar').style.width = tokens.output / total * 100 + '%';
    var note = [];
    if (tokens.source) note.push('Real API usage matched by request_id');
    if (tokens.promptTokens != null) note.push('Prompt ' + number(tokens.promptTokens));
    if (tokens.cacheWrite != null) note.push('Cache write ' + number(tokens.cacheWrite));
    if (tokens.rawInput != null) note.push('Raw uncached ' + number(tokens.rawInput));
    if (tokens.serviceTier) note.push('Tier ' + tokens.serviceTier);
    text('tokenUsageNote', note.join(' · '));
  }

  function truncate(value, length) {
    var valueText = (value || '').replace(/\s+/g, ' ').trim();
    if (!valueText) return 'No textual output';
    return valueText.length > length ? valueText.slice(0, length).trimEnd() + '…' : valueText;
  }

  function classify(event) {
    return event.type === 'tool_result' ? event.type + ' status-' + (event.status || 'success') : event.type;
  }

  function createEvent(event, index, qualityMap) {
    var quality = qualityMap[event.sourceIndex];
    var item = document.createElement('article');
    item.className = 'raw-event ' + classify(event);
    item.id = 'trajectory-event-' + index;
    item.dataset.sourceIndex = event.sourceIndex;
    if (quality) {
      item.classList.add('high-quality-event');
      item.dataset.qualityNode = quality.node;
      item.title = 'High-quality node ' + quality.node + ' · ' + titleCase(quality.pattern);
    }
    var details = document.createElement('details');
    details.className = 'raw-event-details';
    if (event.type === 'assistant' && index > selectedTrajectory().events.length - 4) details.open = true;
    if (event.type === 'tool_result' && ['error', 'timeout', 'rejected'].indexOf(event.status) >= 0) details.open = true;

    var summary = document.createElement('summary');
    summary.className = 'raw-event-summary';
    var sequence = document.createElement('span'); sequence.className = 'raw-event-number'; sequence.textContent = String(index + 1).padStart(3, '0');
    var marker = document.createElement('span'); marker.className = 'raw-event-marker';
    var heading = document.createElement('span'); heading.className = 'raw-event-heading';
    var type = document.createElement('span'); type.className = 'raw-event-type'; type.textContent = typeLabels[event.type] || event.type;
    if (quality) {
      var qualityBadge = document.createElement('span');
      qualityBadge.className = 'raw-event-quality';
      qualityBadge.textContent = 'High quality · Node ' + quality.node;
      heading.appendChild(qualityBadge);
    }
    var strong = document.createElement('strong'); strong.textContent = event.title || type.textContent;
    var preview = document.createElement('span'); preview.className = 'raw-event-preview'; preview.textContent = truncate(event.summary || event.content, 180);
    heading.insertBefore(type, heading.firstChild); heading.appendChild(strong); heading.appendChild(preview);
    var meta = document.createElement('span'); meta.className = 'raw-event-meta'; meta.textContent = event.type === 'tool_result' ? event.status : (event.timestamp ? event.timestamp.slice(11, 19) : 'msg ' + event.sourceIndex);
    summary.appendChild(sequence); summary.appendChild(marker); summary.appendChild(heading); summary.appendChild(meta);

    var body = document.createElement('div'); body.className = 'raw-event-body';
    if (event.stepMetrics) {
      var usage = document.createElement('div'); usage.className = 'step-token-strip';
      usage.innerHTML = '<span>Prompt <b>' + number(event.stepMetrics.prompt) + '</b></span><span>Cached <b>' + number(event.stepMetrics.cached) + '</b></span><span>Output <b>' + number(event.stepMetrics.output) + '</b></span><span>Reasoning <b>' + number(event.stepMetrics.reasoning) + '</b></span>';
      body.appendChild(usage);
    }
    if (event.summary && event.summary.trim() && event.summary.trim() !== (event.content || '').trim()) {
      var label = document.createElement('p'); label.className = 'raw-event-body-label'; label.textContent = 'Summary';
      var summaryText = document.createElement('p'); summaryText.className = 'raw-event-body-summary'; summaryText.textContent = event.summary;
      body.appendChild(label); body.appendChild(summaryText);
    }
    var contentLabel = document.createElement('p'); contentLabel.className = 'raw-event-body-label'; contentLabel.textContent = event.type === 'thinking' ? 'Reasoning' : 'Raw content';
    var pre = document.createElement('pre'); var code = document.createElement('code'); code.textContent = event.content || 'No textual output'; pre.appendChild(code);
    body.appendChild(contentLabel); body.appendChild(pre);
    if (event.toolCallId) { var id = document.createElement('p'); id.className = 'raw-event-call-id'; id.textContent = 'Call ID · ' + event.toolCallId; body.appendChild(id); }
    details.appendChild(summary); details.appendChild(body); item.appendChild(details); return item;
  }

  function updateFilterCounts(trajectory) {
    Array.prototype.forEach.call(elements.filters.querySelectorAll('[data-filter]'), function (button) {
      var count = trajectory.counts[button.dataset.filter] || 0;
      button.querySelector('b').textContent = number(count);
    });
    var source = window.EMPIRIA_FEEDBACK_PIPELINE || {};
    var detail = trajectory.pipelineDetail || source.trajectories && source.trajectories[trajectory.id];
    var nodeSet = new Set();
    if (detail) (detail.segments || []).forEach(function (segment) {
      if (segment.label === 'high_quality') (segment.nodes || []).forEach(function (node) { nodeSet.add(node); });
    });
    elements.highQualityOnly.hidden = trajectory.trajectoryClass !== 'feedback' || nodeSet.size === 0;
    elements.highQualityOnly.setAttribute('aria-pressed', String(highQualityOnly));
    text('highQualityCount', nodeSet.size);
  }

  function renderTimeline() {
    var trajectory = selectedTrajectory();
    if (timelineMode === 'dialogue') {
      syncDialogue(trajectory);
      elements.empty.hidden = true;
      text('timelineStatus', 'Two-lane view');
      return;
    }
    if (!Array.isArray(trajectory.events)) return;
    var qualityMap = highQualityNodeMap(trajectory);
    var query = elements.search.value.trim().toLowerCase();
    var fragment = document.createDocumentFragment(); var visible = 0;
    trajectory.events.forEach(function (event, index) {
      if (!activeFilters.has(event.type)) return;
      if (highQualityOnly && !qualityMap[event.sourceIndex]) return;
      var haystack = [event.type, event.title, event.summary, event.content, event.toolCallId].filter(Boolean).join('\n').toLowerCase();
      if (query && haystack.indexOf(query) === -1) return;
      fragment.appendChild(createEvent(event, index, qualityMap)); visible += 1;
    });
    elements.timeline.textContent = ''; elements.timeline.appendChild(fragment); elements.empty.hidden = visible !== 0;
    text('visibleCount', number(visible)); text('eventCount', 'of ' + number(trajectory.events.length) + ' events'); text('timelineStatus', visible === trajectory.events.length ? 'All events' : visible + ' visible');
  }

  function renderAll() {
    var categoryRuns = categoryItems(activeCategory);
    renderCategoryNav();
    renderSidebar();
    if (!categoryRuns.length) {
      elements.runView.hidden = true;
      elements.categoryEmpty.hidden = false;
      text('categoryEmptyTitle', activeCategory === 'terminal' ? 'Terminal-Bench trajectories are coming next' : 'No trajectories in this source');
      text('categoryEmptyCopy', activeCategory === 'terminal' ? 'The analytics surface is ready for Terminal-Bench task environments, verification results, and full terminal timelines.' : 'Add a trajectory to begin analysis.');
      return;
    }
    elements.runView.hidden = false;
    elements.categoryEmpty.hidden = true;
    var trajectory = selectedTrajectory();
    /* a run whose body is not loaded yet (every Terminal-Bench run, the feedback
       snapshots) goes through the loader, which draws the chrome and fetches */
    if (!Array.isArray(trajectory.events) && trajectory.lazyData) { setSelectedById(trajectory.id); return; }
    renderHeader(trajectory); renderMetrics(trajectory); renderPipelineDetails(trajectory); renderEnvironment(trajectory);
    renderTaskAndVerification(trajectory); renderTokens(trajectory); updateFilterCounts(trajectory); elements.search.value = ''; renderTimeline();
  }

  elements.topCategoryNav.addEventListener('click', function (event) {
    var button = event.target.closest('[data-category]'); if (!button) return;
    activeCategory = button.dataset.category; highQualityOnly = false; var first = applySnapshotDedup(categoryItems(activeCategory))[0]; if (first) selectedIndex = trajectories.indexOf(first); renderAll();
  });
  elements.runSearch.addEventListener('input', renderSidebar);
  Array.prototype.forEach.call(document.querySelectorAll('[data-run-filter]'), function (input) { input.addEventListener('change', renderSidebar); });
  elements.deduplicateSessions.addEventListener('change', function () {
    deduplicateSessions = elements.deduplicateSessions.checked;
    if (deduplicateSessions && selectedTrajectory().snapshotLabel) {
      var visible = applySnapshotDedup(categoryItems('feedback'));
      if (visible.indexOf(selectedTrajectory()) === -1) {
        var replacement = visible.find(function (trajectory) {
          return trajectory.conversationId === selectedTrajectory().conversationId;
        });
        if (replacement) selectedIndex = trajectories.indexOf(replacement);
      }
    }
    renderAll();
  });
  elements.search.addEventListener('input', renderTimeline);
  elements.filters.addEventListener('click', function (event) {
    var button = event.target.closest('[data-filter]'); if (!button) return;
    var filter = button.dataset.filter; if (activeFilters.has(filter)) activeFilters.delete(filter); else activeFilters.add(filter);
    button.setAttribute('aria-pressed', String(activeFilters.has(filter))); renderTimeline();
  });
  elements.highQualityOnly.addEventListener('click', function () {
    highQualityOnly = !highQualityOnly;
    elements.highQualityOnly.setAttribute('aria-pressed', String(highQualityOnly));
    renderTimeline();
  });
  elements.linearViewButton.addEventListener('click', function () { setTimelineMode('linear'); });
  elements.dialogueViewButton.addEventListener('click', function () { setTimelineMode('dialogue'); });
  elements.timelineFullscreen.addEventListener('click', function () { setTimelineFullscreen(!timelineFullscreen); });
  elements.expand.addEventListener('click', function () { Array.prototype.forEach.call(elements.timeline.querySelectorAll('details'), function (node) { node.open = true; }); });
  elements.collapse.addEventListener('click', function () { Array.prototype.forEach.call(elements.timeline.querySelectorAll('details'), function (node) { node.open = false; }); });
  elements.sidebarOpen.addEventListener('click', function () { setSidebarVisible(true); });
  elements.sidebarClose.addEventListener('click', function () { setSidebarVisible(false); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && timelineFullscreen) setTimelineFullscreen(false);
  });
  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'empiria-exit-timeline-fullscreen' && timelineFullscreen) {
      setTimelineFullscreen(false);
    }
  });
  window.addEventListener('resize', function () { setSidebarVisible(sidebarVisible); }, { passive: true });

  if (trajectories[selectedIndex] && trajectories[selectedIndex].trajectoryClass !== activeCategory) {
    var firstOfCategory = applySnapshotDedup(categoryItems(activeCategory))[0];
    if (firstOfCategory) selectedIndex = trajectories.indexOf(firstOfCategory);
  }

  renderAll();
})();
