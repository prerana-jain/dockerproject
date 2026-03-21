# 🐳 Docker 3-Tier Application

A production-quality, Docker-based three-tier web application demonstrating best DevOps practices.

**Stack:** Nginx (alpine) → Node.js/Express → MySQL 8.0

---

## Architecture

```
                         Docker Network: app_net
  ┌─────────┐           ┌────────────────────────────────────────────────┐
  │         │  :8080    │  ┌───────────┐   /api/*   ┌───────────────┐   │
  │ Browser │──────────►│  │   Nginx   │──────────► │   Express     │   │
  │         │           │  │ (alpine)  │            │  Node.js API  │   │
  └─────────┘           │  │  :80      │            │   :3000       │   │
                        │  └───────────┘            └───────┬───────┘   │
                        │                                   │ mysql2    │
                        │                           ┌───────▼───────┐   │
                        │                           │  MySQL 8.0    │   │
                        │                           │   :3306       │   │
                        │                           │  (persisted)  │   │
                        │                           └───────────────┘   │
                        └────────────────────────────────────────────────┘
```

### Request flow

```
Browser
  │
  │  GET /              → Nginx serves index.html (static)
  │  GET /api/health    → Nginx proxies → Express /health → MySQL ping
  │  GET /api/          → Nginx proxies → Express GET /  → "OK"
  ▼
  Done
```

---

## Repository Structure

```
.
├── frontend/
│   ├── Dockerfile            # nginx:alpine + envsubst
│   ├── nginx.conf.template   # proxy config (BACKEND_URL injected at runtime)
│   └── index.html            # Status dashboard SPA
├── backend/
│   ├── Dockerfile            # node:20-alpine multi-stage
│   ├── .dockerignore
│   ├── index.js              # Express app + event-driven retry + exponential backoff
│   └── package.json
├── docker-compose.yml        # Full orchestration with healthchecks
├── .env.example              # Template – copy to .env
└── README.md
```

---

## Quick Start

### Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker | 24.x |
| Docker Compose | v2 (plugin) |

### 1 – Clone and configure

```bash
git clone <repo-url>
cd <repo-dir>
cp .env.example .env
# Edit .env with your preferred passwords
```

### 2 – Build and run

```bash
docker compose up --build
```

> **First run note:** MySQL initialises its data directory on the first boot.
> The backend uses exponential backoff retry logic so it will
> recover automatically once MySQL is ready.

### 3 – Open in browser

```
http://localhost:8080
```

You will see a live status dashboard that polls `/api/health` every 30 s.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Returns `OK` (liveness probe) |
| `GET` | `/health` | JSON status including MySQL connectivity |

### Sample `/health` response

```json
{
  "status": "ok",
  "timestamp": "2024-06-10T12:00:00.000Z",
  "service": "backend",
  "database": {
    "status": "ok",
    "message": "MySQL reachable"
  }
}
```

When MySQL is down, `status` becomes `"degraded"` and the endpoint returns **HTTP 503**.

---

## Design Decisions

### 1 – `BACKEND_URL` via `envsubst`

`nginx.conf.template` contains `${BACKEND_URL}`.
The official `nginx:alpine` image auto-runs `envsubst` on every file in
`/etc/nginx/templates/` at container start, producing `/etc/nginx/conf.d/default.conf`.
**No backend address is ever hardcoded.**

### 2 – Backend retry logic with Exponential Backoff

```
Backend starts → HTTP server binds immediately (always reachable for healthchecks)
             → connectWithRetry() runs with exponential backoff
             → attempt 1: wait 1s
             → attempt 2: wait 2s
             → attempt 3: wait 4s
             → attempt 4: wait 8s
             → attempt 5: wait 16s
             → attempt 6+: wait 30s (capped)
             → if MySQL restarts later, handleDBError() triggers reconnect
```

This approach is **event-driven** — retry only triggers on actual errors,
not by polling every N seconds. This avoids unnecessary DB queries when
everything is healthy.

