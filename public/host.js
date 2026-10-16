const $ = (id) => document.getElementById(id);
const LETTERS = ['A', 'B', 'C', 'D'];
const CIRC = 301.6;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flash(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
  clearTimeout(el._t);
  if (text && kind !== 'err') el._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

// ---------- Host key ----------
const params = new URLSearchParams(location.search);
function storedKey() { try { return localStorage.getItem('hostKey') || ''; } catch { return ''; } }
function saveKey(k) { try { localStorage.setItem('hostKey', k); } catch {} }
if (params.get('key')) saveKey(params.get('key'));

const socket = io({ auth: { hostKey: params.get('key') || storedKey() } });
const call = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

// ---------- State ----------
let quizzes = [];          // summaries: { id, title, count }
let selectedQuizId = null; // quiz launched from the lobby
let editingQuiz = null;    // full quiz open in the creator
let editIndex = null;      // question being edited, or null when adding
let pendingImport = [];
let playerCount = 0;
let tick = null;

// ---------- Views ----------
const VIEWS = ['lobby', 'creator', 'game', 'final'];
function showView(view) {
  VIEWS.forEach((v) => $(v).classList.toggle('hidden', v !== view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('tabs').classList.toggle('hidden', view === 'game' || view === 'final');
}
$('tabs').addEventListener('click', (e) => {
  const view = e.target.dataset?.view;
  if (!view) return;
  if (view === 'creator' && !editingQuiz) openQuiz(selectedQuizId || quizzes[0]?.id);
  showView(view);
});

// ---------- Room ----------
async function createRoom() {
  const res = await call('host:create', null);
  if (res.error) { $('gate').classList.remove('hidden'); return; }
  $('gate').classList.add('hidden');
  $('pin').textContent = res.pin;
  $('joinUrl').value = res.baseUrl;
  showQr(res);
  quizzes = res.quizzes;
  selectedQuizId = res.selectedQuizId;
  renderQuizzes();
  showView('lobby');
}
socket.on('connect', createRoom);

$('gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('gateKey').value.trim();
  saveKey(key);
  socket.auth.hostKey = key;
  flash($('gateMsg'), 'Checking…');
  socket.disconnect().connect();
  setTimeout(() => { if (!$('gate').classList.contains('hidden')) flash($('gateMsg'), 'That key did not work.', 'err'); }, 1500);
});

function showQr({ joinUrl, qr }) {
  $('qr').src = qr;
  $('joinUrlShown').textContent = joinUrl;
}

async function updateQr() {
  const res = await call('host:setJoinUrl', { url: $('joinUrl').value });
  if (res.error) return flash($('urlMsg'), res.error, 'err');
  showQr(res);
  flash($('urlMsg'), 'QR updated', 'ok');
}
$('updateQr').onclick = updateQr;
$('joinUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') updateQr(); });

socket.on('room:players', (players) => {
  playerCount = players.length;
  $('count').textContent = players.length;
  updateStartButton();
  $('players').innerHTML = players.length
    ? players.map((p) => `<span class="chip${p.connected ? '' : ' off'}">${esc(p.name)}</span>`).join('')
    : '<span class="empty">Waiting for players to join…</span>';
});

// ---------- Quiz list (lobby picker + creator sidebar) ----------
socket.on('quiz:list', (list) => {
  quizzes = list;
  if (selectedQuizId && !quizzes.some((q) => q.id === selectedQuizId)) selectedQuizId = null;
  if (!selectedQuizId && quizzes[0]) selectQuiz(quizzes[0].id);
  renderQuizzes();
});

function renderQuizzes() {
  $('quizSelect').innerHTML = quizzes.length
    ? quizzes.map((q) => `<option value="${q.id}"${q.id === selectedQuizId ? ' selected' : ''}>${esc(q.title)} (${q.count} question${q.count === 1 ? '' : 's'})</option>`).join('')
    : '<option value="">No quizzes yet: create one in Quiz Creator</option>';
  $('quizList').innerHTML = quizzes.map((q) =>
    `<button class="quiz-item${editingQuiz?.id === q.id ? ' active' : ''}" data-id="${q.id}"><span>${esc(q.title)}</span><span class="n">${q.count} Q</span></button>`
  ).join('') || '<span class="empty">No quizzes yet.</span>';
  $('editor').classList.toggle('hidden', !editingQuiz);
  updateStartButton();
}

function updateStartButton() {
  const quiz = quizzes.find((q) => q.id === selectedQuizId);
  $('startBtn').disabled = !playerCount || !quiz || !quiz.count;
}

