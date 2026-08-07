@echo off
echo =========================================
echo    Wedding Planner Firebase Deployment
echo =========================================
echo.
echo Setting up local developer tools...
set PATH=%~dp0node-v20.17.0-win-x64;%PATH%
echo.
echo Step 1/2: Checking Authentication...
echo If a browser window opens, please log in to your Google Account.
call npx -y firebase-tools@latest login
echo.
echo Step 2/2: Deploying Website to Firebase...
call npx -y firebase-tools@latest deploy
echo.
echo =========================================
echo    Deployment Finished!
echo =========================================
pause
