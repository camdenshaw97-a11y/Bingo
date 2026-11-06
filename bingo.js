/*
 * The rules of bingo that the server and both pages share: the ball pool (classic 75-ball or a
 * list of your own), how a card is laid out, the winning patterns and how to check a card
 * against them, the ball colours and the player colours. Works in Node and in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bingo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LETTERS = ['B', 'I', 'N', 'G', 'O'];
  // The classic ball colours, by column.
  var COLORS = [
    { bg: '#2f6cf6', hi: '#7aa3ff', ink: '#ffffff', name: 'blue' },
    { bg: '#e8334a', hi: '#ff7f8e', ink: '#ffffff', name: 'red' },
    { bg: '#f4f1ea', hi: '#ffffff', ink: '#1b1f3a', name: 'white' },
    { bg: '#2eb35a', hi: '#7fe39f', ink: '#ffffff', name: 'green' },
    { bg: '#f7a823', hi: '#ffd37a', ink: '#2a1800', name: 'yellow' }
  ];
  var FREE = 0;              // the ball id of the free space
  var CLASSIC_N = 75;
  var MIN_CUSTOM = 30;       // a list of your own needs this many items (6 per column)
  var MAX_CUSTOM = 150;

  /* ---- the pool: what the caller can call ---- */
  // pool = { kind: 'classic' } or { kind: 'custom', name, items: [...] }
  function poolSize(pool) { return pool && pool.kind === 'custom' ? pool.items.length : CLASSIC_N; }
  // Which column a ball lives in. The classic game splits 1–75 into fives of fifteen; a list of
  // your own is split into five near-equal runs in the order it was written.
  function colOf(pool, id) {
    var n = poolSize(pool);
    if (id === FREE) return 2;
    return Math.min(4, Math.floor((id - 1) * 5 / n));
  }
  function idsInCol(pool, c) {
    var n = poolSize(pool), out = [];
    for (var id = 1; id <= n; id++) if (colOf(pool, id) === c) out.push(id);
    return out;
  }
  // What a ball reads as: "B 12" in the classic game, the item itself in a custom list.
  function labelOf(pool, id) {
    if (id === FREE) return 'FREE';
    if (pool && pool.kind === 'custom') return pool.items[id - 1] || '?';
    return String(id);
  }
  function callOf(pool, id) { return id === FREE ? 'FREE' : LETTERS[colOf(pool, id)] + (pool && pool.kind === 'custom' ? ' · ' + labelOf(pool, id) : ' ' + id); }

  /* ---- cards ---- */
  // A card is 25 ball ids in reading order (row by row); the centre is the free space.
  function makeCard(pool, rand) {
    var cols = [];
    for (var c = 0; c < 5; c++) {
      var ids = idsInCol(pool, c).slice(), pick = [];
      for (var k = 0; k < 5; k++) { var i = Math.floor(rand() * ids.length); pick.push(ids.splice(i, 1)[0]); }
      cols.push(pick);
    }
    var card = [];
    for (var r = 0; r < 5; r++) for (var cc = 0; cc < 5; cc++) card.push(r === 2 && cc === 2 ? FREE : cols[cc][r]);
    return card;
  }
  function cardKey(card) { return card.join(','); }

  /* ---- patterns ---- */
  // Each pattern is a list of ways to win; a way is a list of square indexes (0–24) that must all
  // be marked. "Any line" has twelve ways; blackout has one.
  function sq(r, c) { return r * 5 + c; }
  var ROWS = [], COLS = [], DIAG1 = [], DIAG2 = [];
  for (var r = 0; r < 5; r++) { var row = [], col = []; for (var c = 0; c < 5; c++) { row.push(sq(r, c)); col.push(sq(c, r)); } ROWS.push(row); COLS.push(col); DIAG1.push(sq(r, r)); DIAG2.push(sq(r, 4 - r)); }
  var ALL = []; for (var i = 0; i < 25; i++) ALL.push(i);
  var CORNERS = [sq(0, 0), sq(0, 4), sq(4, 0), sq(4, 4)];
  var X = DIAG1.concat(DIAG2.filter(function (s) { return DIAG1.indexOf(s) < 0; }));
  var PLUS = ROWS[2].concat(COLS[2].filter(function (s) { return ROWS[2].indexOf(s) < 0; }));
  var FRAME = ALL.filter(function (s) { var rr = Math.floor(s / 5), cc = s % 5; return rr === 0 || rr === 4 || cc === 0 || cc === 4; });
  var T = ROWS[0].concat(COLS[2].filter(function (s) { return ROWS[0].indexOf(s) < 0; }));
  var DIAMOND = [sq(0, 2), sq(1, 1), sq(1, 3), sq(2, 0), sq(2, 4), sq(3, 1), sq(3, 3), sq(4, 2), sq(2, 2)];
  var STAMPS = [[sq(0, 0), sq(0, 1), sq(1, 0), sq(1, 1)], [sq(0, 3), sq(0, 4), sq(1, 3), sq(1, 4)], [sq(3, 0), sq(3, 1), sq(4, 0), sq(4, 1)], [sq(3, 3), sq(3, 4), sq(4, 3), sq(4, 4)]];
  var ARROW = [sq(0, 4), sq(1, 3), sq(2, 2), sq(3, 1), sq(4, 0), sq(0, 2), sq(0, 3), sq(1, 4), sq(2, 4)];

  var PATTERNS = [
    { id: 'line', name: 'Any Line', short: 'LINE', points: 1, about: 'Five in a row: across, down or corner to corner.', ways: ROWS.concat(COLS, [DIAG1, DIAG2]), demo: ROWS[1] },
    { id: 'corners', name: 'Four Corners', short: 'CORNERS', points: 1, about: 'The four corner squares. Quick and sneaky.', ways: [CORNERS], demo: CORNERS },
    { id: 'stamp', name: 'Postage Stamp', short: 'STAMP', points: 1, about: 'A two-by-two block in any corner of the card.', ways: STAMPS, demo: STAMPS[1] },
    { id: 'two', name: 'Two Lines', short: '2 LINES', points: 2, about: 'Any two complete lines on one card.', ways: null, demo: ROWS[0].concat(COLS[4].filter(function (s) { return ROWS[0].indexOf(s) < 0; })) },
    { id: 'x', name: 'The X', short: 'X', points: 2, about: 'Both diagonals, corner to corner, through the free space.', ways: [X], demo: X },
    { id: 'plus', name: 'The Plus', short: 'PLUS', points: 2, about: 'The middle row and the middle column.', ways: [PLUS], demo: PLUS },
    { id: 't', name: 'Letter T', short: 'T', points: 2, about: 'The top row and the middle column.', ways: [T], demo: T },
    { id: 'diamond', name: 'Diamond', short: 'DIAMOND', points: 2, about: 'A diamond around the free space, point to point.', ways: [DIAMOND], demo: DIAMOND },
    { id: 'arrow', name: 'The Arrow', short: 'ARROW', points: 2, about: 'An arrow from the bottom-left corner to the top-right.', ways: [ARROW], demo: ARROW },
    { id: 'frame', name: 'The Frame', short: 'FRAME', points: 3, about: 'Every square around the outside edge. Sixteen of them.', ways: [FRAME], demo: FRAME },
    { id: 'blackout', name: 'Blackout', short: 'BLACKOUT', points: 5, about: 'The whole card. Every single square.', ways: [ALL], demo: ALL }
  ];
  function patternById(id) { for (var k = 0; k < PATTERNS.length; k++) if (PATTERNS[k].id === id) return PATTERNS[k]; return null; }

  // How many squares a card is short of the pattern, given which squares count as marked.
  // Returns { away: n, way: [...] } for the closest way to win (away 0 = bingo).
  function distance(pattern, marked) {
    var best = null;
    if (pattern.id === 'two') {
      // Two lines: the two closest lines added together, counting a shared square once.
      var lines = ROWS.concat(COLS, [DIAG1, DIAG2]);
      for (var a = 0; a < lines.length; a++) for (var b = a + 1; b < lines.length; b++) {
        var union = lines[a].concat(lines[b].filter(function (s) { return lines[a].indexOf(s) < 0; }));
        var miss = union.filter(function (s) { return !marked[s]; });
        if (!best || miss.length < best.away) best = { away: miss.length, way: union, missing: miss };
      }
      return best;
    }
    for (var w = 0; w < pattern.ways.length; w++) {
      var m = pattern.ways[w].filter(function (s) { return !marked[s]; });
      if (!best || m.length < best.away) best = { away: m.length, way: pattern.ways[w], missing: m };
      if (!m.length) break;
    }
    return best;
  }
  // The squares of a card that are marked: a function of what has been called and what has been
  // daubed. The free space is always marked.
  function markedSquares(card, called, daubs) {
    var out = [];
    for (var s = 0; s < 25; s++) {
      var id = card[s];
      out[s] = id === FREE || (called[id] && (!daubs || daubs[s]));
    }
    return out;
  }

  /* ---- players' colours ---- */
  var PALETTE = [
    { c1: '#ff5d8f', c2: '#b8154b' }, { c1: '#4fd1ff', c2: '#0b7fb3' }, { c1: '#ffd166', c2: '#c98a05' }, { c1: '#7ef09a', c2: '#1f8a46' },
    { c1: '#c792ff', c2: '#6b2fc9' }, { c1: '#ff9f5a', c2: '#c25414' }, { c1: '#5affe0', c2: '#0f9c86' }, { c1: '#ff7ab8', c2: '#9a1f5c' },
    { c1: '#9fd3ff', c2: '#3366cc' }, { c1: '#f0ff6a', c2: '#8a9a05' }, { c1: '#ffb3b3', c2: '#b83a3a' }, { c1: '#b8ffb3', c2: '#3a8a3a' }
  ];
  var FACES = ['🦩', '🐙', '🦄', '🐸', '🦉', '🦊', '🐬', '🐝', '🐧', '🦁', '🐼', '🐨', '🦖', '🐳', '🦋', '🐯'];

  return {
    LETTERS: LETTERS, COLORS: COLORS, FREE: FREE, CLASSIC_N: CLASSIC_N, MIN_CUSTOM: MIN_CUSTOM, MAX_CUSTOM: MAX_CUSTOM,
    poolSize: poolSize, colOf: colOf, idsInCol: idsInCol, labelOf: labelOf, callOf: callOf,
    makeCard: makeCard, cardKey: cardKey, PATTERNS: PATTERNS, patternById: patternById, distance: distance, markedSquares: markedSquares,
    PALETTE: PALETTE, FACES: FACES
  };
});
