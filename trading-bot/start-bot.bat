@echo off
title Gerchik Trading Bot
echo ========================================
echo   Gerchik Levels Trading Bot
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed!
    echo Download from https://nodejs.org
    pause
    exit /b 1
)

echo Checking dependencies...
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

if not exist ".env" (
    echo ERROR: .env file not found!
    echo Copy .env.example to .env and fill in your keys.
    copy .env.example .env
    notepad .env
    pause
    exit /b 1
)

echo.
echo Starting bot...
echo Press Ctrl+C to stop
echo.
node src\bot.js
pause
