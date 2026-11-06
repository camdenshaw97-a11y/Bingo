'use strict';
/*
 * Friend Bingo — the server.
 * One process holds every room in memory. The TV page creates a room, phones join it with a
 * 4-letter code, and the server is the single source of truth: it draws the balls, keeps every
 * card, judges every BINGO and pushes a fresh snapshot to every screen after each change.
 *
 * Built the same way as Friend Feud, Jeopardy, Wheel, Monopoly, Clue and Legendary Friends: the
 * same join flow, the same reconnect and restart-survival tricks, bots, private chat, late
 * jump-in. There is no host: the TV computer is the caller and every phone plays.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Bingo = require('./bingo');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const PAGE_FILES = new Set(['index.html', 'tv.html', 'common.js', 'bingo.js', 'style.css', 'lilita.woff2', 'nunito-400.woff2', 'nunito-700.woff2', 'nunito-900.woff2']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json'
};

// A fingerprint of the pages as they are right now, so a screen left open across an update reloads itself.
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'tv.html', 'common.js', 'bingo.js', 'style.css']) {
    try { h.update(fs.readFileSync(path.join(PUB, f))); } catch (e) { /* missing file: nothing to add */ }
  }
  return h.digest('hex').slice(0, 12);
})();

/* ---------------------------------------------------------------- rules */

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 1;
const BOT_NAMES = ['DOT', 'DAUBER', 'LUCKY', 'BINGO BOB', 'MARGE', 'ETHEL', 'CLYDE', 'PEARL', 'GUS', 'DOLLY', 'ROY', 'BETTY'];
const BOT_MS = 700;
const CARD_CHOICES = [1, 2, 3];
const PACE_CHOICES = [0, 4, 6, 8, 12];          // seconds between balls; 0 = the TV (or captain) calls the next one
const DAUB_CHOICES = ['tap', 'auto'];
const MAX_ROUNDS = 8;

const SPEED = Number(process.env.SPEED_UP) || 1;   // tests run the clocks faster
const INTRO_MS = 7000;
const FIRST_BALL_MS = 2600;
const CLAIM_MS = 4200;                     // a BINGO is being checked: a beat for the drum roll
const CLAIM_WINDOW_MS = 2500;              // after a good bingo, anyone else who shouts on the same ball shares it
const ROUND_MS = 11000;
const LOCKOUT_MS = 12000;                  // a false bingo keeps you quiet this long
const LAST_CALL_MS = 25000;                // every ball is out and nobody shouted: the round ends after this
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const BOOT = Date.now();
const RESTORE_WINDOW_MS = Number(process.env.RESTORE_WINDOW_MS) || 10 * 60 * 1000;
const RESTORE_GRACE_MS = 5000;
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 30000;
const STRAGGLER_MS = Number(process.env.STRAGGLER_MS) || 3 * 60 * 1000;
const BACKUP_V = 1;
const BACKUP_DELAY_MS = 200;
const BACKUP_MAX = 380 * 1024;
const BACKUP_KEY = (() => {
  let seed = process.env.BACKUP_KEY || process.env.RENDER_SERVICE_ID;
  if (!seed) {
    const file = path.join(__dirname, '.backup-key');
    try { seed = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first run */ }
    if (!seed) {
      seed = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(file, seed + '\n', { mode: 0o600 }); } catch (e) { /* read-only disk */ }
    }
  }
  return crypto.createHash('sha256').update('friend-bingo room backup|' + seed).digest();
})();

const DEFAULT_SETTINGS = { rounds: ['line', 'corners', 'x', 'blackout'], cards: 1, pace: 6, daub: 'tap', voice: true, pool: { kind: 'classic' } };
const rooms = new Map();

/* ------------------------------------------------------------------ http */

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/version') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(BUILD); }
  if (p === '/uptime') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('started ' + new Date(BOOT).toISOString() + ' · up ' + Math.round((Date.now() - BOOT) / 1000) + 's');
  }
  if (p === '/qr.svg') {
    const text = (u.searchParams.get('u') || '').slice(0, 300);
    return QRCode.toString(text || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }, (err, svg) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      res.end(svg);
    });
  }
  if (p === '/') p = '/index.html';
  if (p === '/tv') p = '/tv.html';
  const rel = p.replace(/^\/+/, '');
  if (!PAGE_FILES.has(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const file = path.join(PUB, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    if (ext === '.html') data = Buffer.from(String(data).replace('<html lang="en">', '<html lang="en" data-build="' + BUILD + '">'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache' });
    res.end(data);
  });
});

/* --------------------------------------------------------------- helpers */

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const pick = a => a[crypto.randomInt(a.length)];
const chance = p => crypto.randomInt(1000) < p * 1000;
const rand = () => crypto.randomInt(1 << 30) / (1 << 30);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function makeCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function cleanPool(p) {
  if (!p || typeof p !== 'object' || p.kind !== 'custom' || !Array.isArray(p.items)) return { kind: 'classic' };
  const seen = new Set(), items = [];
  for (const it of p.items) { const s = clean(it, 40); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); items.push(s); } if (items.length >= Bingo.MAX_CUSTOM) break; }
  if (items.length < Bingo.MIN_CUSTOM) return { kind: 'classic' };
  return { kind: 'custom', name: clean(p.name, 30) || 'My list', items };
}
function cleanSettings(s) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!s || typeof s !== 'object') return out;
  if (Array.isArray(s.rounds)) { const r = s.rounds.filter(id => Bingo.patternById(id)).slice(0, MAX_ROUNDS); if (r.length) out.rounds = r; }
  if (CARD_CHOICES.includes(s.cards)) out.cards = s.cards;
  if (PACE_CHOICES.includes(s.pace)) out.pace = s.pace;
  if (DAUB_CHOICES.includes(s.daub)) out.daub = s.daub;
  if (typeof s.voice === 'boolean') out.voice = s.voice;
  out.pool = cleanPool(s.pool);
  return out;
}

