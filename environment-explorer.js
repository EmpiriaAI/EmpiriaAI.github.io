(function () {
  'use strict';

  var environments = Array.isArray(window.EMPIRIA_ENVIRONMENTS) ? window.EMPIRIA_ENVIRONMENTS : [];
  var activeEnvironment = null;
  var activeFile = null;
  var activeType = 'terminal';
  var fileCache = Object.create(null);

  var environmentTypes = {
    swe: {
      code: 'SWE',
      label: 'SWE',
      title: 'Software Engineering',
      description: 'Repository-level environments for coding, testing, debugging, and verified software changes.',
      traits: ['Repository state', 'Code execution', 'Test feedback', 'Patch verification']
    },
    terminal: {
      code: 'TER',
      label: 'Terminal',
      title: 'Terminal Environments',
      description: 'Command-line workspaces where agents operate tools, files, processes, and scientific runtimes.',
      traits: ['Shell actions', 'Workspace files', 'Runtime state', 'Programmatic grading']
    },
    cua: {
      code: 'CUA',
      label: 'CUA',
      title: 'Computer Use',
      description: 'Visual interface environments where agents perceive screens, operate applications, and complete end-to-end workflows.',
      traits: ['Visual observation', 'Mouse & keyboard', 'Application state', 'Outcome validation']
    }
  };

  function byId(id) { return document.getElementById(id); }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function inlineMarkdown(value) {
    var code = [];
    var text = String(value || '').replace(/`([^`]+)`/g, function (_, token) {
      code.push('<code>' + escapeHTML(token) + '</code>');
      return '%%CODE' + (code.length - 1) + '%%';
    });
    text = escapeHTML(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    code.forEach(function (token, index) {
      text = text.replace('%%CODE' + index + '%%', token);
    });
    return text;
  }

  function markdownToHTML(markdown) {
    var source = String(markdown || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '');
    var lines = source.split('\n');
    var html = [];
    var index = 0;

    function isBlockStart(line) {
      return /^\s*$/.test(line) || /^#{1,3}\s+/.test(line) || /^```/.test(line) || /^---+$/.test(line) || /^>\s?/.test(line) || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
    }

    while (index < lines.length) {
      var line = lines[index];
      if (/^\s*$/.test(line)) { index += 1; continue; }

      var fence = line.match(/^```\s*([^\s]*)/);
      if (fence) {
        var language = fence[1] || 'text';
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        html.push('<pre data-language="' + escapeHTML(language) + '"><code>' + escapeHTML(codeLines.join('\n')) + '</code></pre>');
        continue;
      }

      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        var level = heading[1].length;
        html.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        index += 1;
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        html.push('<hr>');
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quotes = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quotes.push(lines[index].replace(/^>\s?/, ''));
          index += 1;
        }
        html.push('<blockquote><p>' + inlineMarkdown(quotes.join(' ')) + '</p></blockquote>');
        continue;
      }

      var unordered = /^\s*[-*]\s+/.test(line);
      var ordered = /^\s*\d+\.\s+/.test(line);
      if (unordered || ordered) {
        var tag = ordered ? 'ol' : 'ul';
        var expression = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
        var items = [];
        while (index < lines.length) {
          var item = lines[index].match(expression);
          if (!item) break;
          var itemLines = [item[1].trim()];
          index += 1;
          while (index < lines.length && !/^\s*$/.test(lines[index]) && !expression.test(lines[index]) && !isBlockStart(lines[index])) {
            itemLines.push(lines[index].trim());
            index += 1;
          }
          items.push('<li>' + inlineMarkdown(itemLines.join(' ')) + '</li>');
        }
        html.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      var paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlockStart(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      html.push('<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>');
    }

    return html.join('');
  }

  function fileURL(environment, path) {
    return environment.dataRoot + path.split('/').map(encodeURIComponent).join('/');
  }

  function loadFile(environment, path) {
    var key = environment.id + ':' + path;
    if (fileCache[key]) return Promise.resolve(fileCache[key]);
    return fetch(fileURL(environment, path)).then(function (response) {
      if (!response.ok) throw new Error('Unable to load ' + path + ' (' + response.status + ')');
      return response.text();
    }).then(function (content) {
      fileCache[key] = content;
      return content;
    });
  }

  function setText(id, value) {
    var node = byId(id);
    if (node) node.textContent = value;
  }

  function renderFacts(target, values) {
    target.innerHTML = values.map(function (item) {
      return '<div><dt>' + escapeHTML(item.label) + '</dt><dd>' + escapeHTML(item.value) + '</dd></div>';
    }).join('');
  }

  function typeOf(environment) {
    return environment.type || (String(environment.family || '').toLowerCase().indexOf('terminal') !== -1 ? 'terminal' : 'swe');
  }

  function environmentsForType(type) {
    return environments.filter(function (environment) { return typeOf(environment) === type; });
  }

  function updateTypeCounts() {
    ['swe', 'terminal', 'cua'].forEach(function (type) {
      setText(type + 'EnvironmentCount', environmentsForType(type).length);
    });
  }

  function renderCatalog(query) {
    var needle = String(query || '').trim().toLowerCase();
    var filtered = environments.filter(function (environment) {
      var haystack = [environment.title, environment.family, environment.category].concat(environment.tags || []).join(' ').toLowerCase();
      return typeOf(environment) === activeType && (!needle || haystack.indexOf(needle) !== -1);
    });
    var list = byId('environmentList');
    if (!list) return;
    if (!filtered.length) {
      list.innerHTML = '<p class="catalog-empty">No matching environment.</p>';
      return;
    }
    list.innerHTML = filtered.map(function (environment) {
      var active = activeEnvironment && activeEnvironment.id === environment.id;
      var number = String(environmentsForType(activeType).indexOf(environment) + 1).padStart(2, '0');
      return '<button class="catalog-environment" type="button" data-environment="' + escapeHTML(environment.id) + '" aria-current="' + String(active) + '">' +
        '<span class="catalog-index">' + number + '</span><span><strong>' + escapeHTML(environment.shortTitle || environment.title) + '</strong>' +
        '<small><b>' + escapeHTML(environment.typeLabel || environmentTypes[typeOf(environment)].label) + '</b> · ' + escapeHTML(environment.family + ' · ' + environment.category) + '</small></span></button>';
    }).join('');
  }

  function showType(type, updateURL) {
    if (!environmentTypes[type]) type = 'terminal';
    activeType = type;
    var descriptor = environmentTypes[type];
    var matching = environmentsForType(type);
    var navigation = Array.prototype.slice.call(document.querySelectorAll('[data-environment-type]'));
    navigation.forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-environment-type') === type));
    });
    setText('catalogTypeCode', descriptor.code);
    setText('catalogTypeName', descriptor.label);
    setText('environmentCount', matching.length + (matching.length === 1 ? ' environment' : ' environments'));
    renderCatalog(byId('environmentSearch').value);

    if (!matching.length) {
      byId('environmentTypeEmpty').hidden = false;
      byId('environmentDetail').hidden = true;
      setText('emptyTypeCode', descriptor.label + ' environment');
      setText('emptyTypeTitle', descriptor.title);
      setText('emptyTypeCopy', descriptor.description);
      byId('emptyTypeTraits').innerHTML = descriptor.traits.map(function (trait, index) {
        return '<span><b>' + String(index + 1).padStart(2, '0') + '</b>' + escapeHTML(trait) + '</span>';
      }).join('');
    } else {
      byId('environmentTypeEmpty').hidden = true;
      byId('environmentDetail').hidden = false;
      if (!activeEnvironment || typeOf(activeEnvironment) !== type) activateEnvironment(matching[0].id, updateURL);
    }

    if (updateURL && window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      url.searchParams.set('type', type);
      if (!matching.length) url.searchParams.delete('environment');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  function renderContract(environment) {
    var items = [
      { label: 'Entrypoint', value: environment.contract.entrypoint },
      { label: 'Artifact', value: environment.contract.artifact },
      { label: 'Allowed runtime', value: environment.contract.dependencies },
      { label: 'Evaluation', value: environment.contract.evaluation },
      { label: 'Pass threshold', value: environment.contract.threshold }
    ];
    byId('contractStrip').innerHTML = items.map(function (item) {
      return '<div><span>' + escapeHTML(item.label) + '</span><strong>' + escapeHTML(item.value) + '</strong></div>';
    }).join('');
  }

  function renderFiles(environment) {
    var files = environment.files.filter(function (file) { return file.public; });
    setText('publicFileCount', files.length);
    setText('fileTreeCount', files.length);
    renderFileTree(files, byId('fileSearch').value);
  }

  function renderFileTree(files, query) {
    var needle = String(query || '').trim().toLowerCase();
    var filtered = files.filter(function (file) {
      return !needle || (file.path + ' ' + file.label + ' ' + file.type).toLowerCase().indexOf(needle) !== -1;
    });
    var tree = byId('fileTree');
    if (!filtered.length) {
      tree.innerHTML = '<p class="catalog-empty">No matching public file.</p>';
      return;
    }
    tree.innerHTML = filtered.map(function (file) {
      var current = activeFile && activeFile.path === file.path;
      var icon = file.type === 'markdown' ? 'MD' : file.type === 'json' ? '{}' : file.type === 'toml' ? 'TM' : 'DF';
      return '<button class="file-entry" type="button" data-file="' + escapeHTML(file.path) + '" aria-current="' + String(current) + '">' +
        '<span class="file-icon">' + icon + '</span><span><strong>' + escapeHTML(file.path) + '</strong><small>' + escapeHTML(file.label) + '</small></span></button>';
    }).join('');
  }

  function openFile(path) {
    if (!activeEnvironment) return;
    var file = activeEnvironment.files.find(function (entry) { return entry.path === path && entry.public; });
    if (!file) return;
    activeFile = file;
    renderFileTree(activeEnvironment.files.filter(function (entry) { return entry.public; }), byId('fileSearch').value);
    setText('fileType', file.type);
    setText('filePath', file.path);
    setText('fileSize', file.size);
    var preview = byId('filePreview');
    preview.innerHTML = '<p class="loading-copy" style="padding:28px">Loading ' + escapeHTML(file.path) + '…</p>';
    loadFile(activeEnvironment, file.path).then(function (content) {
      if (activeFile !== file) return;
      if (file.type === 'markdown') {
        preview.innerHTML = '<article class="markdown-body">' + markdownToHTML(content) + '</article>';
      } else {
        preview.innerHTML = '<pre><code>' + escapeHTML(content) + '</code></pre>';
      }
    }).catch(function (error) {
      preview.innerHTML = '<p class="file-load-error">' + escapeHTML(error.message) + '</p>';
    });
  }

  function activateEnvironment(id, updateURL) {
    var environment = environments.find(function (item) { return item.id === id; }) || environments[0];
    if (!environment) return;
    activeEnvironment = environment;
    activeFile = null;
    activeType = typeOf(environment);

    setText('breadcrumbType', environment.typeLabel || environmentTypes[activeType].label);
    setText('breadcrumbFamily', environment.family);
    setText('breadcrumbTask', environment.id);
    setText('environmentStatus', environment.status);
    setText('environmentType', (environment.typeLabel || environmentTypes[activeType].label) + ' environment');
    setText('environmentFamily', environment.family);
    setText('environmentTitle', environment.title);
    setText('environmentSubtitle', environment.subtitle);
    setText('orbitVisualTitle', 'Action → physics → verification');
    setText('difficultyValue', environment.difficulty);
    setText('difficultyGrade', environment.difficultyGrade);
    setText('calibrationValue', environment.calibration);
    setText('expertEstimate', environment.expertEstimate);

    byId('environmentTags').innerHTML = environment.tags.map(function (tag) { return '<span>' + escapeHTML(tag) + '</span>'; }).join('');
    byId('environmentPhases').innerHTML = environment.phases.map(function (phase) {
      return '<article class="environment-phase"><span>' + escapeHTML(phase.code) + '</span><strong>' + escapeHTML(phase.title) + '</strong><p>' + escapeHTML(phase.detail) + '</p></article>';
    }).join('');

    renderContract(environment);
    renderFacts(byId('resourceGrid'), environment.resources);
    renderFacts(byId('timeoutGrid'), environment.timeouts);
    renderFacts(byId('verificationGrid'), environment.verification);
    renderFiles(environment);
    var navigation = Array.prototype.slice.call(document.querySelectorAll('[data-environment-type]'));
    navigation.forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-environment-type') === activeType));
    });
    setText('catalogTypeCode', environmentTypes[activeType].code);
    setText('catalogTypeName', environmentTypes[activeType].label);
    setText('environmentCount', environmentsForType(activeType).length + (environmentsForType(activeType).length === 1 ? ' environment' : ' environments'));
    renderCatalog(byId('environmentSearch').value);

    byId('instructionDocument').innerHTML = '<p class="loading-copy">Loading task instruction…</p>';
    loadFile(environment, 'instruction.md').then(function (content) {
      if (activeEnvironment !== environment) return;
      byId('instructionDocument').innerHTML = markdownToHTML(content);
    }).catch(function (error) {
      byId('instructionDocument').innerHTML = '<p class="file-load-error">' + escapeHTML(error.message) + '</p>';
    });

    byId('taskConfigSource').textContent = 'Loading task.toml…';
    loadFile(environment, 'task.toml').then(function (content) {
      if (activeEnvironment === environment) byId('taskConfigSource').textContent = content;
    }).catch(function (error) {
      byId('taskConfigSource').textContent = error.message;
    });

    openFile(environment.files[0].path);
    document.title = environment.title + ' — Empiria Environment Explorer';

    if (updateURL && window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      url.searchParams.set('type', activeType);
      url.searchParams.set('environment', environment.id);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  function activateTab(name, focus) {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.environment-tabs [role="tab"]'));
    var panels = {
      instruction: byId('panelInstruction'),
      configuration: byId('panelConfiguration'),
      files: byId('panelFiles')
    };
    if (!panels[name]) name = 'instruction';
    buttons.forEach(function (button) {
      var active = button.getAttribute('data-tab') === name;
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('tabindex', active ? '0' : '-1');
      if (active && focus) button.focus();
    });
    Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== name; });
    if (window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      url.hash = name;
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  var search = byId('environmentSearch');
  var fileSearch = byId('fileSearch');
  var environmentList = byId('environmentList');
  var fileTree = byId('fileTree');
  var tablist = document.querySelector('.environment-tabs');
  var typeNav = byId('environmentTypeNav');

  if (search) search.addEventListener('input', function () { renderCatalog(search.value); });
  if (fileSearch) fileSearch.addEventListener('input', function () {
    if (activeEnvironment) renderFileTree(activeEnvironment.files.filter(function (file) { return file.public; }), fileSearch.value);
  });
  if (environmentList) environmentList.addEventListener('click', function (event) {
    var button = event.target.closest('[data-environment]');
    if (!button) return;
    activateEnvironment(button.getAttribute('data-environment'), true);
    if (window.innerWidth <= 820) document.body.classList.add('environment-catalog-hidden');
  });
  if (typeNav) typeNav.addEventListener('click', function (event) {
    var button = event.target.closest('[data-environment-type]');
    if (!button) return;
    showType(button.getAttribute('data-environment-type'), true);
  });
  if (fileTree) fileTree.addEventListener('click', function (event) {
    var button = event.target.closest('[data-file]');
    if (button) openFile(button.getAttribute('data-file'));
  });
  if (tablist) {
    tablist.addEventListener('click', function (event) {
      var button = event.target.closest('[data-tab]');
      if (button) activateTab(button.getAttribute('data-tab'), false);
    });
    tablist.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      var buttons = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
      var current = buttons.indexOf(document.activeElement);
      var next = event.key === 'ArrowRight' ? current + 1 : current - 1;
      next = (next + buttons.length) % buttons.length;
      event.preventDefault();
      activateTab(buttons[next].getAttribute('data-tab'), true);
    });
  }

  byId('catalogClose').addEventListener('click', function () { document.body.classList.add('environment-catalog-hidden'); });
  byId('catalogOpen').addEventListener('click', function () { document.body.classList.remove('environment-catalog-hidden'); });
  byId('emptyTypeReturn').addEventListener('click', function () { showType('terminal', true); });

  var params = new URLSearchParams(window.location.search);
  var requestedEnvironment = params.get('environment') || (environments[0] && environments[0].id);
  var requestedType = params.get('type');
  var requestedRecord = environments.find(function (environment) { return environment.id === requestedEnvironment; });
  var requestedTab = window.location.hash.replace('#', '') || 'instruction';
  if (window.innerWidth <= 820) document.body.classList.add('environment-catalog-hidden');
  updateTypeCounts();
  if (requestedType && environmentTypes[requestedType] && (!requestedRecord || typeOf(requestedRecord) !== requestedType)) {
    showType(requestedType, false);
  } else {
    activateEnvironment(requestedEnvironment, false);
  }
  activateTab(requestedTab, false);
}());
