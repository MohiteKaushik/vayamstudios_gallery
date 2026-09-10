@echo off
rem  Double-click this to start uploading photographs to the VAYAM gallery.
rem
rem  It installs what it needs the first time, then asks four questions and
rem  remembers the answers. After that it just runs.
rem
rem  Leave this window open for as long as the event is running. Closing it
rem  stops the uploading; nothing already uploaded is lost.

title VAYAM photo uploader
cd /d "%~dp0"

echo Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo Python is not installed on this machine.
  echo Get it from https://python.org/downloads and tick
  echo "Add Python to PATH" during the install, then run this again.
  echo.
  pause
  exit /b 1
)

echo Checking the two packages it needs...
python -m pip install --quiet --disable-pip-version-check requests pillow
if errorlevel 1 (
  echo.
  echo Could not install requests and pillow. Check the internet connection.
  echo.
  pause
  exit /b 1
)

echo.
python watch_and_upload.py
echo.
pause
