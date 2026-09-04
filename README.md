# EmpiriaAI.github.io

The Empiria Labs homepage, served by GitHub Pages at
**<https://empiriaai.github.io/>**.

Three files and a stylesheet, no build step and no dependencies. What is
committed here is exactly what is served.

```
index.html      the page
style.css       every rule, including the reduced-motion path
script.js       reveal, the hero's pointer work, the scroll-linked weight ramp
fonts.css       @font-face for the four self-hosted faces
fonts/          Space Grotesk, Inter Tight (+ italic), JetBrains Mono
.nojekyll       opt out of Jekyll — this is plain static output
```

## Local preview

```bash
python3 -m http.server 8000
```

Any static server works. Opening `index.html` directly over `file://` also
works, but the scroll-linked effects are easier to judge over HTTP.

## Two decisions that are easy to undo by accident

**The fonts are self-hosted, not linked.** `fonts.googleapis.com` does not
resolve from mainland China. The request does not degrade, it fails — so the
page fell all the way through to the system stack and the typography, which
is the entire visual identity here, silently disappeared for a large share of
readers. A mirror CDN only relocates the single point of failure. Only the
latin subset is shipped: every character the page renders was audited against
the subset ranges, and the CJK text is set in the system stack by design.

**Every hover rule sits inside `@media (hover: hover) and (pointer: fine)`.**
Ungated, a tap on a touch screen latches the state, and for the two marquees
that stops them for good. Focus rings are on `:focus-visible` so a mouse click
does not leave one behind.

`prefers-reduced-motion` is a real path rather than a token gesture: the
marquees unroll into their complete lists instead of freezing on an arbitrary
clipped slice, the loop diagram parks in a readable resting state rather than
mid-beat, pointer interaction in the hero is never armed, and hover colour
feedback is kept while movement is dropped.

## Source

Site source and the rest of the lab's work: <https://github.com/EmpiriaAI>