/* ----------------------------------------------------------------- rooms */

function newRoom() {
  const room = {
    code: makeCode(), adminToken: rid(), touched: Date.now(), displays: new Set(), players: new Map(),
    order: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), chats: {}, game: null, fx: [], fxSeq: 0, timer: null, botTimer: null
  };
  rooms.set(room.code, room);
  return room;
}
function fx(room, type, data) {
  room.fx.push(Object.assign({ seq: ++room.fxSeq, type }, data || {}));
  if (room.fx.length > 18) room.fx.shift();
}
const pname = (room, id) => { const p = room.players.get(id); return p ? p.name : '?'; };
const seats = room => room.order.filter(id => room.players.has(id));
const captainId = room => {
  const ids = seats(room).filter(id => !room.players.get(id).bot && !(room.game && room.game.players[id] && room.game.players[id].left));
  return ids.find(id => room.players.get(id).connected) || ids[0] || null;
};
function freeColor(room) {
  const used = new Set([...room.players.values()].filter(p => room.order.includes(p.id)).map(p => p.color));
  for (let k = 0; k < Bingo.PALETTE.length; k++) if (!used.has(k)) return k;
  return crypto.randomInt(Bingo.PALETTE.length);
}
const faceTaken = (room, f, except) => [...room.players.values()].some(x => x !== except && room.order.includes(x.id) && x.face === f);
function freeFace(room) { return Bingo.FACES.find(f => !faceTaken(room, f, null)) || pick(Bingo.FACES); }

/* ---------------------------------------------------- surviving a restart */

function packRoom(room, lean, kind) {
  const data = {
    v: BACKUP_V, at: Date.now(), kind: kind || 'backup', code: room.code, adminToken: room.adminToken,
    players: [...room.players.values()].map(p => ({ id: p.id, token: p.token, name: p.name, color: p.color, face: p.face, bot: !!p.bot })),
    order: room.order, settings: room.settings, chats: lean ? {} : room.chats, game: room.game, fxSeq: room.fxSeq
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
  const body = Buffer.concat([c.update(zlib.deflateRawSync(JSON.stringify(data))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unpackRoom(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 30) throw new Error('too short');
  const d = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return JSON.parse(zlib.inflateRawSync(body, { maxOutputLength: 16 * 1024 * 1024 }));
}
function sendBackup(room) {
  if (rooms.get(room.code) !== room) return;
  const to = [...room.displays].filter(ws => ws.admin && ws.readyState === 1);
  if (!to.length) return;
  let blob;
  try { blob = packRoom(room, false); } catch (e) { return console.error('backup error', e); }
  if (blob.length > BACKUP_MAX) return;
  const msg = JSON.stringify({ t: 'backup', code: room.code, blob, info: saveInfo(room) });
  for (const ws of to) ws.send(msg);
}
function queueBackup(room) {
  if (room.backupTimer) return;
  room.backupTimer = setTimeout(() => { room.backupTimer = null; sendBackup(room); }, BACKUP_DELAY_MS);
}
function saveInfo(room) {
  const g = room.game;
  return { at: Date.now(), players: seats(room).map(id => pname(room, id)), phase: g ? g.phase : 'lobby', round: g ? (g.ri + 1) + ' of ' + g.rounds.length : '' };
}
function hydrateRoom(d, code, opts) {
  const room = {
    code, adminToken: opts.adminToken, touched: Date.now(), displays: new Set(), players: new Map(), order: d.order || [],
    settings: cleanSettings(d.settings), chats: d.chats && typeof d.chats === 'object' ? d.chats : {}, game: d.game, fx: [], fxSeq: (d.fxSeq || 0) + 50, timer: null, botTimer: null
  };
  const hold = Date.now() + SEAT_HOLD_MS;
  for (const p of d.players) {
    if (p.bot) room.players.set(p.id, { id: p.id, token: p.token, name: p.name, color: p.color, face: p.face, bot: true, connected: true, ws: null, hold: 0, goneAt: 0 });
    else room.players.set(p.id, { id: p.id, token: p.token, name: p.name, color: p.color, face: p.face, connected: false, ws: null, hold, goneAt: Date.now(), waitingFor: true });
  }
  const g = room.game;
  if (g && g.clock) {
    const used = Math.max(0, Math.min(Number(opts.idle) || 0, 10 * 60 * 1000));
    g.clock.at = Date.now() + Math.max(0, g.clock.at - d.at - used) + RESTORE_GRACE_MS;
  }
  return room;
}
function restoreRoom(blob, code, token, idle) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || d.code !== code || !token || d.adminToken !== token) return null;
  if (!(Date.now() - d.at < ROOM_IDLE_MS) || rooms.has(code)) return null;
  const room = hydrateRoom(d, code, { adminToken: d.adminToken, idle });
  try { publicState(room); } catch (e) { console.error('restore error', e); return null; }
  rooms.set(code, room);
  armTimer(room); scheduleBots(room);
  room.tidyTimer = setTimeout(() => {
    room.tidyTimer = null;
    if (rooms.get(code) !== room || room.game) return;
    let gone = 0;
    for (const p of [...room.players.values()]) if (!p.connected && !room.order.includes(p.id)) { room.players.delete(p.id); gone++; }
    if (gone) pushAll(room);
  }, STRAGGLER_MS);
  fx(room, 'restored');
  console.log('restored room ' + code + ' (' + room.players.size + ' players, ' + (room.game ? room.game.phase : 'lobby') + ')');
  return room;
}

/* ------------------------------------------------------------ the clock */

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function setClock(room, what, ms, show) {
  ms = Math.round(ms / SPEED);
  room.game.clock = { what, at: Date.now() + ms, len: ms, show: !!show };
  armTimer(room);
}
function stopClock(room) { if (room.game) room.game.clock = null; clearTimer(room); }
function armTimer(room) {
  clearTimer(room);
  const g = room.game;
  if (!g || !g.clock) return;
  const c = g.clock;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== g || g.clock !== c) return;
    g.clock = null;
    try { onClock(room, c.what); } catch (e) { console.error('clock error', e); }
    pushAll(room);
  }, Math.max(0, c.at - Date.now()));
}
function onClock(room, what) {
  switch (what) {
    case 'intro': startCalling(room); break;
    case 'ball': callBall(room); break;
    case 'lastCall': endRound(room); break;
    case 'claim': endRound(room); break;
    case 'round': nextRound(room); break;
  }
}

