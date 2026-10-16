# Quiz engine (Phases 1-3)

Real-time classroom quiz: Node.js, Express, Socket.io, qrcode.

## Run

```
npm install
npm start
```

The server listens on port 3000 and prints your local network IP:

- Host on the server computer: `http://localhost:3000/host`
- Host from another device: `http://<your-ip>:3000/host?key=<host key>` (the key is printed at startup; set your own with `HOST_KEY=... npm start`)
- Students (phones): `http://<your-ip>:3000/`, or scan the QR on the host screen

## How it works

- Opening `/host` creates a room with a 6-digit PIN and a QR code. The QR points to the Join URL with `?pin=` added, so students only type their name.
- Change the Join URL at the top of the host screen (for example a tunnel URL) and press **Update QR**.
- Pick a quiz in the lobby and press **Start Game**. The game runs every question in order. After each one the host sees the correct answer, a bar chart of how many students chose each option (plus "None"), the fastest correct answer, and the leaderboard with rank, points gained, each player's fastest correct time and total score. **Next Question** moves on; after the last question the host sees an animated 1st/2nd/3rd podium. **Play Again / Reset** returns everyone to the lobby with scores at zero.
- A question ends when its timer runs out, when every connected student has answered, or when the host presses **End question now**.
- Students only ever receive timing data during a question: no question text or answer text is sent to their devices. A tap locks the choice immediately and sends it with a client timestamp.
- Scoring: a correct answer earns `1000 - floor(timeTakenMs / (timerSec * 1000) * 500)` points (500-1000), a wrong or missing answer earns 0. Time taken is measured on the server, from when it sent the question to when it received the tap, so a tampered phone clock can't fake speed.
- Tie-breaker: equal scores are ranked by the lower total time spent on correct answers, then by who joined first.
- Reconnects: when a student joins, the server gives their browser tab a private token. If they refresh or their phone drops the connection, they rejoin automatically with the same name and score, landing on whatever screen the game is on (a question they already answered stays locked). The token is per tab, so two tabs on one device are two players. In the lobby, a student who disconnects stays listed for 30 seconds.

## Quiz Creator

The **Quiz Creator** tab on `/host` lets you create, rename and delete quizzes, and add, edit, reorder or delete questions (prompt, options A-D, correct option, timer 5-120 s).

**Bulk import** accepts pasted text or an uploaded file and shows a preview before anything is added. Invalid questions are listed and skipped. Example files are in `samples/`.

- Structured text (also how PDFs are read), one question per `Q:` or numbered line:
  ```
  Q: Capital of France?
  A) Berlin
  B) Madrid
  C) Paris
  D) Rome
  Answer: C, Time: 20
  ```
  Single-line form works too: `Q: What is 2+2? A) 3 B) 4 C) 5 D) 6 Answer: B, Time: 10`. Time is optional (default 20).
- JSON: `[{ "question": "...", "options": ["a","b","c","d"], "answer": "B", "time": 20 }]` or `{ "title": "...", "questions": [...] }`. The answer can be a letter, an index 0-3 or the option text.
- Excel (.xlsx) or CSV: columns `Question, A, B, C, D, Answer, Time` (header row optional in that order). Old `.xls` files need saving as `.xlsx` first.

Quizzes are kept in memory only, so they are lost when the server restarts. A "Sample: Space" quiz is created on startup.

## Files

- `server.js`: HTTP server, rooms, game flow, quiz storage
- `importer.js`: text, JSON, PDF, Excel and CSV parsing
- `public/host.html`, `host.css`, `host.js`: host dashboard
- `public/student.html`: student answer pad
