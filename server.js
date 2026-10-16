const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { parseText, parseFile, normalizeQuestion } = require('./importer');

const PORT = 3000;
// Host access: the host page works without a key from this computer (localhost).
// From any other device it needs this key, so students can't open /host and read the answers.
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();
const DEFAULT_JOIN_URL = `http://${LOCAL_IP}:${PORT}/`;

function isLocalAddress(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isHostRequest(addr, key) {
  return isLocalAddress(addr) || (typeof key === 'string' && key === HOST_KEY);
}

// ---------- In-memory quiz storage ----------
const quizzes = new Map(); // id -> { id, title, questions: [...] }

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function createQuiz(title, questions = []) {
  const quiz = { id: newId(), title: String(title || 'Untitled quiz').trim().slice(0, 80) || 'Untitled quiz', questions };
  quizzes.set(quiz.id, quiz);
  return quiz;
}

createQuiz('Sample: Space', [
  { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Saturn'], correctIndex: 1, duration: 20 },
  { text: 'What is the largest planet in our solar system?', options: ['Earth', 'Saturn', 'Jupiter', 'Neptune'], correctIndex: 2, duration: 20 },
  { text: 'How many moons does Earth have?', options: ['1', '2', '0', '4'], correctIndex: 0, duration: 10 },
]);

function quizSummaries() {
  return [...quizzes.values()].map((q) => ({ id: q.id, title: q.title, count: q.questions.length }));
}

// ---------- HTTP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// File import (PDF, XLSX, CSV, JSON, TXT). Body is the raw file; returns a preview, nothing is saved yet.
app.post('/api/import', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  if (!isHostRequest(req.socket.remoteAddress, req.get('x-host-key'))) return res.status(403).json({ errors: ['Host key required.'] });
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
  return [...room.players.values()].map((p) => ({ name: p.name, connected: p.connected }));
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
  io.to(room.hostId).emit('game:end', { leaderboard: leaderboard(room), title: room.quizTitle });
  for (const p of room.players.values()) emitToPlayer(p, 'game:end', studentFinalPayload(room, p));
}

function closeRoom(room, reason) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  io.to(`players:${room.pin}`).emit('room:closed', { reason });
  rooms.delete(room.pin);
}

function broadcastQuizzes() {
  io.to('hosts').emit('quiz:list', quizSummaries());
}

io.on('connection', (socket) => {
  const isHost = isHostRequest(socket.handshake.address, socket.handshake.auth?.hostKey);

  // Wraps a host-only handler: students can't touch quizzes or rooms.
  const hostOnly = (handler) => (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (!isHost) return ack?.({ error: 'Host key required.' });
    return handler(...args);
  };
  const hostRoom = () => rooms.get(socket.data.hostPin);

  // ---------- Host: room ----------
  socket.on('host:create', hostOnly(async (_, ack) => {
    socket.join('hosts');
    const pin = generatePin();
    const firstQuiz = quizzes.values().next().value;
    const room = {
      pin,
      hostId: socket.id,
      players: new Map(),
      state: 'lobby',
      quizId: firstQuiz?.id || null,
      questions: [],
      questionIndex: 0,
      timer: null,
      joinUrl: DEFAULT_JOIN_URL,
    };
    rooms.set(pin, room);
    socket.data.hostPin = pin;
    const { joinUrl, qr } = await buildQr(room, DEFAULT_JOIN_URL);
    ack?.({ pin, baseUrl: DEFAULT_JOIN_URL, joinUrl, qr, quizzes: quizSummaries(), selectedQuizId: room.quizId });
  }));

  socket.on('host:setJoinUrl', hostOnly(async ({ url } = {}, ack) => {
    const room = hostRoom();
    if (!room) return ack?.({ error: 'No room' });
    try {
      const { joinUrl, qr } = await buildQr(room, String(url || '').trim());
      ack?.({ joinUrl, qr });
    } catch {
      ack?.({ error: 'Enter a full URL, e.g. http://192.168.1.10:3000/' });
    }
  }));

  socket.on('host:selectQuiz', hostOnly(({ quizId } = {}, ack) => {
    const room = hostRoom();
    if (!room || !quizzes.has(quizId)) return ack?.({ error: 'Quiz not found' });
    room.quizId = quizId;
    ack?.({ ok: true });
  }));

  socket.on('host:start', hostOnly((_, ack) => {
    const room = hostRoom();
    if (!room || room.state === 'question') return ack?.({ error: 'Game already running' });
    const quiz = quizzes.get(room.quizId);
    if (!quiz || !quiz.questions.length) return ack?.({ error: 'Pick a quiz with at least one question.' });
    // Snapshot the questions so editing the quiz mid-game can't break the running game.
    room.questions = quiz.questions.map((q) => ({ ...q, options: [...q.options] }));
    room.quizTitle = quiz.title;
    room.questionIndex = 0;
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

  // ---------- Host: quiz management ----------
  socket.on('quiz:list', hostOnly((_, ack) => ack?.(quizSummaries())));

  socket.on('quiz:get', hostOnly(({ quizId } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    ack?.(quiz ? { quiz } : { error: 'Quiz not found' });
  }));

  socket.on('quiz:create', hostOnly(({ title } = {}, ack) => {
    const quiz = createQuiz(title);
    broadcastQuizzes();
    ack?.({ quiz });
  }));

  socket.on('quiz:rename', hostOnly(({ quizId, title } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    const t = String(title || '').trim().slice(0, 80);
    if (!quiz || !t) return ack?.({ error: 'Enter a title.' });
    quiz.title = t;
    broadcastQuizzes();
    ack?.({ quiz });
  }));

  socket.on('quiz:delete', hostOnly(({ quizId } = {}, ack) => {
    if (!quizzes.delete(quizId)) return ack?.({ error: 'Quiz not found' });
    for (const room of rooms.values()) if (room.quizId === quizId) room.quizId = null;
    broadcastQuizzes();
    ack?.({ ok: true });
  }));

  // Add one question, or replace one when `index` is given.
  socket.on('quiz:saveQuestion', hostOnly(({ quizId, index, question } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    if (!quiz) return ack?.({ error: 'Quiz not found' });
    const res = normalizeQuestion({ ...question, correct: question?.correctIndex });
    if (res.error) return ack?.({ error: res.error });
    if (Number.isInteger(index) && index >= 0 && index < quiz.questions.length) quiz.questions[index] = res.question;
    else quiz.questions.push(res.question);
    broadcastQuizzes();
    ack?.({ quiz });
  }));

  socket.on('quiz:deleteQuestion', hostOnly(({ quizId, index } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    if (!quiz || !quiz.questions[index]) return ack?.({ error: 'Question not found' });
    quiz.questions.splice(index, 1);
    broadcastQuizzes();
    ack?.({ quiz });
  }));

  socket.on('quiz:moveQuestion', hostOnly(({ quizId, index, dir } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    const to = index + (dir < 0 ? -1 : 1);
    if (!quiz || !quiz.questions[index] || !quiz.questions[to]) return ack?.({ error: 'Cannot move' });
    [quiz.questions[index], quiz.questions[to]] = [quiz.questions[to], quiz.questions[index]];
    ack?.({ quiz });
  }));

  // Parse pasted text (JSON or structured text) into a preview; nothing is saved yet.
  socket.on('import:parse', hostOnly(({ text } = {}, ack) => ack?.(parseText(text))));

  socket.on('quiz:addQuestions', hostOnly(({ quizId, questions } = {}, ack) => {
    const quiz = quizzes.get(quizId);
    if (!quiz) return ack?.({ error: 'Quiz not found' });
    const valid = (Array.isArray(questions) ? questions : [])
      .map((q) => normalizeQuestion({ ...q, correct: q?.correctIndex }))
      .filter((r) => r.question)
      .map((r) => r.question);
    quiz.questions.push(...valid);
    broadcastQuizzes();
    ack?.({ quiz, added: valid.length });
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

  socket.on('student:join', ({ pin, name } = {}, ack) => {
    pin = String(pin || '').trim();
    name = String(name || '').trim().slice(0, 20);
    const room = rooms.get(pin);
    if (!room) return ack?.({ error: 'Room not found. Check the PIN.' });
    if (!name) return ack?.({ error: 'Please enter a name.' });
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return ack?.({ error: 'That name is taken.' });
    if (room.state !== 'lobby') return ack?.({ error: 'Game already in progress.' });

    const token = crypto.randomBytes(16).toString('hex');
    const player = { name, joinedAt: Date.now(), connected: true, socketId: null, dropTimer: null };
    resetPlayer(player);
    room.players.set(token, player);
    attach(room, token, player);
    ack?.({ ok: true, name, token, state: room.state });
  });

  // Reconnect after a refresh or dropped connection, using the token saved in the browser.
  socket.on('student:rejoin', ({ pin, token } = {}, ack) => {
    const room = rooms.get(String(pin || ''));
    const player = room?.players.get(String(token || ''));
    if (!player) return ack?.({ error: 'Your previous game has ended.' });
    attach(room, token, player);
    ack?.({ ok: true, name: player.name, state: room.state, score: player.score });
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

server.listen(PORT, () => {
  console.log('\n  Quiz engine running');
  console.log(`  Local network IP: ${LOCAL_IP}`);
  console.log(`  Host view (this computer): http://localhost:${PORT}/host`);
  console.log(`  Host view (other devices): http://${LOCAL_IP}:${PORT}/host?key=${HOST_KEY}`);
  console.log(`  Student view:              http://${LOCAL_IP}:${PORT}/\n`);
});
