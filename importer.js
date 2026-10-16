// Turns pasted text or uploaded files into quiz questions.
// Supported: JSON, structured text ("Q: ... A) ... B) ... Answer: B, Time: 20"),
// PDF (text extracted, then parsed as structured text), Excel (.xlsx) and CSV.

const path = require('path');
const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');

const LETTERS = ['A', 'B', 'C', 'D'];
const DEFAULT_DURATION = 20;
const MIN_DURATION = 5;
const MAX_DURATION = 120;

function clampDuration(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, n));
}

// Accepts a letter (A-D), an index (0-3), or the text of one of the options.
function parseCorrect(value, options) {
  if (value === undefined || value === null || value === '') return -1;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 3 ? value : -1;
  const s = String(value).trim();
  const letter = s.match(/^\(?([A-Da-d])\)?[).]?$/);
  if (letter) return LETTERS.indexOf(letter[1].toUpperCase());
  if (/^[0-3]$/.test(s)) return Number(s);
  const byText = options.findIndex((o) => o.toLowerCase() === s.toLowerCase());
  return byText;
}

// Validates and normalises one question. Returns { question } or { error }.
function normalizeQuestion(raw) {
  const text = String(raw.text ?? '').trim();
  const options = (raw.options || []).map((o) => String(o ?? '').trim());
  if (!text) return { error: 'missing question text' };
  if (options.length !== 4 || options.some((o) => !o)) return { error: 'needs exactly 4 options (A-D)' };
  const correctIndex = parseCorrect(raw.correct, options);
  if (correctIndex < 0) return { error: 'missing or invalid answer (use A-D or 0-3)' };
  return {
    question: {
      text: text.slice(0, 300),
      options: options.map((o) => o.slice(0, 120)),
      correctIndex,
      duration: clampDuration(raw.duration),
    },
  };
}

function collect(rawList, label) {
  const questions = [];
  const errors = [];
  rawList.forEach((raw, i) => {
    const res = normalizeQuestion(raw);
    if (res.error) {
      const preview = String(raw.text || '').trim().slice(0, 40);
      errors.push(`${label} ${i + 1}${preview ? ` ("${preview}")` : ''}: ${res.error}`);
    } else {
      questions.push(res.question);
    }
  });
  return { questions, errors };
}

// ---------- JSON ----------
function pick(obj, keys) {
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase())) return obj[k];
  }
  return undefined;
}

function fromJsonItem(item) {
  if (!item || typeof item !== 'object') return { text: '' };
  let options = pick(item, ['options', 'answers', 'choices']);
  if (!Array.isArray(options)) options = LETTERS.map((l) => pick(item, [l.toLowerCase(), `option${l.toLowerCase()}`, `option_${l.toLowerCase()}`]));
  return {
    text: pick(item, ['text', 'question', 'prompt', 'q']),
    options,
    correct: pick(item, ['correctindex', 'correct', 'answer', 'correct_answer', 'correctanswer']),
    duration: pick(item, ['duration', 'time', 'timer', 'seconds']),
  };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { questions: [], errors: [`Invalid JSON: ${e.message}`] };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : null;
  if (!list) return { questions: [], errors: ['JSON must be an array of questions or { "questions": [...] }'] };
  const result = collect(list.map(fromJsonItem), 'Question');
  if (!Array.isArray(data) && data.title) result.title = String(data.title).slice(0, 80);
  return result;
}

