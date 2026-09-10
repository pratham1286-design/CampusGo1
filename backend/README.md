# CampusGo backend

## Chosen stack

FastAPI + SQLite (`sqlite3`) + signed HTTP-only session cookies for the local runnable adapter. `requirements.txt` also declares SQLAlchemy async/asyncpg, Redis, slowapi, and itsdangerous for the production deployment target. The current local implementation keeps the database and matching boundaries explicit so they can be moved to PostgreSQL/PostGIS, Redis/BullMQ, and Socket.IO without changing the public API contract.

## Run locally

```powershell
python -m uvicorn backend.api:app --reload --port 8000
```

The existing frontend runs separately on `http://localhost:4173`.

## API notes

- `/auth/verify` accepts an `@lpu.in` or `@lpu.ac.in` address, or a numeric LPU ID. Replace this local domain/ID check with the university identity provider before production.
- `/auth/login` sets the signed `campusgo_session` HTTP-only cookie.
- `POST /rides/estimate` checks zone-scoped driver availability before any wallet action.
- `POST /rides/{id}/confirm` recomputes the fare and performs driver assignment, balance check, wallet deduction, and audit record in one SQLite transaction.
- `/wallet/topup` creates a pending transaction only. It never credits a wallet. A Razorpay webhook adapter must verify the raw-body signature and settle the transaction before production use.
- SOS events are persisted and return the number of stored contacts queued for dispatch. SMS/push credentials and provider selection remain an explicit integration step.

## Tests

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

The local SQLite implementation is for development and review. Production deployment must use HTTPS, a managed relational database, Redis-backed queueing/pub-sub, a real payment provider, and load tests for class-change spikes.
