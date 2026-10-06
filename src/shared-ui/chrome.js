/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Drawerforge — https://drawerforge.co.uk — Copyright (C) 2026 Oliver Johnson
 * GNU AGPL v3 or later, with additional terms under section 7: see LICENSE and NOTICE.
 * Additional permission: the files this program generates — STL, 3MF, ZIP — are not
 * covered by this licence. The models you make with it are yours. */
/* Shared page furniture — runs on every page, tools and prose alike. */
(function () {
  /* Carry the working state across links that ask for it.
     The guide pages hold no state of their own, so following one and coming back
     used to throw away whatever layout you had. Anything marked data-carry passes
     the current hash straight through. */
  var links = document.querySelectorAll('a[data-carry]');
  if (document.body.hasAttribute('data-carry-all')) {
    // every internal link on a prose page carries: hub to spoke, spoke to spoke and
    // back to the tools. Marking them individually meant one missed link threw the
    // layout away, which is exactly what happened with the guide cross-links.
    links = [].filter.call(document.querySelectorAll('a[href]'), function (a) {
      var h = a.getAttribute('href') || '';
      return h && !/^(https?:|mailto:|#)/.test(h);
    });
  }
  /* The link's own anchor gives way to the layout: an address holds one fragment, and
     "../#heights" with the layout added was "#heights#w=…", which the tools read as a
     layout missing its drawer. */
  for (const a of links)
    a.addEventListener('click', function (e) {
      if (!location.hash || location.hash.length < 3) return;
      e.preventDefault();
      location.href = a.getAttribute('href').split('#')[0] + location.hash;
    });

  /* Skip links move focus and leave the address alone. Followed the ordinary way, one
     put #stage in the address bar where the tools keep the layout, and a hash change
     reloads both tools — so the first thing Tab reaches wiped the drawer on screen and
     then the save behind it. The target takes focus (tabindex="-1"), and focusing it
     scrolls it into view, which is all the jump was for. */
  for (const s of document.querySelectorAll('a.skip'))
    s.addEventListener('click', function (e) {
      var t = document.getElementById((s.getAttribute('href') || '').slice(1));
      if (!t) return;
      e.preventDefault();
      t.focus();
    });

  /* A touch screen has no wheel and no shift key, so "wheel zoom · shift-drag pan"
     described controls that do not exist there. Rewritten rather than removed: the
     gestures are still worth naming, they are just different ones. Matching on
     pointer:coarse rather than width, because the question is what the input device
     can do, not how wide the screen is. */
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var hint = document.getElementById('threehint');
  if (hint && coarse) hint.textContent = 'drag rotate · pinch zoom';

  /* Full-screen preview.
     On a touch screen the 3D preview was unusable: dragging a finger across it
     scrolled the page instead of rotating the model, because the canvas has to let
     the page scroll or you could never scroll past it. Rather than trade one for the
     other, expanding it makes the choice explicit — full screen, page scrolling
     locked, and touch-action off the canvas so a drag rotates. Escape or the button
     puts it back. Both tools resize their renderer from a window resize event, so
     one dispatch covers them. */
  var wrap = document.getElementById('threewrap');
  if (wrap) {
    /* Fit, beside it. Once you have zoomed into a corner or panned the drawer half out of
       view there was no way back but zooming out by feel or reloading the page. The
       button only announces itself — each tool listens for 'previewfit' and frames its
       own camera, since the two keep their cameras differently and this file is shared
       with pages that have none. Fit keeps the angle you are looking from: it answers
       "show me all of it", not "start again". */
    var row = document.createElement('div');
    row.className = 'previewbtns';
    var fit = document.createElement('button');
    fit.className = 'fitbtn';
    fit.type = 'button';
    fit.title = 'Fit the whole design in the view';
    fit.setAttribute('aria-label', fit.title);
    fit.textContent = 'Fit';
    fit.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      wrap.dispatchEvent(new CustomEvent('previewfit'));
    });
    row.appendChild(fit);

    var btn = document.createElement('button');
    btn.className = 'previewbtn';
    btn.type = 'button';
    btn.title = 'Expand the preview';
    btn.setAttribute('aria-label', 'Expand the preview');
    btn.textContent = 'Expand';
    row.appendChild(btn);
    wrap.appendChild(row);

    var setExpanded = function (on) {
      wrap.classList.toggle('expanded', on);
      document.body.classList.toggle('previewlock', on);
      btn.textContent = on ? 'Close' : 'Expand';
      btn.title = on ? 'Close the preview' : 'Expand the preview';
      btn.setAttribute('aria-label', btn.title);
      // let the page settle at its new size before the renderer measures it
      requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
    };
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(!wrap.classList.contains('expanded'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.classList.contains('expanded')) setExpanded(false);
    });
  }

  /* Tip jar. Persistent, but dismissible and it stays dismissed — a banner you
     cannot get rid of is worse than no banner. The flag is a local preference,
     not a tracker: nothing leaves the browser.

     It no longer appears on load. It is fixed to the bottom right, so it sits over
     whatever happens to be at the foot of the viewport, and on arrival that is the
     first thing anyone reads: measured at 1440 it landed mid-sentence in the export
     explainer, and at 390 across the dividers fields. First load is also the least
     earned moment to ask for money — the visitor has not used the tool yet. So it
     waits for the visitor to have started: a scroll, which on either tool means they
     are working rather than merely arrived. The timer is the fallback for a drawer
     that fits on one screen, where no scroll ever happens and the jar would otherwise
     never show. Whichever comes first, once, and then it stays.

     The markup ships it `hidden` so it cannot flash before this runs. That does mean
     no tip jar without JavaScript, which is the right trade for a page whose entire
     content is generated by JavaScript, and harmless on the prose pages. */
  var bar = document.getElementById('kofi');
  if (!bar) return;
  var off = false;
  try { off = localStorage.getItem('df-kofi') === 'off'; } catch (e) {}

  var x = document.getElementById('kofiX');
  if (x) x.addEventListener('click', function (e) {
    e.preventDefault();
    bar.hidden = true;
    document.documentElement.classList.remove('kofi-on');
    try { localStorage.setItem('df-kofi', 'off'); } catch (e2) {}
  });

  if (!off) {
    var shown = false;
    var show = function () {
      if (shown) return;
      shown = true;
      clearTimeout(wait);
      // scroll is watched in the capture phase because the rail and the stage are their
      // own scroll containers on the tools — their scroll events do not reach window
      document.removeEventListener('scroll', onScroll, true);
      bar.hidden = false;
      /* The clearance padding goes on while the panel is up and comes off with it, so
         a visitor who dismissed it is not left with a strip of empty page instead. */
      document.documentElement.classList.add('kofi-on');
    };
    var onScroll = function () { show(); };
    var wait = setTimeout(show, 45000);
    document.addEventListener('scroll', onScroll, true);
  }
})();