**Key components:**

```
enableKeepAlive: true        → mysql2 automatically pings DB to detect lost connections
isRetrying flag              → prevents multiple retry loops running simultaneously
exponential backoff          → avoids hammering DB when it is down
handleDBError()              → triggered on actual error, not on a timer
```

### 3 – `depends_on` with `condition: service_healthy`

```
frontend depends_on backend (healthy)
backend  depends_on db      (healthy)
```

Docker waits for each layer's healthcheck to pass before starting the next.
This is safer than `wait-for` scripts that add extra dependencies.

### 4 – Multi-stage backend image

```
Stage 1 (deps): node:20-alpine → npm install --omit=dev
Stage 2 (final): node:20-alpine → copy node_modules + source only
```

Result: **no build toolchain in the final image**, minimal attack surface.

### 5 – Non-root user

The backend runs as `appuser` (UID unprivileged). Nginx runs as the default
`nginx` user. MySQL uses its own internal user.

### 6 – Logging to stdout/stderr

All services log to stdout/stderr only. Docker's json-file driver captures them
and they are viewable via `docker compose logs`.

---

## Testing

### Manual smoke test

```bash
# Check all containers are healthy
docker compose ps

# Backend root
curl http://localhost:8080/api/

# Backend health (full JSON)
curl http://localhost:8080/api/health
```

---

## Failure Scenarios

### Scenario 1 – MySQL Restart using `docker restart`

This is the most important failure test. It proves the backend recovers
automatically when MySQL restarts.

#### Step 1 – Find the MySQL container name

```bash
docker compose ps
```

You will see something like:
```
NAME                        STATUS
dockerassignment-db-1       Up (healthy)
dockerassignment-backend-1  Up (healthy)
dockerassignment-frontend-1 Up (healthy)
```

#### Step 2 – Restart MySQL container

```bash
docker restart dockerassignment-db-1
```

#### Step 3 – Watch backend logs immediately

```bash
docker compose logs -f backend
```

#### What happens to the backend during MySQL restart

```
Timeline after docker restart <mysql-container>
────────────────────────────────────────────────────────────────►

t=0s         t=1-3s          t=5-30s              t=30-35s
│            │               │                    │
MySQL        MySQL           MySQL                MySQL
running      restarting      initialising         healthy ✅
✅           ❌              ⏳                   ✅

Backend      Backend         Backend              Backend
running      detects         retrying with        reconnects
✅           error ❌        backoff ⏳           ✅

/health      /health         /health              /health
200 ok       503 degraded    503 degraded         200 ok ✅
```

#### Exact logs you will see

```
# When MySQL goes down
[DB] Error detected: ECONNREFUSED
[DB] Starting reconnect with exponential backoff...
[DB] Connection attempt 1 …
[DB] Attempt 1 failed: ECONNREFUSED
[DB] Retrying in 1s … (backoff)

# Backoff increasing each attempt
[DB] Connection attempt 2 …
[DB] Attempt 2 failed: ECONNREFUSED
[DB] Retrying in 2s … (backoff)

[DB] Connection attempt 3 …
[DB] Attempt 3 failed: ECONNREFUSED
[DB] Retrying in 4s … (backoff)

# When MySQL comes back up
[DB] Connection attempt 4 …
[DB] New connection established in pool.
[DB] Connected successfully. ✅
```

#### Step 4 – Verify recovery in browser

```
http://localhost:8080/api/health
```

Expected after recovery:
```json
{
  "status": "ok",
  "database": {
    "status": "ok",
    "message": "MySQL reachable"
  }
}
```

#### How long does recovery take?

| Situation | Recovery time |
|-----------|--------------|
| MySQL restarts quickly (2-3s) | Almost instant — backend reconnects on next attempt |
| MySQL takes longer (cold boot) | 30-60s — backoff keeps retrying automatically |
| MySQL never comes back | Backend stays alive, /health reports degraded |

