const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { parseText, parseFile, normalizeQuestion } = require('./importer');
const db = require('./db');
const { Quiz, Result, User } = db;
const auth = require('./auth');
const Avatars = require('./public/avatars');

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('\n  MONGODB_URI is not set. Add your MongoDB connection string to the environment (e.g. Render > Environment) and restart.\n');
  process.exit(1);
}

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();
// On Render the public URL comes from RENDER_EXTERNAL_URL; PUBLIC_URL overrides it anywhere.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const DEFAULT_JOIN_URL = PUBLIC_URL ? `${PUBLIC_URL}/` : `http://${LOCAL_IP}:${PORT}/`;

// ---------- Quiz storage (MongoDB, scoped to the logged-in host) ----------
// The database stores the time limit as `timeLimit`; the game code calls it `duration`.
function toAppQuestion(q) {
  return { text: q.text, options: [...q.options], correctIndex: q.correctIndex, duration: q.timeLimit };
}
function toDbQuestion(q) {
  return { text: q.text, options: q.options, correctIndex: q.correctIndex, timeLimit: q.duration };
}
function toAppQuiz(doc) {
  return { id: String(doc._id), title: doc.title, questions: doc.questions.map(toAppQuestion), createdAt: doc.createdAt };
}

async function findOwnQuiz(userId, quizId) {
  if (!db.mongoose.isValidObjectId(quizId)) return null;
  return Quiz.findOne({ _id: quizId, hostId: userId });
}

async function quizSummaries(userId) {
  const docs = await Quiz.find({ hostId: userId }).sort({ createdAt: -1 }).lean();
  return docs.map((q) => ({
    id: String(q._id),
    title: q.title,
    count: q.questions.length,
    seconds: q.questions.reduce((sum, x) => sum + (x.timeLimit || 0), 0),
    createdAt: q.createdAt,
  }));
}

const SAMPLE_QUESTIONS = [
  { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Saturn'], correctIndex: 1, duration: 20 },
  { text: 'What is the largest planet in our solar system?', options: ['Earth', 'Saturn', 'Jupiter', 'Neptune'], correctIndex: 2, duration: 20 },
  { text: 'How many moons does Earth have?', options: ['1', '2', '0', '4'], correctIndex: 0, duration: 10 },
];

function cleanTitle(title) {
  return String(title || '').trim().slice(0, 80) || 'Untitled quiz';
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
const view = (name) => (req, res) => res.sendFile(path.join(__dirname, 'views', name));
const json = express.json({ limit: '100kb' });
const apiAuth = auth.requireAuth({ api: true });
const pageAuth = auth.requireAuth();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Students: no login, ever.
app.get('/', view('student.html'));

// Host auth pages: skip straight to the dashboard when already logged in.
const authPage = (req, res, next) => (auth.userFromCookieHeader(req.headers.cookie) ? res.redirect('/host/dashboard') : next());
app.get('/login', authPage, view('auth.html'));
app.get('/register', authPage, view('auth.html'));

// Host pages (JWT cookie required)
app.get('/host', (req, res) => res.redirect('/host/dashboard'));
app.get('/host/dashboard', pageAuth, view('dashboard.html'));
app.get('/host/session', pageAuth, view('host.html'));
app.get('/host/results', pageAuth, view('results.html'));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- Auth API ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/register', json, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (await User.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });
  let user;
  try {
    user = await User.create({ email, password: await auth.hashPassword(password) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });
    throw err;
  }
  // Give every new host a quiz to try straight away.
  await Quiz.create({ hostId: user._id, title: 'Sample: Space', questions: SAMPLE_QUESTIONS.map(toDbQuestion) });
  auth.setAuthCookie(res, user);
  res.status(201).json({ ok: true, email: user.email });
}));

