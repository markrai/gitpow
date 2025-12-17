#!/bin/bash
# Test script for Linux build
# This must be run on a Linux system

set -e

echo "========================================"
echo "GitPow Linux Build Test"
echo "========================================"
echo ""
echo "This script will build and test the Linux executable."
echo ""
echo "========================================"
echo "RELEASE OUTPUT LOCATION"
echo "========================================"
echo ""
echo "Release will be generated at:"
echo ""
echo "  $(pwd)/src-tauri/target/release/gitpow-tauri"
echo "  (or $(pwd)/target/release/gitpow-tauri if building from workspace root)"
echo ""
echo "========================================"
echo ""

# Ensure cargo bin is in PATH
if [ -d "$HOME/.cargo/bin" ] && [[ ":$PATH:" != *":$HOME/.cargo/bin:"* ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# Check prerequisites
echo "[1/6] Checking prerequisites..."

if ! command -v cargo &> /dev/null; then
    echo "ERROR: Rust/Cargo not found. Install from https://rustup.rs/"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "✓ Rust/Cargo found: $(cargo --version)"

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found."
    echo ""
    echo "To install Node.js, you have several options:"
    echo ""
    echo "Option 1: Install via NodeSource (recommended for latest LTS):"
    echo "  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    echo ""
    echo "Option 2: Install via nvm (Node Version Manager):"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    echo "  source ~/.bashrc"
    echo "  nvm install --lts"
    echo "  nvm use --lts"
    echo ""
    echo "Option 3: Install via apt (may have older version):"
    echo "  sudo apt update"
    echo "  sudo apt install -y nodejs npm"
    echo ""
    read -p "Would you like to try installing via apt now? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Installing Node.js via apt..."
        sudo apt update
        sudo apt install -y nodejs npm
        if ! command -v node &> /dev/null; then
            echo "ERROR: Installation failed. Please install Node.js manually using one of the options above."
            exit 1
        fi
    else
        exit 1
    fi
fi
echo "✓ Node.js found: $(node --version)"

if ! command -v npm &> /dev/null; then
    echo "ERROR: npm not found. Install Node.js which includes npm."
    exit 1
fi
echo "✓ npm found: $(npm --version)"

if ! command -v wasm-pack &> /dev/null; then
    echo "WARNING: wasm-pack not found. Installing..."
    cargo install wasm-pack
    # Add cargo bin to PATH if not already there
    if [ -d "$HOME/.cargo/bin" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
    fi
    # Verify installation
    if ! command -v wasm-pack &> /dev/null; then
        echo "ERROR: wasm-pack installation failed or not in PATH"
        echo "Please install manually: cargo install wasm-pack"
        echo "Then ensure ~/.cargo/bin is in your PATH"
        exit 1
    fi
fi
echo "✓ wasm-pack found: $(wasm-pack --version)"

if ! command -v cargo &> /dev/null || ! cargo tauri --version &> /dev/null; then
    echo "WARNING: Tauri CLI not found. Installing..."
    cargo install tauri-cli
    # Add cargo bin to PATH if not already there
    if [ -d "$HOME/.cargo/bin" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
    fi
    # Verify installation
    if ! cargo tauri --version &> /dev/null; then
        echo "ERROR: Tauri CLI installation failed or not in PATH"
        echo "Please install manually: cargo install tauri-cli"
        echo "Then ensure ~/.cargo/bin is in your PATH"
        exit 1
    fi
fi
echo "✓ Tauri CLI found: $(cargo tauri --version)"
echo ""

# Check system dependencies
echo "[2/6] Checking system dependencies..."
MISSING_DEPS=()

# Check for pkg-config (needed for GTK)
if ! command -v pkg-config &> /dev/null; then
    MISSING_DEPS+=("pkg-config")
fi

# Check for GTK libraries
if ! pkg-config --exists gtk+-3.0 2>/dev/null; then
    MISSING_DEPS+=("libgtk-3-dev")
fi

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    MISSING_DEPS+=("libwebkit2gtk-4.1-dev")
fi

if ! pkg-config --exists libsoup-3.0 2>/dev/null; then
    MISSING_DEPS+=("libsoup-3.0-dev")
fi

if ! pkg-config --exists javascriptcoregtk-4.1 2>/dev/null; then
    MISSING_DEPS+=("libjavascriptcoregtk-4.1-dev")
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo "WARNING: Missing system dependencies detected:"
    for dep in "${MISSING_DEPS[@]}"; do
        echo "  - $dep"
    done
    echo ""
    echo "These are required system libraries for Tauri applications on Linux."
    echo "They cannot be bundled with the app and must be installed separately."
    echo ""
    
    if command -v apt-get &> /dev/null; then
        INSTALL_CMD="sudo apt update && sudo apt install -y ${MISSING_DEPS[*]} build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils"
        echo "To install, run:"
        echo "  $INSTALL_CMD"
        echo ""
        read -p "Would you like to install these dependencies now? (Y/n) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            echo "Installing dependencies..."
            sudo apt update
            sudo apt install -y "${MISSING_DEPS[@]}" build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils
            if [ $? -eq 0 ]; then
                echo "✓ Dependencies installed successfully"
            else
                echo "✗ Installation failed. Please install manually using the command above."
                exit 1
            fi
        else
            echo "Skipping dependency installation. Build may fail."
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    elif command -v dnf &> /dev/null; then
        echo "To install, run:"
        echo "  sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3 librsvg2-devel"
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    elif command -v pacman &> /dev/null; then
        echo "To install, run:"
        echo "  sudo pacman -S webkit2gtk base-devel curl wget openssl libappindicator librsvg"
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        echo "Please install the packages manually for your distribution"
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
else
    echo "✓ All system dependencies found"
fi
echo ""

# Install Node.js dependencies
echo "[3/6] Installing Node.js dependencies..."
if [ -f "package.json" ]; then
    npm install
    echo "✓ Node.js dependencies installed"
else
    echo "WARNING: package.json not found, skipping npm install"
fi
echo ""

# Create build-output directory
echo "[4/6] Creating build-output directory..."
mkdir -p build-output/linux
echo "Build output directory ready: $(pwd)/build-output/linux"
echo ""

# Build WASM
echo "[5/6] Building WebAssembly module..."

# Check if we're on a Windows mount (WSL) and clean/fix permissions if needed
if [[ "$(pwd)" == /mnt/* ]]; then
    echo "WARNING: Detected Windows filesystem mount."
    echo "Cleaning build directory to avoid permission issues..."
    # Clean the target directory completely to avoid permission issues
    if [ -d "graph-wasm/target" ]; then
        rm -rf graph-wasm/target
    fi
    # Also clean any existing pkg directory
    if [ -d "graph-wasm/pkg" ]; then
        rm -rf graph-wasm/pkg
    fi
    # Create fresh directories with proper permissions
    mkdir -p graph-wasm/target
    chmod -R u+w graph-wasm 2>/dev/null || true
fi

cd graph-wasm
wasm-pack build --target web
cd ..
mkdir -p static/graph-wasm/pkg
cp -r graph-wasm/pkg/* static/graph-wasm/pkg/
echo "✓ WASM build complete"
echo ""

# Build Tauri application
echo "[6/6] Building Linux application (this may take 30-60 minutes)..."
echo "This will compile the entire project. Please be patient..."
echo ""

# Clean and fix permissions for Tauri build if on Windows mount
if [[ "$(pwd)" == /mnt/* ]]; then
    echo "Cleaning Tauri build directories to avoid permission issues..."
    # Clean target directories to avoid permission issues
    if [ -d "target" ]; then
        rm -rf target
    fi
    if [ -d "src-tauri/target" ]; then
        rm -rf src-tauri/target
    fi
    # Create fresh directories
    mkdir -p target src-tauri/target
    chmod -R u+w . 2>/dev/null || true
fi

cargo tauri build
echo ""

# Verify output
echo "========================================"
echo "Verifying build output..."
echo "========================================"
echo ""

# Check both possible locations (workspace root vs src-tauri)
EXECUTABLE=""
if [ -f "target/release/gitpow-tauri" ]; then
    EXECUTABLE="target/release/gitpow-tauri"
elif [ -f "src-tauri/target/release/gitpow-tauri" ]; then
    EXECUTABLE="src-tauri/target/release/gitpow-tauri"
fi

if [ -n "$EXECUTABLE" ] && [ -f "$EXECUTABLE" ]; then
    echo "========================================"
    echo "BUILD SUCCESSFUL!"
    echo "========================================"
    echo ""
    echo "RELEASE FILE LOCATION:"
    echo ""
    echo "  $(pwd)/$EXECUTABLE"
    echo ""
    echo "========================================"
    echo ""
    ls -lh "$EXECUTABLE"
    echo ""
    
    # Copy to build-output
    cp "$EXECUTABLE" build-output/linux/gitpow-tauri 2>/dev/null || true
    chmod +x build-output/linux/gitpow-tauri 2>/dev/null || true
    echo "✓ Executable copied to: $(pwd)/build-output/linux/gitpow-tauri"
    echo ""
    
    # Check for bundles
    if [ -d "src-tauri/target/release/bundle/appimage" ]; then
        echo "✓ AppImage found:"
        ls -lh src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
        cp src-tauri/target/release/bundle/appimage/*.AppImage build-output/linux/ 2>/dev/null || true
    fi
    
    if [ -d "src-tauri/target/release/bundle/deb" ]; then
        echo "✓ Debian package found:"
        ls -lh src-tauri/target/release/bundle/deb/*.deb 2>/dev/null || true
        cp src-tauri/target/release/bundle/deb/*.deb build-output/linux/ 2>/dev/null || true
    fi
    
    echo ""
    echo "========================================"
    echo "HOW TO RUN THE APPLICATION"
    echo "========================================"
    echo ""
    echo "Option 1: Run directly"
    echo "  ./$EXECUTABLE"
    echo ""
    echo "Option 2: Run from build-output"
    echo "  ./build-output/linux/gitpow-tauri"
    echo ""
    echo "Option 3: Run with full path"
    echo "  $(pwd)/$EXECUTABLE"
    echo ""
    echo "If you get permission errors, make it executable:"
    echo "  chmod +x $EXECUTABLE"
    echo ""
    echo "========================================"
    echo "Build complete! Application ready for testing."
    echo "========================================"
else
    echo "✗ ERROR: Executable not found"
    echo ""
    echo "Checked locations:"
    echo "  - $(pwd)/target/release/gitpow-tauri"
    echo "  - $(pwd)/src-tauri/target/release/gitpow-tauri"
    echo ""
    echo "Check the build logs above for error messages."
    echo ""
    echo "Common build errors and solutions:"
    echo "  1. Missing pkg-config: sudo apt install pkg-config"
    echo "  2. Missing GTK libraries: sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev"
    echo "  3. Missing libsoup: sudo apt install libsoup-3.0-dev"
    echo "  4. Missing javascriptcore: sudo apt install libjavascriptcoregtk-4.1-dev"
    echo "  5. Missing xdg-utils: sudo apt install xdg-utils"
    exit 1
fi

echo ""

