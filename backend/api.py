import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import logging
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("CAMPUSGO_DB", BASE_DIR / "campusgo.sqlite3"))
SESSION_SECRET = os.getenv("CAMPUSGO_SESSION_SECRET", "local-only-change-me")
SESSION_TTL_SECONDS = 60 * 60 * 12
CAMPUS_ZONE = "zone-04"
RATE_LIMIT_WINDOW = 60
RATE_LIMITS = {"ride": 12, "wallet": 5, "sos": 3, "verify": 10}
rate_state: dict[tuple[int, str], list[float]] = {}
ip_rate_state: dict[tuple[str, str], list[float]] = {}
verification_challenges: dict[str, dict[str, Any]] = {}
ride_estimates: dict[str, dict[str, Any]] = {}
logger = logging.getLogger("campusgo")

app = FastAPI(title="CampusGo API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:4173", "http://127.0.0.1:4173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class VerifyRequest(BaseModel):
    lpu_id: str = Field(min_length=5, max_length=80)
    email: str = Field(min_length=6, max_length=160)

    @field_validator("lpu_id", "email")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip().lower()


class LoginRequest(BaseModel):
    challenge_id: str = Field(min_length=20, max_length=100)


class RoleRequest(BaseModel):
    role: Literal["rider", "driver", "both"]
    teacher: bool = False


class ContactRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    phone: str = Field(min_length=7, max_length=30)

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value: str) -> str:
        normalized = re.sub(r"[\s().-]", "", value)
        if not re.fullmatch(r"\+?[1-9]\d{7,14}", normalized):
            raise ValueError("phone must be a valid international number")
        return normalized


class VehicleRequest(BaseModel):
    type: Literal["bike", "scooty", "car"]
    plate: str = Field(min_length=4, max_length=20)
    model: str = Field(min_length=2, max_length=80)


class EstimateRequest(BaseModel):
    destination: str = Field(min_length=2, max_length=180)
    pickup: str = Field(default="Near Block 14", min_length=2, max_length=180)
    service: Literal["Bike", "Scooty", "Car"]


class RideRequest(EstimateRequest):
    estimate_id: str = Field(min_length=12, max_length=80)


class RouteRequest(BaseModel):
    origin: str = Field(min_length=2, max_length=180)
    destination: str = Field(min_length=2, max_length=180)
    scheduled_time: datetime
    seats_available: int = Field(ge=1, le=6)
    vehicle_type: Literal["bike", "scooty", "car"]