/* ------------------------------------------------------------ the game */

const P = (g, id) => g.players[id];
const inGame = g => g.order.filter(id => g.players[id] && !g.players[id].left);
const patternOf = g => Bingo.patternById(g.pattern);

function log(room, text, kind, data) {
  const g = room.game;
  g.log.push(Object.assign({ n: ++g.logSeq, text, kind: kind || '' }, data || {}));
  if (g.log.length > 60) g.log.shift();
}

function newPlayer(room, id) {
  return {
    cards: [], daubs: [], points: 0, wins: [], left: false, lockedUntil: 0, claimedAt: 0,
    stats: { daubs: 0, falses: 0, bingos: 0, fastest: null, oneAway: 0, shared: 0 }
  };
}
// Fresh cards for a round. In auto mode, anything already called is daubed.
function dealCards(g, id) {
  const me = P(g, id);
  me.cards = []; me.daubs = []; me.claimedAt = 0; me.lockedUntil = 0; me.botBingoAt = 0; me.botFalse = false;
  const keys = new Set();
  for (let k = 0; k < g.cards; k++) {
    let card;
    for (let guard = 0; guard < 20; guard++) { card = Bingo.makeCard(g.pool, rand); if (!keys.has(Bingo.cardKey(card))) break; }
    keys.add(Bingo.cardKey(card));
    me.cards.push(card);
    const d = new Array(25).fill(false);
    d[12] = true;
    if (g.daub === 'auto') for (let s = 0; s < 25; s++) if (g.calledSet[card[s]]) d[s] = true;
    me.daubs.push(d);
  }
}

