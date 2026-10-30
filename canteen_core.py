from __future__ import annotations

import hashlib
import hmac
import json
import math
import random
import re
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "data" / "streamlit-canteen.sqlite"
COUNTER_NAMES = {
    1: "Meals Counter",
    2: "South Indian & Breakfast Counter",
    3: "Snacks & Chaat Counter",
    4: "Chinese Counter",
    5: "Beverages & Fruit Counter",
}
ALLOWED_ROLES = {"student", "faculty", "staff", "kitchen", "cashier", "admin"}
MIN_TRAINING_SAMPLES = 8
MAX_TRAINING_SAMPLES = 300
MAX_WAIT_MINUTES = 240
INPUT_COUNT = 8
HIDDEN_COUNT = 8


def connect(db_path: str | Path = DEFAULT_DB) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


@contextmanager
def connection_scope(db_path: str | Path = DEFAULT_DB):
    connection = connect(db_path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_db(db_path: str | Path = DEFAULT_DB) -> None:
    with connection_scope(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL REFERENCES users(id),
                customer_name TEXT NOT NULL,
                total REAL NOT NULL,
                payment_method TEXT NOT NULL,
                payment_status TEXT NOT NULL,
                status TEXT NOT NULL,
                items_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS orders_owner_created ON orders(owner_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS tickets (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                counter INTEGER NOT NULL,
                items_json TEXT NOT NULL,
                prep_minutes REAL NOT NULL,
                quantity INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                accepted_at REAL,
                ready_at REAL,
                accepted_features_json TEXT
            );
            CREATE INDEX IF NOT EXISTS tickets_counter_status ON tickets(counter, status, created_at);
            CREATE TABLE IF NOT EXISTS queue_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                counter INTEGER NOT NULL,
                features_json TEXT NOT NULL,
                actual_wait_minutes REAL NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS queue_samples_counter_created ON queue_samples(counter, created_at DESC);
            """
        )


def _password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)


def create_user(
    username: str,
    display_name: str,
    password: str,
    role: str = "student",
    db_path: str | Path = DEFAULT_DB,
    allow_demo_password: bool = False,
) -> dict[str, str]:
    username = username.strip()
    display_name = display_name.strip()
    role = role.lower()
    if not re.fullmatch(r"[\w.@+-]{3,80}", username):
        raise ValueError("Username must be 3–80 letters, numbers, or . _ @ + -.")
    if not display_name or len(display_name) > 100:
        raise ValueError("Enter a name up to 100 characters.")
    minimum_password_length = 8 if allow_demo_password and role == "student" else 10
    if len(password) < minimum_password_length or len(password) > 200:
        raise ValueError(f"Password must be {minimum_password_length}–200 characters.")
    if role not in ALLOWED_ROLES:
        raise ValueError("Choose a valid account role.")
    salt = secrets.token_bytes(16)
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "name": display_name,
        "role": role,
    }
    with connection_scope(db_path) as connection:
        connection.execute(
            """INSERT INTO users
               (id, username, display_name, role, password_salt, password_hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                user["id"],
                username,
                display_name,
                role,
                salt.hex(),
                _password_hash(password, salt).hex(),
                datetime.now(timezone.utc).timestamp(),
            ),
        )
    return user


def _ensure_configured_user(
    config: dict[str, Any], prefix: str, role: str, db_path: str | Path
) -> None:
    username = str(config.get(f"{prefix}_USERNAME", "")).strip()
    password = str(config.get(f"{prefix}_PASSWORD", ""))
    name = str(config.get(f"{prefix}_NAME", username or prefix.title())).strip()
    if not username or not password:
        return
    with connection_scope(db_path) as connection:
        existing = connection.execute(
            "SELECT id, role FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
    if existing is None:
        create_user(
            username,
            name,
            password,
            role,
            db_path,
            allow_demo_password=prefix == "DEMO",
        )
    elif existing["role"] != role:
        raise ValueError(f"Configured account {username!r} already exists with a different role.")


def seed_configured_users(config: dict[str, Any], db_path: str | Path = DEFAULT_DB) -> None:
    initialize_db(db_path)
    for prefix, role in (
        ("DEMO", "student"),
        ("KITCHEN", "kitchen"),
        ("CASHIER", "cashier"),
        ("ADMIN", "admin"),
    ):
        _ensure_configured_user(config, prefix, role, db_path)


def authenticate(
    username: str, password: str, db_path: str | Path = DEFAULT_DB
) -> dict[str, str] | None:
    with connection_scope(db_path) as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username.strip(),)
        ).fetchone()
    if row is None or row["disabled"]:
        return None
    salt = bytes.fromhex(row["password_salt"])
    expected = bytes.fromhex(row["password_hash"])
    if not hmac.compare_digest(_password_hash(password, salt), expected):
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "name": row["display_name"],
        "role": row["role"],
    }


