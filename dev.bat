@echo off
setlocal enabledelayedexpansion
echo Checking prerequisites...

REM Check if wasm-pack is installed
wasm-pack --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: wasm-pack is not installed or not in PATH
    echo.
    echo To install wasm-pack, run:
    echo   cargo install wasm-pack
    echo.
    echo After installation, make sure ~/.cargo/bin is in your PATH.
    echo On Windows, this is typically: %USERPROFILE%\.cargo\bin
    echo.
    echo You can add it to PATH permanently by:
    echo   1. Opening System Properties ^> Environment Variables
    echo   2. Adding %USERPROFILE%\.cargo\bin to your User PATH
    echo   3. Restarting your terminal
    echo.
    pause
    EXIT /B 1
)
echo wasm-pack found: 
wasm-pack --version

REM Check if cargo is available
cargo --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: cargo is not installed or not in PATH
    echo Please install Rust from https://rustup.rs/
    pause
    EXIT /B 1
)
echo cargo found: 
cargo --version

REM Ensure cargo bin is in PATH for this session
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
echo %PATH% | findstr /C:"%CARGO_BIN%" >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    REM Add cargo bin to PATH for this session
    set "PATH=%CARGO_BIN%;%PATH%"
)

REM Check if tauri-cli is installed
cargo tauri --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo WARNING: Tauri CLI is not installed or not in PATH
    echo.
    echo To install Tauri CLI, run:
    echo   cargo install tauri-cli
    echo.
    echo After installation, make sure ~/.cargo/bin is in your PATH.
    echo On Windows, this is typically: %USERPROFILE%\.cargo\bin
    echo.
    set /p INSTALL_TAURI="Would you like to install Tauri CLI now? (Y/n): "
    echo.
    if /i not "!INSTALL_TAURI!"=="n" (
        echo Installing Tauri CLI...
        echo This may take a few minutes...
        cargo install tauri-cli
        REM Check if installation actually succeeded by verifying the binary exists
        if exist "%USERPROFILE%\.cargo\bin\cargo-tauri.exe" (
            echo Tauri CLI installed successfully!
            REM Add cargo bin to PATH for this session
            set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
        ) else (
            echo WARNING: Tauri CLI may not be in expected location.
            echo Please verify installation and ensure %USERPROFILE%\.cargo\bin is in your PATH.
            echo.
            echo You can verify by running: cargo tauri --version
            echo.
            REM Try to refresh PATH and check again
            set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
            cargo tauri --version >nul 2>&1
            IF %ERRORLEVEL% NEQ 0 (
                echo ERROR: Tauri CLI installation verification failed
                echo Please restart your terminal after installation, or add %USERPROFILE%\.cargo\bin to PATH manually.
                pause
                EXIT /B 1
            )
            echo Tauri CLI verified and available!
        )
    ) else (
        echo Skipping Tauri CLI installation. Exiting.
        pause
        EXIT /B 1
    )
)
echo Tauri CLI found: 
cargo tauri --version

echo.
echo Building wasm package...
REM Ensure we're in the project root
cd /d "%~dp0"
pushd graph-wasm
wasm-pack build --target web
set WASM_BUILD_ERROR=%ERRORLEVEL%
popd

IF %WASM_BUILD_ERROR% NEQ 0 (
    echo wasm-pack build failed.
    cd /d "%~dp0"
    pause
    EXIT /B %WASM_BUILD_ERROR%
)

REM Ensure we're back in project root
cd /d "%~dp0"

echo Copying WASM files to static directory...
if not exist "static\graph-wasm\pkg" mkdir "static\graph-wasm\pkg"

REM Wait a moment for filesystem to sync (wasm-pack might still be writing)
timeout /t 1 /nobreak >nul 2>&1

REM Check with both absolute and relative paths
set "PKG_DIR=%~dp0graph-wasm\pkg"
set "PKG_DIR_REL=graph-wasm\pkg"

REM Debug: Show what we're checking
echo Checking for WASM package directory...
echo   Absolute path: %PKG_DIR%
echo   Relative path: %PKG_DIR_REL%
echo   Current directory: %CD%

if exist "%PKG_DIR%" (
    set "PKG_DIR=%PKG_DIR_REL%"
    echo Found package directory at: %PKG_DIR%
) else if exist "%PKG_DIR_REL%" (
    set "PKG_DIR=%PKG_DIR_REL%"
    echo Found package directory at: %PKG_DIR%
) else (
    echo ERROR: graph-wasm\pkg directory not found.
    echo Expected locations:
    echo   - %PKG_DIR%
    echo   - %PKG_DIR_REL%
    echo Current directory: %CD%
    echo.
    echo Listing graph-wasm directory contents:
    if exist "graph-wasm" (
        dir /b graph-wasm 2>nul
    ) else (
        echo graph-wasm directory does not exist!
    )
    echo.
    echo The wasm-pack build may have failed or output to a different location.
    pause
    EXIT /B 1
)

REM Clear destination directory first to avoid conflicts
if exist "static\graph-wasm\pkg\*" (
    del /Q "static\graph-wasm\pkg\*" >nul 2>&1
)

REM Copy files - use robocopy for better reliability, or xcopy as fallback
where robocopy >nul 2>&1
IF %ERRORLEVEL% EQU 0 (
    echo Copying WASM files with robocopy...
    robocopy "%PKG_DIR%" "static\graph-wasm\pkg" /E /NFL /NDL /NJH /NJS
    REM robocopy returns 0-7 for success, 8+ for errors
    set COPY_RESULT=%ERRORLEVEL%
    IF !COPY_RESULT! GEQ 8 (
        echo WARNING: robocopy returned error code !COPY_RESULT!. Trying xcopy...
        xcopy /Y /I /E "%PKG_DIR%\*" "static\graph-wasm\pkg\"
        IF %ERRORLEVEL% NEQ 0 (
            echo ERROR: Both robocopy and xcopy failed to copy WASM files.
            pause
            EXIT /B 1
        )
    )
) else (
    echo Copying WASM files with xcopy...
    xcopy /Y /I /E "%PKG_DIR%\*" "static\graph-wasm\pkg\"
    IF %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to copy WASM files.
        pause
        EXIT /B 1
    )
)

REM Verify files were copied by checking for specific files
if exist "static\graph-wasm\pkg\graph_wasm_bg.wasm" (
    echo WASM files copied successfully.
) else if exist "static\graph-wasm\pkg\*.wasm" (
    echo WASM files copied successfully.
) else (
    echo ERROR: WASM files were not copied. Checking source...
    dir /b "graph-wasm\pkg" 2>nul
    echo.
    echo Please check the directories manually and ensure files are being copied.
    pause
    EXIT /B 1
)

echo Running the Tauri application in DEBUG mode with logging...
echo RUST_LOG=debug is set to show all debug messages
echo.
cd /d "%~dp0"
set RUST_LOG=debug
cargo tauri dev

IF %ERRORLEVEL% NEQ 0 (
    echo Application exited with an error.
    pause
    EXIT /B %ERRORLEVEL%
)

pause

