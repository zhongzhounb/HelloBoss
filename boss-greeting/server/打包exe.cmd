@echo off
chcp 936 >nul
rem 打包出「解压即用」的 HelloBoss.exe(自带 Node 运行时,对方不用装 Node)。
rem 打包这一步需要联网:注入工具 postject 由 npx 现下现用。
rem
rem 维护注意:本文件是 GBK 编码 + CRLF 行尾,改动请保持这两点。
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [HelloBoss] 没找到 node,请先装 Node 22 或更新版本: https://nodejs.org
  pause
  exit /b 1
)

node "launcher\build.mjs"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo [HelloBoss] 打包失败,退出码 %CODE%
  pause
  exit /b %CODE%
)

echo.
echo [HelloBoss] 打包完成,产物在 dist 文件夹里,整个文件夹压成 zip 就能发出去。
pause
endlocal
