# Meeting Minutes

Meeting transcription, report generation, and export service built with Node.js and AWS.

## Architecture

- **Express API** — CRUD for meetings and glossary terms
- **Worker A** — Polls SQS, transcribes audio via AWS Transcribe
- **Worker B** — Generates structured reports via Bedrock Claude
- **Worker C** — Exports PDF and sends email via SES

## Quick Start

```bash
cp .env.example .env
# Fill in SES_FROM_EMAIL and SES_TO_EMAIL
npm install
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/meetings | List meetings |
| POST | /api/meetings | Create meeting |
| GET | /api/meetings/:id | Get meeting |
| PUT | /api/meetings/:id | Update meeting |
| DELETE | /api/meetings/:id | Delete meeting |
| GET | /api/glossary | List terms |
| POST | /api/glossary | Add term |
| PUT | /api/glossary/:id | Update term |
| DELETE | /api/glossary/:id | Delete term |

## Workers

```bash
npm run worker:transcription
npm run worker:report
npm run worker:export
```

## Docker

```bash
docker build -t meeting-minutes .
docker run -p 3300:3300 --env-file .env meeting-minutes
```
