@echo off
chcp 936 >nul
rem 启动大屏服务(后台、隐藏窗口、日志落 data\server.log)。已在跑就跳过 ——
rem 起第二个进程只会因端口被占而报 EADDRINUSE。
rem
rem 健康检查失败时以 1 退出,调用方(打开大屏.cmd)据此决定要不要开浏览器。
rem
rem 维护注意:本文件是 GBK 编码 + CRLF 行尾,改完必须保持这两点。
rem 实测(2026-09-25):UTF-8 批处理即使加了 chcp 65001,cmd 解码多字节字符时
rem 仍会让读取位置错位,后面的行被拦腰截断当命令执行;GBK + CRLF 才稳。
setlocal
cd /d "%~dp0"

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [HelloBoss] 8787 已在监听,跳过启动。
  goto :check
)

if not exist "data" mkdir "data"
rem 让服务跟着大屏页面走:页面关掉 60 秒后服务自己退出,判定链路见 src/idleExit.js。
rem 只在这条脚本里设 —— 双击 打开大屏.vbs 走的就是它。手动 npm start、
rem 以及对局域网开放时都不设,那两种情况页面关了服务还得继续跑。
set "BOSS_EXIT_WHEN_IDLE=1"
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList '\"src/server.js\"' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput 'data\server.log' -RedirectStandardError 'data\server.error.log'"
echo [HelloBoss] 已后台启动,日志 data\server.log

:check
set "HTTP="
for /l %%i in (1,1,10) do (
  if not defined HTTP (
    ping -n 2 127.0.0.1 >nul
    for /f %%s in ('curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8787/health') do set "HTTP=%%s"
  )
)

rem 块内的 echo 文本不能出现未转义的括号 —— cmd 会把 ) 当成块的结束。
if "%HTTP%"=="200" (
  echo [HelloBoss] 健康检查通过 http://127.0.0.1:8787/health
) else (
  echo [HelloBoss] 健康检查没通过 HTTP %HTTP%,错误日志:
  type "data\server.error.log" 2>nul
  echo --- data\server.log ---
  type "data\server.log" 2>nul
  rem 停一下让双击的人看清错误;不能用 pause —— 打开大屏.cmd 会调用它,会卡住。
  ping -n 6 127.0.0.1 >nul
  exit /b 1
)

rem 停一下是为了双击运行时能看到结果。
ping -n 4 127.0.0.1 >nul
endlocal
