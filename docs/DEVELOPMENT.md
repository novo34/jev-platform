# Local development

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Install

```bash
npm install
```

## Start all services

```bash
npm run dev
```

Services:

- Web: http://localhost:3000
- API health: http://localhost:3001/health
- Worker health: http://localhost:3002/health

## Validate

```bash
npm run check
```

This runs workspace type checks, PostgreSQL-backed tests and production builds for the current JEV Platform baseline.