async function selectQuiz(id) {
  selectedQuizId = id;
  await call('host:selectQuiz', { quizId: id });
  renderQuizzes();
}
$('quizSelect').onchange = (e) => selectQuiz(e.target.value);
$('editSelected').onclick = () => { if (selectedQuizId) { openQuiz(selectedQuizId); showView('creator'); } };

$('startBtn').onclick = async () => {
  const res = await call('host:start', null);
  if (res?.error) flash($('startMsg'), res.error, 'err');
};

// ---------- Quiz Creator ----------
async function openQuiz(id) {
  if (!id) { editingQuiz = null; renderQuizzes(); return; }
  const res = await call('quiz:get', { quizId: id });
  if (res.error) return;
  editingQuiz = res.quiz;
  resetForm();
  clearImport();
  renderEditor();
}

$('quizList').addEventListener('click', (e) => {
  const btn = e.target.closest('.quiz-item');
  if (btn) openQuiz(btn.dataset.id);
});

$('newQuizForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await call('quiz:create', { title: $('newQuizTitle').value });
  $('newQuizTitle').value = '';
  editingQuiz = res.quiz;
  resetForm();
  clearImport();
  renderEditor();
  $('qPrompt').focus();
});

function renderEditor() {
  renderQuizzes();
  if (!editingQuiz) return;
  $('quizTitle').value = editingQuiz.title;
  const qs = editingQuiz.questions;
  $('qCount').textContent = `(${qs.length})`;
  $('qList').innerHTML = qs.length
    ? qs.map((q, i) => questionRow(q, i, true)).join('')
    : '<span class="empty">No questions yet. Add one below or bulk import.</span>';
}

function questionRow(q, i, withActions) {
  const opts = q.options.map((o, j) => `<span class="o${j === q.correctIndex ? ' right' : ''}">${LETTERS[j]}: ${esc(o)}</span>`).join('');
  const acts = withActions
    ? `<div class="acts">
        <button class="btn btn-sm" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn btn-sm" data-act="down" data-i="${i}" ${i === editingQuiz.questions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn btn-sm" data-act="edit" data-i="${i}">Edit</button>
        <button class="btn btn-sm btn-danger" data-act="del" data-i="${i}">Delete</button>
      </div>`
    : '';
  return `<div class="q-item${withActions && editIndex === i ? ' editing' : ''}">
    <span class="num">${i + 1}</span>
    <div><div class="qt">${esc(q.text)}</div><div class="opts">${opts}</div><div class="meta">${q.duration}s · answer ${LETTERS[q.correctIndex]}</div></div>
    ${acts}
  </div>`;
}

$('qList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const act = btn.dataset.act;
  if (act === 'edit') return startEdit(i);
  if (act === 'del') {
    if (!confirm('Delete this question?')) return;
    const res = await call('quiz:deleteQuestion', { quizId: editingQuiz.id, index: i });
    if (res.quiz) { editingQuiz = res.quiz; if (editIndex !== null) resetForm(); renderEditor(); }
  } else {
    const res = await call('quiz:moveQuestion', { quizId: editingQuiz.id, index: i, dir: act === 'up' ? -1 : 1 });
    if (res.quiz) { editingQuiz = res.quiz; if (editIndex !== null) resetForm(); renderEditor(); }
  }
});

async function renameQuiz() {
  const title = $('quizTitle').value.trim();
  if (!editingQuiz || !title || title === editingQuiz.title) return;
  const res = await call('quiz:rename', { quizId: editingQuiz.id, title });
  if (res.quiz) editingQuiz.title = res.quiz.title;
}
$('quizTitle').addEventListener('change', renameQuiz);
$('quizTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('useQuiz').onclick = async () => {
  await renameQuiz();
  await selectQuiz(editingQuiz.id);
  showView('lobby');
};

$('deleteQuiz').onclick = async () => {
  if (!confirm(`Delete "${editingQuiz.title}" and all its questions?`)) return;
  await call('quiz:delete', { quizId: editingQuiz.id });
  editingQuiz = null;
  renderQuizzes();
};

// Question form: 4 option inputs, each with a "correct" radio
$('optInputs').innerHTML = LETTERS.map((l, i) => `
  <div class="opt-input" id="optWrap${i}">
    <span class="tag tag-${i}">${l}</span>
    <input type="text" id="opt${i}" maxlength="120" placeholder="Option ${l}" required>
    <label><input type="radio" name="correct" value="${i}" ${i === 0 ? 'checked' : ''}> Correct</label>
  </div>`).join('');
$('optInputs').addEventListener('change', markCorrect);
function markCorrect() {
  const c = Number(document.querySelector('input[name=correct]:checked').value);
  LETTERS.forEach((_, i) => $(`optWrap${i}`).classList.toggle('correct', i === c));
}
markCorrect();