function startGame(room) {
  const ids = seats(room);
  if (ids.length < MIN_PLAYERS || ids.length > MAX_PLAYERS) return;
  const s = room.settings;
  const players = {};
  for (const id of ids) players[id] = newPlayer(room, id);
  room.game = {
    phase: 'intro', started: Date.now(), played: 0,
    rounds: s.rounds.slice(), ri: 0, pattern: s.rounds[0], pool: s.pool, cards: s.cards, pace: s.pace, daub: s.daub, voice: s.voice,
    order: ids.slice(), players, called: [], calledSet: {}, lastBallAt: 0, paused: false,
    claim: null, round: null, history: [], log: [], logSeq: 0, clock: null, awards: null, champions: null
  };
  beginRound(room);
  fx(room, 'start');
}
function beginRound(room) {
  const g = room.game;
  g.phase = 'intro';
  g.pattern = g.rounds[g.ri];
  g.called = []; g.calledSet = {}; g.lastBallAt = 0; g.claim = null; g.round = null; g.paused = false;
  g.bag = shuffle(Array.from({ length: Bingo.poolSize(g.pool) }, (_, i) => i + 1));
  for (const id of inGame(g)) dealCards(g, id);
  log(room, 'Round ' + (g.ri + 1) + ': ' + patternOf(g).name + '.', 'round');
  fx(room, 'round', { ri: g.ri, pattern: g.pattern });
  setClock(room, 'intro', INTRO_MS);
}
function startCalling(room) {
  const g = room.game;
  if (g.phase !== 'intro') return;
  g.phase = 'play';
  fx(room, 'play');
  if (g.pace) setClock(room, 'ball', FIRST_BALL_MS, true);
}
function skipIntro(room) {
  const g = room.game;
  if (g && g.phase === 'intro') { stopClock(room); startCalling(room); }
}
function armBall(room) {
  const g = room.game;
  if (g.phase !== 'play' || g.paused) return;
  if (!g.bag.length) { setClock(room, 'lastCall', LAST_CALL_MS, true); return; }
  if (g.pace) setClock(room, 'ball', g.pace * 1000, true);
}
function callBall(room) {
  const g = room.game;
  if (g.phase !== 'play' || g.paused || !g.bag.length) return;
  const id = g.bag.pop();
  g.called.push(id); g.calledSet[id] = true; g.lastBallAt = Date.now();
  if (g.daub === 'auto') {
    for (const pid of inGame(g)) {
      const me = P(g, pid);
      me.cards.forEach((card, k) => { for (let s = 0; s < 25; s++) if (card[s] === id) me.daubs[k][s] = true; });
    }
  }
  fx(room, 'ball', { id, n: g.called.length, call: Bingo.callOf(g.pool, id) });
  armBall(room);
}
// Call the next ball now. While paused this steps one ball at a time; otherwise the clock restarts.
function nextBall(room) {
  const g = room.game;
  if (!g || g.phase !== 'play') return;
  stopClock(room);
  if (g.paused) { g.paused = false; callBall(room); g.paused = true; stopClock(room); }
  else callBall(room);
}
function pause(room, on) {
  const g = room.game;
  if (!g || g.phase !== 'play') return;
  if (on === g.paused) return;
  g.paused = on;
  if (on) { stopClock(room); fx(room, 'pause'); }
  else { fx(room, 'resume'); if (g.pace) setClock(room, 'ball', Math.max(1500, g.pace * 500), true); else armBall(room); }
}

/* -------- daubs and claims */

function daub(room, p, m) {
  const g = room.game, me = P(g, p.id);
  if (!me || me.left || g.phase !== 'play' && g.phase !== 'claim') return;
  const k = Number(m.k), s = Number(m.s);
  if (!(k >= 0 && k < me.cards.length) || !(s >= 0 && s < 25)) return;
  const id = me.cards[k][s];
  if (me.daubs[k][s]) return;
  if (id !== Bingo.FREE && !g.calledSet[id]) { send(p.ws, { t: 'nope', k, s }); return; }
  me.daubs[k][s] = true;
  me.stats.daubs++;
  send(p.ws, { t: 'daubed', k, s });
}
// What a card looks like to the judge: in tap mode only daubed squares count, in auto mode every called one.
function marked(g, me, k) { return Bingo.markedSquares(me.cards[k], g.calledSet, g.daub === 'tap' ? me.daubs[k] : null); }
function bestCard(g, me) {
  const pat = patternOf(g);
  let best = null;
  me.cards.forEach((card, k) => {
    const d = Bingo.distance(pat, marked(g, me, k));
    if (!best || d.away < best.away) best = { k, away: d.away, way: d.way, missing: d.missing };
  });
  return best || { k: 0, away: 25, way: [], missing: [] };
}
function claim(room, p) {
  const g = room.game, me = P(g, p.id);
  if (!me || me.left) return;
  if (g.phase !== 'play' && g.phase !== 'claim') return;
  if (me.claimedAt) return;
  const now = Date.now();
  if (me.lockedUntil > now) return;
  if (g.phase === 'claim' && now - g.claim.at > CLAIM_WINDOW_MS / SPEED) return;   // too late for this ball
  const best = bestCard(g, me);
  if (best.away > 0) {
    // Not a bingo. Everyone gets to see it.
    me.lockedUntil = now + Math.round(LOCKOUT_MS / SPEED);
    me.stats.falses++;
    log(room, pname(room, p.id) + ' shouts BINGO… and it isn’t one.', 'false');
    fx(room, 'falseBingo', { pid: p.id, away: best.away });
    return;
  }
  me.claimedAt = now;
  me.stats.bingos++;
  const latency = now - g.lastBallAt;
  if (me.stats.fastest == null || latency < me.stats.fastest) me.stats.fastest = latency;
  if (g.phase === 'play') {
    g.phase = 'claim';
    g.claim = { at: now, ball: g.called[g.called.length - 1] || null, pids: [p.id], cards: {} };
    stopClock(room);
    setClock(room, 'claim', CLAIM_MS);
    log(room, pname(room, p.id) + ' shouts BINGO!', 'bingo');
    fx(room, 'bingo', { pid: p.id, k: best.k });
  } else {
    g.claim.pids.push(p.id);
    log(room, pname(room, p.id) + ' shouts BINGO too!', 'bingo');
    fx(room, 'bingo', { pid: p.id, k: best.k, shared: true });
  }
  g.claim.cards[p.id] = { k: best.k, way: best.way };
}
function endRound(room) {
  const g = room.game;
  if (g.phase !== 'play' && g.phase !== 'claim') return;
  stopClock(room);
  const pat = patternOf(g);
  const winners = g.claim ? g.claim.pids.slice() : [];
  const results = {};
  for (const id of inGame(g)) {
    const me = P(g, id), best = bestCard(g, me);
    results[id] = { k: best.k, away: best.away, way: best.way, won: winners.includes(id) };
    if (!winners.includes(id) && best.away === 1) me.stats.oneAway++;
  }
  for (const id of winners) {
    const me = P(g, id);
    me.points += pat.points; me.wins.push(g.ri);
    if (winners.length > 1) me.stats.shared++;
    results[id].card = me.cards[results[id].k];
    results[id].daubs = me.daubs[results[id].k];
  }
  g.round = { ri: g.ri, pattern: g.pattern, winners, balls: g.called.length, points: pat.points, results, ball: g.claim ? g.claim.ball : null };
  g.history.push({ ri: g.ri, pattern: g.pattern, winners, balls: g.called.length });
  g.claim = null;
  g.phase = 'roundOver';
  log(room, winners.length ? winners.map(id => pname(room, id)).join(' & ') + (winners.length > 1 ? ' share ' : ' takes ') + 'round ' + (g.ri + 1) + ' on ball ' + g.called.length + '.' : 'Nobody called it. Round ' + (g.ri + 1) + ' goes unclaimed.', 'roundOver');
  fx(room, 'roundOver', { winners, ri: g.ri });
  setClock(room, 'round', ROUND_MS);
}
function nextRound(room) {
  const g = room.game;
  if (g.phase !== 'roundOver') return;
  if (g.ri + 1 >= g.rounds.length) return endGame(room);
  g.ri++;
  beginRound(room);
}
function skip(room) {
  const g = room.game;
  if (!g) return;
  if (g.phase === 'intro') skipIntro(room);
  else if (g.phase === 'roundOver') { stopClock(room); nextRound(room); }
  else if (g.phase === 'claim') { stopClock(room); endRound(room); }
}

