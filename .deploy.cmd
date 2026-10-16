@echo off
setlocal
set "ROOT=C:\Users\Dell\.gemini\antigravity\scratch\9Anime-main"
cd /d "%ROOT%"

echo == bundle frontend ==
call node scripts\bundle-frontend.js

echo == build prebuilt output ==
call npx --yes vercel@latest build --prod

echo == deploy prebuilt ==
call npx --yes vercel@latest deploy --prod --yes --prebuilt