function resetForm() {
  editIndex = null;
  $('qForm').reset();
  markCorrect();
  $('formTitle').textContent = 'Add a question';
  $('saveQ').textContent = 'Add question';
  $('cancelEdit').classList.add('hidden');
}

function startEdit(i) {
  const q = editingQuiz.questions[i];
  editIndex = i;
  $('qPrompt').value = q.text;
  q.options.forEach((o, j) => { $(`opt${j}`).value = o; });
  document.querySelector(`input[name=correct][value="${q.correctIndex}"]`).checked = true;
  markCorrect();
  if (![...$('qDuration').options].some((o) => Number(o.value) === q.duration)) {
    $('qDuration').add(new Option(`${q.duration} seconds`, q.duration));
  }
  $('qDuration').value = String(q.duration);
  $('formTitle').textContent = `Edit question ${i + 1}`;
  $('saveQ').textContent = 'Save changes';
  $('cancelEdit').classList.remove('hidden');
  renderEditor();
  $('qForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('cancelEdit').onclick = () => { resetForm(); renderEditor(); };

$('qForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = {
    text: $('qPrompt').value,
    options: LETTERS.map((_, i) => $(`opt${i}`).value),
    correctIndex: Number(document.querySelector('input[name=correct]:checked').value),
    duration: Number($('qDuration').value),
  };
  const res = await call('quiz:saveQuestion', { quizId: editingQuiz.id, index: editIndex, question });
  if (res.error) return flash($('qMsg'), res.error, 'err');
  const wasEdit = editIndex !== null;
  editingQuiz = res.quiz;
  resetForm();
  renderEditor();
  flash($('qMsg'), wasEdit ? 'Saved' : 'Question added', 'ok');
  $('qPrompt').focus();
});

// ---------- Bulk import ----------
function clearImport() {
  pendingImport = [];
  $('preview').classList.add('hidden');
  $('importMsg').textContent = '';
}

function showPreview(result) {
  pendingImport = result.questions || [];
  const errors = result.errors || [];
  $('previewErrors').innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join('');
  $('previewList').innerHTML = pendingImport.map((q, i) => questionRow(q, i, false)).join('');
  $('confirmImport').textContent = `Add ${pendingImport.length} question${pendingImport.length === 1 ? '' : 's'}`;
  $('confirmImport').disabled = !pendingImport.length;
  $('preview').classList.remove('hidden');
  flash($('importMsg'), `${pendingImport.length} found${errors.length ? `, ${errors.length} skipped` : ''}`, pendingImport.length ? 'ok' : 'err');
}

$('previewImport').onclick = async () => {
  showPreview(await call('import:parse', { text: $('importText').value }));
};

$('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  flash($('importMsg'), `Reading ${file.name}…`);
  try {
    const res = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'x-host-key': socket.auth.hostKey || '', 'content-type': 'application/octet-stream' },
      body: file,
    });
    showPreview(await res.json());
  } catch {
    flash($('importMsg'), 'Upload failed.', 'err');
  }
};

$('confirmImport').onclick = async () => {
  const res = await call('quiz:addQuestions', { quizId: editingQuiz.id, questions: pendingImport });
  if (res.error) return flash($('importMsg'), res.error, 'err');
  editingQuiz = res.quiz;
  clearImport();
  $('importText').value = '';
  renderEditor();
  flash($('importMsg'), `Added ${res.added} question${res.added === 1 ? '' : 's'}`, 'ok');
};
$('cancelImport').onclick = clearImport;

// ---------- Game ----------
socket.on('question:start', (q) => {
  showView('game');
  $('board').classList.add('hidden');
  $('skipBtn').classList.remove('hidden');
  $('qMeta').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('qText').textContent = q.text;
  $('options').className = 'options';
  $('options').innerHTML = q.options.map((o, i) =>
    `<div class="opt opt-${i}"><div class="letter"><span>${LETTERS[i]}</span></div><div>${esc(o)}</div><div class="votes"></div></div>`
  ).join('');
  $('progress').textContent = `0 / ${playerCount} answered`;

  const endsAt = q.endsAt + (Date.now() - q.serverNow); // align with server clock
  clearInterval(tick);
  const render = () => {
    const left = Math.max(0, endsAt - Date.now());
    $('timerNum').textContent = Math.ceil(left / 1000);
    $('ring').style.strokeDashoffset = CIRC * (1 - left / (q.duration * 1000));
    $('ring').style.stroke = left < 5000 ? '#e5484d' : '#7c5cff';
    if (left <= 0) clearInterval(tick);
  };
  render();
  tick = setInterval(render, 100);
});