/* -------- the end */

function endGame(room, why) {
  const g = room.game;
  stopClock(room);
  g.phase = 'gameOver';
  g.played = Date.now() - g.started;
  g.why = why || 'done';
  const ids = inGame(g);
  const top = Math.max(0, ...ids.map(id => P(g, id).points));
  g.champions = top > 0 ? ids.filter(id => P(g, id).points === top) : [];
  g.awards = awards(room);
  log(room, g.champions.length ? g.champions.map(id => pname(room, id)).join(' & ') + (g.champions.length > 1 ? ' are the champions!' : ' is the champion!') : 'No champion tonight.', 'end');
  fx(room, 'gameOver');
}
function awards(room) {
  const g = room.game, ids = inGame(g), out = [];
  const st = id => P(g, id).stats;
  const most = (key, min, title, blurb) => {
    let best = null;
    for (const id of ids) if (st(id)[key] >= min && (!best || st(id)[key] > st(best)[key])) best = id;
    if (best) out.push({ id: best, title, blurb: blurb(st(best)[key]) });
  };
  let fast = null;
  for (const id of ids) if (st(id).fastest != null && (!fast || st(id).fastest < st(fast).fastest)) fast = id;
  if (fast) out.push({ id: fast, title: 'FASTEST FINGER', blurb: 'Shouted ' + (st(fast).fastest / 1000).toFixed(1) + ' s after the ball' });
  most('falses', 1, 'FALSE ALARM', n => n + ' bingo' + (n === 1 ? '' : 's') + ' that weren’t');
  most('oneAway', 1, 'HEARTBREAKER', n => 'One square away, ' + n + ' time' + (n === 1 ? '' : 's'));
  if (g.daub === 'tap') most('daubs', 20, 'DAUB MACHINE', n => n + ' daubs');
  most('shared', 1, 'GOOD SPORT', n => 'Shared the win ' + n + ' time' + (n === 1 ? '' : 's'));
  return out.slice(0, 4);
}

/* -------- private messages between two phones */

const chatKey = (a, b) => [a, b].sort().join('|');
function chat(room, p, m) {
  const to = String(m.to || ''), other = room.players.get(to);
  if (!other || other === p || other.bot) return;
  const text = clean(m.text, 240);
  if (!text) return;
  const k = chatKey(p.id, to);
  const list = room.chats[k] || (room.chats[k] = []);
  list.push({ from: p.id, text, at: Date.now() });
  if (list.length > 60) list.shift();
}
function chatsFor(room, pid) {
  const out = {};
  for (const k of Object.keys(room.chats)) {
    const [a, b] = k.split('|');
    if (a === pid || b === pid) out[a === pid ? b : a] = room.chats[k];
  }
  return out;
}

/* -------- bots */

