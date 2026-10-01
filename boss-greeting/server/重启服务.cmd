@echo off
chcp 936 >nul
rem 重启大屏服务:先按端口杀掉旧进程,再重新拉起。
rem 改完 src\ 下的代码必须走这一步 —— node 不热加载,旧进程会一直吐旧代码
rem (2026-09-25 那次大屏不实时更新就是这么来的)。
rem
rem 刻意按端口找 PID,而不是 taskkill /im node.exe:后者会误杀你其它 node 进程。
rem 维护注意:GBK 编码 + CRLF 行尾,原因见 启动服务.cmd 顶部注释。
setlocal
cd /d "%~dp0"

set "KILLED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  echo [boss-ai-gate] 停止旧进程 PID %%p
  taskkill /f /pid %%p >nul 2>&1
  set "KILLED=1"
)
if not defined KILLED echo [boss-ai-gate] 没有在跑的旧进程。

rem 端口释放需要一点时间,否则新进程可能抢不到端口。
ping -n 2 127.0.0.1 >nul

call "%~dp0启动服务.cmd"
endlocal