socket.on('question:progress', ({ answered, total }) => {
  $('progress').textContent = `${answered} / ${total} answered`;
});

const fmtSec = (ms) => (ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(2)}s`);

function boardRows(list, showGain) {
  return list.map((p) =>
    `<div class="row"><span class="rank">#${p.rank}</span><span class="name">${esc(p.name)}</span>` +
    `<span class="gain">${showGain && p.lastPoints ? '+' + p.lastPoints : ''}</span>` +
    `<span class="time" title="Fastest correct answer">${fmtSec(p.fastestMs)}</span>` +
    `<span class="score">${p.score}</span></div>`
  ).join('') || '<div class="empty">No players.</div>';
}

function renderBreakdown(counts, noAnswer, correctIndex) {
  const all = [...counts, noAnswer];
  const max = Math.max(1, ...all);
  $('breakdown').innerHTML = all.map((n, i) => {
    const isNone = i === 4;
    const cls = isNone ? 'none' : i === correctIndex ? 'right' : 'dim';
    const label = isNone ? 'None' : `${LETTERS[i]}${i === correctIndex ? ' ✓' : ''}`;
    return `<div class="bar ${cls}"><span class="n">${n}</span>` +
      `<div class="fill ${isNone ? '' : 'opt-' + i}" data-h="${(n / max) * 100}"></div>` +
      `<span class="lbl">${label}</span></div>`;
  }).join('');
  // Grow the bars on the next frame so the transition runs.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('#breakdown .fill').forEach((f) => { f.style.height = `${Math.max(3, f.dataset.h)}%`; });
  }));
}

socket.on('question:end', ({ correctIndex, counts, noAnswer, fastest, leaderboard, isLast }) => {
  clearInterval(tick);
  $('skipBtn').classList.add('hidden');
  $('timerNum').textContent = '0';
  $('ring').style.strokeDashoffset = CIRC;
  $('options').classList.add('revealed');
  document.querySelectorAll('.opt').forEach((el, i) => {
    el.querySelector('.votes').textContent = `${counts[i]} vote${counts[i] === 1 ? '' : 's'}`;
    if (i === correctIndex) el.classList.add('correct');
  });
  const answered = counts.reduce((a, b) => a + b, 0);
  $('progress').textContent = `${answered} of ${answered + noAnswer} answered`;
  renderBreakdown(counts, noAnswer, correctIndex);
  $('fastest').innerHTML = fastest
    ? `Fastest correct answer: <b>${esc(fastest.name)}</b> in <b>${fmtSec(fastest.ms)}</b>`
    : 'Nobody got this one right.';
  $('boardRows').innerHTML = boardRows(leaderboard.slice(0, 10), true);
  $('nextBtn').textContent = isLast ? 'Show podium' : 'Next Question';
  $('board').classList.remove('hidden');
  $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function confetti() {
  const colors = ['#e5484d', '#3e7bfa', '#f5b82e', '#2fb36b', '#7c5cff', '#ffffff'];
  $('confetti').innerHTML = Array.from({ length: 90 }, () => {
    const left = Math.random() * 100;
    const delay = 2.4 + Math.random() * 1.2;
    const c = colors[Math.floor(Math.random() * colors.length)];
    return `<i style="left:${left}%;background:${c};animation-delay:${delay}s;animation-duration:${2.5 + Math.random() * 1.5}s"></i>`;
  }).join('');
}

socket.on('game:end', ({ leaderboard, title }) => {
  clearInterval(tick);
  $('finalTitle').textContent = title;
  const [first, second, third] = leaderboard;
  const step = (p, cls) => p
    ? `<div class="step ${cls}"><div class="medal">${p.rank}</div><div class="who">${esc(p.name)}</div><div class="pts">${p.score} pts</div></div>`
    : '';
  // Re-inserting the nodes restarts the CSS animations on every game.
  $('podium').innerHTML = step(second, 'p2') + step(first, 'p1') + step(third, 'p3');
  $('finalRows').innerHTML = leaderboard.length > 3 ? boardRows(leaderboard.slice(3, 20), false) : '';
  if (first) confetti();
  showView('final');
});

$('nextBtn').onclick = () => socket.emit('host:next');
$('skipBtn').onclick = () => socket.emit('host:skip');
function backToLobby() {
  clearInterval(tick);
  socket.emit('host:lobby');
  showView('lobby');
}
$('lobbyBtn').onclick = () => { if (confirm('End the game and return to the lobby?')) backToLobby(); };
$('finalLobbyBtn').onclick = backToLobby;
