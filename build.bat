@echo off
REM Build script for Master Music Player Electron application
REM Usage: Double-click build.bat or run `build.bat` from PowerShell / CMD

SETLOCAL ENABLEEXTENSIONS

ECHO ======================================================
ECHO   Master Music Player - Build Process Started
ECHO ======================================================

REM Step 1: Ensure Node modules are installed
IF NOT EXIST node_modules (
  ECHO Installing dependencies...
  npm install --legacy-peer-deps
  IF %ERRORLEVEL% NEQ 0 (
    ECHO Error: npm install failed. Exiting.
    EXIT /B %ERRORLEVEL%
  )
) ELSE (
  ECHO Dependencies already installed. Skipping npm install.
)

REM Step 2: Run the Electron Builder script defined in package.json
ECHO Building the Electron application...
npm run build --loglevel error
IF %ERRORLEVEL% NEQ 0 (
  ECHO Error: Build failed. Check the logs above.
  EXIT /B %ERRORLEVEL%
)

ECHO.
ECHO ======================================================
ECHO   Build completed successfully!
ECHO   Output artifacts can be found in the /dist directory.
ECHO ======================================================

ENDLOCAL
