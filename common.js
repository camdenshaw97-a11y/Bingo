/* Shared by the TV page and the phone page. */
(function () {
  'use strict';
  var F = window.Game = {};
  var B = window.Bingo;

  // Change these to rename the game everywhere.
  F.TITLE = 'FRIEND BINGO';
  F.SUB = 'BINGO NIGHT';
  // Shown small on the start screens. Goes up with every change; CHANGELOG.md says what each one was.
  F.VERSION = '1.0.0';

  F.$ = function (sel, root) { return (root || document).querySelector(sel); };
  F.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  F.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  F.clock = function (ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    s = s % 60; m = m % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };
  F.num = function (n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };

  F.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  /* ---- live connection with automatic reconnect ---- */
  F.connect = function (opts) {
    var ws = null, timer = null, tries = 0, stopped = false;
    var myBuild = document.documentElement.getAttribute('data-build');
    function freshCheck() {
      if (!myBuild || !window.fetch) return;
      fetch('/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (v) {
        if (!/^[0-9a-f]{12}$/.test(v) || v === myBuild) return;
        var last = Number(F.store.get('fb.reloadAt', 0));
        if (Date.now() - last < 30000) return;
        F.store.set('fb.reloadAt', Date.now());
        try { sessionStorage.setItem('fb.auto', '1'); } catch (e) { /* private mode */ }
        location.reload();
      }).catch(function () { /* offline: try again next time */ });
    }
    function open() {
      timer = null;
      if (stopped) return;
      try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { return retry(); }
      var mine = ws;
      mine.onopen = function () {
        tries = 0; freshCheck();
        if (opts.onStatus) opts.onStatus(true);
        var h = opts.hello && opts.hello();
        if (h) mine.send(JSON.stringify(h));
      };
      mine.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (err) { return; } opts.onMessage(m); };
      mine.onclose = function () { if (ws !== mine) return; if (opts.onStatus) opts.onStatus(false); retry(); };
      mine.onerror = function () { try { mine.close(); } catch (e) { /* ignore */ } };
    }
    function retry() { if (stopped || timer) return; timer = setTimeout(open, Math.min(4000, 300 + 500 * tries++)); }
    var api = {
      send: function (m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; },
      stop: function () { stopped = true; if (timer) clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } }
    };
    open();
    setInterval(function () { api.send({ t: 'ping' }); }, 20000);
    setInterval(function () { try { fetch('/health').catch(function () {}); freshCheck(); } catch (e) { /* ignore */ } }, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !stopped && (!ws || ws.readyState > 1)) { if (timer) { clearTimeout(timer); timer = null; } tries = 0; open(); }
    });
    return api;
  };

  F.stayAwake = function () {
    var lock = null;
    function ask() {
      if (!navigator.wakeLock || document.hidden) return;
      try { navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); } catch (e) { /* not allowed here */ }
    }
    ask();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
    document.addEventListener('click', function () { if (!lock) ask(); }, { passive: true });
  };

  F.fit = function (el, min) {
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize), floor = min || size * 0.45, guard = 0;
    while ((el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) && size > floor && guard++ < 60) {
      size -= Math.max(1, size * 0.05);
      el.style.fontSize = size + 'px';
    }
  };

  var calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  F.motionOK = function () { return !(calm && calm.matches); };
  F.anim = function (el, frames, opts) {
    if (!el || !el.animate || !F.motionOK()) return null;
    try { return el.animate(frames, opts); } catch (e) { return null; }
  };
  F.bump = function (el, scale) {
    return F.anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(' + (scale || 1.2) + ')', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.3, 1.3, .5, 1)' });
  };
  F.shake = function (el) {
    return F.anim(el, [0, -6, 12, -18, 18, -14, 12, -8, 4, 0].map(function (x) { return { transform: 'translateX(' + x + 'px)' }; }), { duration: 480, easing: 'ease-out' });
  };

  /* ---- redraw a block of HTML without throwing away what is already on screen ---- */
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null; }
  function morphKids(from, to) {
    var want = {}, cur = from.firstChild, next = to.firstChild, n, k, hit, c, clear;
    function id(x) { var kk = keyOf(x); return kk ? x.nodeName + '|' + kk : null; }
    function drop(x) { if (x === cur) cur = cur.nextSibling; from.removeChild(x); }
    for (n = to.firstChild; n; n = n.nextSibling) if (id(n)) want[id(n)] = 1;
    while (next) {
      n = next; next = next.nextSibling;
      while (cur && id(cur) && !want[id(cur)]) drop(cur);
      k = id(n); hit = null;
      for (c = cur; c; c = c.nextSibling) if (k ? id(c) === k : (!id(c) && c.nodeName === n.nodeName)) { hit = c; break; }
      if (hit && hit !== cur) {
        clear = true;
        for (c = cur; c !== hit; c = c.nextSibling) if (id(c) && want[id(c)]) { clear = false; break; }
        if (clear) while (cur !== hit) drop(cur);
      }
      if (hit) { if (hit === cur) cur = cur.nextSibling; else from.insertBefore(hit, cur); morphNode(hit, n); }
      else from.insertBefore(n, cur);
    }
    while (cur) drop(cur);
  }
  function morphNode(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    var i, at, name;
    for (i = a.attributes.length - 1; i >= 0; i--) { name = a.attributes[i].name; if (!b.hasAttribute(name) && name.indexOf('data-fx-') !== 0) a.removeAttribute(name); }
    for (i = 0; i < b.attributes.length; i++) { at = b.attributes[i]; if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value); }
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA' || a.nodeName === 'SELECT') {
      if (document.activeElement !== a) { var v = b.getAttribute('value') || ''; if (a.value !== v) a.value = v; }
      return;
    }
    if (a.hasAttribute('data-live') || a.hasAttribute('data-static')) return;
    morphKids(a, b);
  }
  F.morph = function (root, html) { var t = document.createElement('template'); t.innerHTML = html; morphKids(root, t.content); };

  F.pressFx = function () {
    var held = null, t0 = 0;
    function release() { var b = held; held = null; if (b) setTimeout(function () { b.removeAttribute('data-fx-press'); }, Math.max(0, 110 - (performance.now() - t0))); }
    document.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button, a.tvbtn, a.link, .tap') : null;
      if (!b || b.disabled) return;
      if (held && held !== b) held.removeAttribute('data-fx-press');
      held = b; t0 = performance.now();
      b.setAttribute('data-fx-press', '');
    }, { passive: true });
    ['pointerup', 'pointercancel', 'blur'].forEach(function (ev) { addEventListener(ev, release, { passive: true }); });
    document.addEventListener('touchstart', function () {}, { passive: true });
  };

  /* ---- dialogs styled like the game ---- */
  F.dialog = function (o) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'dlg-back';
      var h = '<div class="dlg" role="dialog">' + (o.title ? '<h2>' + F.esc(o.title) + '</h2>' : '') + (o.text ? '<p>' + F.esc(o.text) + '</p>' : '') + (o.html || '');
      if (o.input) h += '<input class="dlg-in" maxlength="' + (o.input.maxlength || 40) + '" placeholder="' + F.esc(o.input.placeholder || '') + '" value="' + F.esc(o.input.value || '') + '">';
      if (o.textarea) h += '<textarea class="dlg-in dlg-ta" rows="' + (o.textarea.rows || 10) + '" placeholder="' + F.esc(o.textarea.placeholder || '') + '">' + F.esc(o.textarea.value || '') + '</textarea>';
      h += '<div class="dlg-row">' + (o.buttons || [{ label: 'OK', kind: 'pri', value: true }]).map(function (b, i) { return '<button class="dlg-btn ' + (b.kind || '') + '" data-i="' + i + '">' + F.esc(b.label) + '</button>'; }).join('') + '</div></div>';
      back.innerHTML = h;
      document.body.appendChild(back);
      var inp = back.querySelector('.dlg-in'), ta = back.querySelector('.dlg-ta');
      function done(v) { back.classList.add('out'); setTimeout(function () { back.remove(); }, 180); resolve(v); }
      back.addEventListener('click', function (e) {
        var b = e.target.closest('.dlg-btn');
        if (b) { var bt = (o.buttons || [{ value: true }])[Number(b.getAttribute('data-i'))]; done(inp ? { value: bt.value, text: ta ? ta.value : inp.value, name: ta && back.querySelector('.dlg-name') ? back.querySelector('.dlg-name').value : undefined } : bt.value); }
        else if (e.target === back && !o.input && !o.textarea) done(o.cancel === undefined ? false : o.cancel);
      });
      if (inp && !ta) { setTimeout(function () { inp.focus(); inp.select(); }, 60); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var pri = (o.buttons || []).findIndex(function (b) { return b.kind === 'pri'; }); done({ value: pri >= 0 ? o.buttons[pri].value : true, text: inp.value }); } }); }
      if (ta) setTimeout(function () { ta.focus(); }, 60);
      addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && back.parentNode) { done(o.cancel === undefined ? false : o.cancel); removeEventListener('keydown', esc); } });
    });
  };
  F.confirm = function (title, text, okLabel, danger) {
    return F.dialog({ title: title, text: text, buttons: [{ label: okLabel || 'OK', kind: danger ? 'red' : 'pri', value: true }, { label: 'Cancel', kind: 'ghost', value: false }] });
  };

  /* ---- sound effects, synthesized so there are no audio files to load ---- */
  F.sfx = (function () {
    var ctx = null, muted = false, master = null;
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) { ctx = new C(); master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination); }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(o) {
      var c = ac(); if (!c || muted) return;
      var t = c.currentTime + (o.t || 0), d = o.d || 0.3;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.g || 0.3, t + (o.a || 0.012));
      if (o.hold) g.gain.setValueAtTime(o.g || 0.3, t + d - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + d + 0.05);
    }
    function noise(t, d, g, freq, q) {
      var c = ac(); if (!c || muted) return;
      var n = Math.floor(c.sampleRate * d), buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 2500; f.Q.value = q || 1.2;
      gn.gain.value = g;
      src.connect(f); f.connect(gn); gn.connect(master);
      src.start(c.currentTime + (t || 0));
    }
    function bell(f, t, g) { tone({ f: f, t: t, d: 1.0, g: g }); tone({ f: f * 2, t: t, d: 0.6, g: g * 0.35 }); tone({ f: f * 3.01, t: t, d: 0.3, g: g * 0.15 }); }
    return {
      unlock: ac, ctx: ac,
      mute: function (v) { muted = v; if (master) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.03); },
      isMuted: function () { return muted; },
      tick: function () { tone({ f: 1000, type: 'square', d: 0.04, g: 0.08 }); },
      join: function () { tone({ f: 660, d: 0.09, g: 0.14 }); tone({ f: 990, t: 0.08, d: 0.2, g: 0.14 }); },
      ping: function () { tone({ f: 1760, type: 'sine', d: 0.1, g: 0.14 }); tone({ f: 2349, type: 'sine', t: 0.1, d: 0.25, g: 0.12 }); },
      tap: function () { tone({ f: 880, type: 'triangle', d: 0.06, g: 0.1 }); },
      // The cage turns: a rattle of balls.
      rattle: function () { for (var i = 0; i < 9; i++) noise(i * 0.07 + Math.random() * 0.02, 0.05, 0.35, 1800 + Math.random() * 1400, 2); },
      // A ball drops into the tray and the caller reads it.
      ball: function () { noise(0, 0.06, 0.6, 2600, 1.5); tone({ f: 1320, f2: 880, type: 'sine', t: 0.02, d: 0.16, g: 0.14 }); tone({ f: 660, type: 'triangle', t: 0.12, d: 0.22, g: 0.1 }); },
      // A dauber hits the card: a soft wet thump.
      daub: function () { noise(0, 0.05, 0.5, 700, 0.8); tone({ f: 420, f2: 180, type: 'sine', d: 0.09, g: 0.16 }); },
      nope: function () { tone({ f: 220, f2: 160, type: 'square', d: 0.12, g: 0.07 }); },
      // Somebody shouts BINGO: a drum roll builds while the card is checked.
      drumroll: function (secs) { var n = Math.floor((secs || 3) * 14); for (var i = 0; i < n; i++) noise(i / 14, 0.04, 0.35 + 0.4 * i / n, 260 + 60 * (i % 2), 0.9); },
      // The bingo is good: a marquee fanfare.
      bingo: function () {
        [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.11, d: i === 6 ? 1.4 : 0.14, g: 0.22 }); });
        [262, 330, 392].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 0.66, d: 1.6, g: 0.05 }); });
        bell(2093, 0.8, 0.12); bell(2637, 1.0, 0.08);
      },
      // The bingo is bad: the hall groans.
      buzzer: function () { tone({ f: 120, type: 'square', d: 0.55, g: 0.16, hold: true }); tone({ f: 113, type: 'square', d: 0.55, g: 0.12, hold: true }); tone({ f: 60, type: 'sawtooth', t: 0.05, d: 0.5, g: 0.1, hold: true }); },
      share: function () { [659, 784, 988].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.09, d: 0.3, g: 0.14 }); }); },
      round: function () { [392, 523, 659].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.1, d: i === 2 ? 0.6 : 0.14, g: 0.16 }); }); },
      close: function () { tone({ f: 988, type: 'sine', d: 0.08, g: 0.1 }); tone({ f: 1319, type: 'sine', t: 0.09, d: 0.3, g: 0.1 }); },
      champion: function () {
        [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.14, d: i === 7 ? 2.0 : 0.2, g: 0.2 }); });
        [262, 330, 392, 523].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 1.1, d: 2.2, g: 0.05 }); });
        bell(2093, 1.2, 0.12); bell(2637, 1.5, 0.08);
      },
      sad: function () { [392, 370, 349, 311].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.22, d: i === 3 ? 1.0 : 0.24, g: 0.1 }); }); },
      intro: function () { [[523, 0], [659, 0.18], [784, 0.36], [1047, 0.54]].forEach(function (n) { tone({ f: n[0], type: 'triangle', t: n[1], d: n[1] === 0.54 ? 1.2 : 0.2, g: 0.14 }); }); bell(2093, 0.7, 0.08); },
      pause: function () { tone({ f: 660, type: 'sine', d: 0.1, g: 0.1 }); tone({ f: 440, type: 'sine', t: 0.12, d: 0.25, g: 0.1 }); }
    };
  })();

  /* ---- the caller's voice (the TV only; needs nothing but the browser) ---- */
  F.voice = (function () {
    var on = true, ready = false, voice = null;
    function pickVoice() {
      if (!window.speechSynthesis) return;
      var vs = speechSynthesis.getVoices();
      if (!vs.length) return;
      var en = vs.filter(function (v) { return /^en/i.test(v.lang); });
      var pref = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Zira', 'Daniel', 'Karen', 'Moira'];
      for (var i = 0; i < pref.length; i++) { var hit = en.filter(function (v) { return v.name.indexOf(pref[i]) >= 0; })[0]; if (hit) { voice = hit; break; } }
      if (!voice) voice = en[0] || vs[0];
      ready = true;
    }
    if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
    return {
      ok: function () { return !!window.speechSynthesis; },
      set: function (v) { on = v; if (!v && window.speechSynthesis) speechSynthesis.cancel(); },
      isOn: function () { return on; },
      say: function (text, rate) {
        if (!on || !window.speechSynthesis) return;
        try {
          if (!ready) pickVoice();
          speechSynthesis.cancel();
          var u = new SpeechSynthesisUtterance(text);
          if (voice) u.voice = voice;
          u.rate = rate || 0.92; u.pitch = 1.0; u.volume = 1;
          speechSynthesis.speak(u);
        } catch (e) { /* no voice here */ }
      }
    };
  })();
  // "B 12" read the way a caller reads it: the letter, then the number as digits ("one two") and as a number.
  F.callText = function (pool, id) {
    if (pool && pool.kind === 'custom') return B.LETTERS[B.colOf(pool, id)] + '. ' + B.labelOf(pool, id);
    var L = B.LETTERS[B.colOf(pool, id)];
    var digits = String(id).split('').join(' ');
    return L + '. ' + (id >= 10 ? digits + '. ' : '') + L + ' ' + id;
  };

  /* ---- pictures ---- */
  F.emo = function (e) { return '<span class="emo">' + F.esc(e || '❓') + '</span>'; };
  // A player as a coloured medallion with their face.
  F.med = function (p, cls) {
    var c = B.PALETTE[(p && p.color) || 0] || B.PALETTE[0];
    return '<span class="med' + (cls ? ' ' + cls : '') + '" style="--c1:' + c.c1 + ';--c2:' + c.c2 + '">' + F.emo(p ? p.face : '🙂') + '</span>';
  };
  F.colorOf = function (p) { return B.PALETTE[(p && p.color) || 0] || B.PALETTE[0]; };
  // A bingo ball: the letter and the number (or the item) on a glossy ball in its column colour.
  F.ball = function (pool, id, cls) {
    var c = B.colOf(pool, id), col = B.COLORS[c], custom = pool && pool.kind === 'custom';
    var label = custom ? B.labelOf(pool, id) : String(id);
    return '<span class="ball' + (cls ? ' ' + cls : '') + (custom ? ' word' : '') + '" style="--bc:' + col.bg + ';--bh:' + col.hi + ';--bi:' + col.ink + '"><span class="face"><i>' + B.LETTERS[c] + '</i><b>' + F.esc(label) + '</b></span></span>';
  };
  // A little 5×5 picture of a pattern.
  F.patternPic = function (pattern, cls) {
    var on = {}; (pattern.demo || []).forEach(function (s) { on[s] = 1; });
    var h = '';
    for (var s = 0; s < 25; s++) h += '<i class="' + (on[s] ? 'on' : '') + (s === 12 ? ' free' : '') + '"></i>';
    return '<span class="pat' + (cls ? ' ' + cls : '') + '">' + h + '</span>';
  };

  // The game's mark: a glossy ball with a star.
  var logoN = 0;
  F.logo = function () {
    var k = ++logoN;
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="fbg' + k + '" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#ff8fb3"/><stop offset=".55" stop-color="#ff3d7f"/><stop offset="1" stop-color="#8a0f3f"/></radialGradient><radialGradient id="fbh' + k + '" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="50" cy="50" r="47" fill="url(#fbg' + k + ')"/><circle cx="50" cy="50" r="30" fill="#fff6e8"/><text x="50" y="62" text-anchor="middle" font-family="Lilita One, Impact, sans-serif" font-size="34" fill="#8a0f3f">★</text><ellipse cx="34" cy="26" rx="16" ry="9" fill="url(#fbh' + k + ')" transform="rotate(-30 34 26)"/></svg>';
  };
  F.LOGO = F.logo();
})();