function addBot(room) {
  if (seats(room).length >= MAX_PLAYERS) return;
  const used = new Set([...room.players.values()].map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || ('BOT ' + crypto.randomInt(100, 999));
  const p = { id: rid(6), token: rid(), name, color: freeColor(room), face: freeFace(room), bot: true, connected: true, ws: null, hold: 0, goneAt: 0 };
  room.players.set(p.id, p);
  room.order.push(p.id);
  const g = room.game;
  if (g) { g.players[p.id] = newPlayer(room, p.id); g.order.push(p.id); dealCards(g, p.id); log(room, name + ' pulls up a chair.', 'join'); }
  fx(room, 'joined', { name: p.name, pid: p.id, bot: true });
}
const isBot = (room, id) => { const p = room.players.get(id); return !!(p && p.bot); };
const nerve = (id, salt) => (crypto.createHash('sha1').update(id + '|' + (salt || '')).digest()[0] / 255);

function botHasWork(room) {
  const g = room.game;
  if (!g || (g.phase !== 'play' && g.phase !== 'claim')) return false;
  return inGame(g).some(id => isBot(room, id));
}
function scheduleBots(room) {
  if (room.botTimer || !botHasWork(room)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (rooms.get(room.code) !== room) return;
    let changed = false;
    try { changed = botTick(room); } catch (e) { console.error('bot error', e); }
    if (changed) pushAll(room); else scheduleBots(room);
  }, (BOT_MS + crypto.randomInt(900)) / SPEED);
}
function botTick(room) {
  const g = room.game;
  if (!g) return false;
  let changed = false;
  const now = Date.now();
  for (const id of inGame(g)) {
    if (!isBot(room, id)) continue;
    const p = room.players.get(id), me = P(g, id);
    if (me.claimedAt) continue;
    const speed = 0.4 + nerve(id, 'speed') * 0.6;     // how quick a dauber
    // Daub what's been called, one square at a time, a beat after the ball.
    if (g.daub === 'tap') {
      let did = false;
      me.cards.forEach((card, k) => {
        if (did) return;
        for (let s = 0; s < 25; s++) {
          if (me.daubs[k][s] || !g.calledSet[card[s]]) continue;
          const calledIdx = g.called.indexOf(card[s]);
          const age = (now - g.lastBallAt) + (g.called.length - 1 - calledIdx) * (g.pace ? g.pace * 1000 : 4000) / SPEED;
          if (age > (400 + 2200 * (1 - speed)) / SPEED) { me.daubs[k][s] = true; me.stats.daubs++; did = true; break; }
        }
      });
    }
    const best = bestCard(g, me);
    if (best.away === 0) {
      if (!me.botBingoAt) me.botBingoAt = now;
      else if (now - me.botBingoAt > (700 + 2600 * (1 - speed)) / SPEED) { claim(room, p); changed = true; }
    } else {
      me.botBingoAt = 0;
      // Once in a while a jumpy bot gets excited one square early (at most once a round).
      if (best.away === 1 && g.phase === 'play' && !me.botFalse && me.lockedUntil < now && nerve(id, 'jumpy') > 0.6 && chance(0.004)) { me.botFalse = true; claim(room, p); changed = true; }
    }
  }
  return changed;
}

/* ----------------------------------------------------- lobby and TV actions */

function adminAction(room, m) {
  const g = room.game;
  switch (m.a) {
    case 'start': if (!g) startGame(room); return;
    case 'again': if (g && g.phase === 'gameOver') { room.game = null; startGame(room); } return;
    case 'settings': if (!g) room.settings = cleanSettings(Object.assign({}, room.settings, m.settings || {})); return;
    case 'kick': { const x = room.players.get(m.id); if (x) dropPlayer(room, x, true); return; }
    case 'addBot': if (!g || g.phase !== 'gameOver') addBot(room); return;
    case 'removeBot': {
      if (g) return;
      const bots = seats(room).map(id => room.players.get(id)).filter(x => x.bot);
      const x = m.id ? room.players.get(m.id) : bots[bots.length - 1];
      if (x && x.bot) dropPlayer(room, x, true);
      return;
    }
    case 'lobby': if (g) { stopClock(room); room.game = null; fx(room, 'lobby'); } return;
    case 'endGame': if (g && g.phase !== 'gameOver') { if (g.phase === 'play' || g.phase === 'claim') endRound(room); endGame(room, 'early'); } return;
    case 'skipIntro': skipIntro(room); return;
    case 'skip': skip(room); return;
    case 'next': nextBall(room); return;
    case 'pause': pause(room, true); return;
    case 'resume': pause(room, false); return;
  }
}

/* ----------------------------------------------------------------- state */

