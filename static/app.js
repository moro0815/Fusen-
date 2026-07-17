/* ===== 院内ふせんボード フロントエンド ===== */
"use strict";

const POLL_INTERVAL_MS = 5000;

const state = {
  departments: [],
  notes: [],
  archiveNotes: [],
  view: "board", // "board" | "archive"
  search: "",
  editingNoteId: null, // null = 新規作成
  selectedColor: "yellow",
  knownNoteIds: null, // 初回ロード後に Set。新着検知に使う
  lastStateJson: "",
};

const $ = (id) => document.getElementById(id);

/* ---------- ユーティリティ ---------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(epochSec) {
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return "たった今";
  if (diff < 3600) return Math.floor(diff / 60) + "分前";
  if (diff < 86400) return Math.floor(diff / 3600) + "時間前";
  const d = new Date(epochSec * 1000);
  return d.getMonth() + 1 + "/" + d.getDate() + " " +
    d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空レスポンス */ }
  if (!res.ok) {
    const msg = (data && data.error) || "通信エラーが発生しました";
    throw new Error(msg);
  }
  return data;
}

function showToast(message, urgent) {
  const el = document.createElement("div");
  el.className = "toast" + (urgent ? " toast-urgent" : "");
  el.textContent = message;
  $("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ---------- データ取得 (5秒ごとに自動更新) ---------- */

async function refresh() {
  let data;
  try {
    data = await api("/api/state");
    $("conn-status").hidden = true;
  } catch (e) {
    $("conn-status").hidden = false;
    return;
  }

  // 新着付箋の検知 (自分の初回ロードは除く)
  if (state.knownNoteIds !== null) {
    for (const n of data.notes) {
      if (!state.knownNoteIds.has(n.id)) {
        const dept = data.departments.find((d) => d.id === n.department_id);
        const deptName = dept ? dept.name : "";
        showToast(
          (n.urgent ? "🔴 至急: " : "🗒️ ") + "「" + deptName + "」に新しい付箋が届きました",
          !!n.urgent
        );
      }
    }
  }
  state.knownNoteIds = new Set(data.notes.map((n) => n.id));

  const json = JSON.stringify(data);
  if (json === state.lastStateJson) return; // 変化なしなら再描画しない
  state.lastStateJson = json;
  state.departments = data.departments;
  state.notes = data.notes;
  renderBoard();
  renderDeptOptions();
}

/* ---------- ボード描画 ---------- */

function noteMatchesSearch(note) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return (
    note.content.toLowerCase().includes(q) ||
    (note.author || "").toLowerCase().includes(q)
  );
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (const dept of state.departments) {
    const notes = state.notes.filter(
      (n) => n.department_id === dept.id && noteMatchesSearch(n)
    );

    const col = document.createElement("section");
    col.className = "column";
    col.innerHTML =
      '<div class="column-head">' +
      '<span class="column-title">' + escapeHtml(dept.name) + "</span>" +
      '<span class="column-count">' + notes.length + "</span>" +
      '<button class="column-add" title="この部署に付箋を貼る" data-dept="' +
      dept.id + '">＋</button>' +
      "</div>" +
      '<div class="column-notes"></div>';

    const notesEl = col.querySelector(".column-notes");
    if (notes.length === 0) {
      notesEl.innerHTML = '<div class="column-empty">付箋はありません</div>';
    } else {
      for (const note of notes) notesEl.appendChild(renderNote(note));
    }
    board.appendChild(col);
  }
}

function renderNote(note) {
  const el = document.createElement("article");
  el.className = "note color-" + note.color + (note.urgent ? " urgent" : "");
  el.dataset.id = note.id;

  let badges = "";
  if (note.urgent) badges += '<span class="badge-urgent">至急</span>';
  if (note.pinned) badges += '<span class="badge-pin">📌</span>';

  const meta = [note.author, formatTime(note.created_at)]
    .filter(Boolean)
    .join(" · ");

  el.innerHTML =
    (badges ? '<div class="note-badges">' + badges + "</div>" : "") +
    '<div class="note-content">' + escapeHtml(note.content) + "</div>" +
    '<div class="note-footer">' +
    '<span class="note-meta">' + escapeHtml(meta) + "</span>" +
    '<span class="note-actions">' +
    '<button class="note-btn pin-btn" title="' +
    (note.pinned ? "ピン留めを外す" : "ピン留め (上に固定)") + '">📌</button>' +
    '<button class="note-btn done-btn" title="完了にする">✔</button>' +
    "</span></div>";
  return el;
}

function renderDeptOptions() {
  const select = $("note-dept");
  const current = select.value;
  select.innerHTML = state.departments
    .map((d) => '<option value="' + d.id + '">' + escapeHtml(d.name) + "</option>")
    .join("");
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

/* ---------- 付箋モーダル ---------- */

function selectColor(color) {
  state.selectedColor = color;
  document.querySelectorAll(".color-swatch").forEach((el) => {
    el.classList.toggle("selected", el.dataset.color === color);
  });
}

function openNoteModal(note, presetDeptId) {
  state.editingNoteId = note ? note.id : null;
  $("note-modal-title").textContent = note ? "付箋の編集" : "新しい付箋";
  $("note-save-btn").textContent = note ? "保存" : "貼る";
  $("note-delete-btn").hidden = !note;
  $("note-content").value = note ? note.content : "";
  $("note-urgent").checked = note ? !!note.urgent : false;
  $("note-author").value = note
    ? note.author
    : localStorage.getItem("fusen_author") || "";
  renderDeptOptions();
  $("note-dept").value = note ? note.department_id : (presetDeptId || state.departments[0]?.id || "");
  selectColor(note ? note.color : "yellow");
  $("note-error").hidden = true;
  $("note-modal").hidden = false;
  $("note-content").focus();
}

function closeNoteModal() {
  $("note-modal").hidden = true;
  state.editingNoteId = null;
}

async function saveNote() {
  const payload = {
    content: $("note-content").value,
    department_id: parseInt($("note-dept").value, 10),
    color: state.selectedColor,
    urgent: $("note-urgent").checked,
    author: $("note-author").value.trim(),
  };
  localStorage.setItem("fusen_author", payload.author);
  try {
    if (state.editingNoteId === null) {
      const created = await api("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (state.knownNoteIds) state.knownNoteIds.add(created.id); // 自分の投稿は新着通知しない
    } else {
      await api("/api/notes/" + state.editingNoteId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    closeNoteModal();
    state.lastStateJson = "";
    await refresh();
  } catch (e) {
    $("note-error").textContent = e.message;
    $("note-error").hidden = false;
  }
}

async function deleteEditingNote() {
  if (state.editingNoteId === null) return;
  if (!confirm("この付箋を削除します。よろしいですか?")) return;
  try {
    await api("/api/notes/" + state.editingNoteId, { method: "DELETE" });
    closeNoteModal();
    state.lastStateJson = "";
    await refresh();
  } catch (e) {
    $("note-error").textContent = e.message;
    $("note-error").hidden = false;
  }
}

async function updateNoteFlags(id, fields) {
  try {
    await api("/api/notes/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    state.lastStateJson = "";
    await refresh();
  } catch (e) {
    showToast("⚠ " + e.message, true);
  }
}

/* ---------- アーカイブ ---------- */

async function openArchive() {
  state.view = "archive";
  $("board").hidden = true;
  $("archive").hidden = false;
  await refreshArchive();
}

function closeArchive() {
  state.view = "board";
  $("archive").hidden = true;
  $("board").hidden = false;
}

async function refreshArchive() {
  let data;
  try {
    data = await api("/api/archive");
  } catch (e) {
    showToast("⚠ " + e.message, true);
    return;
  }
  state.archiveNotes = data.notes;
  const list = $("archive-list");
  list.innerHTML = "";
  if (data.notes.length === 0) {
    list.innerHTML = '<div class="archive-empty">完了済みの付箋はありません</div>';
    return;
  }
  const deptName = (id) => {
    const d = state.departments.find((x) => x.id === id);
    return d ? d.name : "";
  };
  for (const note of data.notes) {
    const item = document.createElement("div");
    item.className = "archive-item";
    item.dataset.id = note.id;
    const meta = [
      deptName(note.department_id),
      note.author,
      "完了: " + formatTime(note.done_at || note.updated_at),
    ]
      .filter(Boolean)
      .join(" · ");
    item.innerHTML =
      '<span class="archive-color color-' + note.color + '"></span>' +
      '<div class="archive-body">' +
      '<div class="archive-content">' + escapeHtml(note.content) + "</div>" +
      '<div class="archive-meta">' + escapeHtml(meta) + "</div>" +
      "</div>" +
      '<span class="archive-actions">' +
      '<button class="btn restore-btn">↩ 戻す</button>' +
      '<button class="btn btn-danger purge-btn">削除</button>' +
      "</span>";
    list.appendChild(item);
  }
}

/* ---------- 部署設定 ---------- */

function openSettings() {
  renderDeptList();
  $("dept-new-name").value = "";
  $("dept-error").hidden = true;
  $("settings-modal").hidden = false;
}

function renderDeptList() {
  const list = $("dept-list");
  list.innerHTML = "";
  state.departments.forEach((dept, i) => {
    const row = document.createElement("div");
    row.className = "dept-item";
    row.dataset.id = dept.id;
    row.innerHTML =
      '<input type="text" value="' + escapeHtml(dept.name) + '" maxlength="20">' +
      '<button class="btn dept-rename-btn">変更</button>' +
      (i === 0
        ? ""
        : '<button class="btn btn-danger dept-delete-btn">削除</button>');
    list.appendChild(row);
  });
}

function showDeptError(msg) {
  $("dept-error").textContent = msg;
  $("dept-error").hidden = false;
}

async function afterDeptChange() {
  $("dept-error").hidden = true;
  state.lastStateJson = "";
  await refresh();
  renderDeptList();
}

/* ---------- イベント設定 ---------- */

function setupEvents() {
  $("new-note-btn").addEventListener("click", () => openNoteModal(null));
  $("archive-btn").addEventListener("click", openArchive);
  $("archive-back-btn").addEventListener("click", closeArchive);
  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close-btn").addEventListener("click", () => {
    $("settings-modal").hidden = true;
  });

  $("search-input").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    renderBoard();
  });

  // ボード上のクリック (列の＋ / 付箋のボタン / 付箋本体)
  $("board").addEventListener("click", (e) => {
    const addBtn = e.target.closest(".column-add");
    if (addBtn) {
      openNoteModal(null, parseInt(addBtn.dataset.dept, 10));
      return;
    }
    const noteEl = e.target.closest(".note");
    if (!noteEl) return;
    const id = parseInt(noteEl.dataset.id, 10);
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;

    if (e.target.closest(".done-btn")) {
      updateNoteFlags(id, { done: true });
    } else if (e.target.closest(".pin-btn")) {
      updateNoteFlags(id, { pinned: !note.pinned });
    } else {
      openNoteModal(note);
    }
  });

  // アーカイブ内のボタン
  $("archive-list").addEventListener("click", async (e) => {
    const item = e.target.closest(".archive-item");
    if (!item) return;
    const id = parseInt(item.dataset.id, 10);
    try {
      if (e.target.closest(".restore-btn")) {
        await api("/api/notes/" + id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ done: false }),
        });
        showToast("付箋をボードに戻しました");
      } else if (e.target.closest(".purge-btn")) {
        if (!confirm("この付箋を完全に削除します。よろしいですか?")) return;
        await api("/api/notes/" + id, { method: "DELETE" });
      } else {
        return;
      }
      state.lastStateJson = "";
      await refresh();
      await refreshArchive();
    } catch (err) {
      showToast("⚠ " + err.message, true);
    }
  });

  // 付箋モーダル
  $("note-save-btn").addEventListener("click", saveNote);
  $("note-cancel-btn").addEventListener("click", closeNoteModal);
  $("note-delete-btn").addEventListener("click", deleteEditingNote);
  $("color-picker").addEventListener("click", (e) => {
    const swatch = e.target.closest(".color-swatch");
    if (swatch) selectColor(swatch.dataset.color);
  });
  $("note-modal").addEventListener("click", (e) => {
    if (e.target === $("note-modal")) closeNoteModal();
  });
  // Ctrl+Enter (または Cmd+Enter) で保存
  $("note-content").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") saveNote();
  });

  // 部署設定モーダル
  $("settings-modal").addEventListener("click", (e) => {
    if (e.target === $("settings-modal")) $("settings-modal").hidden = true;
  });
  $("dept-add-btn").addEventListener("click", async () => {
    const name = $("dept-new-name").value.trim();
    try {
      await api("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      $("dept-new-name").value = "";
      await afterDeptChange();
    } catch (err) {
      showDeptError(err.message);
    }
  });
  $("dept-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("dept-add-btn").click();
  });
  $("dept-list").addEventListener("click", async (e) => {
    const row = e.target.closest(".dept-item");
    if (!row) return;
    const id = parseInt(row.dataset.id, 10);
    try {
      if (e.target.closest(".dept-rename-btn")) {
        const name = row.querySelector("input").value.trim();
        await api("/api/departments/" + id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        await afterDeptChange();
      } else if (e.target.closest(".dept-delete-btn")) {
        const dept = state.departments.find((d) => d.id === id);
        if (
          !confirm(
            "部署「" + (dept ? dept.name : "") + "」を削除します。\n" +
            "この部署あての付箋は先頭の列に移動されます。よろしいですか?"
          )
        )
          return;
        await api("/api/departments/" + id, { method: "DELETE" });
        await afterDeptChange();
      }
    } catch (err) {
      showDeptError(err.message);
    }
  });

  // Esc キーでモーダルを閉じる
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("note-modal").hidden) closeNoteModal();
      if (!$("settings-modal").hidden) $("settings-modal").hidden = true;
    }
  });
}

/* ---------- 起動 ---------- */

setupEvents();
refresh();
setInterval(() => {
  refresh();
  if (state.view === "archive") refreshArchive();
}, POLL_INTERVAL_MS);
