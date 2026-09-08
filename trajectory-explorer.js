(function () {
  'use strict';

  var trajectories = window.EMPIRIA_RAW_TRAJECTORIES || [];
  if (!trajectories.length) return;

  var selectedIndex = 0;
  var activeCategory = 'feedback';
  var highQualityOnly = false;
  var activeFilters = new Set(['user', 'thinking', 'assistant', 'tool_call', 'tool_result']);
  var elements = {
    topCategoryNav: document.getElementById('topCategoryNav'),
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
    timeline: document.getElementById('rawTimeline'),
    empty: document.getElementById('rawEmpty'),
    expand: document.getElementById('expandVisible'),
    collapse: document.getElementById('collapseAll'),
    highQualityOnly: document.getElementById('highQualityOnly'),
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

  function highQualityNodeMap(trajectory) {
    var source = window.EMPIRIA_FEEDBACK_PIPELINE || {};
    var detail = source.trajectories && source.trajectories[trajectory.id];
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

  function trajectoryStatus(trajectory) {
    var environment = trajectory.environment || {};
    var successful = trajectory.situation === 'successful' || environment.resolved === 'true' || environment.reward === '1.0';
    return { successful: successful, label: successful ? 'Successful' : 'Error' };
  }

  function categoryItems(category) {
    return trajectories.filter(function (trajectory) { return trajectory.trajectoryClass === category; });
  }

  function categoryCount(category) {
    return categoryItems(category).length;
  }

  function selectedTrajectory() {
    return trajectories[selectedIndex];
  }

  function setSelectedById(id) {
    var index = trajectories.findIndex(function (trajectory) { return trajectory.id === id; });
    if (index < 0) return;
    selectedIndex = index;
    activeCategory = trajectories[index].trajectoryClass;
    highQualityOnly = false;
    renderAll();
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

    ['feedback', 'swe', 'terminal'].forEach(function (category) {
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
        var first = categoryItems(category)[0];
        if (first) selectedIndex = trajectories.indexOf(first);
        renderAll();
      });
      section.appendChild(heading);

      var list = document.createElement('div');
      list.className = 'sidebar-run-list';
      var items = categoryItems(category).filter(function (trajectory) {
        var status = trajectoryStatus(trajectory);
        if (status.successful && !allowSuccess) return false;
        if (!status.successful && !allowFailed) return false;
        var haystack = [trajectory.title, trajectory.id, trajectory.shortId, trajectory.environment && trajectory.environment.repository, trajectory.environment && trajectory.environment.task].join(' ').toLowerCase();
        return !query || haystack.indexOf(query) !== -1;
      });

      if (!items.length) {
        var none = document.createElement('p');
        none.className = 'sidebar-empty';
        none.textContent = category === 'terminal' ? 'Awaiting Terminal-Bench trajectories' : 'No matching runs';
        list.appendChild(none);
      }

      items.forEach(function (trajectory) {
        visibleRuns += 1;
        var status = trajectoryStatus(trajectory);
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'sidebar-run';
        button.setAttribute('aria-pressed', String(trajectory === selectedTrajectory()));
        button.innerHTML = '<span class="sidebar-run-status ' + (status.successful ? 'success' : 'error') + '"></span>' +
          '<span class="sidebar-run-copy"><strong>' + trajectory.title + '</strong><small>' + trajectory.shortId + ' · ' + (trajectory.model || 'unknown model') + '</small></span>';
        button.addEventListener('click', function () { setSelectedById(trajectory.id); });
        list.appendChild(button);
      });
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
    text('runBreadcrumb', titleCase(trajectory.trajectoryClass) + ' / ' + trajectory.shortId);
    text('trajectoryName', trajectory.title);
    text('runSubtitle', env.issue || env.taskName || trajectory.taskType || 'Agent trajectory');
    var badge = document.getElementById('trajectoryResult');
    badge.textContent = status.label;
    badge.className = 'run-status ' + (status.successful ? 'success' : 'error');
    var meta = [trajectory.model, trajectory.agent || env.agent, trajectory.dataSource, trajectory.id].filter(Boolean);
    document.getElementById('runMetaLine').textContent = meta.join(' · ');
  }

  function renderMetrics(trajectory) {
    var env = trajectory.environment || {};
    var tokens = trajectory.tokenUsage || {};
    var counts = trajectory.counts || {};
    var agentSteps = trajectory.agentStepCount;
    if (agentSteps == null && trajectory.trajectoryClass === 'swe') {
      agentSteps = Math.max(0, (trajectory.messageCount || 0) - (counts.system || 0) - (counts.user || 0));
    }
    text('metricPrimaryLabel', trajectory.trajectoryClass === 'swe' ? 'Reward' : 'Value tier');
    text('metricOutcomeLabel', trajectory.trajectoryClass === 'swe' ? 'Verification' : 'Outcome');
    text('metricReward', trajectory.trajectoryClass === 'swe' ? env.reward : trajectory.valueTier);
    text('metricDuration', env.duration != null ? duration(env.duration) : '—');
    text('metricSteps', trajectory.trajectoryClass === 'swe' ? agentSteps : counts.thinking);
    text('metricTools', number(trajectory.toolCallCount));
    text('metricTokens', number(tokens.total));
    text('metricVerification', trajectory.trajectoryClass === 'swe' ? env.tests : titleCase(trajectory.situation));
  }

  function renderEnvironment(trajectory) {
    var env = trajectory.environment || {};
    text('environmentFamily', env.family || titleCase(trajectory.trajectoryClass));
    var facts;
    if (trajectory.trajectoryClass === 'swe') {
      facts = [
        ['Benchmark', env.benchmark], ['Task', env.task], ['Repository', env.repository], ['Base commit', env.baseCommit],
        ['Version', env.version], ['Difficulty', env.difficulty], ['Runtime', env.runtime], ['OS / architecture', [env.os, env.architecture].filter(Boolean).join(' · ')], ['Image', env.image],
        ['Workspace', env.workdir], ['Resources', [env.cpu, env.memory, env.storage].filter(Boolean).join(' · ')],
        ['Internet', env.internet], ['Agent', env.agent], ['Model', env.model], ['Verifier', env.verifier]
      ];
    } else {
      facts = [
        ['Family', env.family], ['Source file', env.sourceFile], ['Runtime', env.runtime], ['Model', env.model],
        ['Verifier', env.verifier], ['Report', env.report], ['Data source', trajectory.dataSource], ['Conversation ID', trajectory.id]
      ];
    }
    appendFacts(elements.environmentGrid, facts);

    if (trajectory.trajectoryClass === 'swe') {
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
    appendFacts(elements.taskFacts, trajectory.trajectoryClass === 'swe' ? [
      ['Task type', trajectory.taskType], ['Category', env.taskCategory || trajectory.category], ['Model', trajectory.model || env.model],
      ['Service tier', env.serviceTier || trajectory.serviceTier || 'Not reported'], ['Created', '2019-03-24'],
      ['Base commit', env.baseCommit], ['Patch target', 'django/template/engine.py'], ['Regression test', 'test_autoescape_off']
    ] : [
      ['Category', trajectory.category], ['Task type', trajectory.taskType], ['Value tier', trajectory.valueTier],
      ['Model', trajectory.model], ['Data source', trajectory.dataSource], ['Messages', number(trajectory.messageCount)]
    ]);

    appendFacts(elements.verificationList, trajectory.trajectoryClass === 'swe' ? [
      ['Reward', env.reward, 'success-text'], ['Resolved', env.resolved, 'success-text'], ['Patch exists', 'true', 'success-text'],
      ['Patch applied', env.patchApplied, 'success-text'], ['FAIL_TO_PASS', env.failToPass, 'success-text'],
      ['PASS_TO_PASS', env.passToPass, 'success-text'], ['Tests', env.tests, 'success-text'], ['Exception', 'None', 'success-text']
    ] : [
      ['Outcome', titleCase(trajectory.situation), trajectoryStatus(trajectory).successful ? 'success-text' : 'error-text'],
      ['Value tier', trajectory.valueTier], ['Error rate', trajectory.errorRate == null ? '—' : (trajectory.errorRate * 100).toFixed(1) + '%'],
      ['Tool calls', number(trajectory.toolCallCount)], ['Events', number(trajectory.events.length)], ['Report', env.report]
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

  function renderPipelineDetails(trajectory) {
    var source = window.EMPIRIA_FEEDBACK_PIPELINE || {};
    var detail = source.trajectories && source.trajectories[trajectory.id];
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
    var dataset = source.dataset || {};

    elements.pipelinePanel.hidden = false;
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
      ['Category', thinking.category], ['With thinking', number(thinking.withThinking)],
      ['Dropped', number(thinking.dropped)], ['Near duplicates', number(thinking.nearDuplicates)]
    ]);

    appendFacts(elements.pipelineDatasetFacts, [
      ['Source file', dataset.sourceFile], ['Trajectories', number(dataset.trajectoryCount)],
      ['Tool calls', number(dataset.toolCallCount)], ['Estimated tokens', number(dataset.estimatedTokens)],
      ['Tool-call range', number(dataset.minToolCalls) + '–' + number(dataset.maxToolCalls)],
      ['Estimated-token range', number(dataset.minEstimatedTokens) + '–' + number(dataset.maxEstimatedTokens)],
      ['Task types', dataset.taskTypeDistribution], ['Outcomes', dataset.outcomeDistribution],
      ['Value tiers', dataset.valueTierDistribution]
    ]);
  }

  function renderTokens(trajectory) {
    var tokens = trajectory.tokenUsage || { cachedInput: 0, uncachedInput: 0, output: 0, total: 0 };
    var total = tokens.total || 1;
    text('tokenTotal', number(tokens.total)); text('tokenCached', number(tokens.cachedInput));
    text('tokenUncached', number(tokens.uncachedInput)); text('tokenOutput', number(tokens.output));
    text('tokenCachedPct', (tokens.cachedInput / total * 100).toFixed(1) + '%');
    text('tokenUncachedPct', (tokens.uncachedInput / total * 100).toFixed(1) + '%');
    text('tokenOutputPct', (tokens.output / total * 100).toFixed(1) + '%');
    document.getElementById('tokenCachedBar').style.width = tokens.cachedInput / total * 100 + '%';
    document.getElementById('tokenUncachedBar').style.width = tokens.uncachedInput / total * 100 + '%';
    document.getElementById('tokenOutputBar').style.width = tokens.output / total * 100 + '%';
  }

  function truncate(value, length) {
    var valueText = (value || '').replace(/\s+/g, ' ').trim();
    if (!valueText) return 'No textual output';
    return valueText.length > length ? valueText.slice(0, length).trimEnd() + '…' : valueText;
  }

  function classify(event) {
    return event.type === 'tool_result' ? event.type + ' status-' + (event.status || 'success') : event.type;
  }

  function createEvent(event, index) {
    var quality = highQualityNodeMap(selectedTrajectory())[event.sourceIndex];
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
    var detail = source.trajectories && source.trajectories[trajectory.id];
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
    var qualityMap = highQualityNodeMap(trajectory);
    var query = elements.search.value.trim().toLowerCase();
    var fragment = document.createDocumentFragment(); var visible = 0;
    trajectory.events.forEach(function (event, index) {
      if (!activeFilters.has(event.type)) return;
      if (highQualityOnly && !qualityMap[event.sourceIndex]) return;
      var haystack = [event.type, event.title, event.summary, event.content, event.toolCallId].filter(Boolean).join('\n').toLowerCase();
      if (query && haystack.indexOf(query) === -1) return;
      fragment.appendChild(createEvent(event, index)); visible += 1;
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
    renderHeader(trajectory); renderMetrics(trajectory); renderPipelineDetails(trajectory); renderEnvironment(trajectory);
    renderTaskAndVerification(trajectory); renderTokens(trajectory); updateFilterCounts(trajectory); elements.search.value = ''; renderTimeline();
  }

  elements.topCategoryNav.addEventListener('click', function (event) {
    var button = event.target.closest('[data-category]'); if (!button) return;
    activeCategory = button.dataset.category; highQualityOnly = false; var first = categoryItems(activeCategory)[0]; if (first) selectedIndex = trajectories.indexOf(first); renderAll();
  });
  elements.runSearch.addEventListener('input', renderSidebar);
  Array.prototype.forEach.call(document.querySelectorAll('[data-run-filter]'), function (input) { input.addEventListener('change', renderSidebar); });
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
  elements.expand.addEventListener('click', function () { Array.prototype.forEach.call(elements.timeline.querySelectorAll('details'), function (node) { node.open = true; }); });
  elements.collapse.addEventListener('click', function () { Array.prototype.forEach.call(elements.timeline.querySelectorAll('details'), function (node) { node.open = false; }); });
  elements.sidebarOpen.addEventListener('click', function () { elements.sidebar.classList.add('open'); });
  elements.sidebarClose.addEventListener('click', function () { elements.sidebar.classList.remove('open'); });

  renderAll();
})();