app.post('/api/auth/login', json, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await User.findOne({ email });
  if (!user || !(await auth.checkPassword(password, user.password))) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  auth.setAuthCookie(res, user);
  res.json({ ok: true, email: user.email });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', apiAuth, (req, res) => res.json({ email: req.user.email }));

// ---------- Dashboard API ----------
app.get('/api/quizzes', apiAuth, wrap(async (req, res) => res.json(await quizSummaries(req.user.id))));

app.post('/api/quizzes', apiAuth, json, wrap(async (req, res) => {
  const doc = await Quiz.create({ hostId: req.user.id, title: cleanTitle(req.body?.title) });
  res.status(201).json({ id: String(doc._id), title: doc.title });
}));

app.delete('/api/quizzes/:id', apiAuth, wrap(async (req, res) => {
  const doc = await findOwnQuiz(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Quiz not found.' });
  await doc.deleteOne();
  for (const room of rooms.values()) if (room.quizId === req.params.id) room.quizId = null;
  broadcastQuizzes(req.user.id);
  res.json({ ok: true });
}));

app.get('/api/results', apiAuth, wrap(async (req, res) => {
  const docs = await Result.find({ hostId: req.user.id }).sort({ date: -1 }).limit(200).lean();
  res.json(docs.map((r) => ({
    id: String(r._id),
    quizId: r.quizId ? String(r.quizId) : null,
    quizTitle: r.quizTitle,
    roomPin: r.roomPin,
    date: r.date,
    scores: r.scores,
  })));
}));

// Dashboard totals: quizzes, finished sessions, players and average accuracy.
app.get('/api/stats', apiAuth, wrap(async (req, res) => {
  const [quizzes, results] = await Promise.all([
    Quiz.countDocuments({ hostId: req.user.id }),
    Result.find({ hostId: req.user.id }, { quizId: 1, 'scores.accuracy': 1 }).lean(),
  ]);
  const scores = results.flatMap((r) => r.scores);
  const sessionsByQuiz = {};
  for (const r of results) if (r.quizId) sessionsByQuiz[r.quizId] = (sessionsByQuiz[r.quizId] || 0) + 1;
  res.json({
    quizzes,
    sessions: results.length,
    players: scores.length,
    avgAccuracy: scores.length ? Math.round(scores.reduce((sum, s) => sum + (s.accuracy || 0), 0) / scores.length) : null,
    sessionsByQuiz,
  });
}));

// File import (PDF, XLSX, CSV, JSON, TXT). Body is the raw file; returns a preview, nothing is saved yet.
app.post('/api/import', apiAuth, express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  try {
    const result = await parseFile(req.body, String(req.query.name || ''));
    res.json(result);
  } catch (e) {
    res.status(400).json({ questions: [], errors: [`Could not read the file: ${e.message}`] });
  }
});

// ---------- Rooms ----------
const rooms = new Map(); // pin -> room
// Players are keyed by a private token kept in the student's browser, so a refresh
// (new socket) can reclaim the same player and score. Only the token can reclaim a player.
const LOBBY_GRACE_MS = 30000; // how long a disconnected player stays listed in the lobby

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(pin));
  return pin;
}

function withPin(url, pin) {
  try {
    const u = new URL(url);
    u.searchParams.set('pin', pin);
    return u.toString();
  } catch {
    return null;
  }
}

async function buildQr(room, url) {
  const joinUrl = withPin(url, room.pin);
  if (!joinUrl) throw new Error('Invalid URL');
  room.joinUrl = url;
  const qr = await QRCode.toDataURL(joinUrl, { width: 360, margin: 1 });
  return { joinUrl, qr };
}

function resetPlayer(p) {
  p.score = 0;
  p.lastPoints = 0;
  p.answer = null;
  p.totalCorrectMs = 0; // tie-breaker: total time spent on correct answers
  p.fastestMs = null;   // fastest correct answer this game
  p.correctCount = 0;
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({ name: p.name, avatar: p.avatar, connected: p.connected }));
}

// Highest score first. Ties go to the lower total time on correct answers, then the earlier joiner.
function rankedPlayers(room) {
  return [...room.players.values()].sort((a, b) =>
    b.score - a.score || a.totalCorrectMs - b.totalCorrectMs || a.joinedAt - b.joinedAt);
}

function leaderboard(room) {
  return rankedPlayers(room).map((p, i) => ({
    rank: i + 1,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    lastPoints: p.lastPoints,
    fastestMs: p.fastestMs,
    lastMs: p.answer && p.lastPoints ? p.answer.elapsed : null,
    correctCount: p.correctCount,
  }));
}

function rankOf(room, player) {
  return rankedPlayers(room).indexOf(player) + 1;
}

function emitPlayers(room) {
  io.to(room.hostId).emit('room:players', playerList(room));
}

function emitToPlayer(player, event, payload) {
  if (player.socketId) io.to(player.socketId).emit(event, payload);
}

// What a student should see right now (used on question start and after a reconnect).
// Never includes question or answer text.
function studentQuestionPayload(room, player) {
  const q = room.questions[room.questionIndex];
  return {
    index: room.questionIndex,
    total: room.questions.length,
    duration: q.duration,
    endsAt: room.endsAt,
    serverNow: Date.now(),
    locked: player.answer ? player.answer.choice : null,
  };
}

