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
│   ├── index.js              # Express app + retry logic
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
> The backend uses retry logic (up to 20 attempts, 5 s apart) so it will  
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

### 2 – Backend retry logic

```
Backend starts → HTTP server binds immediately (always reachable for healthchecks)
             → connectWithRetry() runs in background
             → retries every 5 s, up to 20 times (~100 s total)
             → if MySQL restarts later, /health triggers a re-attempt automatically
```

This means the backend **never crashes** due to DB unavailability, satisfying Docker's healthcheck and allowing Compose to continue starting.

### 3 – `depends_on` with `condition: service_healthy`

```
frontend depends_on backend (healthy)
backend  depends_on db      (healthy)
```

Docker waits for each layer's healthcheck to pass before starting the next.  
This is safer than `wait-for` scripts that add extra dependencies.

### 4 – Multi-stage backend image

```
Stage 1 (deps): node:20-alpine → npm ci --omit=dev
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
curl http://localhost:8080/api/health | jq .
```

### Failure scenarios

#### Simulate MySQL crash and recovery

```bash
# Stop MySQL
docker compose stop db

# Health endpoint now returns 503
curl -o /dev/null -w "%{http_code}" http://localhost:8080/api/health
# → 503

# Restart MySQL
docker compose start db

# Wait ~30 s for MySQL to initialise + backend to reconnect
sleep 30
curl http://localhost:8080/api/health | jq .status
# → "ok"
```

The backend **recovers automatically** — no container restart needed.

#### Inspect logs

```bash
docker compose logs -f backend   # retry attempts visible here
docker compose logs -f db
docker compose logs -f frontend
```

#### Test DB persistence

```bash
docker compose down          # stop containers (volume survives)
docker compose up -d         # restart
curl http://localhost:8080/api/health   # DB still has its data
```

To wipe the volume:

```bash
docker compose down -v       # -v removes named volumes
```

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

## Production Considerations (Beyond This Assignment)

- Add TLS termination (Certbot / Traefik)
- Use Docker secrets instead of env vars for passwords
- Switch logging driver to `fluentd` or `loki`
- Add rate limiting in Nginx
- Use a read replica for MySQL health checks to avoid write-lock
- Move to Kubernetes with Helm for multi-node deployments