class TopupRequest(BaseModel):
    amount: int = Field(gt=0, le=50000)
    payment_order_id: str = Field(min_length=6, max_length=120)


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    db = connect()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lpu_id TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL DEFAULT 'rider',
            verified INTEGER NOT NULL DEFAULT 0,
            teacher INTEGER NOT NULL DEFAULT 0,
            rating REAL NOT NULL DEFAULT 5.0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            type TEXT NOT NULL,
            plate TEXT NOT NULL,
            model TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS driver_locations (
            driver_id INTEGER PRIMARY KEY REFERENCES users(id),
            zone TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wallets (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            balance INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS wallet_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            amount INTEGER NOT NULL,
            type TEXT NOT NULL,
            ride_id INTEGER,
            status TEXT NOT NULL,
            gateway_reference TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rider_id INTEGER NOT NULL REFERENCES users(id),
            driver_id INTEGER REFERENCES users(id),
            type TEXT NOT NULL,
            service TEXT NOT NULL,
            pickup TEXT NOT NULL,
            destination TEXT NOT NULL,
            zone TEXT NOT NULL,
            fare INTEGER NOT NULL,
            status TEXT NOT NULL,
            estimate_id TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS driver_routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            driver_id INTEGER NOT NULL REFERENCES users(id),
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            scheduled_time TEXT NOT NULL,
            seats_available INTEGER NOT NULL,
            vehicle_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open'
        );
        CREATE TABLE IF NOT EXISTS emergency_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            phone TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sos_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ride_id INTEGER NOT NULL REFERENCES rides(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            triggered_at TEXT NOT NULL,
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_rides_zone_status ON rides(zone, status);
        CREATE INDEX IF NOT EXISTS idx_users_role_verified ON users(role, verified);
        CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON wallet_transactions(user_id, created_at);
        """
    )
    seed = db.execute("SELECT id FROM users WHERE lpu_id = ?", ("driver-demo",)).fetchone()
    if not seed:
        now = utc_now()
        driver_id = db.execute("INSERT INTO users (lpu_id,email,role,verified,teacher,rating,created_at) VALUES (?,?,?,?,?, ?,?)", ("driver-demo", "driver@lpu.in", "driver", 1, 0, 4.9, now)).lastrowid
        db.execute("INSERT INTO vehicles (user_id,type,plate,model) VALUES (?,?,?,?)", (driver_id, "bike", "PB08A4521", "Yamaha R15"))
        db.execute("INSERT INTO driver_locations (driver_id,zone,updated_at) VALUES (?,?,?)", (driver_id, CAMPUS_ZONE, now))
        db.execute("INSERT INTO wallets (user_id,balance) VALUES (?,?)", (driver_id, 0))
    else:
        db.execute("INSERT OR IGNORE INTO driver_locations (driver_id,zone,updated_at) VALUES (?,?,?)", (seed["id"], CAMPUS_ZONE, utc_now()))
        db.execute("INSERT OR IGNORE INTO wallets (user_id,balance) VALUES (?,?)", (seed["id"], 0))
    db.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sign_session(user_id: int) -> str:
    payload = json.dumps({"user_id": user_id, "expires": int(time.time()) + SESSION_TTL_SECONDS}, separators=(",", ":"))
    encoded = payload.encode().hex()
    signature = hmac.new(SESSION_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def verify_session(value: str) -> int:
    try:
        encoded, signature = value.split(".", 1)
        expected = hmac.new(SESSION_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        payload = json.loads(bytes.fromhex(encoded))
        if payload["expires"] < time.time():
            raise ValueError
        return int(payload["user_id"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="Valid CampusGo session required")


def current_user(campusgo_session: str | None = Cookie(default=None), authorization: str | None = Header(default=None)) -> sqlite3.Row:
    token = campusgo_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Valid CampusGo session required")
    db = connect()
    user = db.execute("SELECT * FROM users WHERE id = ? AND verified = 1", (verify_session(token),)).fetchone()
    db.close()
    if not user:
        raise HTTPException(status_code=403, detail="Verified LPU account required")
    return user


def rate_limit(user_id: int, bucket: str) -> None:
    now = time.time()
    key = (user_id, bucket)
    recent = [stamp for stamp in rate_state.get(key, []) if stamp > now - RATE_LIMIT_WINDOW]
    if len(recent) >= RATE_LIMITS[bucket]:
        raise HTTPException(status_code=429, detail="Too many requests; try again shortly")
    recent.append(now)
    rate_state[key] = recent


def rate_limit_ip(client_ip: str, bucket: str) -> None:
    now = time.time()
    key = (client_ip, bucket)
    recent = [stamp for stamp in ip_rate_state.get(key, []) if stamp > now - RATE_LIMIT_WINDOW]
    if len(recent) >= RATE_LIMITS[bucket]:
        raise HTTPException(status_code=429, detail="Too many verification attempts; try again shortly")
    recent.append(now)
    ip_rate_state[key] = recent


def teacher_identity(email: str, lpu_id: str) -> bool:
    configured_domains = tuple(filter(None, os.getenv("LPU_TEACHER_EMAIL_DOMAINS", "faculty.lpu.in,staff.lpu.in").split(",")))
    return email.startswith(("teacher.", "faculty.")) or any(email.endswith(f"@{domain}") for domain in configured_domains) or lpu_id.startswith(("faculty-", "staff-"))


def user_payload(user: sqlite3.Row) -> dict[str, Any]:
    return {"id": user["id"], "lpu_id": user["lpu_id"], "email": user["email"], "role": user["role"], "verified": bool(user["verified"]), "teacher": bool(user["teacher"]), "rating": user["rating"]}


def calculate_fare(service: str, destination: str) -> int:
    base = {"Bike": 15, "Scooty": 25, "Car": 45}[service]
    city_destination = any(word in destination.lower() for word in ("jalandhar", "phagwara", "ludhiana"))
    return base + (max(1, len(destination) // 18) * 12 if city_destination else 0)


def available_driver(db: sqlite3.Connection, service: str, zone: str = CAMPUS_ZONE) -> sqlite3.Row | None:
    vehicle_type = service.lower()
    return db.execute("""SELECT u.id, u.teacher, u.rating, v.model, v.plate FROM users u JOIN vehicles v ON v.user_id = u.id JOIN driver_locations dl ON dl.driver_id = u.id WHERE u.verified = 1 AND u.role IN ('driver','both') AND v.type = ? AND dl.zone = ? AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = u.id AND r.status IN ('matched','in_progress')) ORDER BY u.teacher DESC, u.rating DESC LIMIT 1""", (vehicle_type, zone)).fetchone()


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "campusgo-api"}


@app.post("/auth/verify")
def verify_lpu(payload: VerifyRequest, request: Request) -> dict[str, Any]:
    rate_limit_ip(request.client.host if request.client else "unknown", "verify")
    allowed = payload.email.endswith(("@lpu.in", "@lpu.ac.in")) and bool(re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,79}", payload.lpu_id))
    if not allowed:
        raise HTTPException(status_code=400, detail="Use a valid LPU email or LPU ID")
    challenge_id = secrets.token_urlsafe(24)
    verification_challenges[challenge_id] = {"lpu_id": payload.lpu_id, "email": payload.email, "teacher": teacher_identity(payload.email, payload.lpu_id), "expires": time.time() + 600}
    return {"challenge_id": challenge_id, "verified": True, "message": "LPU identity verified"}


@app.post("/auth/login")
def login(payload: LoginRequest, response: Response) -> dict[str, Any]:
    challenge = verification_challenges.pop(payload.challenge_id, None)
    if not challenge or challenge["expires"] < time.time():
        raise HTTPException(status_code=401, detail="Verification challenge expired")
    db = connect()
    now = utc_now()
    db.execute("INSERT INTO users (lpu_id,email,verified,teacher,created_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified=1,teacher=excluded.teacher", (challenge["lpu_id"], challenge["email"], 1, int(challenge["teacher"]), now))
    user = db.execute("SELECT * FROM users WHERE email = ?", (challenge["email"],)).fetchone()
    db.execute("INSERT OR IGNORE INTO wallets (user_id,balance) VALUES (?,0)", (user["id"],))
    db.close()
    response.set_cookie("campusgo_session", sign_session(user["id"]), httponly=True, secure=os.getenv("CAMPUSGO_ENV") == "production", samesite="strict", max_age=SESSION_TTL_SECONDS)
    return {"user": user_payload(user)}


@app.post("/profile/role")
def set_role(payload: RoleRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    db = connect()
    db.execute("UPDATE users SET role=?,teacher=? WHERE id=?", (payload.role, user["teacher"], user["id"]))
    updated = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    db.close()
    return {"user": user_payload(updated)}


@app.post("/profile/emergency-contacts")
def add_contact(payload: ContactRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, int]:
    db = connect()
    contact_id = db.execute("INSERT INTO emergency_contacts (user_id,name,phone) VALUES (?,?,?)", (user["id"], payload.name, payload.phone)).lastrowid
    db.close()
    return {"id": contact_id}


@app.post("/profile/vehicle")
def add_vehicle(payload: VehicleRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, int]:
    if user["role"] not in ("driver", "both"):
        raise HTTPException(status_code=403, detail="Driver role required")
    db = connect()
    vehicle_id = db.execute("INSERT INTO vehicles (user_id,type,plate,model) VALUES (?,?,?,?)", (user["id"], payload.type, payload.plate.upper(), payload.model)).lastrowid
    db.close()
    return {"id": vehicle_id}


@app.get("/wallet/balance")
def wallet_balance(user: sqlite3.Row = Depends(current_user)) -> dict[str, int]:
    db = connect()
    wallet = db.execute("SELECT balance FROM wallets WHERE user_id=?", (user["id"],)).fetchone()
    db.close()
    return {"balance": wallet["balance"] if wallet else 0}


@app.post("/wallet/topup", status_code=202)
def wallet_topup(payload: TopupRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    rate_limit(user["id"], "wallet")
    db = connect()
    db.execute("INSERT INTO wallet_transactions (user_id,amount,type,status,gateway_reference,created_at) VALUES (?,?,?,?,?,?)", (user["id"], payload.amount, "topup", "pending", payload.payment_order_id, utc_now()))
    db.close()
    return {"status": "pending", "message": "Awaiting verified Razorpay webhook", "amount": payload.amount}


@app.post("/payments/razorpay/webhook")
def payment_webhook(request: Request, x_razorpay_signature: str | None = Header(default=None)) -> dict[str, str]:
    # Production assumption: configure RAZORPAY_WEBHOOK_SECRET and verify the raw body before crediting.
    secret = os.getenv("RAZORPAY_WEBHOOK_SECRET")
    if not secret or not x_razorpay_signature:
        raise HTTPException(status_code=503, detail="Payment webhook is not configured")
    raise HTTPException(status_code=501, detail="Gateway adapter pending credential configuration")


@app.post("/rides/estimate")
def ride_estimate(payload: EstimateRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    db = connect()
    driver = available_driver(db, payload.service)
    fare = calculate_fare(payload.service, payload.destination)
    estimate_id = secrets.token_urlsafe(16)
    ride_estimates[estimate_id] = {"user_id": user["id"], "destination": payload.destination, "pickup": payload.pickup, "service": payload.service, "fare": fare, "zone": CAMPUS_ZONE, "expires": time.time() + 120}
    db.close()
    return {"estimate_id": estimate_id, "available": bool(driver), "fare": fare, "currency": "INR", "service": payload.service, "driver_eta_minutes": 3 if driver else None, "zone": CAMPUS_ZONE}


@app.post("/rides/request", status_code=201)
def request_ride(payload: RideRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    rate_limit(user["id"], "ride")
    db = connect()
    estimate = ride_estimates.pop(payload.estimate_id, None)
    if not estimate or estimate["expires"] < time.time() or estimate["user_id"] != user["id"] or estimate["destination"] != payload.destination or estimate["pickup"] != payload.pickup or estimate["service"] != payload.service:
        db.close()
        raise HTTPException(status_code=409, detail="estimate_expired")
    driver = available_driver(db, payload.service, estimate["zone"])
    if not driver:
        db.close()
        raise HTTPException(status_code=409, detail="no_ride_available")
    fare = estimate["fare"]
    now = utc_now()
    ride_id = db.execute("INSERT INTO rides (rider_id,type,service,pickup,destination,zone,fare,status,estimate_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (user["id"], "citylink" if fare > 45 else "campus_hop", payload.service, payload.pickup, payload.destination, estimate["zone"], fare, "requested", payload.estimate_id, now)).lastrowid
    db.close()
    return {"ride_id": ride_id, "status": "requested", "fare": fare, "message": "Ride request queued in your campus zone"}


@app.post("/rides/{ride_id}/confirm")
def confirm_ride(ride_id: int, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    rate_limit(user["id"], "ride")
    db = connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        ride = db.execute("SELECT * FROM rides WHERE id=? AND rider_id=?", (ride_id, user["id"])).fetchone()
        if not ride or ride["status"] != "requested":
            raise HTTPException(status_code=409, detail="ride_unavailable")
        driver = available_driver(db, ride["service"])
        wallet = db.execute("SELECT balance FROM wallets WHERE user_id=?", (user["id"],)).fetchone()
        if not driver:
            raise HTTPException(status_code=409, detail="no_ride_available")
        if not wallet or wallet["balance"] < ride["fare"]:
            raise HTTPException(status_code=402, detail="topup_needed")
        db.execute("UPDATE rides SET driver_id=?,status='matched' WHERE id=?", (driver["id"], ride_id))
        db.execute("UPDATE wallets SET balance=balance-? WHERE user_id=?", (ride["fare"], user["id"]))
        db.execute("INSERT INTO wallet_transactions (user_id,amount,type,ride_id,status,created_at) VALUES (?,?,?,?,?,?)", (user["id"], -ride["fare"], "ride_charge", ride_id, "completed", utc_now()))
        db.commit()
        return {"ride_id": ride_id, "status": "matched", "fare": ride["fare"], "driver": {"name": "Nearby LPU driver", "model": driver["model"], "plate": driver["plate"], "rating": driver["rating"], "teacher": bool(driver["teacher"])}}
    except HTTPException:
        db.rollback()
        raise
    finally:
        db.close()


@app.post("/rides/{ride_id}/cancel")
def cancel_ride(ride_id: int, user: sqlite3.Row = Depends(current_user)) -> dict[str, str]:
    db = connect()
    result = db.execute("UPDATE rides SET status='cancelled' WHERE id=? AND rider_id=? AND status IN ('searching','matched')", (ride_id, user["id"]))
    db.close()
    if result.rowcount != 1:
        raise HTTPException(status_code=404, detail="Ride not found or cannot be cancelled")
    return {"status": "cancelled"}


@app.post("/rides/{ride_id}/complete")
def complete_ride(ride_id: int, user: sqlite3.Row = Depends(current_user)) -> dict[str, str]:
    db = connect()
    result = db.execute("UPDATE rides SET status='completed' WHERE id=? AND (rider_id=? OR driver_id=?) AND status='in_progress'", (ride_id, user["id"], user["id"]))
    db.close()
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="Ride is not in progress")
    return {"status": "completed"}


def dispatch_sos_alert(ride_id: int, user_id: int, contacts: list[dict[str, Any]]) -> None:
    webhook_url = os.getenv("CAMPUSGO_SOS_WEBHOOK_URL")
    if not webhook_url:
        logger.error("SOS dispatch is not configured; event=%s user=%s", ride_id, user_id)
        return
    body = json.dumps({"event": "campusgo.sos", "ride_id": ride_id, "user_id": user_id, "contacts": contacts}).encode()
    request = urllib.request.Request(webhook_url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5):
            return
    except Exception:
        logger.exception("SOS dispatch failed; event=%s user=%s", ride_id, user_id)


@app.post("/rides/{ride_id}/sos")
def ride_sos(ride_id: int, background_tasks: BackgroundTasks, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    rate_limit(user["id"], "sos")
    db = connect()
    ride = db.execute("SELECT id FROM rides WHERE id=? AND (rider_id=? OR driver_id=?)", (ride_id, user["id"], user["id"])).fetchone()
    if not ride:
        db.close()
        raise HTTPException(status_code=404, detail="Ride not found")
    event_id = db.execute("INSERT INTO sos_events (ride_id,user_id,triggered_at) VALUES (?,?,?)", (ride_id, user["id"], utc_now())).lastrowid
    contacts = db.execute("SELECT name,phone FROM emergency_contacts WHERE user_id=?", (user["id"],)).fetchall()
    db.close()
    contact_payload = [dict(contact) for contact in contacts]
    if not contact_payload:
        raise HTTPException(status_code=409, detail="trusted_contact_required")
    if not os.getenv("CAMPUSGO_SOS_WEBHOOK_URL"):
        raise HTTPException(status_code=503, detail="sos_dispatch_not_configured")
    background_tasks.add_task(dispatch_sos_alert, ride_id, user["id"], contact_payload)
    return {"event_id": event_id, "status": "alert_queued", "contacts_notified": len(contact_payload), "message": "Emergency alert queued for dispatch"}


@app.post("/driver/routes", status_code=201)
def create_route(payload: RouteRequest, user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    if user["role"] not in ("driver", "both"):
        raise HTTPException(status_code=403, detail="Driver role required")
    db = connect()
    route_id = db.execute("INSERT INTO driver_routes (driver_id,origin,destination,scheduled_time,seats_available,vehicle_type) VALUES (?,?,?,?,?,?)", (user["id"], payload.origin, payload.destination, payload.scheduled_time.isoformat(), payload.seats_available, payload.vehicle_type)).lastrowid
    db.close()
    return {"route_id": route_id, "status": "open"}


@app.get("/driver/requests")
def driver_requests(user: sqlite3.Row = Depends(current_user)) -> list[dict[str, Any]]:
    if user["role"] not in ("driver", "both"):
        raise HTTPException(status_code=403, detail="Driver role required")
    db = connect()
    rows = db.execute("SELECT id,pickup,destination,service,fare,status,created_at FROM rides WHERE driver_id=? AND status IN ('searching','matched','in_progress') ORDER BY created_at DESC", (user["id"],)).fetchall()
    db.close()
    return [dict(row) for row in rows]


@app.get("/driver/earnings")
def driver_earnings(user: sqlite3.Row = Depends(current_user)) -> dict[str, Any]:
    if user["role"] not in ("driver", "both"):
        raise HTTPException(status_code=403, detail="Driver role required")
    db = connect()
    result = db.execute("SELECT COUNT(*) AS rides, COALESCE(SUM(fare),0) AS total FROM rides WHERE driver_id=? AND status='completed'", (user["id"],)).fetchone()
    db.close()
    return {"rides_completed": result["rides"], "total_earnings": result["total"], "currency": "INR"}
