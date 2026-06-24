# SheGuard — Railway + PostgreSQL Deployment Guide

## Project Structure
```
sheguard/
├── server.js           ← Backend (Node.js + Express + PostgreSQL)
├── package.json        ← Dependencies
├── railway.toml        ← Railway config
├── .gitignore
└── public/             ← All HTML files served statically
    ├── index.html
    ├── login.html
    ├── profile-details.html
    ├── contact-details.html
    ├── dashboard.html
    ├── live-map.html
    ├── about.html
    └── siren.mp3       ← Copy your siren.mp3 here
```

---

## Step 1 — Install dependencies locally (to test first)
```bash
cd sheguard
npm install
```

## Step 2 — Test locally with a local PostgreSQL OR skip to Railway directly

To test locally, create a `.env` file (never commit this):
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/sheguard
```
Then run:
```bash
node server.js
# Open http://localhost:3000
```

---

## Step 3 — Push to GitHub

```bash
cd sheguard
git init
git add .
git commit -m "Initial SheGuard full-stack commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sheguard.git
git push -u origin main
```

---

## Step 4 — Deploy on Railway

1. Go to https://railway.app and sign in (use GitHub login)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"** → choose your `sheguard` repo
4. Railway will auto-detect Node.js and start building

---

## Step 5 — Add PostgreSQL Database on Railway

1. In your Railway project dashboard, click **"+ New"**
2. Select **"Database" → "Add PostgreSQL"**
3. Railway automatically creates the DB and sets `DATABASE_URL` environment variable
4. Your app will auto-restart and connect — **no manual config needed**

---

## Step 6 — Add siren.mp3

Place your `siren.mp3` file inside the `public/` folder before pushing to GitHub.
If you forgot, just add it and push again:
```bash
cp /path/to/siren.mp3 public/siren.mp3
git add public/siren.mp3
git commit -m "Add siren audio asset"
git push
```

---

## Step 7 — Get your live URL

In Railway dashboard → your app → **Settings → Domains**
Click **"Generate Domain"** → you get a URL like:
`https://sheguard-production.up.railway.app`

Share this URL — it's your live website!

---

## What Changed from Local Version

| What | Before (SQLite) | After (PostgreSQL) |
|------|-----------------|--------------------|
| Database | Local `.db` file | Cloud PostgreSQL |
| Passwords | Plain text | bcrypt hashed |
| Auth | No register | Login + Register |
| Profile | Save only | Save + Pre-fill on revisit |
| Contacts | No validation | Validates name+phone required |
| Safe Circle | Static mock data | Real DB contacts |
| Session guard | None | Redirects to login if no userId |
| Logout | Goes to index | Clears localStorage + redirects |

---

## Default Test Account
No seed account anymore — users register themselves via the **"Create Account"** tab on login page.

## Troubleshooting

- **"Cannot connect to database"** → Check Railway PostgreSQL is added and `DATABASE_URL` env var exists
- **"Page not found"** → Make sure all HTML files are inside `public/` folder
- **Siren not playing** → Place `siren.mp3` inside `public/` folder
- **GPS not working** → Railway serves over HTTPS which is required for geolocation — should work fine