// ---------- Structured text ----------
// Works on multi-line text and on text flattened onto one line (as PDFs often are).
function parseStructuredText(text) {
  const normalized = text
    .replace(/\r/g, '')
    // "1. What is..." at the start of a line counts as a question marker
    .replace(/^\s*\d+\s*[.)]\s+/gm, 'Q: ')
    .replace(/\s+/g, ' ');

  const blocks = normalized
    .split(/(?:^|\s)(?:Q(?:uestion)?\s*\d*\s*[:.)])\s*/i)
    .map((b) => b.trim())
    .filter(Boolean);
  // Ignore a heading or intro before the first "Q:" (common at the top of a PDF).
  if (blocks.length > 1 && !/^\s*Q(?:uestion)?\s*\d*\s*[:.)]/i.test(normalized)) blocks.shift();

  const raws = blocks.map((block) => {
    const answerMatch = block.match(/\b(?:Answer|Correct(?:\s+answer)?|Ans)\s*[:=-]\s*\(?([A-Da-d0-3])\)?(?![\w])/i);
    const timeMatch = block.match(/\b(?:Time|Timer|Duration|Seconds)\s*[:=-]\s*(\d+)/i);

    // Everything before "Answer:" / "Time:" holds the prompt and the options.
    const cut = block.search(/\b(?:Answer|Correct(?:\s+answer)?|Ans|Time|Timer|Duration|Seconds)\s*[:=-]/i);
    const body = cut >= 0 ? block.slice(0, cut) : block;

    // Option markers: "A)", "A.", "A:", "(A)" preceded by start or whitespace.
    const markers = [];
    let from = 0;
    for (const letter of LETTERS) {
      const re = new RegExp(`(?:^|\\s)\\(?${letter}\\s*[).:]\\s*`, 'gi');
      re.lastIndex = from;
      const m = re.exec(body);
      if (!m) break;
      markers.push({ start: m.index, contentStart: m.index + m[0].length });
      from = m.index + m[0].length;
    }

    const textEnd = markers.length ? markers[0].start : body.length;
    const options = markers.map((m, i) => body.slice(m.contentStart, i + 1 < markers.length ? markers[i + 1].start : body.length).replace(/[\s,;]+$/, '').trim());

    return {
      text: body.slice(0, textEnd).trim(),
      options,
      correct: answerMatch ? answerMatch[1] : undefined,
      duration: timeMatch ? timeMatch[1] : undefined,
    };
  });

  if (!raws.length) return { questions: [], errors: ['No questions found. Start each question with "Q:".'] };
  return collect(raws, 'Question');
}

function parseText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { questions: [], errors: ['Nothing to import.'] };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(trimmed);
  return parseStructuredText(trimmed);
}

// ---------- Spreadsheets (Excel / CSV) ----------
const COLUMN_ALIASES = {
  text: ['question', 'prompt', 'text', 'q'],
  a: ['a', 'option a', 'optiona', 'option_a', 'answer a', 'choice a'],
  b: ['b', 'option b', 'optionb', 'option_b', 'answer b', 'choice b'],
  c: ['c', 'option c', 'optionc', 'option_c', 'answer c', 'choice c'],
  d: ['d', 'option d', 'optiond', 'option_d', 'answer d', 'choice d'],
  correct: ['answer', 'correct', 'correct answer', 'correctindex', 'correct_answer', 'correct option'],
  duration: ['time', 'timer', 'duration', 'seconds', 'time (s)'],
};

// rows: array of arrays of cell strings
function parseRows(rows) {
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!rows.length) return { questions: [], errors: ['The sheet is empty.'] };

  const header = rows[0].map((c) => String(c ?? '').trim().toLowerCase());
  const cols = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) cols[field] = idx;
  }
  const hasHeader = cols.text !== undefined;
  // Without a header, assume: Question, A, B, C, D, Answer, Time
  const map = hasHeader ? cols : { text: 0, a: 1, b: 2, c: 3, d: 4, correct: 5, duration: 6 };
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const cell = (row, field) => (map[field] === undefined ? undefined : row[map[field]]);

  const raws = dataRows.map((row) => ({
    text: cell(row, 'text'),
    options: ['a', 'b', 'c', 'd'].map((f) => cell(row, f)),
    correct: cell(row, 'correct'),
    duration: cell(row, 'duration'),
  }));
  return collect(raws, 'Row');
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
  }
  return typeof v === 'number' ? v : String(v);
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { questions: [], errors: ['The workbook has no sheets.'] };
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    for (let i = 1; i <= Math.max(row.cellCount, 7); i++) values.push(cellValue(row.getCell(i).value));
    rows.push(values);
  });
  return parseRows(rows);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const delimiter = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return parseRows(rows);
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    return parseText(text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, ' '));
  } finally {
    await parser.destroy();
  }
}

async function parseFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  switch (ext) {
    case '.pdf': return parsePdf(buffer);
    case '.xlsx': return parseXlsx(buffer);
    case '.csv': return parseCsv(buffer.toString('utf8'));
    case '.json':
    case '.txt':
    case '.md': return parseText(buffer.toString('utf8'));
    case '.xls': return { questions: [], errors: ['Old .xls files are not supported. Save the sheet as .xlsx or .csv and try again.'] };
    default: return { questions: [], errors: [`Unsupported file type "${ext || filename}". Use PDF, XLSX, CSV, JSON or TXT.`] };
  }
}

module.exports = { parseText, parseFile, normalizeQuestion, clampDuration, DEFAULT_DURATION };
