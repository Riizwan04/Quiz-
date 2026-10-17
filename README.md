# Quiz engine (Phases 1-3)

Real-time classroom quiz: Node.js, Express, Socket.io, qrcode.

## Run

Requires Node 18+ and a MongoDB database (MongoDB Atlas works).

```
npm install
MONGODB_URI="mongodb+srv://..." JWT_SECRET="a-long-random-string" npm start
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string. The server exits with a clear message if it is missing or unreachable at startup. |
| `JWT_SECRET` | Yes in production | Signs host login cookies. With `NODE_ENV=production` the server refuses to start without it; locally a random one is used per run. |
| `PORT` | No | Set automatically on Render; defaults to 3000. |
| `PUBLIC_URL` | No | Public address used for the default join URL and QR code. On Render, `RENDER_EXTERNAL_URL` is used automatically. |
| `NODE_ENV` | No | Set to `production` on Render so login cookies are marked `Secure` (HTTPS only). |

On Render: Build command `npm install`, Start command `npm start`, and add the variables above under Environment.

### Routes

| Route | Who | What |
| --- | --- | --- |
| `/` | Students | Join with PIN and name. No account needed. |
| `/login`, `/register` | Hosts | Email and password. Passwords are hashed with bcrypt; login sets an httpOnly JWT cookie valid for 7 days. |
| `/host/dashboard` | Logged-in host | Your quizzes only, with Create New Quiz, Launch Session, Edit, Delete and View Past Results. |
| `/host/session?quiz=<id>` | Logged-in host | Lobby (PIN, QR, players), live game and Quiz Creator. `&view=creator` opens the editor. |
| `/host/results` | Logged-in host | Final scoreboards of your finished games: rank, points, accuracy, correct answers, fastest time. |

`/host` redirects to the dashboard, and any host page redirects to `/login` when not logged in. The host's Socket.io connection is authenticated with the same cookie, so students can never load quiz questions or answers, and hosts only ever see their own quizzes and results.

## How it works

- Data lives in MongoDB: `users` (email, bcrypt password hash), `quizzes` (owner, title, questions with options, correct index and time limit) and `results` (quiz, host, room PIN, scoreboard with points and accuracy, date). New hosts get a "Sample: Space" quiz.
- Live games run in server memory. A game uses a snapshot of the quiz taken at Start, so a slow or briefly unavailable database never interrupts a game in progress. The final scoreboard is saved when the podium appears, and retried if the database is temporarily down.
- Launching a session creates a room with a 6-digit PIN and a QR code. The QR points to the Join URL with `?pin=` added, so students only type their name.
- Change the Join URL at the top of the host screen (for example a tunnel URL) and press **Update QR**.
- Pick a quiz in the lobby and press **Start Game**. The game runs every question in order. After each one the host sees the correct answer, a bar chart of how many students chose each option (plus "None"), the fastest correct answer, and the leaderboard with rank, points gained, each player's fastest correct time and total score. **Next Question** moves on; after the last question the host sees an animated 1st/2nd/3rd podium. **Play Again / Reset** returns everyone to the lobby with scores at zero.
- A question ends when its timer runs out, when every connected student has answered, or when the host presses **End question now**.
- Students only ever receive timing data during a question: no question text or answer text is sent to their devices. A tap locks the choice immediately and sends it with a client timestamp.
- Scoring: a correct answer earns `1000 - floor(timeTakenMs / (timerSec * 1000) * 500)` points (500-1000), a wrong or missing answer earns 0. Time taken is measured on the server, from when it sent the question to when it received the tap, so a tampered phone clock can't fake speed.
- Tie-breaker: equal scores are ranked by the lower total time spent on correct answers, then by who joined first.
- Reconnects: when a student joins, the server gives their browser tab a private token. If they refresh or their phone drops the connection, they rejoin automatically with the same name and score, landing on whatever screen the game is on (a question they already answered stays locked). The token is per tab, so two tabs on one device are two players. In the lobby, a student who disconnects stays listed for 30 seconds.

## Quiz Creator

The **Quiz Creator** tab in a host session (or **Edit** on the dashboard) lets you rename and delete quizzes, and add, edit, reorder or delete questions (prompt, options A-D, correct option, timer 5-120 s).

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

Quizzes are saved to MongoDB as you edit them.

## Files

- `server.js`: HTTP routes, auth API, rooms and game flow
- `db.js`: MongoDB connection and the User, Quiz and Result models
- `auth.js`: bcrypt password hashing and JWT cookie handling
- `importer.js`: text, JSON, PDF, Excel and CSV parsing
- `views/`: pages (`student.html`, `auth.html`, `dashboard.html`, `results.html`, `host.html` for the live session and quiz editor)
- `public/`: static CSS and JS
