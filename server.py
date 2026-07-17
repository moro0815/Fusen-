#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
院内ふせんボード - サーバー本体

Python 標準ライブラリのみで動作する、付箋型メッセージ共有システムです。
院内ネットワーク上の PC 1 台でこのファイルを実行し、
各端末のブラウザから http://<このPCのIPアドレス>:8420/ を開いて使います。

起動方法:  python server.py
ポート変更: 環境変数 FUSEN_PORT で指定 (例: FUSEN_PORT=8080 python server.py)
データ保存: 同じフォルダの fusen.db (SQLite) に保存されます。
"""
import json
import os
import re
import socket
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "fusen.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = int(os.environ.get("FUSEN_PORT", "8420"))

ALLOWED_COLORS = {"yellow", "pink", "blue", "green", "purple"}
DEFAULT_DEPARTMENTS = ["全体", "受付", "診察室", "処置室", "検査室"]
MAX_CONTENT_LEN = 2000
MAX_AUTHOR_LEN = 50
MAX_DEPT_NAME_LEN = 20

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS departments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS notes (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            content       TEXT    NOT NULL,
            department_id INTEGER NOT NULL DEFAULT 1,
            color         TEXT    NOT NULL DEFAULT 'yellow',
            urgent        INTEGER NOT NULL DEFAULT 0,
            pinned        INTEGER NOT NULL DEFAULT 0,
            author        TEXT    NOT NULL DEFAULT '',
            done          INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            done_at       INTEGER
        );
        """
    )
    count = conn.execute("SELECT COUNT(*) AS c FROM departments").fetchone()["c"]
    if count == 0:
        for i, name in enumerate(DEFAULT_DEPARTMENTS):
            conn.execute(
                "INSERT INTO departments(name, sort_order) VALUES(?, ?)", (name, i)
            )
    conn.commit()
    conn.close()


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "FusenBoard/1.0"

    # ---------- 共通ユーティリティ ----------

    def log_message(self, fmt, *args):
        pass  # アクセスログは出力しない (コンソールを起動情報だけに保つ)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "リクエストの形式が正しくありません")
        if not isinstance(data, dict):
            raise ApiError(400, "リクエストの形式が正しくありません")
        return data

    # ---------- ルーティング ----------

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        path = self.path.split("?", 1)[0]
        try:
            if path.startswith("/api/"):
                self.handle_api(method, path)
            elif method == "GET":
                self.serve_static(path)
            else:
                self.send_json({"error": "not found"}, 404)
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # 想定外エラーでもサーバーは止めない
            print("エラー:", e)
            try:
                self.send_json({"error": "サーバー内部エラー"}, 500)
            except OSError:
                pass

    def handle_api(self, method, path):
        conn = get_db()
        try:
            note_m = re.fullmatch(r"/api/notes/(\d+)", path)
            dept_m = re.fullmatch(r"/api/departments/(\d+)", path)

            if method == "GET" and path == "/api/state":
                self.api_state(conn)
            elif method == "GET" and path == "/api/archive":
                self.api_archive(conn)
            elif method == "POST" and path == "/api/notes":
                self.api_create_note(conn)
            elif method == "PUT" and note_m:
                self.api_update_note(conn, int(note_m.group(1)))
            elif method == "DELETE" and note_m:
                self.api_delete_note(conn, int(note_m.group(1)))
            elif method == "POST" and path == "/api/departments":
                self.api_create_department(conn)
            elif method == "PUT" and dept_m:
                self.api_update_department(conn, int(dept_m.group(1)))
            elif method == "DELETE" and dept_m:
                self.api_delete_department(conn, int(dept_m.group(1)))
            else:
                raise ApiError(404, "not found")
        finally:
            conn.close()

    # ---------- API 実装 ----------

    def api_state(self, conn):
        departments = rows_to_dicts(
            conn.execute("SELECT * FROM departments ORDER BY sort_order, id")
        )
        notes = rows_to_dicts(
            conn.execute(
                "SELECT * FROM notes WHERE done = 0 "
                "ORDER BY pinned DESC, urgent DESC, created_at DESC"
            )
        )
        self.send_json({"departments": departments, "notes": notes})

    def api_archive(self, conn):
        notes = rows_to_dicts(
            conn.execute(
                "SELECT * FROM notes WHERE done = 1 ORDER BY done_at DESC LIMIT 500"
            )
        )
        self.send_json({"notes": notes})

    def validate_note_fields(self, conn, data, partial=False):
        fields = {}
        if "content" in data or not partial:
            content = str(data.get("content", "")).strip()
            if not content:
                raise ApiError(400, "内容を入力してください")
            if len(content) > MAX_CONTENT_LEN:
                raise ApiError(400, "内容が長すぎます (%d文字まで)" % MAX_CONTENT_LEN)
            fields["content"] = content
        if "department_id" in data or not partial:
            try:
                dept_id = int(data.get("department_id", 1))
            except (TypeError, ValueError):
                raise ApiError(400, "宛先の指定が正しくありません")
            row = conn.execute(
                "SELECT id FROM departments WHERE id = ?", (dept_id,)
            ).fetchone()
            if row is None:
                raise ApiError(400, "宛先の部署が見つかりません")
            fields["department_id"] = dept_id
        if "color" in data or not partial:
            color = str(data.get("color", "yellow"))
            if color not in ALLOWED_COLORS:
                color = "yellow"
            fields["color"] = color
        if "author" in data or not partial:
            fields["author"] = str(data.get("author", "")).strip()[:MAX_AUTHOR_LEN]
        for flag in ("urgent", "pinned", "done"):
            if flag in data:
                fields[flag] = 1 if data.get(flag) else 0
        return fields

    def api_create_note(self, conn):
        data = self.read_json()
        fields = self.validate_note_fields(conn, data, partial=False)
        now = int(time.time())
        cur = conn.execute(
            "INSERT INTO notes(content, department_id, color, urgent, pinned, author,"
            " created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (
                fields["content"],
                fields["department_id"],
                fields["color"],
                fields.get("urgent", 0),
                fields.get("pinned", 0),
                fields["author"],
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM notes WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        self.send_json(dict(row), 201)

    def api_update_note(self, conn, note_id):
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if row is None:
            raise ApiError(404, "付箋が見つかりません")
        data = self.read_json()
        fields = self.validate_note_fields(conn, data, partial=True)
        if not fields:
            self.send_json(dict(row))
            return
        now = int(time.time())
        fields["updated_at"] = now
        if fields.get("done") == 1 and row["done"] == 0:
            fields["done_at"] = now
        if fields.get("done") == 0:
            fields["done_at"] = None
        sets = ", ".join("%s = ?" % k for k in fields)
        conn.execute(
            "UPDATE notes SET %s WHERE id = ?" % sets,
            (*fields.values(), note_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        self.send_json(dict(row))

    def api_delete_note(self, conn, note_id):
        conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        conn.commit()
        self.send_json({"ok": True})

    def api_create_department(self, conn):
        data = self.read_json()
        name = str(data.get("name", "")).strip()
        if not name:
            raise ApiError(400, "部署名を入力してください")
        if len(name) > MAX_DEPT_NAME_LEN:
            raise ApiError(400, "部署名が長すぎます (%d文字まで)" % MAX_DEPT_NAME_LEN)
        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) AS m FROM departments"
        ).fetchone()["m"]
        cur = conn.execute(
            "INSERT INTO departments(name, sort_order) VALUES(?, ?)",
            (name, max_order + 1),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM departments WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        self.send_json(dict(row), 201)

    def api_update_department(self, conn, dept_id):
        row = conn.execute(
            "SELECT * FROM departments WHERE id = ?", (dept_id,)
        ).fetchone()
        if row is None:
            raise ApiError(404, "部署が見つかりません")
        data = self.read_json()
        name = str(data.get("name", "")).strip()
        if not name:
            raise ApiError(400, "部署名を入力してください")
        if len(name) > MAX_DEPT_NAME_LEN:
            raise ApiError(400, "部署名が長すぎます (%d文字まで)" % MAX_DEPT_NAME_LEN)
        conn.execute("UPDATE departments SET name = ? WHERE id = ?", (name, dept_id))
        conn.commit()
        self.send_json({"ok": True})

    def api_delete_department(self, conn, dept_id):
        first = conn.execute(
            "SELECT id FROM departments ORDER BY sort_order, id LIMIT 1"
        ).fetchone()
        if first is not None and dept_id == first["id"]:
            raise ApiError(400, "先頭の部署 (全体) は削除できません")
        row = conn.execute(
            "SELECT * FROM departments WHERE id = ?", (dept_id,)
        ).fetchone()
        if row is None:
            raise ApiError(404, "部署が見つかりません")
        # この部署あての付箋は先頭の部署 (全体) に付け替える
        conn.execute(
            "UPDATE notes SET department_id = ? WHERE department_id = ?",
            (first["id"], dept_id),
        )
        conn.execute("DELETE FROM departments WHERE id = ?", (dept_id,))
        conn.commit()
        self.send_json({"ok": True})

    # ---------- 静的ファイル ----------

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # パストラバーサル対策: static フォルダの外は参照させない
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            self.send_json({"error": "not found"}, 404)
            return
        full = os.path.join(STATIC_DIR, rel)
        if not os.path.isfile(full):
            self.send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    """院内 LAN 上でこの PC に割り当てられている IP アドレスを推定する"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 実際にパケットは送信されない
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    print("=" * 52)
    print("  院内ふせんボード を起動しました")
    print("")
    print("  このPCから:      http://localhost:%d/" % PORT)
    print("  院内の他の端末から: http://%s:%d/" % (ip, PORT))
    print("")
    print("  終了するには Ctrl+C を押してください")
    print("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました")


if __name__ == "__main__":
    main()
