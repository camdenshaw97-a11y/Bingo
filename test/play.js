'use strict';
/*
 * Plays whole games against a real server with scripted screens: a TV and phones that join, pick
 * faces, daub, shout false bingos and real ones, share a win, and survive the server forgetting
 * the room. Then bots play a whole night by themselves, once with numbers and once with a list.
 * The clocks run 25 times faster than in a real game.   Run with: npm test
 */
process.env.RESTORE_WINDOW_MS = '600000';
process.env.SPEED_UP = '25';
const WebSocket = require('ws');
const { server, rooms, packRoom, restoreRoom, _t } = require('../server');
const { Bingo: B } = _t;

const PORT = 3998;
let failures = 0, passes = 0;
function check(name, ok, extra) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

class Screen {
  constructor(name) {
    this.name = name; this.state = null; this.last = {}; this.errors = []; this.msgs = []; this.leaks = [];
    this.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    this.ready = new Promise(res => this.ws.on('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'state') { this.state = m.s; this.audit(m.s); }
      if (m.t === 'error') this.errors.push(m.msg);
      this.msgs.push(m);
      this.last[m.t] = m;
    });
  }
  // A phone must never be sent another phone's cards, and nobody sees the bag of balls still to come.
  audit(s) {
    const g = s.game;
    if (!g) return;
    if (g.bag) this.leaks.push('the bag');
    if (s.me && g.players) for (const id of Object.keys(g.players)) if (g.players[id].cards && Array.isArray(g.players[id].cards)) this.leaks.push('cards of ' + id);
    if (s.me && g.phase === 'play' && g.claimCards) this.leaks.push('claim cards during play');
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(fn, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn(this.state, this.last)) return true; } catch (e) { /* not yet */ } await wait(8); }
    return false;
  }
  close() { this.ws.close(); }
}
const roomOf = tv => rooms.get(tv.state.code);
const G = tv => roomOf(tv).game;
async function phase(tv, p, ms = 8000) { return tv.until(s => s.phase === p, ms); }

function cardOk(pool, card) {
  if (card.length !== 25 || card[12] !== B.FREE) return false;
  const seen = new Set();
  for (let s = 0; s < 25; s++) {
    if (s === 12) continue;
    const id = card[s], c = s % 5;
    if (seen.has(id) || B.colOf(pool, id) !== c) return false;
    seen.add(id);
  }
  return true;
}

