/**
 * クリニック共有付箋ボード - サーバー
 *
 * 依存パッケージなし（Node.js 標準機能のみで動作）
 * 起動: node server.js
 * アクセス: http://<このPCのIPアドレス>:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const PATIENTS_FILE = path.join(DATA_DIR, 'patients.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CATEGORIES = ['normal', 'info', 'caution', 'urgent'];
const ASSIGNEES = ['all', 'reception', 'nurse', 'doctor', 'office'];

// 患者フローボードの状態（動線の各段階）
const PATIENT_STATUSES = ['reception', 'waiting', 'consulting', 'treatment', 'checkout', 'done'];

// 完了にした付箋を自動削除するまでの日数
const DONE_RETENTION_DAYS = 7;
// 「完了」にした患者をボードから自動的に消すまでの時間
const PATIENT_DONE_RETENTION_HOURS = 3;

let notes = [];
let patients = [];
let templates = [];

// 端末レジストリ: 端末名 -> 最終アクセス時刻(ms)。
// ポーリング時に ?device=端末名 を付けてもらうことで自動登録される。
let devices = {};
const ONLINE_THRESHOLD_MS = 30 * 1000;

function loadDevices() {
  try {
    const names = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    if (Array.isArray(names)) names.forEach((n) => { if (typeof n === 'string') devices[n] = 0; });
  } catch (e) { /* ファイルなし */ }
}

function saveDevices() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DEVICES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.keys(devices).sort(), null, 2), 'utf8');
  fs.renameSync(tmp, DEVICES_FILE);
}

function deviceList() {
  const now = Date.now();
  return Object.keys(devices).sort().map((name) => ({
    name,
    online: now - devices[name] < ONLINE_THRESHOLD_MS,
  }));
}

function loadNotes() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) notes = parsed;
  } catch (e) {
    notes = [];
  }
}

function saveNotes() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function sanitizeText(v, max) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}

function sanitizeNoteInput(body, base) {
  const note = Object.assign({}, base);
  if ('text' in body) note.text = sanitizeText(body.text, 2000);
  if ('author' in body) note.author = sanitizeText(body.author, 50);
  if ('category' in body && CATEGORIES.includes(body.category)) note.category = body.category;
  if ('assignee' in body && ASSIGNEES.includes(body.assignee)) note.assignee = body.assignee;
  if ('visible' in body) note.visible = !!body.visible;
  if ('done' in body) note.done = !!body.done;
  if ('popup' in body) note.popup = !!body.popup;
  if ('popupTarget' in body) note.popupTarget = sanitizeText(body.popupTarget, 30) || 'all';
  if ('pinned' in body) note.pinned = !!body.pinned;
  if ('dueAt' in body) {
    if (typeof body.dueAt === 'string' && body.dueAt && !isNaN(Date.parse(body.dueAt))) {
      note.dueAt = new Date(body.dueAt).toISOString();
    } else {
      note.dueAt = null;
    }
  }
  // acks(確認履歴)はクライアントから直接書き換えられないよう、ここでは受け取らない
  return note;
}

// 完了から一定日数たった付箋を自動削除してボードを整理する
function cleanupDoneNotes() {
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const before = notes.length;
  notes = notes.filter((n) => !(n.done && new Date(n.updatedAt).getTime() < cutoff));
  if (notes.length !== before) saveNotes();
}

// ---- 患者フローボード ----
function loadPatients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATIENTS_FILE, 'utf8'));
    if (Array.isArray(parsed)) patients = parsed;
  } catch (e) { patients = []; }
}

function savePatients() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PATIENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(patients, null, 2), 'utf8');
  fs.renameSync(tmp, PATIENTS_FILE);
}

function sanitizePatientInput(body, base) {
  const p = Object.assign({}, base);
  if ('number' in body) p.number = sanitizeText(String(body.number == null ? '' : body.number), 12).trim();
  if ('memo' in body) p.memo = sanitizeText(body.memo, 60);
  if ('status' in body && PATIENT_STATUSES.includes(body.status)) p.status = body.status;
  return p;
}

