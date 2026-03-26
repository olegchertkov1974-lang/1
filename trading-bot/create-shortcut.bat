@echo off
echo Creating desktop shortcut...

set SCRIPT_DIR=%~dp0
set DESKTOP=%USERPROFILE%\Desktop
set SHORTCUT=%DESKTOP%\Gerchik Bot.lnk

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%SCRIPT_DIR%start-bot.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Description = 'Gerchik Levels Trading Bot'; $s.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo Shortcut created on Desktop: "Gerchik Bot"
    echo Double-click it to start the bot.
) else (
    echo ERROR: Failed to create shortcut.
)

pause
