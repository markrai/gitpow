#!/bin/bash
# Test script for macOS build
# This must be run on a macOS system

set -e

echo "========================================"
echo "GitPow macOS Build Test"
echo "========================================"
echo ""

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "ERROR: This script must be run on macOS"
    echo "macOS builds cannot be done in Docker"
    exit 1
fi

# Check prerequisites
echo "[1/5] Checking prerequisites..."

if ! command -v cargo &> /dev/null; then
    echo "ERROR: Rust/Cargo not found. Install from https://rustup.rs/"
    exit 1
fi
echo "✓ Rust/Cargo found"

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org/"
    exit 1
fi
echo "✓ Node.js found"

if ! command -v wasm-pack &> /dev/null; then
    echo "ERROR: wasm-pack not found. Install with: cargo install wasm-pack"
    exit 1
fi
echo "✓ wasm-pack found"

if ! command -v cargo &> /dev/null || ! cargo tauri --version &> /dev/null; then
    echo "ERROR: Tauri CLI not found. Install with: cargo install tauri-cli"
    exit 1
fi
echo "✓ Tauri CLI found"
echo ""

# Create build-output directory
echo "[2/5] Creating build-output directory..."
mkdir -p build-output/macos
echo "Build output directory ready"
echo ""

# Build WASM
echo "[3/5] Building WebAssembly module..."
cd graph-wasm
wasm-pack build --target web
cd ..
mkdir -p static/graph-wasm/pkg
cp -r graph-wasm/pkg/* static/graph-wasm/pkg/
echo "WASM build complete"
echo ""

# Build Tauri application
echo "[4/5] Building macOS application (this may take 30-60 minutes)..."
cargo tauri build
echo ""

# Verify output
echo "[5/5] Verifying build output..."
echo "========================================"
echo ""

if [ -d "src-tauri/target/release/bundle/macos/GitPow.app" ]; then
    echo "✓ SUCCESS: macOS application bundle found"
    echo "  Location: src-tauri/target/release/bundle/macos/GitPow.app"
    ls -lh src-tauri/target/release/bundle/macos/GitPow.app
    echo ""
    
    # Copy to build-output
    cp -r src-tauri/target/release/bundle/macos/GitPow.app build-output/macos/ 2>/dev/null || true
    
    if [ -d "src-tauri/target/release/bundle/dmg" ]; then
        echo "✓ DMG installer found:"
        ls -lh src-tauri/target/release/bundle/dmg/*.dmg
        cp src-tauri/target/release/bundle/dmg/*.dmg build-output/macos/ 2>/dev/null || true
    fi
    
    echo ""
    echo "Build complete! Application ready for testing."
else
    echo "✗ ERROR: Application bundle not found"
    echo "Check the build logs above for error messages"
    exit 1
fi

echo ""
echo "========================================"
echo "macOS build test complete!"
echo "========================================"