// 完了にした患者を一定時間後にボードから自動で消す（1日の自然な入れ替わり）
function cleanupDonePatients() {
  const cutoff = Date.now() - PATIENT_DONE_RETENTION_HOURS * 60 * 60 * 1000;
  const before = patients.length;
  patients = patients.filter((p) => !(p.status === 'done' && new Date(p.statusChangedAt || p.updatedAt).getTime() < cutoff));
  if (patients.length !== before) savePatients();
}

// ---- クイックテンプレート ----
const DEFAULT_TEMPLATES = [
  { label: '採血お願いします', text: '採血お願いします', category: 'caution', assignee: 'nurse' },
  { label: 'Dr呼び出し', text: '至急、診察室へお願いします（Dr呼び出し）', category: 'urgent', assignee: 'doctor' },
  { label: '処置室へご案内', text: '処置室へご案内をお願いします', category: 'info', assignee: 'nurse' },
  { label: '会計へご案内', text: '会計の準備ができました。ご案内をお願いします', category: 'info', assignee: 'reception' },
  { label: '次の方どうぞ', text: '次の患者様をお呼びください', category: 'info', assignee: 'reception' },
];

function loadTemplates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    if (Array.isArray(parsed)) { templates = parsed; return; }
  } catch (e) { /* ファイルなし → 既定テンプレートで初期化 */ }
  templates = DEFAULT_TEMPLATES.map((t) => ({
    id: crypto.randomBytes(6).toString('hex'),
    label: t.label, text: t.text, category: t.category, assignee: t.assignee,
  }));
  saveTemplates();
}

