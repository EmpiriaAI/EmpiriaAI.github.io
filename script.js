/* Empiria Labs — scroll reveal, nav state, mobile menu */
(function () {
  'use strict';

  /* Opt into the JS-only hidden state. Must be the first statement so a
     failure below can never leave the page blank under the fold. */
  document.documentElement.classList.add('js');

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── mobile nav ──────────────────────────────────────── */
  var toggle = document.getElementById('navToggle');
  var nav = document.querySelector('.site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── B · split the statements into staggered words ────
     Done in JS, not in the markup, so the HTML stays a readable
     sentence: the source is the content, the spans are presentation.

     The trailing space is emitted as a text node BETWEEN spans, never
     inside one. Inside an inline-block a space stops being a break
     opportunity and the whole paragraph refuses to wrap.

     Words inside <em> stay inside the <em>, so the vermilion italic
     still comes from CSS, and the counter jumps two steps when a clause
     opens — that pause is what lets the italic land as a conclusion
     instead of arriving mixed in with its own setup. */
  function splitWords(root) {
    var texts = [], tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (tw.nextNode()) { texts.push(tw.currentNode); }

    var i = 0;
    texts.forEach(function (tn) {
      var parent = tn.parentNode;
      if (!parent) return;
      var inEm = !!(parent.closest && parent.closest('em'));
      var frag = document.createDocumentFragment();
      var opened = false;

      tn.nodeValue.split(/(\s+)/).forEach(function (tok) {
        if (!tok) return;
        if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(' ')); return; }
        if (inEm && !opened) { i += 2; opened = true; }
        var s = document.createElement('span');
        s.className = inEm ? 'cl cl-em' : 'cl';
        s.style.setProperty('--i', i++);
        s.textContent = tok;
        frag.appendChild(s);
      });
      parent.replaceChild(frag, tn);
    });
  }

  /* English blocks only. Staggering CJK per character reads as a bullet
     screen rather than as reading, so .statement-zh / .prose-zh keep the
     plain block fade. */
  Array.prototype.forEach.call(
    document.querySelectorAll('.statement, .prose'), splitWords);

  /* ── D · index the inventory rows so they draw in order ── */
  Array.prototype.forEach.call(document.querySelectorAll('.env-list'), function (list) {
    Array.prototype.forEach.call(list.children, function (li, n) {
      li.style.setProperty('--i', n);
    });
  });

  /* Counts up to the total already in the markup, never replacing it with
     a placeholder first — so with no JS, no IntersectionObserver, or
     reduced motion, the correct number is simply what was always there. */
  function countUp(el) {
    if (!el || el.__ran) return;
    el.__ran = true;
    var target = parseInt(el.textContent, 10);
    if (!(target > 0)) return;
    var t0 = 0;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / 760);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ── scroll reveal ───────────────────────────────────── */
  var revealables = document.querySelectorAll('.reveal, .env-list');
  function enter(el) {
    el.classList.add('in-view');
    if (el.classList.contains('env-list')) {
      var track = el.closest('.track');
      if (track) countUp(track.querySelector('.count'));
    }
  }
  function revealAll() {
    Array.prototype.forEach.call(revealables, function (el) {
      el.classList.add('in-view');
    });
  }
  if (reduce || !('IntersectionObserver' in window)) {
    revealAll();
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          enter(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    Array.prototype.forEach.call(revealables, function (el) { io.observe(el); });

    /* Headless capture and printing never scroll, so nothing would ever
       intersect. Force everything visible for those contexts. */
    window.addEventListener('beforeprint', revealAll);
    if (navigator.webdriver) { revealAll(); }
  }

  /* ── nav active section ──────────────────────────────── */
  var links = Array.prototype.slice.call(document.querySelectorAll('.site-nav a'));
  var targets = links
    .map(function (a) {
      var id = a.getAttribute('href');
      return id && id.charAt(0) === '#' ? document.querySelector(id) : null;
    })
    .filter(Boolean);

  if (targets.length && 'IntersectionObserver' in window) {
    var navIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    targets.forEach(function (t) { navIo.observe(t); });
  }

  /* ── hero parallax ───────────────────────────────────────
     The receding ground plane drifts slower than the copy, which reads
     as depth without moving anything the eye is trying to read. */
  var field = document.querySelector('.hero-field');
  var hero = document.querySelector('.hero');
  var plane = document.querySelector('.plane-wrap');
  var stale = true;                        /* pointer geometry needs re-measuring */

  if (field && hero && !reduce) {
    var queued = false, lastY = -1;
    function park() {
      queued = false;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (y > hero.offsetHeight + 200) return;
      if (y === lastY) return;
      lastY = y;
      /* the parallax moves .hero-field, so any cached rect of it is now wrong */
      stale = true;
      field.style.transform = 'translate3d(0,' + (y * 0.16).toFixed(1) + 'px,0)';
    }
    window.addEventListener('scroll', function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(park);
    }, { passive: true });
    park();
  }

  /* ── A + C · one scroll loop for the ground and the type ──
     Both of these are functions of scroll offset, so they share a single
     rAF-throttled handler. The hero parallax above cannot absorb them —
     it deliberately bails out once you are past the hero, which is
     exactly where these two start mattering.

     Deliberately not an IntersectionObserver: these are continuous
     functions of position, not on/off states. */
  var world = document.querySelector('.world');
  var weighted = Array.prototype.slice.call(
        document.querySelectorAll('.statement, .closing-title'));

  if ((world || weighted.length) && !reduce) {
    var qd = false;

    function frame() {
      qd = false;
      var vh = window.innerHeight || 1;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;

      if (world) {
        /* Up close the hero IS the environment and already draws its own
           plane; the far view only emerges as the hero leaves, so the two
           never overlap and argue. */
        var hh = hero ? hero.offsetHeight : vh;
        var o = (y - hh * 0.35) / (hh * 0.5);
        world.style.setProperty('--world-o', Math.min(1, Math.max(0, o)).toFixed(3));
        /* Modulo the 92px tile: the grid is seamless, so the remainder is
           visually identical and the value never grows without bound over
           a long scroll. */
        world.style.setProperty('--world-y', (y * 0.14 % 92).toFixed(1));
      }

      /* Weight tracks distance from the reading line rather than mere
         visibility — the sentence is heaviest exactly when it is the
         thing you are looking at, and eases off as you leave it.

         Writing font-variation-settings relayouts the element, and each
         statement holds ~30 inline-block words that then all get
         re-measured. So only write when the ROUNDED value actually
         moved: a slow scroll produces a few dozen writes instead of one
         per frame, and the visible result is identical.

         Verified safe against reflow at 1440 / 1024 / 768 / 390: across
         the whole 300..470 range the blocks hold 5 lines and an identical
         height, so nothing below them ever shifts. Widening that range
         means re-checking this.

         300 is the floor because that is where Space Grotesk's weight
         axis begins — the old 230 start was inherited from a serif whose
         axis went to 200, and asking for it here silently clamps, which
         would have flattened the first third of the ramp into no change
         at all. */
      for (var i = 0; i < weighted.length; i++) {
        var el = weighted[i];
        var r = el.getBoundingClientRect();
        if (r.bottom < -120 || r.top > vh + 120) continue;
        var d = Math.abs((r.top + r.height / 2) - vh * 0.42) / (vh * 0.62);
        var p = Math.max(0, 1 - d);
        /* squared, so the last stretch into the reading line carries most
           of the change and the settle reads as deliberate */
        var wg = Math.round(300 + p * p * 170);
        if (el.__wg === wg) continue;
        el.__wg = wg;
        el.style.setProperty('--wght', wg);
      }
    }

    function queue() {
      if (qd) return;
      qd = true;
      requestAnimationFrame(frame);
    }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue, { passive: true });
    frame();
  }

  /* ── K · an act, and the verdict on it ───────────────────
     Shared by both input paths so a cursor and a finger produce exactly
     the same phenomenon. The spark is the outcome; the label names it,
     0.18s later so the order act -> verified is actually legible.

     Counts .spark, never childElementCount: .events also holds the 24
     permanent environment marks, so a child count would report the
     budget as already spent before the first click.

     The label is suppressed where it would land on copy. It lives in
     .hero-field, below .hero-inner, so over the lead paragraph it comes
     out as illegible mush under legible text — and the hero's lower
     right is deliberately kept bare for the plane, which is exactly
     where a verdict belongs. The spark still fires everywhere; a 7px dot
     behind type reads as atmosphere, a 111px line of caps does not. */
  var copy = null, rg = null;
  var narrow = window.matchMedia('(max-width: 620px)');
  function occupied(box, x, y, w, h) {
    if (!copy) {
      copy = Array.prototype.slice.call(document.querySelectorAll(
        /* .hero-title .rise, not .hero-title: its two lines are display:
           block, and a range spanning block children yields their block
           rects — full width — which is the very thing ranges were used
           to avoid. One level deeper and the rects are tight to glyphs. */
        '.hero .eyebrow, .hero-title .rise, .hero-title-zh, .hero-lead,' +
        '.hero-cta .btn, .hero-foot p'));
      rg = document.createRange();
    }
    var br = box.getBoundingClientRect();
    var l = br.left + x, t = br.top + y;

    for (var i = 0; i < copy.length; i++) {
      var el = copy[i], rects;
      if (el.classList.contains('btn')) {
        rects = [el.getBoundingClientRect()];
      } else {
        /* Range rects, not the element box. These blocks are full-width
           by layout while their glyphs occupy a fraction of it, so the
           element rect would reserve the entire band and silence the
           verdict over bare canvas to the right of a short line. A range
           over the contents returns one tight rect per line box. */
        rg.selectNodeContents(el);
        rects = rg.getClientRects();
      }
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (l < r.right + 8 && l + w > r.left - 8 &&
            t < r.bottom + 8 && t + h > r.top - 8) return true;
      }
    }
    return false;
  }
  /* the element list survives a resize; nothing here caches geometry */
  window.addEventListener('resize', function () { copy = null; }, { passive: true });

  function emit(box, px, py, fieldW) {
    if (!box || box.querySelectorAll('.spark').length >= 8) return;

    var s = document.createElement('span');
    s.className = 'spark';
    s.style.setProperty('--x', px.toFixed(0) + 'px');
    s.style.setProperty('--y', py.toFixed(0) + 'px');
    s.addEventListener('animationend', function () { s.remove(); });
    box.appendChild(s);

    /* The label is a wide-viewport thing, and that is a measured call
       rather than a shrug. A 390px hero is 733px tall carrying ten lines
       of copy: across a 120-point grid there is no band that can hold
       even a tightened 90px label without sitting within 8px of a line —
       best case was 8 of 64 ground points, and placing it below the tap
       instead just puts it under the reader's own finger. Touch still
       gets the substantive half from the tap: the spark and the cells
       lighting up. */
    if (narrow.matches) return;

    /* 111px x 17px is what the label measures at 10.5px/.26em; past the
       right edge it grows the other way instead */
    var flip = px > fieldW - 150;
    var lx = flip ? px - 125 : px + 14;
    if (occupied(box, lx, py - 25, 111, 24)) return;

    var v = document.createElement('span');
    v.className = flip ? 'verdict flip' : 'verdict';
    v.setAttribute('aria-hidden', 'true');
    v.style.setProperty('--x', px.toFixed(0) + 'px');
    v.style.setProperty('--y', py.toFixed(0) + 'px');
    v.innerHTML = 'act<i>/</i><b>verified</b>';
    v.addEventListener('animationend', function () { v.remove(); });
    box.appendChild(v);
  }

  /* ── hero interaction ────────────────────────────────────
     "Intelligence through interaction" should be demonstrable, not just
     asserted. Moving the pointer turns the camera and lights the cells the
     probe is over; a click returns a verified outcome at that exact spot —
     the act -> observe -> verify loop, playable in the hero.

     Gated on a fine pointer: on touch there is no hover, so a probe that only
     appears mid-tap is noise, and tap-to-spark would fight scrolling. */
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (field && hero && plane && fine && !reduce) {
    document.documentElement.classList.add('pointer-fine');

    var events = Array.prototype.slice.call(document.querySelectorAll('.ev'));
    var sparkBox = document.querySelector('.events');

    /* target vs rendered: everything is eased so the environment feels like
       it has mass, and so leaving the hero glides back to neutral. */
    var tx = 0, ty = 0,      rx = 0, ry = 0;      /* pointer, field-relative px */
    var tAmt = 0,            rAmt = 0;            /* 0 = away, 1 = engaged      */
    var fRect = null, pRect = null;
    var running = false, seen = false;

    function measure() {
      fRect = field.getBoundingClientRect();
      pRect = plane.getBoundingClientRect();
      /* the marks are placed in percentages, so a resize moves them */
      for (var i = 0; i < events.length; i++) { events[i].__c = null; }
      stale = false;
    }

    function paint() {
      var w = fRect.width || 1, h = fRect.height || 1;
      var nx = (rx / w - 0.5) * 2;                 /* -1 .. 1 */
      var ny = (ry / h - 0.5) * 2;

      var st = hero.style;
      st.setProperty('--mx', rx.toFixed(1) + 'px');
      st.setProperty('--my', ry.toFixed(1) + 'px');
      st.setProperty('--pmx', (rx + fRect.left - pRect.left).toFixed(1) + 'px');
      st.setProperty('--pmy', (ry + fRect.top - pRect.top).toFixed(1) + 'px');

      /* Deliberately tiny. The hero has to stay readable; anything past ~2deg
         starts to feel like the page is sliding out from under the type. */
      st.setProperty('--yaw',   (nx * 1.7 * rAmt).toFixed(2) + 'deg');
      st.setProperty('--pitch', (ny * 0.9 * rAmt).toFixed(2) + 'deg');
      st.setProperty('--pox',   (-nx * 46 * rAmt).toFixed(1) + 'px');

      /* the frontier answers as you approach it */
      var toHorizon = Math.abs(ry - h * 0.54);
      var hzb = Math.max(0, 1 - toHorizon / (h * 0.26));
      st.setProperty('--hzb', (hzb * hzb * rAmt).toFixed(3));

      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var r = e.__c || (e.__c = { x: e.offsetLeft, y: e.offsetTop });
        var dx = r.x - rx, dy = r.y - ry;
        e.classList.toggle('near', rAmt > 0.4 && dx * dx + dy * dy < 11000);
      }

    }

    function tick() {
      if (stale) measure();

      /* Critically damped enough to never overshoot into a wobble. Letting go
         resolves faster than engaging: a crosshair left sitting on the plane
         after the pointer has gone is a stray artefact, not a trail. */
      rx += (tx - rx) * 0.14;
      ry += (ty - ry) * 0.14;
      rAmt += (tAmt - rAmt) * (tAmt ? 0.1 : 0.19);

      paint();

      /* park the loop once it has settled, so an idle tab costs nothing */
      if (Math.abs(tx - rx) < 0.4 && Math.abs(ty - ry) < 0.4 &&
          Math.abs(tAmt - rAmt) < 0.006) {
        rx = tx; ry = ty; rAmt = tAmt;
        paint();                       /* land exactly on neutral, not near it */
        running = false;
        if (!tAmt) hero.classList.remove('live');
        return;
      }
      requestAnimationFrame(tick);
    }

    function wake() {
      if (running) return;
      running = true;
      requestAnimationFrame(tick);
    }

    hero.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      if (stale || !fRect) measure();
      tx = e.clientX - fRect.left;
      ty = e.clientY - fRect.top;
      if (!seen) {                       /* first sighting: no glide from 0,0 */
        seen = true; rx = tx; ry = ty;
      }
      tAmt = 1;
      hero.classList.add('live');
      wake();
    });

    hero.addEventListener('pointerleave', function () {
      tAmt = 0;
      wake();
    });

    /* an act returns a verified outcome, right where it happened */
    hero.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      /* let links and buttons be links and buttons, and keep the top band
         out of it — a spark there lands behind the strip, so the click
         would look like it simply did nothing */
      if (e.target.closest && e.target.closest('a, button, .hero-banner')) return;
      if (stale || !fRect) measure();
      emit(sparkBox, e.clientX - fRect.left, e.clientY - fRect.top, fRect.width);
    });

    window.addEventListener('resize', function () { stale = true; wake(); });
  }

  /* ── J · the environment answers a tap ───────────────────
     The block above is gated on a fine pointer, which left the hero on a
     phone as a static grid. That was over-gating: the original worry was
     that tap-to-spark would fight scrolling, but a tap that does not MOVE
     cannot be a scroll.

     So the discrimination happens on release, not on press — under 10px
     of travel and under 500ms down. Nothing calls preventDefault, every
     listener is passive, and a drag of any length scrolls exactly as
     before. pointercancel matters as much as pointerup: once the browser
     claims the gesture for scrolling it fires cancel and never up, which
     is the cleanest possible signal that this was not a tap.

     A tap also lights the cells it landed on, through the same lit layer
     and the same --pmx/--pmy mask the cursor drives — the phone gets the
     same phenomenon, not a separate mobile effect. Land it above the
     horizon and you get the spark with no cells lit, which is correct:
     there is no ground up there to sense. */
  if (field && hero && plane && !fine && !reduce) {
    document.documentElement.classList.add('pointer-coarse');

    var tapBox = document.querySelector('.events');
    var downT = 0, downX = 0, downY = 0, litT = 0;

    hero.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      downT = e.timeStamp; downX = e.clientX; downY = e.clientY;
    }, { passive: true });

    /* the browser took the gesture for scrolling — forget the press */
    hero.addEventListener('pointercancel', function () { downT = 0; }, { passive: true });

    hero.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'mouse' || !downT) return;
      var dt = e.timeStamp - downT;
      var dx = e.clientX - downX, dy = e.clientY - downY;
      downT = 0;
      if (dt > 500 || dx * dx + dy * dy > 100) return;
      /* let links and buttons be links and buttons, and keep the top band
         out of it — a spark there lands behind the strip, so the tap would
         look like it simply did nothing */
      if (e.target.closest && e.target.closest('a, button, .hero-banner')) return;

      var fr = field.getBoundingClientRect();
      emit(tapBox, e.clientX - fr.left, e.clientY - fr.top, fr.width);

      /* the mask is in the plane's own space, not the field's */
      var pr = plane.getBoundingClientRect();
      hero.style.setProperty('--pmx', (e.clientX - pr.left).toFixed(0) + 'px');
      hero.style.setProperty('--pmy', (e.clientY - pr.top).toFixed(0) + 'px');
      hero.classList.add('touched');
      clearTimeout(litT);
      litT = setTimeout(function () { hero.classList.remove('touched'); }, 620);
    }, { passive: true });
  }

  /* ── the wordmark answers when it is addressed ───────────
     The footer writes the name once when it arrives. Pointing at it writes
     it again: the same phenomenon on demand, not a second effect.

     Fine pointers only. On a touch screen there is no hover — the state
     latches on tap, and the entire premise of this sweep is that it is
     transient. Under reduced motion the accent layer is display:none, so
     there would be nothing to replay.

     Three things here exist because the first version felt unreliable, and
     each was measured rather than guessed:

     · The listener is on .wordmark, not on the span. The span is a line
       box 195px tall while the visible letters run 243px, so the top 48px
       of every capital — a fifth of the name — looked live and was not.
       .wordmark's own box is exactly the visible band, because its
       overflow:hidden is what defines that band in the first place.
     · Which means the x test has to be explicit: .wordmark spans the full
       1440 while the glyphs stop at 961, and 480px of empty gutter must
       not answer.
     · A mousemove path, which the first version deliberately omitted. That
       was the real defect. mouseenter fires once per entry, so a cursor
       already inside the box gets no second chance — and if that one entry
       was refused (the footer scrolling up under a stationary cursor is
       enough), moving over the letters could never trigger anything again.
       That was a dead end, not a cool-down.

     Refusals, and what each is for:
       · already sweeping — restarting mid-stroke snaps the clip back to
         zero, which reads as a fault rather than a reply. animationstart
         arms this, so nothing has to guess when the entrance is over.
       · landed under 300ms ago, on entry only — just enough to stop the
         arrival at the bottom of the page from playing twice back to back.
         It was 900ms, which combined with the 1.6s sweep left the name
         inert for two and a half seconds.
       · under 30px of travel, on the mousemove path — so a cursor parked
         on the name does not loop, while a deliberate flick does. */
  var mark = document.querySelector('.wordmark');
  var name = mark && mark.querySelector('span');
  if (name && fine && !reduce) {
    var sweeping = false, landedAt = -Infinity;
    var travel = 0, lastX = 0, lastY = 0;

    name.addEventListener('animationstart', function (e) {
      if (e.animationName === 'write') sweeping = true;
    });
    function landed(e) {
      if (e.animationName !== 'write') return;
      sweeping = false;
      landedAt = e.timeStamp;
      mark.classList.add('written');       /* retire the entrance rule */
      mark.classList.remove('rewriting');
    }
    name.addEventListener('animationend', landed);
    name.addEventListener('animationcancel', landed);

    /* Vertical is already handled by the element the listener sits on. */
    function onLetters(x) {
      var r = name.getBoundingClientRect();
      return x >= r.left && x <= r.right;
    }
    function play() {
      if (sweeping) return;
      travel = 0;
      /* .written is set here too, not only on animationend: if the
         entrance never ran, the replay must still work. */
      mark.classList.add('written');
      mark.classList.add('rewriting');
    }

    mark.addEventListener('mouseenter', function (e) {
      lastX = e.clientX; lastY = e.clientY; travel = 0;
      if (e.timeStamp - landedAt < 300) return;
      if (onLetters(e.clientX)) play();
    });

    mark.addEventListener('mousemove', function (e) {
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      travel += Math.sqrt(dx * dx + dy * dy);
      if (travel < 30 || sweeping) return;
      if (e.timeStamp - landedAt < 600) return;
      if (onLetters(e.clientX)) play();
    }, { passive: true });
  }
})();