def normalize_features(features: dict[str, float]) -> list[float]:
    return [
        min(1.0, max(0.0, float(features.get("queueOrders", 0)) / 20)),
        min(1.0, max(0.0, float(features.get("queueMinutes", 0)) / MAX_WAIT_MINUTES)),
        min(1.0, max(0.0, float(features.get("prepMinutes", 0)) / 60)),
        min(1.0, max(0.0, float(features.get("quantity", 1)) / 20)),
        min(1.0, max(0.0, float(features.get("staff", 1)) / 10)),
        min(1.0, max(0.0, float(features.get("rushFactor", 1)) / 2)),
        min(1.0, max(0.0, float(features.get("hour", 12)) / 23)),
        min(1.0, max(0.0, float(features.get("weekday", 0)) / 6)),
    ]


def _forward(
    model: dict[str, Any], inputs: list[float]
) -> tuple[list[float], float]:
    hidden = [
        max(
            0.0,
            sum(weight * value for weight, value in zip(weights, inputs))
            + model["hiddenBias"][index],
        )
        for index, weights in enumerate(model["inputWeights"])
    ]
    output = sum(
        weight * value for weight, value in zip(model["outputWeights"], hidden)
    ) + model["outputBias"]
    return hidden, output


def train_queue_model(
    samples: list[dict[str, Any]], counter: int
) -> dict[str, Any] | None:
    valid = [
        sample
        for sample in samples[-MAX_TRAINING_SAMPLES:]
        if sample.get("features") is not None
        and math.isfinite(float(sample.get("targetMinutes", -1)))
        and float(sample.get("targetMinutes", -1)) >= 0
    ]
    if not valid:
        return None
    data = [
        (
            normalize_features(sample["features"]),
            min(MAX_WAIT_MINUTES, float(sample["targetMinutes"])) / MAX_WAIT_MINUTES,
        )
        for sample in valid
    ]
    rng = random.Random(counter * 7919 + len(valid) * 104729)
    model = {
        "inputWeights": [
            [(rng.random() * 2 - 1) * 0.25 for _ in range(INPUT_COUNT)]
            for _ in range(HIDDEN_COUNT)
        ],
        "hiddenBias": [0.05] * HIDDEN_COUNT,
        "outputWeights": [(rng.random() * 2 - 1) * 0.05 for _ in range(HIDDEN_COUNT)],
        "outputBias": sum(target for _, target in data) / len(data),
    }
    learning_rate = 0.035
    for _ in range(280):
        input_gradient = [[0.0] * INPUT_COUNT for _ in range(HIDDEN_COUNT)]
        hidden_gradient = [0.0] * HIDDEN_COUNT
        output_gradient = [0.0] * HIDDEN_COUNT
        output_bias_gradient = 0.0
        for inputs, target in data:
            hidden, output = _forward(model, inputs)
            error = output - target
            output_bias_gradient += error
            for hidden_index in range(HIDDEN_COUNT):
                output_gradient[hidden_index] += error * hidden[hidden_index]
                if hidden[hidden_index] > 0:
                    gradient = error * model["outputWeights"][hidden_index]
                    hidden_gradient[hidden_index] += gradient
                    for feature_index, value in enumerate(inputs):
                        input_gradient[hidden_index][feature_index] += gradient * value
        scale = learning_rate / len(data)
        model["outputBias"] -= output_bias_gradient * scale
        for hidden_index in range(HIDDEN_COUNT):
            model["hiddenBias"][hidden_index] -= hidden_gradient[hidden_index] * scale
            model["outputWeights"][hidden_index] -= output_gradient[hidden_index] * scale
            for feature_index in range(INPUT_COUNT):
                model["inputWeights"][hidden_index][feature_index] -= (
                    input_gradient[hidden_index][feature_index] * scale
                )
    model["sampleCount"] = len(valid)
    model["ready"] = len(valid) >= MIN_TRAINING_SAMPLES
    return model


