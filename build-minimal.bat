@echo off
echo Starting minimal build process...
echo.

echo Step 1: Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo Error: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo Step 2: Running build optimization...
call npm run prebuild
if %errorlevel% neq 0 (
    echo Warning: Build optimization failed, continuing anyway...
)

echo.
echo Step 3: Building application with minimal size...
call npm run build
if %errorlevel% neq 0 (
    echo Error: Build failed
    pause
    exit /b 1
)

echo.
echo Build completed successfully!
echo Check the dist folder for the installer.
echo.

REM Show installer size
for %%f in (dist\*.exe) do (
    echo Installer: %%f
    echo Size: %%~zf bytes
)

pause
