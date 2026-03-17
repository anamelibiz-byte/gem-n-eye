#!/bin/bash
# ═══════════════════════════════════════════════
# GEM N EYE — Push to GitHub
# Run this once from inside your GemNEye folder:
#   chmod +x push-to-github.sh && ./push-to-github.sh
# ═══════════════════════════════════════════════

echo ""
echo "✦ GEM N EYE — GitHub Setup"
echo "──────────────────────────"
echo ""

# 1. Make sure git is installed
if ! command -v git &> /dev/null; then
  echo "❌ Git is not installed. Download it at https://git-scm.com"
  exit 1
fi

# 2. Ask for GitHub username
read -p "Enter your GitHub username: " GH_USER
if [ -z "$GH_USER" ]; then echo "❌ Username required."; exit 1; fi

# 3. Repo name
REPO_NAME="gem-n-eye"
echo ""
echo "→ Repo will be: https://github.com/$GH_USER/$REPO_NAME"
echo ""

# 4. Init git
git init
git branch -M main
git config user.email "anamelibiz@gmail.com"
git config user.name "Anameli"

# 5. Stage all files
git add .

# 6. First commit
git commit -m "Initial commit — GEM N EYE AI Monetization Blueprint Engine"

# 7. Add remote and push
git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"

echo ""
echo "──────────────────────────────────────────────────────"
echo "BEFORE pressing Enter, go to GitHub and create the repo:"
echo "  1. Go to https://github.com/new"
echo "  2. Repository name: gem-n-eye"
echo "  3. Set to Private or Public (your choice)"
echo "  4. ❌ Do NOT check 'Initialize with README'"
echo "  5. Click Create Repository"
echo "──────────────────────────────────────────────────────"
read -p "Done creating the repo on GitHub? Press Enter to push... "

git push -u origin main

echo ""
echo "✅ Done! Your code is live at:"
echo "   https://github.com/$GH_USER/$REPO_NAME"
echo ""
echo "Next: Go to vercel.com → New Project → Import from GitHub → pick gem-n-eye"
