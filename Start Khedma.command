#!/bin/bash
# Double-click this file on a Mac to start Khedma.
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Opening the download page..."
  open "https://nodejs.org"
  echo ""
  echo "Install Node.js (big green button), then double-click this file again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First-time setup: installing... (about a minute)"
  npm install --no-audit --no-fund || { echo "Install failed — check your internet connection."; read -n 1 -s -r; exit 1; }
fi

( sleep 4 && open "http://localhost:3000" ) &
echo ""
echo "Starting Khedma — your browser will open automatically."
echo "Keep this window open while using the app. Close it to stop."
echo ""
npm run dev
