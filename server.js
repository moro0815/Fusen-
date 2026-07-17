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
const PUBLIC_DIR = path.join(__dirname, 'public');

const CATEGORIES = ['normal', 'info', 'caution', 'urgent'];
const ASSIGNEES = ['all', 'reception', 'nurse', 'doctor', 'office'];

let notes = [];

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
  return note;
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
    if (pathname === '/api/notes' && req.method === 'GET') {
      return sendJson(res, 200, { notes });
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
        createdAt: now,
        updatedAt: now,
      });
      if (!note.text.trim()) return sendJson(res, 400, { error: '内容が空です' });
      notes.push(note);
      saveNotes();
      return sendJson(res, 201, { note });
    }

    const noteMatch = pathname.match(/^\/api\/notes\/([0-9a-f]+)$/);
    if (noteMatch) {
      const idx = notes.findIndex((n) => n.id === noteMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: '付箋が見つかりません' });

      if (req.method === 'PUT') {
        const body = await readBody(req);
        const updated = sanitizeNoteInput(body, notes[idx]);
        if (!updated.text.trim()) return sendJson(res, 400, { error: '内容が空です' });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  クリニック共有付箋ボード を起動しました');
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