function saveTemplates() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = TEMPLATES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(templates, null, 2), 'utf8');
  fs.renameSync(tmp, TEMPLATES_FILE);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // --- API ---
    // まとめて取得（付箋・端末・患者・テンプレートを1回で）。5秒ごとのポーリング用。
    if ((pathname === '/api/state' || pathname === '/api/notes') && req.method === 'GET') {
      const dev = sanitizeText(url.searchParams.get('device') || '', 30).trim();
      if (dev) {
        const isNew = !(dev in devices);
        devices[dev] = Date.now();
        if (isNew) saveDevices();
      }
      return sendJson(res, 200, { notes, devices: deviceList(), patients, templates });
    }

    // ===== 患者フローボード =====
    if (pathname === '/api/patients' && req.method === 'POST') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const p = sanitizePatientInput(body, {
        id: crypto.randomBytes(8).toString('hex'),
        number: '', memo: '', status: 'reception',
        createdAt: now, updatedAt: now, statusChangedAt: now,
      });
      if (!p.number) return sendJson(res, 400, { error: '受付番号を入力してください' });
      patients.push(p);
      savePatients();
      return sendJson(res, 201, { patient: p });
    }

    if (pathname === '/api/patients/clear-done' && req.method === 'POST') {
      patients = patients.filter((p) => p.status !== 'done');
      savePatients();
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/patients/clear-all' && req.method === 'POST') {
      patients = [];
      savePatients();
      return sendJson(res, 200, { ok: true });
    }

    const patMatch = pathname.match(/^\/api\/patients\/([0-9a-f]+)$/);
    if (patMatch) {
      const idx = patients.findIndex((p) => p.id === patMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: '患者が見つかりません' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const old = patients[idx];
        const updated = sanitizePatientInput(body, old);
        if (!updated.number) return sendJson(res, 400, { error: '受付番号を入力してください' });
        const now = new Date().toISOString();
        if (updated.status !== old.status) updated.statusChangedAt = now;
        updated.updatedAt = now;
        patients[idx] = updated;
        savePatients();
        return sendJson(res, 200, { patient: updated });
      }
      if (req.method === 'DELETE') {
        patients.splice(idx, 1);
        savePatients();
        return sendJson(res, 200, { ok: true });
      }
    }

    // ===== クイックテンプレート =====
    if (pathname === '/api/templates' && req.method === 'POST') {
      const body = await readBody(req);
      const label = sanitizeText(body.label, 30).trim();
      const text = sanitizeText(body.text, 500).trim();
      if (!label || !text) return sendJson(res, 400, { error: 'ラベルと内容を入力してください' });
      const tpl = {
        id: crypto.randomBytes(6).toString('hex'),
        label, text,
        category: CATEGORIES.includes(body.category) ? body.category : 'info',
        assignee: ASSIGNEES.includes(body.assignee) ? body.assignee : 'all',
      };
      templates.push(tpl);
      saveTemplates();
      return sendJson(res, 201, { template: tpl });
    }
    const tplMatch = pathname.match(/^\/api\/templates\/([0-9a-f]+)$/);
    if (tplMatch && req.method === 'DELETE') {
      const before = templates.length;
      templates = templates.filter((t) => t.id !== tplMatch[1]);
      if (templates.length !== before) saveTemplates();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const note = sanitizeNoteInput(body, {
        id: crypto.randomBytes(8).toString('hex'),
        text: '',
        author: '',
        category: 'normal',
        assignee: 'all',
        visible: true,
        done: false,
        popup: false,
        popupTarget: 'all',
        popupAt: null,
        pinned: false,
        dueAt: null,
        acks: [],
        createdAt: now,
        updatedAt: now,
      });
      if (!note.text.trim()) return sendJson(res, 400, { error: '内容が空です' });
      if (note.popup) note.popupAt = now;
      notes.push(note);
      saveNotes();
      return sendJson(res, 201, { note });
    }

    // ポップアップの確認記録: どの端末の誰がいつ確認したかを付箋に残す
    const ackMatch = pathname.match(/^\/api\/notes\/([0-9a-f]+)\/ack$/);
    if (ackMatch && req.method === 'POST') {
      const note = notes.find((n) => n.id === ackMatch[1]);
      if (!note) return sendJson(res, 404, { error: '付箋が見つかりません' });
      const body = await readBody(req);
      const device = sanitizeText(body.device || '', 30).trim() || '(端末名未設定)';
      const name = sanitizeText(body.name || '', 50).trim();
      if (!Array.isArray(note.acks)) note.acks = [];
      // 同じ通知(popupAt)を同じ端末が二重に記録しないようにする
      const already = note.acks.some((a) => a.popupAt === note.popupAt && a.device === device);
      if (!already) {
        note.acks.push({ device, name, at: new Date().toISOString(), popupAt: note.popupAt });
        saveNotes();
      }
      return sendJson(res, 200, { note });
    }

    const noteMatch = pathname.match(/^\/api\/notes\/([0-9a-f]+)$/);
    if (noteMatch) {
      const idx = notes.findIndex((n) => n.id === noteMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: '付箋が見つかりません' });

      if (req.method === 'PUT') {
        const body = await readBody(req);
        const old = notes[idx];
        const updated = sanitizeNoteInput(body, old);
        if (!updated.text.trim()) return sendJson(res, 400, { error: '内容が空です' });
        // ポップアップが新たにONになった、または内容/宛先端末が変わったら再通知する
        if (updated.popup && (!old.popup || updated.text !== old.text || updated.popupTarget !== old.popupTarget)) {
          updated.popupAt = new Date().toISOString();
        }
        updated.updatedAt = new Date().toISOString();
        notes[idx] = updated;
        saveNotes();
        return sendJson(res, 200, { note: updated });
      }

      if (req.method === 'DELETE') {
        notes.splice(idx, 1);
        saveNotes();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    // --- 静的ファイル ---
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 400, { error: e.message || 'bad request' });
  }
});

loadNotes();
loadDevices();
loadPatients();
loadTemplates();
cleanupDoneNotes();
cleanupDonePatients();
setInterval(function () {
  cleanupDoneNotes();     // 古い完了付箋を掃除
  cleanupDonePatients();  // 完了した患者をボードから掃除
}, 10 * 60 * 1000); // 10分ごと

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  クリニック共有ボード（付箋＋患者フロー）を起動しました');
  console.log('==========================================');
  console.log('');
  console.log('  このPCでは:  http://localhost:' + PORT);
  console.log('');
  console.log('  院内の他のPCからは、以下のいずれかのアドレスを');
  console.log('  ブラウザで開いてください:');
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('    http://' + iface.address + ':' + PORT);
      }
    }
  }
  console.log('');
  console.log('  終了するには Ctrl+C を押してください。');
});
