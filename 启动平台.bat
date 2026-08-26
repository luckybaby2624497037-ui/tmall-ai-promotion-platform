@echo off
chcp 65001 >nul
title 天猫推广自动化平台 - 本地服务
cd /d "%~dp0"

echo ==============================================
echo   天猫推广自动化平台 本地服务启动中...
echo ==============================================

REM 设置阿里妈妈应用凭证（万相台代理）
set TAOBAO_APP_KEY=HHJ2608
set TAOBAO_APP_SECRET=XmwfSqD80kEEXTp1W6ASHdrb1BDI8QQIQ
set PORT=8081
set HOST=0.0.0.0

REM 查找可用的 node
where node >nul 2>&1
if %errorlevel%==0 (
  set NODE_CMD=node
) else (
  if exist "D:\xcxd智能ai助手\XCXD\node.exe" (
    set "NODE_CMD=D:\xcxd智能ai助手\XCXD\node.exe"
  ) else (
    echo [错误] 未找到 node，请安装 Node.js 或修改本脚本中的 node 路径
    pause
    exit /b 1
  )
)

echo 正在启动后端服务（含万相台真实数据代理）...
echo 启动后浏览器将自动打开 http://localhost:8081
echo 如未自动打开，请手动访问该地址
echo 关闭本窗口即停止服务
echo ==============================================
start "" http://localhost:8081
%NODE_CMD% server.js
pause