function studentResultPayload(room, player) {
  const q = room.questions[room.questionIndex];
  return {
    answered: !!player.answer,
    correct: !!player.answer && player.answer.choice === q.correctIndex,
    points: player.lastPoints,
    score: player.score,
    rank: rankOf(room, player),
    totalPlayers: room.players.size,
    isLast: room.questionIndex >= room.questions.length - 1,
  };
}

function studentFinalPayload(room, player) {
  return { score: player.score, rank: rankOf(room, player), totalPlayers: room.players.size };
}

function sendCurrentState(room, player) {
  if (room.state === 'question') emitToPlayer(player, 'question:start', studentQuestionPayload(room, player));
  else if (room.state === 'results') emitToPlayer(player, 'question:end', studentResultPayload(room, player));
  else if (room.state === 'finished') emitToPlayer(player, 'game:end', studentFinalPayload(room, player));
}

// Spec formula: 1000 - floor(timeTaken / totalTime * 500). Correct answers earn 500-1000, wrong earn 0.
function scoreAnswer(correct, elapsedMs, durationSec) {
  if (!correct) return 0;
  const t = Math.min(Math.max(elapsedMs, 0), durationSec * 1000);
  return 1000 - Math.floor((t / (durationSec * 1000)) * 500);
}

function startQuestion(room) {
  const q = room.questions[room.questionIndex];
  room.state = 'question';
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + q.duration * 1000;
  for (const p of room.players.values()) {
    p.answer = null;
    p.lastPoints = 0;
  }

  // Host gets the full question.
  io.to(room.hostId).emit('question:start', {
    index: room.questionIndex,
    total: room.questions.length,
    text: q.text,
    options: q.options,
    duration: q.duration,
    endsAt: room.endsAt,
    serverNow: Date.now(),
    players: room.players.size,
  });

  // Students get ONLY timing info: no question text, no option text.
  for (const p of room.players.values()) emitToPlayer(p, 'question:start', studentQuestionPayload(room, p));

  room.timer = setTimeout(() => endQuestion(room), q.duration * 1000);
}

function endQuestion(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer);
  room.state = 'results';
  const q = room.questions[room.questionIndex];

  const counts = [0, 0, 0, 0];
  let noAnswer = 0;
  let fastest = null;
  for (const p of room.players.values()) {
    if (!p.answer) { noAnswer++; continue; }
    counts[p.answer.choice]++;
    if (p.answer.choice === q.correctIndex && (!fastest || p.answer.elapsed < fastest.ms)) {
      fastest = { name: p.name, ms: p.answer.elapsed };
    }
  }

  io.to(room.hostId).emit('question:end', {
    index: room.questionIndex,
    total: room.questions.length,
    isLast: room.questionIndex >= room.questions.length - 1,
    correctIndex: q.correctIndex,
    counts,
    noAnswer,
    fastest,
    leaderboard: leaderboard(room),
  });

  for (const p of room.players.values()) emitToPlayer(p, 'question:end', studentResultPayload(room, p));
}

function finishGame(room) {
  clearTimeout(room.timer);
  room.state = 'finished';
  const board = leaderboard(room);
  io.to(room.hostId).emit('game:end', { leaderboard: board, title: room.quizTitle });
  for (const p of room.players.values()) emitToPlayer(p, 'game:end', studentFinalPayload(room, p));
  saveResult(room, board);
}

// Saves the final scoreboard. Runs after the podium is already on screen, so a slow or
// unavailable database never holds up the game; failures are logged and retried a few times.
function saveResult(room, board, attempt = 1) {
  if (room.resultSaved) return;
  room.resultSaved = true;
  const total = room.questions.length;
  const doc = {
    quizId: db.mongoose.isValidObjectId(room.quizId) ? room.quizId : undefined,
    hostId: room.hostUserId,
    quizTitle: room.quizTitle,
    roomPin: room.pin,
    scores: board.map((p) => ({
      rank: p.rank,
      name: p.name,
      avatar: p.avatar,
      points: p.score,
      accuracy: total ? Math.round((p.correctCount / total) * 100) : 0,
      correct: p.correctCount,
      total,
      fastestMs: p.fastestMs,
    })),
    date: new Date(),
  };
  Result.create(doc).catch((err) => {
    console.error(`[db] Could not save result for room ${room.pin} (attempt ${attempt}):`, err.message);
    if (attempt < 5) {
      room.resultSaved = false;
      setTimeout(() => saveResult(room, board, attempt + 1), attempt * 5000);
    }
  });
}