def predict_queue_minutes(model: dict[str, Any], features: dict[str, float]) -> float:
    _, output = _forward(model, normalize_features(features))
    return min(MAX_WAIT_MINUTES, max(0.0, output * MAX_WAIT_MINUTES))


def _current_features(
    prep_minutes: float,
    quantity: int,
    queue_orders: int,
    queue_minutes: float,
    staff: int,
    rush_factor: float,
) -> dict[str, float]:
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    return {
        "queueOrders": queue_orders,
        "queueMinutes": queue_minutes,
        "prepMinutes": prep_minutes,
        "quantity": quantity,
        "staff": max(1, staff),
        "rushFactor": rush_factor,
        "hour": now.hour,
        "weekday": now.weekday(),
    }


def _counter_model(
    connection: sqlite3.Connection, counter: int
) -> dict[str, Any] | None:
    rows = connection.execute(
        """SELECT features_json, actual_wait_minutes FROM queue_samples
           WHERE counter = ? ORDER BY created_at DESC LIMIT ?""",
        (counter, MAX_TRAINING_SAMPLES),
    ).fetchall()
    samples = [
        {"features": json.loads(row["features_json"]), "targetMinutes": row["actual_wait_minutes"]}
        for row in reversed(rows)
    ]
    return train_queue_model(samples, counter)


def estimate_wait(
    counter: int,
    prep_minutes: float,
    quantity: int,
    created_before: float | None = None,
    db_path: str | Path = DEFAULT_DB,
) -> tuple[int, str]:
    with connection_scope(db_path) as connection:
        query = """SELECT prep_minutes, status, accepted_at FROM tickets
                   WHERE counter = ? AND status IN ('queued', 'preparing')"""
        params: list[Any] = [counter]
        if created_before is not None:
            query += " AND created_at < ?"
            params.append(created_before)
        rows = connection.execute(query, params).fetchall()
        queue_orders = len(rows)
        queue_minutes = sum(
            max(0.0, float(row["prep_minutes"]) - (
                (datetime.now(timezone.utc).timestamp() - row["accepted_at"]) / 60
                if row["accepted_at"] is not None and row["status"] == "preparing"
                else 0
            ))
            for row in rows
        )
        features = _current_features(
            prep_minutes, quantity, queue_orders, queue_minutes, 1, 1.25
        )
        model = _counter_model(connection, counter)
    fallback = math.ceil(queue_minutes + prep_minutes)
    if model and model["ready"]:
        return max(1, math.ceil(predict_queue_minutes(model, features))), "Neural estimate"
    return max(1, fallback), "Preparation + live queue"