async function main() {
  /* ---------------------------------------------------- the rules */
  const classic = { kind: 'classic' };
  check('eleven patterns, each with a name, points and a picture', B.PATTERNS.length === 11 && B.PATTERNS.every(p => p.name && p.points >= 1 && p.demo && p.demo.length));
  let good = 0;
  for (let i = 0; i < 200; i++) if (cardOk(classic, B.makeCard(classic, Math.random))) good++;
  check('200 classic cards: free centre, five per column, no repeats', good === 200);
  const custom = { kind: 'custom', name: 'test', items: Array.from({ length: 33 }, (_, i) => 'thing ' + i) };
  good = 0;
  for (let i = 0; i < 100; i++) if (cardOk(custom, B.makeCard(custom, Math.random))) good++;
  check('100 cards from a 33-item list: columns split evenly enough', good === 100 && [0, 1, 2, 3, 4].every(c => B.idsInCol(custom, c).length >= 6));
  check('a ball reads as its letter and number', B.callOf(classic, 1) === 'B 1' && B.callOf(classic, 75) === 'O 75' && B.callOf(classic, 40) === 'N 40');
  {
    const card = B.makeCard(classic, Math.random), called = {};
    [0, 1, 2, 3, 4].forEach(s => { called[card[s]] = true; });
    const m = B.markedSquares(card, called, null);
    check('a called top row is a line and a 3-away two-lines', B.distance(B.patternById('line'), m).away === 0 && B.distance(B.patternById('two'), m).away === 3);
    check('four corners counts the free space as nothing', B.distance(B.patternById('corners'), B.markedSquares(card, {}, null)).away === 4);
    check('the X counts the free space', B.distance(B.patternById('x'), B.markedSquares(card, {}, null)).away === 8);
    const daubs = new Array(25).fill(false); daubs[12] = true; daubs[0] = true;
    check('in tap mode only daubed squares count (corner plus free space: a diagonal 3 away)', B.distance(B.patternById('line'), B.markedSquares(card, called, daubs)).away === 3);
  }

  await new Promise(res => server.listen(PORT, res));

  /* ---------------------------------------------------- a scripted night */
  const tv = new Screen('tv');
  await tv.ready;
  tv.send({ t: 'create' });
  await tv.until(s => s && s.code);
  tv.send({ t: 'h', a: 'settings', settings: { rounds: ['line', 'corners'], cards: 2, pace: 4, daub: 'tap', voice: false, pool: { kind: 'custom', items: ['too', 'short'] } } });
  await tv.until(s => s.settings.rounds.length === 2);
  check('the TV sets the night: two rounds, two cards, a ball every 4 s', tv.state.settings.cards === 2 && tv.state.settings.pace === 4 && tv.state.settings.daub === 'tap');
  check('a list that is too short falls back to the classic balls', tv.state.settings.pool.kind === 'classic');

  const names = ['AMY', 'BEN', 'CAM'];
  const ph = [];
  for (const n of names) { const p = new Screen(n); await p.ready; p.send({ t: 'join', code: tv.state.code, name: n }); ph.push(p); }
  await tv.until(s => s.players.length === 3);
  await Promise.all(ph.map(p => p.until(s => s && s.me)));
  check('three phones join with faces and colours of their own', tv.state.players.length === 3 && new Set(tv.state.players.map(p => p.face)).size === 3 && new Set(tv.state.players.map(p => p.color)).size === 3);
  check('the first phone in is the captain', tv.state.captain === ph[0].state.me.id && ph[0].state.me.isCaptain);
  ph[1].send({ t: 'face', f: B.FACES[0] });
  await wait(100);
  check('a face someone else has is refused', ph[1].errors.length === 1 && tv.state.players[1].face !== B.FACES[0]);
  ph[1].send({ t: 'face', f: B.FACES[9] });
  await ph[1].until(s => s.me.face === B.FACES[9]);
  check('a free face is taken', ph[1].state.me.face === B.FACES[9]);
  ph[0].send({ t: 'daub', k: 0, s: 0 }); ph[0].send({ t: 'bingo' });
  await wait(60);
  check('daubs and shouts before the game does nothing', !G(tv));

  tv.send({ t: 'h', a: 'start' });
  check('the game starts with the round intro', await phase(tv, 'intro'));
  await Promise.all(ph.map(p => p.until(s => s.me.cards && s.me.cards.length === 2)));
  check('every phone has two cards of its own', ph.every(p => p.state.me.cards.length === 2 && p.state.me.cards.every(c => cardOk(classic, c))) && ph[0].state.me.cards[0].join() !== ph[1].state.me.cards[0].join());
  check('the free space starts daubed and nothing else', ph.every(p => p.state.me.daubs.every(d => d[12] && d.filter(Boolean).length === 1)));
  check('the TV shows round 1 of 2: any line', tv.state.game.ri === 0 && tv.state.game.pattern === 'line' && tv.state.game.rounds.length === 2);

  ph[1].send({ t: 'h', a: 'skipIntro' });
  await wait(80);
  check('only the captain can skip the intro', tv.state.phase === 'intro');
  ph[0].send({ t: 'h', a: 'skipIntro' });
  check('the captain skips the intro and the caller starts', await phase(tv, 'play'));
  check('the first ball comes', await tv.until(s => s.game.called.length >= 1, 3000));
  const room = roomOf(tv), g = room.game;
  check('the phones see the ball and the TV sees the clock to the next one', await ph[0].until(s => s.game.called.length >= 1) && tv.state.game.clock && tv.state.game.clock.what === 'ball');
  check('the bag never reaches a screen', ph.every(p => !p.leaks.length) && !tv.leaks.length, ph.map(p => p.leaks.join()).join('|'));

  // Pause the caller so the scripted part isn't racing the balls.
  tv.send({ t: 'h', a: 'pause' });
  await tv.until(s => s.game.paused);
  const pausedAt = tv.state.game.called.length;
  await wait(300);
  check('pausing stops the balls', tv.state.game.paused && tv.state.game.called.length === pausedAt && !tv.state.game.clock);
  const amy = g.players[ph[0].state.me.id];
  const uncalled = amy.cards[0].findIndex((id, s) => s !== 12 && !g.calledSet[id]);
  ph[0].msgs.length = 0;
  ph[0].send({ t: 'daub', k: 0, s: uncalled });
  await ph[0].until((s, l) => l.nope);
  check('daubing a number that hasn’t been called is refused', ph[0].last.nope && ph[0].last.nope.s === uncalled && !amy.daubs[0][uncalled]);
  ph[0].send({ t: 'bingo' });
  await tv.until(s => s.fx.some(e => e.type === 'falseBingo'));
  await ph[0].until(s => s.me.lockedFor > 0);
  check('shouting bingo with nothing is a false bingo and a lockout', tv.state.fx.some(e => e.type === 'falseBingo') && tv.state.game.players[amy === g.players[ph[0].state.me.id] ? ph[0].state.me.id : ''].locked && amy.stats.falses === 1 && ph[0].state.me.lockedFor > 0);
  ph[0].send({ t: 'bingo' });
  await wait(60);
  check('a locked-out player’s shout is ignored', amy.stats.falses === 1);

  // Call balls by hand until Amy's first card has a line called, daubing as we go.
  tv.send({ t: 'h', a: 'next' });
  await tv.until(s => s.game.called.length === pausedAt + 1);
  check('next ball while paused calls one ball and stays paused', tv.state.game.paused && tv.state.game.called.length === pausedAt + 1 && !tv.state.game.clock);
  tv.send({ t: 'h', a: 'resume' });
  await tv.until(s => !s.game.paused);
  check('resume starts the clock again', !tv.state.game.paused && tv.state.game.clock && tv.state.game.clock.what === 'ball');
  tv.send({ t: 'h', a: 'pause' });
  await tv.until(s => s.game.paused);
  const line = B.patternById('line');
  let guard = 0;
  while (guard++ < 80) {
    const marked = B.markedSquares(amy.cards[0], g.calledSet, null);
    if (B.distance(line, marked).away === 0) break;
    tv.send({ t: 'h', a: 'next' });
    await wait(25);
  }
  check('balls called by hand until a line is on the card', B.distance(line, B.markedSquares(amy.cards[0], g.calledSet, null)).away === 0 && g.paused);
  // Daub everything called on card 0 except one square of the line, from the phone.
  const way = B.distance(line, B.markedSquares(amy.cards[0], g.calledSet, null)).way;
  const hold = way.find(s => s !== 12);
  for (let s = 0; s < 25; s++) if (s !== 12 && s !== hold && g.calledSet[amy.cards[0][s]]) ph[0].send({ t: 'daub', k: 0, s });
  await wait(150);
  await ph[0].until(s => s.me.lockedFor === 0, 2000);
  check('the TV sees Amy one away', await tv.until(s => s.game.players[ph[0].state.me.id].away === 1, 1500));
  ph[0].send({ t: 'bingo' });
  await wait(80);
  check('a bingo with one square not daubed is a false bingo, even though it was called', amy.stats.falses === 2 && tv.state.phase === 'play');
  await ph[0].until(s => s.me.lockedFor === 0, 2000);
  ph[0].send({ t: 'daub', k: 0, s: hold });
  await ph[0].until((s, l) => l.daubed && l.daubed.s === hold);
  check('the TV sees Amy ready to shout', await tv.until(s => s.game.players[ph[0].state.me.id].away === 0, 1500));
  ph[0].send({ t: 'bingo' });
  check('a real bingo stops the caller to check the card', await phase(tv, 'claim', 2000) && tv.state.game.claim.pids[0] === ph[0].state.me.id);
  check('the TV gets the winning card to show, the other phones don’t', tv.state.game.claimCards && tv.state.game.claimCards[ph[0].state.me.id].card.join() === amy.cards[0].join() && !ph[1].state.game.claimCards);
  check('the round ends with Amy the winner and a point', await phase(tv, 'roundOver', 6000) && tv.state.game.round.winners.join() === ph[0].state.me.id && tv.state.game.players[ph[0].state.me.id].points === 1);
  check('the phones see the result', await ph[0].until(s => s.me.result && s.me.result.won) && await ph[1].until(s => s.me.result && !s.me.result.won));
  check('the hall log tells the story', tv.state.game.log.some(l => l.kind === 'bingo') && tv.state.game.log.some(l => l.kind === 'false'));

  const oldCard = amy.cards[0].join();
  tv.send({ t: 'h', a: 'skip' });
  check('round two begins with fresh cards', await phase(tv, 'intro', 2000) && tv.state.game.ri === 1 && tv.state.game.pattern === 'corners' && await ph[0].until(s => s.game.ri === 1 && s.me.cards[0].join() !== oldCard && s.me.daubs[0].filter(Boolean).length === 1));

  /* ---------------------------------------------------- the server forgets the room */
  const blob = packRoom(room, false);
  const code = room.code, token = room.adminToken;
  const before = JSON.stringify({ ri: room.game.ri, cards: room.game.players[ph[0].state.me.id].cards, points: room.game.players[ph[0].state.me.id].points });
  rooms.delete(code);
  const back = restoreRoom(blob, code, token, 0);
  check('a room restored from the TV’s backup has the same round, cards and points', back && JSON.stringify({ ri: back.game.ri, cards: back.game.players[ph[0].state.me.id].cards, points: back.game.players[ph[0].state.me.id].points }) === before);
  check('restoring with the wrong token is refused', !restoreRoom(blob, code, 'nope', 0));
  const tv2 = new Screen('tv2');
  await tv2.ready;
  tv2.send({ t: 'watch', code, token });
  await tv2.until(s => s && s.game);
  check('the TV reconnects to the restored room as admin', tv2.last.watching && tv2.last.watching.admin && (tv2.state.phase === 'intro' || tv2.state.phase === 'play'));
  for (const p of ph) { p.ws.close(); }
  const amy2 = new Screen('AMY2'); await amy2.ready;
  amy2.send({ t: 'rejoin', code, token: ph[0].last.joined.token });
  await amy2.until(s => s && s.me);
  check('a phone rejoins with its token and gets its cards back', amy2.state.me.name === 'AMY' && amy2.state.me.cards.length === 2 && amy2.state.me.points === 1);
  tv2.send({ t: 'h', a: 'endGame' });
  check('the TV can end the night early and standings decide', await phase(tv2, 'gameOver', 2000) && tv2.state.game.champions.join() === amy2.state.me.id);
  tv2.send({ t: 'h', a: 'lobby' });
  await phase(tv2, 'lobby', 2000);
  tv2.close(); amy2.close();

  /* ---------------------------------------------------- a shared win, auto-daub */
  {
    const t = new Screen('tv3'); await t.ready;
    t.send({ t: 'create' });
    await t.until(s => s && s.code);
    t.send({ t: 'h', a: 'settings', settings: { rounds: ['corners'], cards: 1, pace: 4, daub: 'auto', voice: false } });
    await t.until(s => s.settings.daub === 'auto');
    const a = new Screen('A'), b = new Screen('B');
    await a.ready; await b.ready;
    a.send({ t: 'join', code: t.state.code, name: 'ANNA' }); b.send({ t: 'join', code: t.state.code, name: 'BO' });
    await t.until(s => s.players.length === 2);
    t.send({ t: 'h', a: 'start' });
    await phase(t, 'intro');
    const r = roomOf(t), gg = r.game;
    // Give them the same corners so both can shout on the same ball.
    const ida = a.state ? a.state.me.id : null, idb = b.state ? b.state.me.id : null;
    await a.until(s => s.me.cards); await b.until(s => s.me.cards);
    const corners = [0, 4, 20, 24];
    corners.forEach(s => { gg.players[b.state.me.id].cards[0][s] = gg.players[a.state.me.id].cards[0][s]; });
    t.send({ t: 'h', a: 'skipIntro' });
    await phase(t, 'play');
    t.send({ t: 'h', a: 'pause' });
    await t.until(s => s.game.paused);
    guard = 0;
    while (guard++ < 80 && corners.some(s => !gg.calledSet[gg.players[a.state.me.id].cards[0][s]])) { t.send({ t: 'h', a: 'next' }); await wait(25); }
    await a.until(s => s.me.best && s.me.best.away === 0, 2000);
    check('auto-daub marks called numbers on the phone by itself', corners.every(s => a.state.me.daubs[0][s]) && a.state.me.best.away === 0);
    a.send({ t: 'bingo' });
    await phase(t, 'claim', 2000);
    b.send({ t: 'bingo' });
    await t.until(s => s.game.claim && s.game.claim.pids.length === 2, 1500);
    check('a second shout on the same ball joins the claim', t.state.game.claim.pids.length === 2);
    check('both share the round and both get the points', await phase(t, 'roundOver', 6000) && t.state.game.round.winners.length === 2 && Object.values(t.state.game.players).every(p => p.points === 1));
    check('the only round done, the night ends with two champions and a good-sport award', await phase(t, 'gameOver', 3000) && t.state.game.champions.length === 2 && t.state.game.awards.some(x => x.title === 'GOOD SPORT'));
    t.send({ t: 'h', a: 'again' });
    check('play again deals a new night to the same table', await phase(t, 'intro', 2000) && t.state.game.ri === 0 && Object.values(t.state.game.players).every(p => p.points === 0));
    t.close(); a.close(); b.close();
  }

  /* ---------------------------------------------------- bots play a whole night */
  {
    const t = new Screen('tv4'); await t.ready;
    t.send({ t: 'create' });
    await t.until(s => s && s.code);
    t.send({ t: 'h', a: 'settings', settings: { rounds: ['line', 'x', 'blackout'], cards: 2, pace: 4, daub: 'tap', voice: false } });
    await t.until(s => s.settings.rounds.length === 3);
    for (let i = 0; i < 4; i++) t.send({ t: 'h', a: 'addBot' });
    await t.until(s => s.players.length === 4);
    check('four bots pull up chairs', t.state.players.every(p => p.bot) && t.state.players.length === 4);
    t.send({ t: 'h', a: 'start' });
    const t0 = Date.now();
    check('bots daub, shout and finish three rounds by themselves', await phase(t, 'gameOver', 90000), 'phase ' + t.state.phase + ' round ' + t.state.game.ri + ' called ' + t.state.game.called.length);
    const gg = t.state.game;
    const totalPts = Object.values(gg.players).reduce((n, p) => n + p.points, 0);
    check('every round was won and the points add up (' + totalPts + ')', gg.history.length === 3 && gg.history.every(h => h.winners.length >= 1) && totalPts >= 1 + 2 + 5);
    check('there is a champion and a fastest finger', gg.champions.length >= 1 && gg.awards.some(a => a.title === 'FASTEST FINGER'));
    console.log('       (bot night took ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s at 25× speed)');
    t.close();
  }

  /* ---------------------------------------------------- a night with a list of your own */
  {
    const t = new Screen('tv5'); await t.ready;
    t.send({ t: 'create' });
    await t.until(s => s && s.code);
    const items = Array.from({ length: 40 }, (_, i) => 'Inside joke #' + (i + 1));
    t.send({ t: 'h', a: 'settings', settings: { rounds: ['stamp'], cards: 1, pace: 4, daub: 'auto', voice: false, pool: { kind: 'custom', name: 'Our jokes', items: items.concat(['inside joke #1']) } } });
    await t.until(s => s.settings.pool.kind === 'custom');
    check('a list of 40 is accepted, duplicates dropped, name kept', t.state.settings.pool.items.length === 40 && t.state.settings.pool.name === 'Our jokes');
    for (let i = 0; i < 3; i++) t.send({ t: 'h', a: 'addBot' });
    const p = new Screen('P'); await p.ready;
    p.send({ t: 'join', code: t.state.code, name: 'PAT' });
    await t.until(s => s.players.length === 4);
    t.send({ t: 'h', a: 'start' });
    await phase(t, 'intro');
    await p.until(s => s.me.cards);
    check('the cards hold items from the list, by column', cardOk(t.state.game.pool, p.state.me.cards[0]) && p.state.me.cards[0].every(id => id === 0 || (id >= 1 && id <= 40)));
    check('a called item reads as its letter and the item', await t.until(s => s.game.called.length >= 1, 5000) && /^[BINGO] · Inside joke #\d+$/.test(B.callOf(t.state.game.pool, t.state.game.last)));
    check('the bots finish the round on the list too', await phase(t, 'gameOver', 60000), 'phase ' + t.state.phase);
    // A late joiner after the game is over is told to wait for the next one.
    const late = new Screen('LATE'); await late.ready;
    late.send({ t: 'join', code: t.state.code, name: 'LATE' });
    await late.until((s, l) => l.error);
    check('nobody can join a night that just ended', /just ended/.test(late.last.error.msg));
    t.close(); p.close(); late.close();
  }

  /* ---------------------------------------------------- jumping in late */
  {
    const t = new Screen('tv6'); await t.ready;
    t.send({ t: 'create' });
    await t.until(s => s && s.code);
    t.send({ t: 'h', a: 'settings', settings: { rounds: ['line'], cards: 1, pace: 0, daub: 'auto', voice: false } });
    await t.until(s => s.settings.pace === 0);
    t.send({ t: 'h', a: 'addBot' });
    await t.until(s => s.players.length === 1);
    t.send({ t: 'h', a: 'start' });
    await phase(t, 'intro');
    t.send({ t: 'h', a: 'skipIntro' });
    await phase(t, 'play');
    await wait(200);
    check('manual pace: no ball comes until someone calls it', t.state.game.called.length === 0 && !t.state.game.clock);
    t.send({ t: 'h', a: 'next' }); t.send({ t: 'h', a: 'next' }); t.send({ t: 'h', a: 'next' });
    await t.until(s => s.game.called.length === 3);
    const l = new Screen('L'); await l.ready;
    l.send({ t: 'join', code: t.state.code, name: 'LIV' });
    await l.until(s => s && s.me && s.me.cards);
    const gg = roomOf(t).game, liv = gg.players[l.state.me.id];
    check('a late joiner gets a card mid-round, already daubed for what was called', l.state.me.cards.length === 1 && liv.cards[0].every((id, s) => !gg.calledSet[id] || liv.daubs[0][s]));
    check('the late joiner is the captain, being the only human', t.state.captain === l.state.me.id);
    l.send({ t: 'leave' });
    await l.until((s, m) => m.left);
    check('when the last human leaves the room goes back to the lobby', await phase(t, 'lobby', 2000));
    t.close(); l.close();
  }

  await wait(50);
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
