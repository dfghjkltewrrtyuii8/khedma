# Khedma | خدمة

MVP of a Saudi freelance marketplace — Arabic-first with RTL, English toggle, SAR pricing, Saudi cities. Liquid-glass design with an iOS-style tab bar on mobile.

## Easiest way to run (no terminal)

1. Install [Node.js](https://nodejs.org) (one-time).
2. **Mac:** double-click `Start Khedma.command` — if macOS blocks it, right-click it → Open → Open.
   **Windows:** double-click `Start Khedma.bat`.
3. Your browser opens at http://localhost:3000 automatically.

## Terminal way

```bash
npm install
npm run dev   # http://localhost:3000
```

## Demo accounts (password: `demo1234`)

- Client: `client@demo.sa`
- Freelancer: `freelancer@demo.sa`

## Core flow

Client posts a project → freelancer browses/filters by category and submits a proposal → client accepts one (others auto-rejected) → client marks the project complete.

## Notes

- Single Next.js app (App Router, JS, server actions). No database — an in-memory store seeded with bilingual demo data (`lib/db.js`); data resets on server restart.
- Skipped by design: messaging, reviews, payments/escrow, portfolio uploads, email verification.