def place_order(
    user: dict[str, str],
    selections: dict[str, int],
    menu: list[dict[str, Any]],
    payment_method: str,
    db_path: str | Path = DEFAULT_DB,
) -> str:
    catalog = {str(item["id"]): item for item in menu}
    quantities: dict[str, int] = {}
    for item_id, quantity in selections.items():
        if int(quantity) > 0:
            if str(item_id) not in catalog or int(quantity) > 50:
                raise ValueError("The order contains an invalid menu item or quantity.")
            quantities[str(item_id)] = int(quantity)
    if not quantities:
        raise ValueError("Add at least one item before placing an order.")
    if payment_method not in {"Cash on delivery", "UPI (demo)", "Card (demo)"}:
        raise ValueError("Choose a supported demo payment method.")
    items = []
    grouped: dict[int, list[dict[str, Any]]] = {}
    for item_id, quantity in quantities.items():
        product = catalog[item_id]
        entry = {
            "id": item_id,
            "name": product["name"],
            "category": product["category"],
            "counter": int(product["station"]),
            "price": float(product["price"]),
            "prep": float(product["basePrepMinutes"]),
            "quantity": quantity,
        }
        items.append(entry)
        grouped.setdefault(entry["counter"], []).append(entry)
    order_id = uuid.uuid4().hex[:10].upper()
    now = datetime.now(timezone.utc).timestamp()
    total = sum(item["price"] * item["quantity"] for item in items)
    payment_status = "pending" if payment_method == "Cash on delivery" else "demo"
    with connection_scope(db_path) as connection:
        connection.execute(
            """INSERT INTO orders
               (id, owner_id, customer_name, total, payment_method, payment_status,
                status, items_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)""",
            (
                order_id, user["id"], user["name"], total, payment_method,
                payment_status, json.dumps(items), now, now,
            ),
        )
        for counter, ticket_items in grouped.items():
            quantity = sum(item["quantity"] for item in ticket_items)
            prep_minutes = sum(item["prep"] * item["quantity"] for item in ticket_items)
            connection.execute(
                """INSERT INTO tickets
                   (id, order_id, counter, items_json, prep_minutes, quantity, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)""",
                (
                    str(uuid.uuid4()), order_id, counter, json.dumps(ticket_items),
                    prep_minutes, quantity, now,
                ),
            )
    return order_id


def list_orders(
    user: dict[str, str], db_path: str | Path = DEFAULT_DB
) -> list[dict[str, Any]]:
    with connection_scope(db_path) as connection:
        if user["role"] in {"admin", "kitchen", "cashier"}:
            rows = connection.execute(
                "SELECT * FROM orders ORDER BY created_at DESC LIMIT 100"
            ).fetchall()
        else:
            rows = connection.execute(
                """SELECT * FROM orders WHERE owner_id = ?
                   ORDER BY created_at DESC LIMIT 100""",
                (user["id"],),
            ).fetchall()
        orders = [dict(row) for row in rows]
        for order in orders:
            order["items"] = json.loads(order.pop("items_json"))
            tickets = connection.execute(
                "SELECT * FROM tickets WHERE order_id = ? ORDER BY counter", (order["id"],)
            ).fetchall()
            order["tickets"] = []
            for ticket in tickets:
                data = dict(ticket)
                data["items"] = json.loads(data.pop("items_json"))
                order["tickets"].append(data)
    return orders


def list_counter_tickets(counter: int, db_path: str | Path = DEFAULT_DB) -> list[dict[str, Any]]:
    with connection_scope(db_path) as connection:
        rows = connection.execute(
            """SELECT t.*, o.customer_name, o.id AS public_order_id
               FROM tickets t JOIN orders o ON o.id = t.order_id
               WHERE t.counter = ? AND t.status IN ('queued', 'preparing')
               ORDER BY t.created_at ASC LIMIT 100""",
            (counter,),
        ).fetchall()
    tickets = [dict(row) for row in rows]
    for ticket in tickets:
        ticket["items"] = json.loads(ticket.pop("items_json"))
    return tickets


def _update_order_status(connection: sqlite3.Connection, order_id: str) -> None:
    states = [
        row["status"]
        for row in connection.execute(
            "SELECT status FROM tickets WHERE order_id = ?", (order_id,)
        ).fetchall()
    ]
    if states and all(state == "ready" for state in states):
        status = "ready"
    elif any(state == "preparing" for state in states):
        status = "preparing"
    else:
        status = "queued"
    connection.execute(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?",
        (status, datetime.now(timezone.utc).timestamp(), order_id),
    )


