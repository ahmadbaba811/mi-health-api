# MiHealth API

This is a minimal Node.js (Express) API scaffold with a SQL Server (`mssql`) connection.

Quick start

1. Install dependencies:

```bash
cd api
npm install
```

2. Copy `.env.example` to `.env` and set your SQL Server credentials.

3. Start the server:

```bash
npm run dev
```

Endpoints

- `GET /` - health check
- `GET /users` - example: reads from `[Users]` table (adjust to your schema)

Notes

- Adjust queries in `src/routes/users.js` to match your database schema.
- The app waits for DB connection before starting.
