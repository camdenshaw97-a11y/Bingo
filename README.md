# Friend Bingo

A bingo night for a TV and your phones. The TV is the caller: it draws the balls, reads them out loud, lights up the board and keeps score. Everyone daubs on their own phone and the first to shout BINGO takes the round.

Built the same way as Friend Feud, Friend Jeopardy, Friend Wheel, Friend Monopoly, Friend Clue and Legendary Friends: one Node server, a TV page, a phone page, a 4-letter room code or QR to join, and a game that survives a server restart.

## Running it

```
npm install
npm start          # http://localhost:3000 (phones) and http://localhost:3000/tv (the TV)
npm test           # plays scripted and bot-only nights against a real server
```

On Render: a free Node web service from this repo, build `npm install`, start `node server.js` (there's a `render.yaml`). The TV page is `YOUR-SITE/tv`; phones use `YOUR-SITE` and the room code.

## How it plays

- **1 to 12 players**, one phone each, plus bots the TV can add. Pick a face on your phone; your colour is yours for the night. The first person in is the captain (can start the game, skip intros, pause, call the next ball, move on to the next round).
- **The TV sets the night**: the rounds, in order, each with a winning pattern (Any Line, Four Corners, Postage Stamp, Two Lines, the X, the Plus, Letter T, Diamond, the Arrow, the Frame, Blackout — worth 1 to 5 points); 1, 2 or 3 cards per player; the caller's pace (a ball every 4/6/8/12 s, or manual: space bar on the TV or the captain's phone); tap-to-daub or auto-daub; the caller's voice on or off; and the balls: the classic 1–75, or a list of your own.
- **A list of your own**: write 30 to 150 things (inside jokes, people, places), one per line. They become the balls: the first fifth are the B column, the next the I, and so on. Cards are dealt from the list and the caller calls "G · Someone spills a drink". Lists are saved on the TV computer.
- **Tap to daub** is real bingo: you have to spot your numbers (only called ones can be daubed; tap an uncalled one and the square wiggles). Miss one and you miss the bingo. **Auto-daub** marks them for you; you still have to shout.
- **Shouting BINGO** stops the caller: the TV checks the card with a drum roll and shows it to the room. A good bingo wins the round's points; anyone else who shouts on the same ball shares it. A false bingo gets the buzzer, a NOT A BINGO stamp, and a 12-second lockout — and goes on your record.
- **The TV rail** shows everyone's points and who's 1 AWAY (or sitting on a bingo they haven't noticed).
- **Awards** at the end: Fastest Finger, False Alarm, Heartbreaker (one square away the most), Daub Machine, Good Sport. Most points is champion; ties share it. Play again keeps the table.
- **Also**: private chat between phones, jump in mid-game (you get a card straight away), leave and come back with the same name, reconnect, restart survival (the TV holds a sealed copy of the room), pause, skip, keyboard shortcuts on the TV (space = next ball / skip, P pause, M sound, V voice, F full screen).

## Files

- `server.js` — the whole game: rooms, dealing, the caller, daubs, claims, scoring, bots, restart survival.
- `bingo.js` — the rules shared with the pages: the ball pool, cards, the patterns and how to check them, colours and faces.
- `tv.html`, `index.html`, `common.js`, `style.css` — the TV, the phone, and what they share (connection, dialogs, synthesized sounds, the caller's voice, ball and card drawing).
- `test/play.js` — the test suite.