def set_ticket_status(
    ticket_id: str,
    status: str,
    staff_count: int = 1,
    rush_factor: float = 1.25,
    db_path: str | Path = DEFAULT_DB,
) -> None:
    if status not in {"preparing", "ready"}:
        raise ValueError("Invalid kitchen ticket status.")
    now = datetime.now(timezone.utc).timestamp()
    with connection_scope(db_path) as connection:
        ticket = connection.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if ticket is None or ticket["status"] == "ready":
            raise ValueError("This kitchen ticket is no longer active.")
        if status == "preparing":
            if ticket["status"] != "queued":
                raise ValueError("Only queued tickets can be started.")
            earlier = connection.execute(
                """SELECT prep_minutes, quantity FROM tickets
                   WHERE counter = ? AND status IN ('queued', 'preparing') AND created_at < ?""",
                (ticket["counter"], ticket["created_at"]),
            ).fetchall()
            queue_minutes = sum(float(row["prep_minutes"]) for row in earlier)
            features = _current_features(
                float(ticket["prep_minutes"]), int(ticket["quantity"]),
                len(earlier), queue_minutes, staff_count, rush_factor,
            )
            connection.execute(
                """UPDATE tickets SET status = 'preparing', accepted_at = ?,
                   accepted_features_json = ? WHERE id = ?""",
                (now, json.dumps(features), ticket_id),
            )
        else:
            if ticket["status"] != "preparing" or ticket["accepted_at"] is None:
                raise ValueError("Start this ticket before marking it ready.")
            actual_wait = max(0.0, (now - float(ticket["accepted_at"])) / 60)
            features = json.loads(ticket["accepted_features_json"] or "{}")
            connection.execute(
                "UPDATE tickets SET status = 'ready', ready_at = ? WHERE id = ?",
                (now, ticket_id),
            )
            connection.execute(
                """INSERT INTO queue_samples
                   (counter, features_json, actual_wait_minutes, created_at)
                   VALUES (?, ?, ?, ?)""",
                (ticket["counter"], json.dumps(features), actual_wait, now),
            )
            connection.execute(
                """DELETE FROM queue_samples WHERE counter = ? AND id NOT IN
                   (SELECT id FROM queue_samples WHERE counter = ?
                    ORDER BY created_at DESC LIMIT ?)""",
                (ticket["counter"], ticket["counter"], MAX_TRAINING_SAMPLES),
            )
        _update_order_status(connection, ticket["order_id"])


def set_payment_status(
    order_id: str, status: str, db_path: str | Path = DEFAULT_DB
) -> None:
    if status not in {"paid", "collected"}:
        raise ValueError("Unsupported payment action.")
    with connection_scope(db_path) as connection:
        order = connection.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if order is None or order["status"] != "ready":
            raise ValueError("Only ready orders can be handed over.")
        if status == "collected" and order["payment_status"] == "pending":
            raise ValueError("Record cash payment before collection.")
        connection.execute(
            "UPDATE orders SET payment_status = ?, status = ?, updated_at = ? WHERE id = ?",
            (
                "paid" if status == "paid" else order["payment_status"],
                "collected" if status == "collected" else order["status"],
                datetime.now(timezone.utc).timestamp(),
                order_id,
            ),
        )


def model_status(db_path: str | Path = DEFAULT_DB) -> dict[int, dict[str, Any]]:
    with connection_scope(db_path) as connection:
        return {
            counter: {
                "sampleCount": connection.execute(
                    "SELECT COUNT(*) FROM queue_samples WHERE counter = ?", (counter,)
                ).fetchone()[0],
                "model": _counter_model(connection, counter),
            }
            for counter in COUNTER_NAMES
        }
