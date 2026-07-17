@echo off
rem === 院内ふせんボード 起動ファイル (Windows用) ===
rem ポートを変更したい場合は、次の行の先頭の「rem 」を消して番号を変えてください
rem set FUSEN_PORT=8420

cd /d "%~dp0"
py server.py 2>nul || python server.py
pause