function publicState(room) {
  const g = room.game;
  const pl = id => { const p = room.players.get(id); return p ? { id: p.id, name: p.name, on: p.connected, color: p.color, face: p.face, bot: !!p.bot } : null; };
  const s = {
    code: room.code, phase: g ? g.phase : 'lobby',
    players: (g ? g.order.filter(id => room.players.has(id)) : seats(room)).map(pl).filter(Boolean),
    captain: captainId(room), settings: room.settings,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, cardChoices: CARD_CHOICES, paceChoices: PACE_CHOICES, maxRounds: MAX_ROUNDS,
    fx: room.fx, game: null
  };
  if (g) {
    const players = {};
    for (const id of g.order) {
      const p = g.players[id];
      if (!p) continue;
      const best = (g.phase === 'play' || g.phase === 'claim') ? bestCard(g, p) : null;
      players[id] = { points: p.points, wins: p.wins, left: p.left, away: best ? best.away : null, claimed: !!p.claimedAt, locked: p.lockedUntil > Date.now(), stats: p.stats, cards: p.cards.length };
    }
    const last = g.called.length ? g.called[g.called.length - 1] : null;
    s.game = {
      rounds: g.rounds, ri: g.ri, pattern: g.pattern, pool: g.pool, cards: g.cards, pace: g.pace, daub: g.daub, voice: g.voice,
      order: g.order.filter(id => g.players[id]), players,
      called: g.called, last, left: g.bag ? g.bag.length : 0, paused: g.paused,
      claim: g.claim ? { pids: g.claim.pids, ball: g.claim.ball, cards: g.claim.cards } : null,
      round: g.round, history: g.history,
      clock: g.clock && g.clock.show ? { what: g.clock.what, left: Math.max(0, g.clock.at - Date.now()), len: g.clock.len } : null,
      elapsed: g.phase === 'gameOver' ? g.played : Date.now() - g.started,
      log: g.log.slice(-20), awards: g.awards || null, champions: g.champions || null
    };
    // Winners' cards are shown on the TV once the round is over, never during it.
    if (g.phase === 'claim' && g.claim) {
      s.game.claimCards = {};
      for (const id of g.claim.pids) { const me = P(g, id), c = g.claim.cards[id]; s.game.claimCards[id] = { card: me.cards[c.k], daubs: me.daubs[c.k], way: c.way }; }
    }
  }
  return s;
}
function stateFor(room, pub, p) {
  const s = Object.assign({}, pub);
  const g = room.game;
  const playing = g ? !!(g.players[p.id] && !g.players[p.id].left) : room.order.includes(p.id);
  s.me = { id: p.id, name: p.name, color: p.color, face: p.face, isCaptain: pub.captain === p.id, playing };
  s.me.chats = chatsFor(room, p.id);
  if (g && pub.game && pub.game.claimCards) s.game = Object.assign({}, pub.game, { claimCards: null });
  if (g && playing) {
    const me = g.players[p.id];
    s.me.cards = me.cards; s.me.daubs = me.daubs; s.me.points = me.points; s.me.wins = me.wins;
    s.me.lockedFor = Math.max(0, me.lockedUntil - Date.now());
    s.me.claimed = !!me.claimedAt;
    if (g.phase === 'play' || g.phase === 'claim') { const b = bestCard(g, me); s.me.best = { k: b.k, away: b.away, missing: b.missing }; }
    if (g.round && g.round.results[p.id]) s.me.result = g.round.results[p.id];
  }
  return s;
}
function pushDisplays(room) {
  if (!room.displays.size) return;
  const d = JSON.stringify({ t: 'state', s: Object.assign({}, publicState(room), { display: true }) });
  for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  queueBackup(room);
}
function pushAll(room) {
  room.touched = Date.now();
  const pub = publicState(room);
  if (room.displays.size) {
    const d = JSON.stringify({ t: 'state', s: Object.assign({}, pub, { display: true }) });
    for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  }
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'state', s: stateFor(room, pub, p) }));
  }
  queueBackup(room);
  scheduleBots(room);
}

/* -------------------------------------------------------------- messages */

function dropPlayer(room, p, kicked) {
  const g = room.game;
  const i = room.order.indexOf(p.id);
  if (g && g.players[p.id] && !g.players[p.id].left && g.phase !== 'gameOver') {
    const me = g.players[p.id];
    me.left = true;
    log(room, pname(room, p.id) + ' leaves the table.', 'left');
    fx(room, 'leftGame', { pid: p.id });
    if (g.claim && g.claim.pids.includes(p.id) && g.claim.pids.length === 1 && g.phase === 'claim') { g.claim = null; g.phase = 'play'; stopClock(room); armBall(room); }
    if (!inGame(g).length) { stopClock(room); room.game = null; fx(room, 'lobby'); }
  }
  if (!g && i >= 0) room.order.splice(i, 1);
  if (!g || !g.players[p.id]) room.players.delete(p.id);
  else if (!p.bot) p.connected = false;
  if (p.ws) { send(p.ws, { t: 'left', kicked: !!kicked }); p.ws.room = null; p.ws.pid = null; p.ws = null; }
  if (g && room.game === g && !g.order.some(id => room.players.has(id) && !room.players.get(id).bot && !g.players[id].left)) { stopClock(room); room.game = null; fx(room, 'lobby'); }
}
function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    send(p.ws, { t: 'left', replaced: true });
    p.ws.room = null; p.ws.pid = null;
    try { p.ws.close(); } catch (e) { /* ignore */ }
  }
  p.ws = ws; p.connected = true; p.hold = 0; p.goneAt = 0; p.waitingFor = false;
  ws.room = room; ws.pid = p.id;
}
const justStarted = () => Date.now() - BOOT < RESTORE_WINDOW_MS;
function showOn(ws, room, admin) {
  if (ws.display && ws.room && ws.room !== room) ws.room.displays.delete(ws);
  ws.room = room; ws.display = true; ws.admin = admin;
  room.displays.add(ws);
}