> **Key point:** The backend NEVER crashes or needs a manual restart.
> It recovers 100% automatically using event-driven reconnection.

---

### Scenario 2 – MySQL Stop and Start

```bash
# Stop MySQL completely
docker compose stop db

# Check backend is still running (not crashed)
docker compose ps

# Health returns 503 but backend is alive
curl http://localhost:8080/api/health

# Start MySQL again
docker compose start db

# Wait ~30s for MySQL to initialise
# Health returns 200 automatically
curl http://localhost:8080/api/health
```

---

### Scenario 3 – Full Stack Restart

```bash
# Stop everything
docker compose down

# Start everything again
docker compose up -d

# Watch startup ORDER in logs
docker compose logs -f
```

Expected startup order:
```
db      | ready for connections     ← step 1: DB starts first
backend | [APP] Listening on 3000   ← step 2: backend starts after DB healthy
backend | [DB] Connected ✅         ← step 3: backend connects to DB
frontend| nginx started             ← step 4: frontend starts last
```

This order is enforced by `depends_on: condition: service_healthy`.

---

### Scenario 4 – Data Persistence Test

```bash
# Stop containers (volume is kept)
docker compose down

# Check volume still exists
docker volume ls
# → dockerassignment_db_data still listed ✅

# Restart
docker compose up -d

# Data is still there
curl http://localhost:8080/api/health
# → "status": "ok" ✅
```

To wipe all data:
```bash
docker compose down -v   # -v removes named volumes
```

---

## Retry Logic — How it Works

```
                    ┌─────────────────────────────┐
                    │     Backend starts up        │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   connectWithRetry()         │
                    │   attempt 1 → wait 1s        │
                    │   attempt 2 → wait 2s        │
                    │   attempt 3 → wait 4s        │
                    │   attempt 4 → wait 8s        │
                    │   attempt 5 → wait 16s       │
                    │   attempt 6+ → wait 30s      │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   Connected ✅               │
                    │   enableKeepAlive active     │
                    │   pings DB every 10s         │
                    └──────────────┬──────────────┘
                                   │
                         DB goes down ❌
                                   │
                    ┌──────────────▼──────────────┐
                    │   handleDBError() triggered  │
                    │   pool = null                │
                    │   isRetrying = true          │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   connectWithRetry() again   │
                    │   exponential backoff        │
                    │   only ONE loop at a time    │
                    └──────────────┬──────────────┘
                                   │
                         DB comes back ✅
                                   │
                    ┌──────────────▼──────────────┐
                    │   Connected ✅               │
                    │   isRetrying = false         │
                    │   /health returns 200        │
                    └─────────────────────────────┘
```

### Why exponential backoff over fixed interval?

| Fixed interval (basic) | Exponential backoff (production) |
|------------------------|----------------------------------|
| Retries every 5s always | Waits longer each attempt |
| Hammers DB when down | Gentle on recovering DB |
| Wastes resources | Efficient resource use |
| Not industry standard | Used by AWS, Google, Netflix |

### Why event-driven over polling?

| Polling every 5s | Event-driven |
|-----------------|--------------|
| Always querying DB | Only queries on error |
| Wastes connections | Efficient connections |
| Runs even when healthy | Silent when healthy |
| Manual timer management | Uses built-in mysql2 events |

---

## Stopping

```bash
docker compose down          # stop & remove containers (volume kept)
docker compose down -v       # stop & remove containers + volume
```

---

## Environment Variables Reference

| Variable | Used by | Description |
|----------|---------|-------------|
| `MYSQL_ROOT_PASSWORD` | db, db healthcheck | MySQL root password |
| `MYSQL_DATABASE` | db, backend | Database name |
| `MYSQL_USER` | db, backend | App DB user |
| `MYSQL_PASSWORD` | db, backend | App DB password |
| `BACKEND_PORT` | backend, frontend | Port Express listens on (default `3000`) |
| `FRONTEND_PORT` | docker-compose | Host port for Nginx (default `8080`) |

---
