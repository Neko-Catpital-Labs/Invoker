/**
 * Botvillage MOBA canvas — 480×270 logical, nearest-neighbor upscale.
 * Exposes window.Botvillage.mount(root, options).
 */
(function (global) {
  'use strict';

  var W = 480;
  var H = 270;
  var CHATTER = [
    'on my way',
    'defending',
    'pushing',
    'warding',
    'farming',
    'reclaiming',
    'scouting',
  ];

  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function hourFromQuery(search) {
    try {
      var m = /(?:^|[?&])hour=(\d{1,2})/.exec(search || '');
      if (!m) return null;
      var n = parseInt(m[1], 10);
      return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
    } catch (_) {
      return null;
    }
  }

  function isNight(hour) {
    return hour < 6 || hour >= 20;
  }

  function Synth() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
  }
  Synth.prototype.ensure = function () {
    if (this.ctx || typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.started = true;
  };
  Synth.prototype.beep = function (freq, dur, type) {
    if (this.muted || !this.ctx) return;
    var t0 = this.ctx.currentTime;
    var o = this.ctx.createOscillator();
    var g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.04, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t0);
    o.stop(t0 + dur);
  };

  function layoutLandmarks(landmarks, heroes) {
    var pos = Object.create(null);
    pos['landmark:fountain'] = { x: W * 0.5, y: H * 0.52 };

    var outposts = landmarks.filter(function (l) { return l.kind === 'outpost'; });
    outposts.forEach(function (l, i) {
      var a = (i / Math.max(outposts.length, 1)) * Math.PI * 2 - Math.PI / 2;
      pos[l.id] = {
        x: W * 0.5 + Math.cos(a) * 150,
        y: H * 0.52 + Math.sin(a) * 70,
      };
    });

    var shops = landmarks.filter(function (l) { return l.kind === 'shop'; });
    shops.forEach(function (l, i) {
      pos[l.id] = { x: 40 + (i % 4) * 36, y: 36 + Math.floor(i / 4) * 28 };
    });

    var jungles = landmarks.filter(function (l) { return l.kind === 'jungle'; });
    jungles.forEach(function (l, i) {
      pos[l.id] = { x: W - 50 - (i % 3) * 40, y: 40 + Math.floor(i / 3) * 30 };
    });

    var pads = landmarks.filter(function (l) { return l.kind === 'pad'; });
    pads.forEach(function (l, i) {
      pos[l.id] = { x: 60 + (i % 5) * 40, y: H - 40 - Math.floor(i / 5) * 24 };
    });

    var barracks = landmarks.filter(function (l) { return l.kind === 'barracks'; });
    barracks.forEach(function (l, i) {
      var col = i % 6;
      var row = Math.floor(i / 6);
      pos[l.id] = { x: 70 + col * 60, y: 90 + row * 50 };
    });

    heroes.forEach(function (h, i) {
      if (!pos[h.barracksLandmarkId]) {
        pos[h.barracksLandmarkId] = { x: 70 + (i % 6) * 60, y: 90 + Math.floor(i / 6) * 50 };
      }
    });

    return pos;
  }

  function mount(root, options) {
    options = options || {};
    var hourOverride = options.hour != null ? options.hour : hourFromQuery(location.search);
    var synth = new Synth();
    var muted = false;

    root.innerHTML = '';
    root.classList.add('botvillage-root');
    root.style.overflow = 'hidden';
    root.style.position = 'relative';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.background = '#0b1220';
    root.style.userSelect = 'none';

    var stage = document.createElement('div');
    stage.className = 'botvillage-stage';
    stage.style.position = 'absolute';
    stage.style.inset = '0';
    stage.style.overflow = 'hidden';
    stage.style.display = 'flex';
    stage.style.alignItems = 'center';
    stage.style.justifyContent = 'center';
    root.appendChild(stage);

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.imageRendering = 'pixelated';
    canvas.style.imageRendering = 'crisp-edges';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.cursor = 'pointer';
    stage.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var card = document.createElement('div');
    card.className = 'botvillage-card';
    card.style.cssText = 'display:none;position:absolute;left:12px;bottom:12px;z-index:2;width:200px;padding:10px 12px;border-radius:10px;background:rgba(8,12,22,0.92);border:1px solid rgba(180,200,255,0.25);color:#e8eefc;font:12px/1.35 ui-sans-serif,system-ui,sans-serif;pointer-events:none;';
    root.appendChild(card);

    var hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;top:8px;right:10px;z-index:2;color:#9db0d0;font:11px ui-monospace,monospace;opacity:0.85;';
    hud.textContent = 'M mute';
    root.appendChild(hud);

    var world = options.world || { heroes: [], landmarks: [], trips: [], activeTripCount: 0, generatedAt: '' };
    var selectedKind = null;
    var units = [];
    var landmarkPos = Object.create(null);
    var bubbles = [];
    var lastTripKey = '';
    var raf = 0;
    var running = true;
    var lastTs = 0;

    function avatarColor(id) {
      return 'hsl(' + hashHue(id) + ' 55% 52%)';
    }

    function rebuildUnits() {
      landmarkPos = layoutLandmarks(world.landmarks || [], world.heroes || []);
      var next = [];
      var heroes = world.heroes || [];
      var trips = world.trips || [];

      heroes.forEach(function (hero) {
        var home = landmarkPos[hero.barracksLandmarkId] || { x: W / 2, y: H / 2 };
        var heroTrips = trips.filter(function (t) { return t.workerKind === hero.workerKind; });
        if (heroTrips.length === 0) {
          next.push({
            key: 'hero:' + hero.workerKind,
            workerKind: hero.workerKind,
            name: hero.name,
            title: hero.title,
            mood: hero.mood,
            goalWord: hero.goalWord,
            statusChip: hero.statusChip,
            illusion: false,
            x: home.x,
            y: home.y,
            tx: home.x,
            ty: home.y,
            hue: hashHue(hero.workerKind),
            bob: Math.random() * Math.PI * 2,
          });
          return;
        }
        heroTrips.forEach(function (trip, idx) {
          var dest = landmarkPos[trip.destLandmarkId] || home;
          var src = landmarkPos[trip.sourceLandmarkId] || home;
          var existing = units.find(function (u) { return u.key === 'trip:' + trip.id; });
          next.push({
            key: 'trip:' + trip.id,
            workerKind: hero.workerKind,
            name: hero.name,
            title: hero.title,
            mood: 'working',
            goalWord: trip.goalWord,
            statusChip: trip.status,
            illusion: true,
            x: existing ? existing.x : src.x,
            y: existing ? existing.y : src.y,
            tx: dest.x,
            ty: dest.y,
            hue: hashHue(hero.workerKind + ':' + idx),
            bob: Math.random() * Math.PI * 2,
          });
        });
      });

      // Player shopkeep at mid — never in roster
      next.push({
        key: 'player:you',
        workerKind: null,
        name: 'you',
        title: 'shopkeep',
        mood: 'idle',
        goalWord: 'watch',
        statusChip: 'you',
        illusion: false,
        player: true,
        x: W * 0.5,
        y: H * 0.58,
        tx: W * 0.5,
        ty: H * 0.58,
        hue: 32,
        bob: 0,
      });

      var tripKey = trips.map(function (t) { return t.id; }).sort().join('|');
      if (tripKey !== lastTripKey) {
        if (tripKey.length > lastTripKey.length) {
          synth.beep(520, 0.08, 'triangle');
          var chatter = CHATTER[Math.floor(Math.random() * CHATTER.length)];
          var walker = next.find(function (u) { return u.illusion; });
          if (walker) {
            bubbles.push({ x: walker.x, y: walker.y - 18, text: chatter, until: performance.now() + 1800 });
          }
        }
        lastTripKey = tripKey;
      }
      units = next;
      renderCard();
    }

    function renderCard() {
      if (!selectedKind) {
        card.style.display = 'none';
        return;
      }
      var hero = (world.heroes || []).find(function (h) { return h.workerKind === selectedKind; });
      var unit = units.find(function (u) { return u.workerKind === selectedKind; });
      if (!hero && !unit) {
        card.style.display = 'none';
        return;
      }
      var name = hero ? hero.name : unit.name;
      var title = hero ? hero.title : unit.title;
      var goal = hero ? hero.goalWord : unit.goalWord;
      var chip = hero ? hero.statusChip : unit.statusChip;
      card.style.display = 'block';
      card.innerHTML =
        '<div style="display:flex;gap:10px;align-items:center">' +
        '<div style="width:36px;height:36px;border-radius:8px;background:' + avatarColor(selectedKind) + ';image-rendering:pixelated"></div>' +
        '<div style="min-width:0">' +
        '<div style="font-weight:700;font-size:13px">' + escapeHtml(name) + '</div>' +
        '<div style="opacity:0.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(title) + '</div>' +
        '</div></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;align-items:center">' +
        '<span style="font-weight:700;font-size:11px;letter-spacing:0.04em">' + escapeHtml(goal) + '</span>' +
        '<span style="border:1px solid rgba(180,200,255,0.35);border-radius:999px;padding:1px 7px;font-size:10px">' + escapeHtml(chip) + '</span>' +
        '</div>';
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function drawNametag(c, x, y, text, night) {
      var label = String(text || '');
      c.save();
      c.font = 'bold 7px ui-monospace, monospace';
      var tw = c.measureText(label).width;
      var pw = tw + 6;
      var ph = 9;
      var px = Math.round(x - pw / 2);
      var py = Math.round(y - 18);
      c.fillStyle = night ? 'rgba(10,14,24,0.85)' : 'rgba(20,24,36,0.8)';
      roundRect(c, px, py, pw, ph, 3);
      c.fill();
      c.fillStyle = '#f4f7ff';
      c.textBaseline = 'middle';
      c.fillText(label, Math.round(x - tw / 2), py + ph / 2 + 0.5);
      c.restore();
    }

    function drawBubble(c, x, y, text) {
      c.save();
      c.font = 'bold 8px Trebuchet MS, Comic Sans MS, sans-serif';
      var tw = c.measureText(text).width;
      var pw = tw + 8;
      var ph = 12;
      var px = Math.round(x - pw / 2);
      var py = Math.round(y - 30);
      c.fillStyle = 'rgba(245,248,255,0.95)';
      roundRect(c, px, py, pw, ph, 4);
      c.fill();
      c.beginPath();
      c.moveTo(x - 3, py + ph);
      c.lineTo(x + 3, py + ph);
      c.lineTo(x, py + ph + 4);
      c.closePath();
      c.fill();
      c.fillStyle = '#1a2233';
      c.textBaseline = 'middle';
      c.fillText(text, Math.round(x - tw / 2), py + ph / 2);
      c.restore();
    }

    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function drawLandmark(c, landmark, p, night) {
      var x = Math.round(p.x);
      var y = Math.round(p.y);
      if (landmark.kind === 'fountain') {
        c.fillStyle = night ? '#3a6a9a' : '#5aa0d8';
        c.beginPath();
        c.arc(x, y, 10, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = night ? '#1e3a55' : '#2f6a9a';
        c.fillRect(x - 8, y + 2, 16, 5);
      } else if (landmark.kind === 'outpost') {
        c.fillStyle = night ? '#6a4a2a' : '#a87840';
        c.fillRect(x - 7, y - 4, 14, 10);
        c.fillStyle = night ? '#3a2818' : '#6a4420';
        c.fillRect(x - 2, y - 10, 4, 6);
      } else if (landmark.kind === 'shop') {
        c.fillStyle = night ? '#5a3a6a' : '#8a60a8';
        c.fillRect(x - 6, y - 5, 12, 10);
        c.fillStyle = '#d8b060';
        c.fillRect(x - 7, y - 8, 14, 3);
      } else if (landmark.kind === 'jungle') {
        c.fillStyle = night ? '#1e4a2a' : '#2f7a40';
        c.beginPath();
        c.moveTo(x, y - 10);
        c.lineTo(x + 8, y + 4);
        c.lineTo(x - 8, y + 4);
        c.closePath();
        c.fill();
      } else if (landmark.kind === 'barracks') {
        c.fillStyle = night ? '#3a4258' : '#6a7488';
        c.fillRect(x - 9, y - 6, 18, 12);
        c.fillStyle = night ? '#252b38' : '#444c5c';
        c.fillRect(x - 10, y - 9, 20, 3);
      } else {
        c.fillStyle = night ? '#4a5060' : '#8890a0';
        c.fillRect(x - 5, y - 3, 10, 7);
      }
    }

    function drawUnit(c, u, night, t) {
      var bob = Math.sin(t * 0.006 + u.bob) * (u.mood === 'working' ? 1.4 : 0.6);
      var x = Math.round(u.x);
      var y = Math.round(u.y + bob);
      if (u.player) {
        // shopkeep apron silhouette
        c.fillStyle = '#c4a574';
        c.fillRect(x - 4, y - 8, 8, 6);
        c.fillStyle = '#5a3a28';
        c.fillRect(x - 5, y - 2, 10, 8);
        c.fillStyle = '#e8d2a8';
        c.fillRect(x - 3, y - 11, 6, 4);
        drawNametag(c, x, y - 4, 'you', night);
        return;
      }
      var body = 'hsl(' + u.hue + ' 50% ' + (night ? '42%' : '55%') + ')';
      c.globalAlpha = u.illusion ? 0.72 : 1;
      c.fillStyle = body;
      c.fillRect(x - 4, y - 7, 8, 9);
      c.fillStyle = 'hsl(' + ((u.hue + 40) % 360) + ' 45% 70%)';
      c.fillRect(x - 3, y - 11, 6, 4);
      if (u.mood === 'working') {
        c.fillStyle = '#f0d060';
        c.fillRect(x + 5, y - 6, 3, 3);
      }
      if (u.mood === 'sleep') {
        c.fillStyle = '#d0e0ff';
        c.font = 'bold 8px Trebuchet MS, sans-serif';
        c.fillText('Zzz', x + 6, y - 12);
      }
      c.globalAlpha = 1;
      drawNametag(c, x, y - 4, u.name, night);
    }

    function draw(ts) {
      if (!running) return;
      var dt = lastTs ? Math.min(32, ts - lastTs) : 16;
      lastTs = ts;
      var hour = hourOverride != null ? hourOverride : new Date().getHours();
      var night = isNight(hour);

      units.forEach(function (u) {
        if (u.player) return;
        var speed = u.illusion ? 0.045 : 0.02;
        u.x = lerp(u.x, u.tx, 1 - Math.pow(1 - speed, dt));
        u.y = lerp(u.y, u.ty, 1 - Math.pow(1 - speed, dt));
      });

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = night ? '#0c1424' : '#1a2a1c';
      ctx.fillRect(0, 0, W, H);

      // lanes / river
      ctx.strokeStyle = night ? '#1e2a40' : '#2a4030';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(20, 30);
      ctx.lineTo(W - 20, H - 30);
      ctx.moveTo(W - 20, 30);
      ctx.lineTo(20, H - 30);
      ctx.stroke();
      ctx.fillStyle = night ? '#16304a' : '#3a6a88';
      ctx.fillRect(0, Math.round(H * 0.48), W, 14);

      (world.landmarks || []).forEach(function (l) {
        var p = landmarkPos[l.id];
        if (p) drawLandmark(ctx, l, p, night);
      });

      units.forEach(function (u) { drawUnit(ctx, u, night, ts); });

      bubbles = bubbles.filter(function (b) { return b.until > ts; });
      bubbles.forEach(function (b) { drawBubble(ctx, b.x, b.y, b.text); });

      raf = requestAnimationFrame(draw);
    }

    function canvasPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      var scale = Math.min(rect.width / W, rect.height / H);
      var ox = (rect.width - W * scale) / 2;
      var oy = (rect.height - H * scale) / 2;
      return {
        x: (ev.clientX - rect.left - ox) / scale,
        y: (ev.clientY - rect.top - oy) / scale,
      };
    }

    function onClick(ev) {
      synth.ensure();
      var p = canvasPoint(ev);
      var hit = null;
      var best = 14;
      units.forEach(function (u) {
        if (u.player) return;
        var d = Math.hypot(u.x - p.x, u.y - p.y);
        if (d < best) {
          best = d;
          hit = u;
        }
      });
      selectedKind = hit ? hit.workerKind : null;
      if (options.onSelect) options.onSelect(selectedKind);
      renderCard();
      if (hit) synth.beep(660, 0.05, 'square');
    }

    function onKey(ev) {
      if (ev.key === 'm' || ev.key === 'M') {
        muted = !muted;
        synth.muted = muted;
        hud.textContent = muted ? 'M unmute' : 'M mute';
      }
    }

    canvas.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    rebuildUnits();
    raf = requestAnimationFrame(draw);

    return {
      setWorld: function (next) {
        world = next || world;
        rebuildUnits();
      },
      setHour: function (h) {
        hourOverride = h;
      },
      select: function (kind) {
        selectedKind = kind;
        renderCard();
      },
      destroy: function () {
        running = false;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('click', onClick);
        window.removeEventListener('keydown', onKey);
        root.innerHTML = '';
      },
    };
  }

  global.Botvillage = { mount: mount, VIEW_W: W, VIEW_H: H };
})(typeof window !== 'undefined' ? window : globalThis);