function onMessage(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return;

  if (m.t === 'create') {
    const room = newRoom();
    room.settings = cleanSettings(m.settings);
    showOn(ws, room, true);
    send(ws, { t: 'created', code: room.code, token: room.adminToken });
    return pushAll(room);
  }
  if (m.t === 'watch' || m.t === 'restore') {
    const code = clean(m.code, 4).toUpperCase();
    let room = rooms.get(code), restored = false;
    if (!room && m.t === 'restore' && typeof m.blob === 'string' && m.blob.length <= BACKUP_MAX) { room = restoreRoom(m.blob, code, m.token, m.idle); restored = !!room; }
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'That game is no longer running.', wait: m.t === 'watch' && justStarted() });
    showOn(ws, room, m.token === room.adminToken);
    send(ws, { t: 'watching', code: room.code, admin: ws.admin, restored });
    return pushAll(room);
  }
  if (m.t === 'join') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: "Can't find that room. Check the 4-letter code on the TV.", wait: justStarted() });
    const name = clean(m.name, 12).toUpperCase();
    if (!name) return send(ws, { t: 'error', msg: 'Enter your name.' });
    let p = [...room.players.values()].find(x => x.name === name);
    const g = room.game;
    if (p) {
      if (p.bot) return send(ws, { t: 'error', msg: name + ' is a bot’s name. Pick another name.' });
      if (p.connected) return send(ws, { t: 'error', msg: 'Someone is already playing as ' + name + '. Pick another name.' });
      if (p.hold && Date.now() < p.hold) return send(ws, { t: 'error', msg: name + ' is still reconnecting. Try again in a few seconds, or pick another name.' });
      p.token = rid();
      if (g && g.players[p.id] && g.players[p.id].left && g.phase !== 'gameOver') {
        g.players[p.id].left = false;
        if (!room.order.includes(p.id)) room.order.push(p.id);
        log(room, name + ' is back at the table.', 'join');
      }
    } else {
      if (room.order.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'This room is full: ' + MAX_PLAYERS + ' players.' });
      if (g && g.phase === 'gameOver') return send(ws, { t: 'error', msg: 'That game just ended. Join the next one from the TV.' });
      const want = String(m.face || '');
      p = { id: rid(6), token: rid(), name, color: freeColor(room), face: Bingo.FACES.includes(want) && !faceTaken(room, want, null) ? want : freeFace(room), connected: true, ws: null };
      room.players.set(p.id, p);
      room.order.push(p.id);
      if (g) {
        g.players[p.id] = newPlayer(room, p.id); g.order.push(p.id);
        if (g.phase !== 'gameOver') dealCards(g, p.id);
        log(room, name + ' pulls up a chair.', 'join');
      }
      fx(room, 'joined', { name: p.name, pid: p.id, late: !!g });
    }
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const p = room && [...room.players.values()].find(x => x.token === m.token);
    if (!p) return send(ws, { t: 'error', code: 'noroom', msg: 'That game has ended.', wait: !room && justStarted() });
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  const room = ws.room;
  if (!room) return;
  if (ws.display) {
    if (!ws.admin) return;
    if (m.t === 'h') { adminAction(room, m); return pushAll(room); }
    return;
  }
  const p = room.players.get(ws.pid);
  if (!p) return;
  const g = room.game;
  switch (m.t) {
    case 'face': {
      const f = String(m.f || '');
      if (!Bingo.FACES.includes(f)) break;
      if (faceTaken(room, f, p)) { send(ws, { t: 'error', msg: 'Someone already has that one.' }); break; }
      p.face = f;
      break;
    }
    case 'chat': chat(room, p, m); break;
    case 'h':
      if (captainId(room) !== p.id) break;
      if (['start', 'skipIntro', 'skip', 'next', 'pause', 'resume', 'again'].includes(m.a) || (m.a === 'lobby' && g && g.phase === 'gameOver')) adminAction(room, m);
      break;
    case 'daub': if (g) { daub(room, p, m); pushDisplays(room); } return;    // the phone is told directly; the TV sees "1 away" move
    case 'bingo': if (g) claim(room, p); break;
    case 'leave': dropPlayer(room, p, false); break;
    default: return;
  }
  pushAll(room);
}
function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.display) { room.displays.delete(ws); return; }
  const p = room.players.get(ws.pid);
  if (p && p.ws === ws) {
    p.connected = false; p.ws = null; p.goneAt = Date.now();
    if (!room.game) { const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1); room.players.delete(p.id); }
    pushAll(room);
  }
}

/* ------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { onMessage(ws, m); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error('close error', e); } });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) { clearTimer(room); clearTimeout(room.backupTimer); clearTimeout(room.tidyTimer); clearTimeout(room.botTimer); rooms.delete(code); }
  }
}, 30000).unref();
// The clock on the TV counts down on its own; a push every few seconds keeps every screen honest.
setInterval(() => {
  for (const room of rooms.values()) if (room.game && room.game.clock && room.game.clock.show && room.displays.size) {
    const d = JSON.stringify({ t: 'tick', left: Math.max(0, room.game.clock.at - Date.now()) });
    for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  }
}, 5000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Friend Bingo on port ' + PORT + ' (build ' + BUILD + ')'));
}
module.exports = { server, rooms, packRoom, restoreRoom, _t: { Bingo } };
