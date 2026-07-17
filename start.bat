@echo off
rem クリニック共有付箋ボード 起動用バッチ（Windows）
rem このファイルをダブルクリックするとサーバーが起動します。
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ja からインストールしてください。
  pause
  exit /b 1
)
node server.js
pause