function closeRoom(room, reason) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  io.to(`players:${room.pin}`).emit('room:closed', { reason });
  rooms.delete(room.pin);
}

// Keeps every open tab of the same host in sync after a quiz changes.
function broadcastQuizzes(userId) {
  quizSummaries(userId)
    .then((list) => io.to(`user:${userId}`).emit('quiz:list', list))
    .catch((err) => console.error('[db] quiz list:', err.message));
}

io.on('connection', (socket) => {
  // A host is whoever holds a valid login cookie. Students never have one, so they
  // can't reach any quiz content or control a room.
  const user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
  socket.data.userId = user?.id || null;

  // Wraps a host-only handler: checks login and turns database errors into a readable ack.
  const hostOnly = (handler) => async (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (!user) return ack?.({ error: 'Please log in again.', auth: false });
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[host]', err);
      ack?.({ error: 'Could not reach the database. Please try again.' });
    }
  };
  const hostRoom = () => rooms.get(socket.data.hostPin);
  const ownQuiz = (quizId) => findOwnQuiz(user.id, quizId);
  const pushList = () => broadcastQuizzes(user.id);

  // ---------- Host: room ----------
  socket.on('host:create', hostOnly(async ({ quizId } = {}, ack) => {
    socket.join(`user:${user.id}`);
    const quizzes = await quizSummaries(user.id);
    const pin = generatePin();
    const room = {
      pin,
      hostId: socket.id,
      hostUserId: user.id,
      players: new Map(),
      state: 'lobby',
      quizId: quizzes.some((q) => q.id === quizId) ? quizId : quizzes[0]?.id || null,
      questions: [],
      questionIndex: 0,
      timer: null,
      joinUrl: DEFAULT_JOIN_URL,
    };
    rooms.set(pin, room);
    socket.data.hostPin = pin;
    const { joinUrl, qr } = await buildQr(room, DEFAULT_JOIN_URL);
    ack?.({ pin, baseUrl: DEFAULT_JOIN_URL, joinUrl, qr, quizzes, selectedQuizId: room.quizId, email: user.email });
  }));

  socket.on('host:setJoinUrl', hostOnly(async ({ url } = {}, ack) => {
    const room = hostRoom();
    if (!room) return ack?.({ error: 'No room' });
    try {
      const { joinUrl, qr } = await buildQr(room, String(url || '').trim());
      ack?.({ joinUrl, qr });
    } catch {
      ack?.({ error: 'Enter a full URL, e.g. https://your-app.onrender.com/' });
    }
  }));

  socket.on('host:selectQuiz', hostOnly(async ({ quizId } = {}, ack) => {
    const room = hostRoom();
    if (!room || !(await ownQuiz(quizId))) return ack?.({ error: 'Quiz not found' });
    room.quizId = quizId;
    ack?.({ ok: true });
  }));

  socket.on('host:start', hostOnly(async (_, ack) => {
    const room = hostRoom();
    if (!room || room.state === 'question') return ack?.({ error: 'Game already running' });
    const doc = await ownQuiz(room.quizId);
    if (!doc || !doc.questions.length) return ack?.({ error: 'Pick a quiz with at least one question.' });
    // Snapshot the questions so editing the quiz (or a database hiccup) can't affect the running game.
    room.questions = doc.questions.map(toAppQuestion);
    room.quizTitle = doc.title;
    room.questionIndex = 0;
    room.resultSaved = false;
    for (const p of room.players.values()) resetPlayer(p);
    startQuestion(room);
    ack?.({ ok: true });
  }));

  socket.on('host:next', hostOnly(() => {
    const room = hostRoom();
    if (!room || room.state !== 'results') return;
    if (room.questionIndex >= room.questions.length - 1) return finishGame(room);
    room.questionIndex++;
    startQuestion(room);
  }));

  socket.on('host:skip', hostOnly(() => {
    const room = hostRoom();
    if (room) endQuestion(room);
  }));

  socket.on('host:lobby', hostOnly(() => {
    const room = hostRoom();
    if (!room) return;
    clearTimeout(room.timer);
    room.state = 'lobby';
    // Play Again / Reset: scores go back to zero; players who left during the game are dropped.
    for (const [token, p] of room.players) {
      if (!p.connected) room.players.delete(token);
      else resetPlayer(p);
    }
    emitPlayers(room);
    io.to(`players:${room.pin}`).emit('room:lobby');
  }));

  // ---------- Host: quiz management (always scoped to the logged-in host) ----------
  socket.on('quiz:list', hostOnly(async (_, ack) => ack?.(await quizSummaries(user.id))));

  socket.on('quiz:get', hostOnly(async ({ quizId } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    ack?.(doc ? { quiz: toAppQuiz(doc) } : { error: 'Quiz not found' });
  }));

  socket.on('quiz:create', hostOnly(async ({ title } = {}, ack) => {
    const doc = await Quiz.create({ hostId: user.id, title: cleanTitle(title) });
    pushList();
    ack?.({ quiz: toAppQuiz(doc) });
  }));

  socket.on('quiz:rename', hostOnly(async ({ quizId, title } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    const t = String(title || '').trim().slice(0, 80);
    if (!doc || !t) return ack?.({ error: 'Enter a title.' });
    doc.title = t;
    await doc.save();
    pushList();
    ack?.({ quiz: toAppQuiz(doc) });
  }));

  socket.on('quiz:delete', hostOnly(async ({ quizId } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    if (!doc) return ack?.({ error: 'Quiz not found' });
    await doc.deleteOne();
    for (const room of rooms.values()) if (room.quizId === quizId) room.quizId = null;
    pushList();
    ack?.({ ok: true });
  }));

  // Add one question, or replace one when `index` is given.
  socket.on('quiz:saveQuestion', hostOnly(async ({ quizId, index, question } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    if (!doc) return ack?.({ error: 'Quiz not found' });
    const res = normalizeQuestion({ ...question, correct: question?.correctIndex });
    if (res.error) return ack?.({ error: res.error });
    if (Number.isInteger(index) && index >= 0 && index < doc.questions.length) doc.questions.set(index, toDbQuestion(res.question));
    else doc.questions.push(toDbQuestion(res.question));
    await doc.save();
    pushList();
    ack?.({ quiz: toAppQuiz(doc) });
  }));

  socket.on('quiz:deleteQuestion', hostOnly(async ({ quizId, index } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    if (!doc || !doc.questions[index]) return ack?.({ error: 'Question not found' });
    doc.questions.splice(index, 1);
    await doc.save();
    pushList();
    ack?.({ quiz: toAppQuiz(doc) });
  }));

  socket.on('quiz:moveQuestion', hostOnly(async ({ quizId, index, dir } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    const to = index + (dir < 0 ? -1 : 1);
    if (!doc || !doc.questions[index] || !doc.questions[to]) return ack?.({ error: 'Cannot move' });
    const list = doc.questions.map((q) => q.toObject());
    [list[index], list[to]] = [list[to], list[index]];
    doc.questions = list;
    await doc.save();
    ack?.({ quiz: toAppQuiz(doc) });
  }));

  // Parse pasted text (JSON or structured text) into a preview; nothing is saved yet.
  socket.on('import:parse', hostOnly(({ text } = {}, ack) => ack?.(parseText(text))));

  socket.on('quiz:addQuestions', hostOnly(async ({ quizId, questions } = {}, ack) => {
    const doc = await ownQuiz(quizId);
    if (!doc) return ack?.({ error: 'Quiz not found' });
    const valid = (Array.isArray(questions) ? questions : [])
      .map((q) => normalizeQuestion({ ...q, correct: q?.correctIndex }))
      .filter((r) => r.question)
      .map((r) => toDbQuestion(r.question));
    doc.questions.push(...valid);
    await doc.save();
    pushList();
    ack?.({ quiz: toAppQuiz(doc), added: valid.length });
  }));

  // ---------- Student ----------
  function attach(room, token, player) {
    // A refresh can connect the new socket before the old one's disconnect arrives.
    if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.leave(`players:${room.pin}`);
    clearTimeout(player.dropTimer);
    player.socketId = socket.id;
    player.connected = true;
    socket.data.pin = room.pin;
    socket.data.token = token;
    socket.join(`players:${room.pin}`);
    emitPlayers(room);
  }

  socket.on('student:join', ({ pin, name, avatar } = {}, ack) => {
    pin = String(pin || '').trim();
    name = String(name || '').trim().slice(0, 20);
    const room = rooms.get(pin);
    if (!room) return ack?.({ error: 'Room not found. Check the PIN.' });
    if (!name) return ack?.({ error: 'Please enter a name.' });
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return ack?.({ error: 'That name is taken.' });
    if (room.state !== 'lobby') return ack?.({ error: 'Game already in progress.' });

    const token = crypto.randomBytes(16).toString('hex');
    const player = {
      name,
      avatar: Avatars.isValid(avatar) ? avatar : Avatars.random().id,
      joinedAt: Date.now(),
      connected: true,
      socketId: null,
      dropTimer: null,
    };
    resetPlayer(player);
    room.players.set(token, player);
    attach(room, token, player);
    ack?.({ ok: true, name, avatar: player.avatar, token, state: room.state });
  });

  // Reconnect after a refresh or dropped connection, using the token saved in the browser.
  socket.on('student:rejoin', ({ pin, token } = {}, ack) => {
    const room = rooms.get(String(pin || ''));
    const player = room?.players.get(String(token || ''));
    if (!player) return ack?.({ error: 'Your previous game has ended.' });
    attach(room, token, player);
    ack?.({ ok: true, name: player.name, avatar: player.avatar, state: room.state, score: player.score });
    sendCurrentState(room, player);
  });

  socket.on('student:leave', () => {
    const room = rooms.get(socket.data.pin);
    if (!room || !socket.data.token) return;
    const player = room.players.get(socket.data.token);
    if (player) clearTimeout(player.dropTimer);
    room.players.delete(socket.data.token);
    socket.leave(`players:${room.pin}`);
    socket.data.pin = socket.data.token = null;
    emitPlayers(room);
  });

  socket.on('student:answer', ({ choice, clientTs } = {}, ack) => {
    const serverTs = Date.now();
    const room = rooms.get(socket.data.pin);
    const player = room?.players.get(socket.data.token);
    if (!room || !player || player.socketId !== socket.id) return ack?.({ error: 'Not in a room' });
    if (room.state !== 'question' || serverTs > room.endsAt) return ack?.({ error: 'Time is up' });
    if (player.answer) return ack?.({ error: 'Already answered', choice: player.answer.choice });
    if (![0, 1, 2, 3].includes(choice)) return ack?.({ error: 'Bad choice' });

    const q = room.questions[room.questionIndex];
    // Time is measured on the server (receive time minus question start), so a client can't fake speed.
    // clientTs is stored for reference only.
    const elapsed = serverTs - room.startedAt;
    const correct = choice === q.correctIndex;
    const points = scoreAnswer(correct, elapsed, q.duration);

    player.answer = { choice, clientTs: Number(clientTs) || null, serverTs, elapsed };
    player.lastPoints = points;
    player.score += points;
    if (correct) {
      player.correctCount++;
      player.totalCorrectMs += elapsed;
      if (player.fastestMs === null || elapsed < player.fastestMs) player.fastestMs = elapsed;
    }
    ack?.({ ok: true, choice });

    const active = [...room.players.values()].filter((p) => p.connected);
    const answered = active.filter((p) => p.answer).length;
    io.to(room.hostId).emit('question:progress', { answered, total: active.length });
    // Everyone still connected has answered: no need to wait out the timer.
    if (answered === active.length) endQuestion(room);
  });

  // ---------- Disconnects ----------
  socket.on('disconnect', () => {
    if (socket.data.hostPin) {
      const room = rooms.get(socket.data.hostPin);
      if (room && room.hostId === socket.id) closeRoom(room, 'The host left the game.');
      return;
    }
    const room = rooms.get(socket.data.pin);
    const player = room?.players.get(socket.data.token);
    if (!player || player.socketId !== socket.id) return; // already reattached to a newer socket
    player.connected = false;
    player.socketId = null;
    // Mid-game, keep the player (and score) until the game ends. In the lobby, drop them
    // if they don't come back shortly, so the list doesn't fill with people who left.
    if (room.state === 'lobby') {
      const token = socket.data.token;
      player.dropTimer = setTimeout(() => {
        if (!player.connected && room.state === 'lobby' && rooms.get(room.pin) === room) {
          room.players.delete(token);
          emitPlayers(room);
        }
      }, LOBBY_GRACE_MS);
    }
    emitPlayers(room);
  });
});

db.connect(MONGODB_URI)
  .then(() => {
    server.listen(PORT, () => {
      console.log('\n  Quiz engine running');
      console.log('  MongoDB connected');
      console.log(`  Local network IP: ${LOCAL_IP}`);
      console.log(`  Students join at: ${DEFAULT_JOIN_URL}`);
      console.log(`  Hosts log in at:  ${DEFAULT_JOIN_URL}login\n`);
    });
  })
  .catch((err) => {
    console.error(`\n  Could not connect to MongoDB: ${err.message}\n  Check MONGODB_URI and that the database allows connections from this server.\n`);
    process.exit(1);
  });
