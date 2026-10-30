"use strict";

const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const vm = require("node:vm");
const { MAX_TRAINING_SAMPLES, MIN_TRAINING_SAMPLES, trainQueueModel } = require("./queue-model");

const ROOT = __dirname;
const DATA_DIR = process.env.CANTEEN_DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "canteen.sqlite");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = new Set(["student", "faculty", "staff", "kitchen", "cashier", "admin"]);
const COUNTER_NAMES = {
  1: "Meals Counter",
  2: "South Indian & Breakfast Counter",
  3: "Snacks & Chaat Counter",
  4: "Chinese Counter",
  5: "Beverages & Fruit Counter"
};
const db = (() => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, role TEXT NOT NULL, password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      hidden_by_customer INTEGER NOT NULL DEFAULT 0, archived_by_admin INTEGER NOT NULL DEFAULT 0,
      deleted_by TEXT, deleted_at INTEGER, data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_owner_created ON orders(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
    CREATE TABLE IF NOT EXISTS payment_logs (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
      action TEXT NOT NULL, method TEXT, amount REAL NOT NULL, actor_id TEXT REFERENCES users(id),
      actor_name TEXT NOT NULL, occurred_at INTEGER NOT NULL, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), actor_name TEXT NOT NULL,
      action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
      details_json TEXT NOT NULL, occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_actions_time ON admin_action_logs(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queue_training_samples (
      order_id TEXT NOT NULL, station INTEGER NOT NULL, features_json TEXT NOT NULL,
      actual_wait_minutes REAL NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (order_id, station)
    );
    CREATE INDEX IF NOT EXISTS queue_samples_station_created ON queue_training_samples(station, created_at DESC);
    CREATE TABLE IF NOT EXISTS queue_models (
      station INTEGER PRIMARY KEY, model_json TEXT NOT NULL, sample_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
})();

const statements = {
  userByName: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  userById: db.prepare("SELECT id, username, display_name AS name, role FROM users WHERE id = ? AND disabled = 0"),
  insertUser: db.prepare("INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  sessionUser: db.prepare("SELECT u.id, u.username, u.display_name AS name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  insertOrder: db.prepare("INSERT INTO orders (id, owner_id, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)"),
  updateOrder: db.prepare("UPDATE orders SET updated_at = ?, data_json = ? WHERE id = ?"),
  getOrder: db.prepare("SELECT * FROM orders WHERE id = ?"),
  hideOrder: db.prepare("UPDATE orders SET hidden_by_customer = 1, updated_at = ? WHERE id = ? AND owner_id = ?"),
  hideAllOrders: db.prepare("UPDATE orders SET hidden_by_customer = 1, updated_at = ? WHERE owner_id = ? AND hidden_by_customer = 0 AND (json_extract(data_json, '$.status') IN ('collected', 'cancelled', 'rejected') OR json_extract(data_json, '$.paymentStatus') = 'refunded')"),
  archiveOrder: db.prepare("UPDATE orders SET archived_by_admin = 1, updated_at = ? WHERE id = ? AND archived_by_admin = 0"),
  restoreOrder: db.prepare("UPDATE orders SET archived_by_admin = 0, updated_at = ? WHERE id = ? AND archived_by_admin = 1"),
  insertAction: db.prepare("INSERT INTO admin_action_logs (id, actor_id, actor_name, action, target_type, target_id, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  insertPayment: db.prepare("INSERT INTO payment_logs (id, order_id, action, method, amount, actor_id, actor_name, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  existingPayment: db.prepare("SELECT id FROM payment_logs WHERE id = ?"),
  updatePaymentActor: db.prepare("UPDATE payment_logs SET actor_id = ?, actor_name = ? WHERE id = ?")
};

function loadMenuCatalog() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const boundary = script?.indexOf("const categoryNames =");
  if (!script || boundary < 0) throw new Error("Could not load the canteen menu from index.html.");
  const context = {};
  vm.runInNewContext(`${script.slice(0, boundary)}\nglobalThis.__serverMenu = menu;`, context, { timeout: 2000 });
  if (!Array.isArray(context.__serverMenu) || !context.__serverMenu.length) throw new Error("The canteen menu is empty.");
  return context.__serverMenu.map(item => ({ ...item }));
}

const MENU_CATALOG = loadMenuCatalog();

function savedSettings() {
  const record = db.prepare("SELECT value_json FROM settings WHERE key='app'").get();
  return record ? JSON.parse(record.value_json) : {};
}

function currentIstCalendar(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    hour: Number(values.hour),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday)
  };
}

function queueFeaturesForTask(task, settings, station, excludeOrderId, timestamp = Date.now()) {
  const rushFactor = ({ quiet: 1, normal: 1.25, busy: 1.5, rush: 2 })[settings.dayMode] || 1.25;
  const activeOrders = db.prepare(`SELECT data_json FROM orders
    WHERE id != ? AND json_extract(data_json, '$.status') IN ('accepted', 'preparing')`).all(excludeOrderId);
  let queueOrders = 0;
  let queueMinutes = 0;
  for (const row of activeOrders) {
    const order = JSON.parse(row.data_json);
    for (const queuedTask of Array.isArray(order.tasks) ? order.tasks : []) {
      if (Number(queuedTask.station) !== station || queuedTask.status === "ready") continue;
      const prep = Number(queuedTask.prep);
      if (!Number.isFinite(prep) || prep <= 0) continue;
      const remaining = prep * rushFactor;
      const elapsed = queuedTask.status === "preparing" && queuedTask.startedAt
        ? Math.max(0, (timestamp - Number(queuedTask.startedAt)) / 60000)
        : 0;
      queueOrders++;
      queueMinutes += Math.max(0, remaining - elapsed);
    }
  }
  const calendar = currentIstCalendar(timestamp);
  return {
    queueOrders,
    queueMinutes,
    prepMinutes: Number(task.prep) || 0,
    quantity: (task.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    staff: Math.max(1, Number(settings.staffPerCounter?.[station]) || 1),
    rushFactor,
    hour: calendar.hour,
    weekday: calendar.weekday
  };
}

function queueModelsForStudent() {
  const models = {};
  for (const row of db.prepare("SELECT station, model_json, sample_count FROM queue_models").all()) {
    models[String(row.station)] = {
      ...JSON.parse(row.model_json),
      sampleCount: Number(row.sample_count),
      ready: Number(row.sample_count) >= MIN_TRAINING_SAMPLES
    };
  }
  return models;
}

function trainQueueModelForStation(station) {
  const rows = db.prepare(`SELECT features_json, actual_wait_minutes FROM queue_training_samples
    WHERE station = ? ORDER BY created_at DESC LIMIT ?`).all(station, MAX_TRAINING_SAMPLES);
  if (!rows.length) return;
  const samples = rows.map(row => ({
    features: JSON.parse(row.features_json),
    targetMinutes: Number(row.actual_wait_minutes)
  }));
  const model = trainQueueModel(samples, station);
  db.prepare(`INSERT INTO queue_models (station, model_json, sample_count, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(station) DO UPDATE SET
    model_json = excluded.model_json, sample_count = excluded.sample_count, updated_at = excluded.updated_at`)
    .run(station, JSON.stringify(model), model.sampleCount, Date.now());
}

function saveCompletedQueueTrainingSample(order, task, station, completedAt) {
  if (!task.mlFeatures || !order.acceptedAt) return;
  const actualWaitMinutes = Math.max(0, (completedAt - Number(order.acceptedAt)) / 60000);
  const result = db.prepare(`INSERT INTO queue_training_samples
    (order_id, station, features_json, actual_wait_minutes, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id, station) DO NOTHING`)
    .run(String(order.id), station, JSON.stringify(task.mlFeatures), actualWaitMinutes, completedAt);
  if (result.changes) trainQueueModelForStation(station);
}

function queueLoadForCustomer(user) {
  const load = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [String(index + 1), { orders: 0, minutes: 0 }]));
  const settings = savedSettings();
  const rushFactor = ({ quiet: 1, normal: 1.25, busy: 1.5, rush: 2 })[settings.dayMode] || 1.25;
  const now = Date.now();
  const rows = db.prepare(`SELECT data_json FROM orders
    WHERE owner_id != ? AND json_extract(data_json, '$.status') IN ('accepted', 'preparing')`).all(user.id);
  for (const row of rows) {
    const order = JSON.parse(row.data_json);
    for (const task of Array.isArray(order.tasks) ? order.tasks : []) {
      const station = Number(task.station);
      if (!Number.isInteger(station) || station < 1 || station > 5 || task.status === "ready") continue;
      const prep = Number(task.prep);
      if (!Number.isFinite(prep) || prep <= 0) continue;
      const work = prep * rushFactor;
      const elapsed = task.status === "preparing" && task.startedAt
        ? Math.max(0, (now - Number(task.startedAt)) / 60000)
        : 0;
      const counter = load[String(station)];
      counter.orders++;
      counter.minutes += Math.max(0, work - elapsed);
    }
  }
  for (const counter of Object.values(load)) counter.minutes = Math.round(counter.minutes * 100) / 100;
  return load;
}

function catalogOrderItems(items, settings) {
  return items.map(item => {
    const catalogItem = MENU_CATALOG.find(entry => String(entry.id) === String(item.id));
    if (!catalogItem) throw httpError(400, "An order includes an item that is not on the current canteen menu.");
    const station = Number(settings.itemMappings?.[catalogItem.id] ?? catalogItem.station);
    const availability = settings.availability?.[catalogItem.id];
    if (availability?.available === false || settings.categoryAvailability?.[catalogItem.category] === false || settings.counterAvailability?.[station] === false) {
      throw httpError(409, `${catalogItem.name} is currently unavailable.`);
    }
    return {
      ...item, id: catalogItem.id, name: catalogItem.name, category: catalogItem.category,
      station, prep: Number(settings.prepOverrides?.[catalogItem.id] ?? catalogItem.basePrepMinutes),
      price: Number(settings.priceOverrides?.[catalogItem.id] ?? catalogItem.price)
    };
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}

function safeEqual(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function recordAction(actor, action, targetType, targetId, details = {}) {
  statements.insertAction.run(
    crypto.randomUUID(), actor.id, actor.name, action, targetType,
    targetId == null ? null : String(targetId), JSON.stringify(details), Date.now()
  );
}

function createUser(username, name, password, role, minimumPasswordLength = 10) {
  if (!/^[\w.@+-]{3,80}$/.test(username)) throw httpError(400, "Username must be 3–80 letters, numbers, or . _ @ + -.");
  if (name.length < 1 || name.length > 100) throw httpError(400, "Enter a name up to 100 characters.");
  if (password.length < minimumPasswordLength || password.length > 200) throw httpError(400, `Password must be ${minimumPasswordLength}–200 characters.`);
  if (!ROLES.has(role)) throw httpError(400, "Choose a valid account role.");
  const credentials = hashPassword(password);
  const user = { id: crypto.randomUUID(), username, name, role };
  statements.insertUser.run(user.id, username, name, role, credentials.salt, credentials.hash, Date.now());
  return user;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || "";
  const token = cookies.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return token ? decodeURIComponent(token.slice(name.length + 1)) : "";
}

function buildSessionCookie(request, token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  const isHttps = request.headers["x-forwarded-proto"] === "https" || Boolean(request.socket && request.socket.encrypted);
  const secure = isHttps ? "; Secure" : "";
  if (!token) return "canteen_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + secure;
  return "canteen_session=" + encodeURIComponent(token) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAgeSeconds + secure;
}

function requireUser(request) {
  const token = cookieValue(request, "canteen_session");
  if (!token) throw httpError(401, "Please sign in to continue.");
  const user = statements.sessionUser.get(crypto.createHash("sha256").update(token).digest("hex"), Date.now());
  if (!user) throw httpError(401, "Your session expired. Please sign in again.");
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw httpError(403, "Your account does not have permission for this action.");
}

function assertClientIdentity(request, user) {
  const claimedId = request.headers["x-canteen-user-id"];
  if (claimedId && claimedId !== user.id) throw httpError(409, "Your server session changed. Please sign in again.");
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 2_000_000) throw httpError(413, "Request body is too large.");
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw httpError(400, "Request body must be valid JSON."); }
}

function orderRows(user, url) {
  const params = url.searchParams;
  const canSeeAll = !["student", "faculty", "staff"].includes(user.role);
  if (params.get("all") === "1") requireRole(user, ["admin"]);
  const includeHidden = params.get("hidden") === "1";
  const includeArchived = params.get("archived") === "1";
  const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 25));
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const predicates = [];
  const values = [];
  if (!canSeeAll) {
    predicates.push("o.owner_id = ?");
    values.push(user.id);
  }
  if (!includeHidden && !canSeeAll) predicates.push("o.hidden_by_customer = 0");
  if (["admin", "cashier"].includes(user.role)) {
    predicates.push("o.archived_by_admin = ?");
    values.push(includeArchived ? 1 : 0);
  } else if (includeArchived) throw httpError(403, "Archive access is restricted to cash-desk staff.");
  const from = params.get("from");
  const to = params.get("to");
  if (from && Number.isFinite(Date.parse(from))) { predicates.push("o.created_at >= ?"); values.push(Date.parse(from)); }
  if (to && Number.isFinite(Date.parse(to))) { predicates.push("o.created_at < ?"); values.push(Date.parse(to) + 86400000); }
  const q = (params.get("q") || "").trim();
  if (q) {
    predicates.push("(o.id LIKE ? OR lower(o.data_json) LIKE ?)");
    values.push(`%${q}%`, `%${q.toLowerCase()}%`);
  }
  const status = params.get("status");
  if (status === "refunded") predicates.push("json_extract(o.data_json, '$.paymentStatus') = 'refunded'");
  else if (status) { predicates.push("json_extract(o.data_json, '$.status') = ?"); values.push(status); }
  const payment = params.get("payment");
  if (payment === "upi") predicates.push("(json_extract(o.data_json, '$.payment') = 'upi' OR json_extract(o.data_json, '$.paymentMethodAtDesk') = 'upi')");
  else if (payment === "cod") predicates.push("(json_extract(o.data_json, '$.payment') = 'cod' AND COALESCE(json_extract(o.data_json, '$.paymentMethodAtDesk'), 'cash') = 'cash')");
  else if (payment) { predicates.push("json_extract(o.data_json, '$.payment') = ?"); values.push(payment); }
  const paymentStatus = params.get("paymentStatus");
  if (paymentStatus) { predicates.push("json_extract(o.data_json, '$.paymentStatus') = ?"); values.push(paymentStatus); }
  const counter = params.get("counter");
  if (counter) {
    predicates.push("EXISTS (SELECT 1 FROM json_each(o.data_json, '$.items') AS item WHERE CAST(json_extract(item.value, '$.station') AS TEXT) = ?)");
    values.push(counter);
  }
  const itemName = params.get("item");
  if (itemName) {
    predicates.push("EXISTS (SELECT 1 FROM json_each(o.data_json, '$.items') AS item WHERE lower(json_extract(item.value, '$.name')) LIKE ?)");
    values.push(`%${itemName.toLowerCase()}%`);
  }
  const cashier = params.get("cashier");
  if (cashier) {
    predicates.push("EXISTS (SELECT 1 FROM payment_logs p WHERE p.order_id = o.id AND lower(p.actor_name) LIKE ?)");
    values.push(`%${cashier.toLowerCase()}%`);
  }
  if (params.get("history") === "1") {
    predicates.push("(json_extract(o.data_json, '$.status') IN ('collected', 'cancelled', 'rejected') OR json_extract(o.data_json, '$.paymentStatus') = 'refunded')");
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const count = db.prepare(`SELECT COUNT(*) AS count FROM orders o ${where}`).get(...values).count;
  const rows = db.prepare(`SELECT o.*, u.display_name AS owner_name, u.username AS owner_username
    FROM orders o JOIN users u ON u.id = o.owner_id ${where}
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...values, limit, offset);
  const paymentHistory = db.prepare("SELECT id, action, method, amount, actor_name AS by, occurred_at AS at, reason FROM payment_logs WHERE order_id = ? ORDER BY occurred_at");
  const orderAudit = db.prepare("SELECT actor_name AS by, action, details_json AS details, occurred_at AS at FROM admin_action_logs WHERE target_type = 'order' AND target_id = ? ORDER BY occurred_at");
  const summary = db.prepare(`SELECT
    COUNT(*) AS orders,
    COALESCE(SUM(CAST(json_extract(o.data_json, '$.total') AS REAL)), 0) AS gross,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.paymentStatus') = 'paid' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) ELSE 0 END), 0) AS paid,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.paymentStatus') = 'unpaid' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) ELSE 0 END), 0) AS unpaid,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.paymentStatus') = 'refunded' THEN COALESCE(CAST(json_extract(o.data_json, '$.refundAmount') AS REAL), CAST(json_extract(o.data_json, '$.total') AS REAL)) ELSE 0 END), 0) AS refunds,
    SUM(CASE WHEN json_extract(o.data_json, '$.status') = 'cancelled' THEN 1 ELSE 0 END) AS cancellations,
    SUM(CASE WHEN json_extract(o.data_json, '$.status') = 'rejected' THEN 1 ELSE 0 END) AS rejections,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.payment') = 'cod' AND json_extract(o.data_json, '$.paymentMethodAtDesk') = 'cash' AND json_extract(o.data_json, '$.paymentStatus') = 'paid' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) WHEN json_extract(o.data_json, '$.payment') = 'cod' AND json_extract(o.data_json, '$.paymentMethodAtDesk') IS NULL AND json_extract(o.data_json, '$.paymentStatus') = 'paid' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) ELSE 0 END), 0) AS cash,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.payment') = 'upi' OR json_extract(o.data_json, '$.paymentMethodAtDesk') = 'upi' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) ELSE 0 END), 0) AS upi,
    COALESCE(SUM(CASE WHEN json_extract(o.data_json, '$.payment') = 'card' THEN CAST(json_extract(o.data_json, '$.total') AS REAL) ELSE 0 END), 0) AS card
    FROM orders o ${where}`).get(...values);
  return {
    orders: rows.map(row => ({
      ...JSON.parse(row.data_json), hiddenByCustomer: Boolean(row.hidden_by_customer),
      archivedByAdmin: Boolean(row.archived_by_admin), ownerName: row.owner_name,
      ownerUsername: row.owner_username,
      deletedBy: row.deleted_by, deletedAt: row.deleted_at,
      paymentLogs: paymentHistory.all(row.id),
      auditTrail: orderAudit.all(row.id).map(entry => ({ ...entry, details: JSON.parse(entry.details) }))
    })),
    total: count, limit, offset, summary
  };
}

function normalizeOrder(order, owner, previous) {
  if (!order || typeof order !== "object" || !Array.isArray(order.items) || !order.items.length) throw httpError(400, "An order must include at least one item.");
  const id = String(order.id || "");
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw httpError(400, "Order number is invalid.");
  const settings = savedSettings();
  const requestedItems = !previous
    ? catalogOrderItems(order.items, settings)
    : owner.role === "admin" && JSON.stringify(order.items) !== JSON.stringify(previous.items)
      ? catalogOrderItems(order.items, settings)
      : previous.items;
  const items = requestedItems.map(item => {
    const quantity = Number(item.quantity);
    const price = Number(item.price);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isFinite(price) || price < 0) throw httpError(400, "Order item quantity or price is invalid.");
    return { ...item, quantity, price, name: String(item.name || "").slice(0, 160) };
  });
  if (items.some(item => !item.name)) throw httpError(400, "Every order item must have a name.");
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const createdAt = previous ? previous.createdAt : Date.now();
  const next = {
    ...order, id, items, total, createdAt,
    placedAt: previous ? (previous.placedAt || previous.createdAt) : createdAt,
    customer: previous ? previous.customer : owner.name,
    customerId: previous ? previous.customerId : owner.id,
    role: previous ? previous.role : owner.role,
    status: previous ? (!["admin", "kitchen", "cashier"].includes(owner.role) ? previous.status : (order.status || previous.status)) : "incoming"
  };
  if (!previous) {
    if (!["cod", "upi", "card"].includes(String(order.payment))) throw httpError(400, "Choose cash, UPI, or card as a payment method.");
    next.paymentStatus = order.payment === "cod" ? "unpaid" : "paid";
    next.paymentLabel = order.payment === "cod" ? "Cash at desk" : `${String(order.payment).toUpperCase()} · demo paid`;
    next.paidAt = order.payment === "cod" ? null : Date.now();
    next.paidBy = order.payment === "cod" ? null : "Online demo";
    next.tasks = [];
  }
  if (previous && !["admin", "kitchen", "cashier"].includes(owner.role)) {
    const allowed = new Set(["hiddenByCustomer", "estimatedMinutes", "estimatedReadyAt"]);
    for (const key of Object.keys(previous)) {
      if (!allowed.has(key) && JSON.stringify(next[key]) !== JSON.stringify(previous[key])) throw httpError(403, "Students cannot edit placed order details.");
    }
  }
  return next;
}

function persistOrder(order, owner) {
  const current = statements.getOrder.get(order.id);
  const isStaff = ["admin", "kitchen", "cashier"].includes(owner.role);
  if (current && !isStaff && current.owner_id !== owner.id) throw httpError(404, "Order not found.");
  if (current && ["cashier", "kitchen"].includes(owner.role)) {
    const existing = JSON.parse(current.data_json);
    const merged = { ...existing };
    if (owner.role === "kitchen") {
      for (const key of ["status", "tasks", "acceptedAt", "readyAt", "rejectionReason", "estimatedMinutes", "estimatedReadyAt"]) {
        if (Object.hasOwn(order, key)) merged[key] = order[key];
      }
    } else {
      for (const key of ["paymentStatus", "paymentLabel", "paidAt", "paidBy", "paymentMethodAtDesk", "status", "collectedAt", "cancellationReason", "refundAmount"]) {
        if (Object.hasOwn(order, key)) merged[key] = order[key];
      }
      if (existing.status === "awaiting-payment" && order.status === "accepted") {
        for (const key of ["tasks", "acceptedAt", "queueSequence", "estimatedMinutes", "estimatedReadyAt"]) {
          if (Object.hasOwn(order, key)) merged[key] = order[key];
        }
      }
    }
    order = merged;
  }
  const previous = current ? JSON.parse(current.data_json) : null;
  const normalized = normalizeOrder(order, owner, previous);
  const now = Date.now();
  const completedTasks = [];
  if (previous) {
    if (previous.status !== normalized.status) {
      if (normalized.status === "awaiting-payment") normalized.acceptedAt = now;
      if (normalized.status === "accepted") {
        normalized.acceptedAt = now;
        normalized.queueSequence = allocateSequence("next-queue-sequence");
        normalized.acceptedBy = owner.name;
      }
      if (normalized.status === "preparing") normalized.preparingAt = now;
      if (normalized.status === "ready") normalized.readyAt = now;
      if (normalized.status === "rejected") { normalized.rejectedAt = now; normalized.rejectedBy = owner.name; }
      if (normalized.status === "cancelled") { normalized.cancelledAt = now; normalized.cancelledBy = owner.name; }
      if (normalized.status === "collected") { normalized.collectedAt = now; normalized.collectedBy = owner.name; }
    }
    if (previous.paymentStatus !== normalized.paymentStatus) {
      if (normalized.paymentStatus === "paid") { normalized.paidAt = now; normalized.paidBy = owner.name; }
      if (normalized.paymentStatus === "unpaid") normalized.paidAt = null;
      if (normalized.paymentStatus === "refunded") { normalized.refundedAt = now; normalized.refundedBy = owner.name; }
    }
    if (Array.isArray(normalized.tasks)) {
      normalized.tasks = normalized.tasks.map(task => {
        const station = Number(task.station);
        const oldTask = (previous.tasks || []).find(entry => Number(entry.station) === station);
        if (!oldTask) {
          if (normalized.status === "accepted" && ["incoming", "awaiting-payment"].includes(previous.status) && task.status === "queued") {
            return { ...task, startedAt: null, completedAt: null, mlFeatures: queueFeaturesForTask(task, savedSettings(), station, normalized.id, now) };
          }
          return task;
        }
        const nextTask = { ...task, mlFeatures: oldTask.mlFeatures || null };
        if (oldTask.status === "queued" && task.status === "preparing") nextTask.startedAt = now;
        else nextTask.startedAt = oldTask.startedAt || null;
        if (oldTask.status === "preparing" && task.status === "ready") {
          nextTask.completedAt = now;
          completedTasks.push({ task: nextTask, station });
        } else {
          nextTask.completedAt = oldTask.completedAt || null;
        }
        return nextTask;
      });
    }
    validateOrderChange(owner, previous, normalized);
  }
  if (!current) statements.insertOrder.run(normalized.id, owner.id, normalized.createdAt, now, JSON.stringify(normalized));
  else statements.updateOrder.run(now, JSON.stringify(normalized), normalized.id);
  for (const { task, station } of completedTasks) saveCompletedQueueTrainingSample(normalized, task, station, Number(task.completedAt));
  if (previous) {
    const changed = ["status", "paymentStatus", "paymentLabel", "paidAt", "paidBy", "readyAt", "collectedAt", "rejectionReason", "cancellationReason", "refundAmount"]
      .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(normalized[key]));
    if (changed.length) recordAction(owner, "update-order", "order", normalized.id, Object.fromEntries(changed.map(key => [key, { from: previous[key] ?? null, to: normalized[key] ?? null }])));
  }
  return normalized;
}

function validateOrderChange(actor, previous, next) {
  if (actor.role === "admin") return;
  const changed = key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]);
  if (actor.role === "kitchen") {
    if (changed("paymentStatus") && !(next.status === "rejected" && next.paymentStatus === "refunded")) {
      throw httpError(403, "Kitchen accounts cannot change payment records.");
    }
    if (changed("status")) {
      const valid = (previous.status === "incoming" && ["accepted", "awaiting-payment", "rejected"].includes(next.status))
        || (previous.status === "accepted" && next.status === "preparing")
        || (previous.status === "preparing" && next.status === "ready");
      if (!valid) throw httpError(409, "That kitchen status transition is not allowed.");
      if (next.status === "accepted" && !next.tasks?.length) throw httpError(400, "Accept the order with its counter tasks.");
      if (next.status === "awaiting-payment" && (previous.payment !== "cod" || previous.paymentStatus === "paid")) throw httpError(409, "This order cannot wait for cash-desk payment.");
      if (next.status === "rejected" && !String(next.rejectionReason || "").trim()) throw httpError(400, "Provide a reason before rejecting an order.");
      if (next.status === "preparing" && !(next.tasks || []).some(task => task.status === "preparing")) throw httpError(409, "Start a counter ticket before moving the order to Preparing.");
      if (next.status === "ready" && (!(next.tasks || []).length || next.tasks.some(task => task.status !== "ready"))) throw httpError(409, "Every counter ticket must be Ready first.");
    }
    if (changed("tasks")) {
      for (const task of next.tasks || []) {
        const old = (previous.tasks || []).find(entry => Number(entry.station) === Number(task.station));
        if (!old) {
          if (!["accepted"].includes(next.status) || !["incoming", "awaiting-payment"].includes(previous.status) || task.status !== "queued") {
            throw httpError(403, "Kitchen tickets cannot be added outside order acceptance.");
          }
          continue;
        }
        if (JSON.stringify(old.items) !== JSON.stringify(task.items) || Number(old.prep) !== Number(task.prep)) throw httpError(403, "Kitchen tickets cannot have their item details changed.");
        const allowed = old.status === task.status || (old.status === "queued" && task.status === "preparing") || (old.status === "preparing" && task.status === "ready");
        if (!allowed) throw httpError(409, "A counter ticket cannot skip its preparation steps.");
        if (old.status !== task.status) assertFirstInQueue(next.id, task.station);
      }
    }
    if (changed("tasks") && !validateTaskSplit(previous, next)) throw httpError(400, "The order must be split into exactly one ticket per counter with the original items.");
    return;
  }
  if (actor.role === "cashier") {
    if (changed("tasks") && !(previous.status === "awaiting-payment" && next.status === "accepted")) throw httpError(403, "Cashiers cannot edit kitchen tickets.");
    if (changed("status")) {
      const valid = next.status === "cancelled"
        || (previous.status === "ready" && previous.paymentStatus === "paid" && next.status === "collected")
        || (previous.status === "awaiting-payment" && next.status === "accepted" && next.paymentStatus === "paid" && (next.tasks || []).length > 0);
      if (!valid) throw httpError(409, "That cash-desk status transition is not allowed.");
    }
    if (changed("paymentStatus") && !["paid", "unpaid", "refunded"].includes(next.paymentStatus)) throw httpError(400, "Payment status is invalid.");
    return;
  }
  throw httpError(403, "This account cannot change placed orders.");
}

function validateTaskSplit(previous, next) {
  const allowedToCreate = !previous.tasks?.length && ["incoming", "awaiting-payment"].includes(previous.status) && next.status === "accepted";
  if (!allowedToCreate) return true;
  const expected = new Map();
  for (const item of previous.items || []) {
    const station = Number(item.station);
    const group = expected.get(station) || new Map();
    group.set(String(item.id || item.name), {
      quantity: Number(item.quantity), name: String(item.name), price: Number(item.price), prep: Number(item.prep)
    });
    expected.set(station, group);
  }
  const actual = new Map();
  for (const task of next.tasks || []) {
    const station = Number(task.station);
    if (!expected.has(station) || actual.has(station)) return false;
    actual.set(station, new Map((task.items || []).map(item => [String(item.id || item.name), {
      quantity: Number(item.quantity), name: String(item.name), price: Number(item.price), prep: Number(item.prep)
    }])));
  }
  return expected.size === actual.size && [...expected].every(([station, items]) =>
    actual.has(station) && items.size === actual.get(station).size && [...items].every(([id, item]) =>
      JSON.stringify(actual.get(station).get(id)) === JSON.stringify(item)
    )
  );
}

function assertFirstInQueue(orderId, stationId) {
  const queue = db.prepare("SELECT id, data_json FROM orders WHERE json_extract(data_json, '$.status') IN ('accepted', 'preparing')").all()
    .map(row => ({ id: row.id, order: JSON.parse(row.data_json) }))
    .flatMap(row => (row.order.tasks || []).filter(task => Number(task.station) === Number(stationId) && task.status !== "ready").map(task => ({
      id: row.id, acceptedAt: Number(row.order.acceptedAt || row.order.createdAt), queueSequence: Number(row.order.queueSequence) || 0
    })))
    .sort((a, b) => a.acceptedAt - b.acceptedAt || a.queueSequence - b.queueSequence);
  if (queue[0]?.id !== String(orderId)) throw httpError(409, "This ticket is not first in its counter's FIFO queue.");
}

function validatePaymentChange(actor, order, previous, suppliedLogs) {
  if (!previous || !["admin", "cashier", "kitchen"].includes(actor.role)) return;
  const nextStatus = order.paymentStatus || previous.paymentStatus;
  if (nextStatus === previous.paymentStatus) return;
  const action = nextStatus === "paid" ? "paid" : nextStatus === "unpaid" ? "undo" : "refund";
  const matching = (suppliedLogs || []).find(log =>
    String(log.orderId) === String(order.id) && log.action === action &&
    Number(log.amount) === Number(previous.total) && !statements.existingPayment.get(String(log.id))
  );
  if (!matching) throw httpError(409, "A matching, logged payment action is required.");
  if (action === "paid" && (actor.role !== "cashier" || previous.payment !== "cod" || !["cash", "upi"].includes(matching.method))) {
    throw httpError(403, "Only the cash desk can record exact cash or UPI collection for an unpaid COD order.");
  }
  if (action === "paid" && order.paymentMethodAtDesk !== matching.method) throw httpError(409, "The selected payment method must match the logged cash-desk payment.");
  if (action === "undo") {
    const last = db.prepare("SELECT action, actor_id, occurred_at FROM payment_logs WHERE order_id = ? ORDER BY occurred_at DESC LIMIT 1").get(String(order.id));
    if (actor.role !== "cashier" || !last || last.action !== "paid" || last.actor_id !== actor.id || Date.now() - last.occurred_at > 300000 || order.status === "collected") {
      throw httpError(409, "This payment is no longer eligible for undo.");
    }
  }
  if (action === "refund" && !((actor.role === "cashier" && order.status === "cancelled") || (actor.role === "kitchen" && order.status === "rejected"))) {
    throw httpError(403, "Refunds must be attached to a logged cancellation or kitchen rejection.");
  }
}

function recordPaymentLogs(logs, actor) {
  if (!Array.isArray(logs)) return;
  for (const log of logs.slice(-100)) {
    if (!log?.id || !log.orderId || !Number.isFinite(Number(log.amount)) || Number(log.amount) < 0) continue;
    const order = statements.getOrder.get(String(log.orderId));
    if (!order) continue;
    const orderData = JSON.parse(order.data_json);
    if (!["paid", "refund", "undo", "adjustment"].includes(String(log.action))) continue;
    const demoPayment = ["student", "faculty", "staff"].includes(actor.role)
      && log.action === "paid" && log.method === "online-demo" && ["upi", "card"].includes(orderData.payment)
      && orderData.paymentStatus === "paid";
    const kitchenRefund = actor.role === "kitchen" && log.action === "refund" && orderData.status === "rejected";
    if (!["admin", "cashier"].includes(actor.role) && !demoPayment && !kitchenRefund) continue;
    if (["paid", "undo"].includes(log.action) && Number(log.amount) !== Number(orderData.total)) continue;
    if (log.action === "refund" && Number(log.amount) <= 0) continue;
    const lastAction = db.prepare("SELECT action FROM payment_logs WHERE order_id = ? ORDER BY occurred_at DESC LIMIT 1").get(String(log.orderId))?.action;
    if (log.action === "paid" && lastAction === "paid") continue;
    if (log.action === "undo" && lastAction !== "paid") continue;
    if (log.action === "refund" && lastAction === "refund") continue;
    if (statements.existingPayment.get(String(log.id))) continue;
    statements.insertPayment.run(
      String(log.id), String(log.orderId), String(log.action || "payment").slice(0, 40),
      String(log.method || "").slice(0, 40), Number(log.amount), actor.id, demoPayment ? "Online demo" : actor.name, Date.now(),
      String(log.reason || "").slice(0, 500) || null
    );
  }
}

function stateVersion() {
  const newest = db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS latest FROM orders").get().latest;
  const settings = db.prepare("SELECT value_json FROM settings WHERE key='app'").get()?.value_json || "";
  return crypto.createHash("sha256").update(`${newest}|${settings}`).digest("hex");
}

function allocateOrderId() {
  const saved = db.prepare("SELECT value_json FROM settings WHERE key='next-order-id'").get();
  const maximum = Number(db.prepare("SELECT MAX(CAST(id AS INTEGER)) AS id FROM orders WHERE id GLOB '[0-9]*'").get().id) || 99;
  let next = Math.max(Number(saved ? JSON.parse(saved.value_json) : 100), maximum + 1);
  while (statements.getOrder.get(String(next))) next++;
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('next-order-id', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(next + 1));
  return String(next);
}

function allocateSequence(key) {
  const saved = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
  const next = Number(saved ? JSON.parse(saved.value_json) : 1);
  db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify(next + 1));
  return next;
}

function csvEscape(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

function exportCsv(user, url) {
  requireRole(user, ["admin"]);
  return url;
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;
  const method = request.method;
  if (pathname.startsWith("/api/")) {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "same-origin");
    if (method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, sqlite: true });
      return;
    }
    if (method === "POST" && pathname === "/api/auth/register") {
      const body = await readJson(request);
      const role = String(body.role || "student").toLowerCase();
      if (!["student", "faculty", "staff"].includes(role)) throw httpError(403, "Only student, faculty, and staff self-registration is allowed.");
      const user = createUser(String(body.username || "").trim(), String(body.name || "").trim(), String(body.password || ""), role);
      const token = crypto.randomBytes(32).toString("base64url");
      statements.insertSession.run(crypto.createHash("sha256").update(token).digest("hex"), user.id, Date.now() + SESSION_TTL_MS);
      sendJson(response, 201, { user }, { "set-cookie": buildSessionCookie(request, token) });
      return;
    }
    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await readJson(request);
      const row = statements.userByName.get(String(body.username || "").trim());
      const password = String(body.password || "");
      if (!row || row.disabled || !safeEqual(hashPassword(password, row.password_salt).hash, row.password_hash)) throw httpError(401, "Username or password is incorrect.");
      const token = crypto.randomBytes(32).toString("base64url");
      statements.insertSession.run(crypto.createHash("sha256").update(token).digest("hex"), row.id, Date.now() + SESSION_TTL_MS);
      const user = { id: row.id, username: row.username, name: row.display_name, role: row.role };
      sendJson(response, 200, { user }, { "set-cookie": buildSessionCookie(request, token) });
      return;
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      const user = requireUser(request);
      response.setHeader("x-canteen-user-id", user.id);
      response.setHeader("x-canteen-user-role", user.role);
      assertClientIdentity(request, user);
      const token = cookieValue(request, "canteen_session");
      if (token) statements.deleteSession.run(crypto.createHash("sha256").update(token).digest("hex"));
      sendJson(response, 200, { ok: true }, { "set-cookie": buildSessionCookie(request, null) });
      return;
    }
    const user = requireUser(request);
    response.setHeader("x-canteen-user-id", user.id);
    response.setHeader("x-canteen-user-role", user.role);
    assertClientIdentity(request, user);
    if (method === "GET" && pathname === "/api/auth/me") { sendJson(response, 200, { user }); return; }
    if (method === "GET" && pathname === "/api/queue") {
      requireRole(user, ["student", "faculty", "staff"]);
      const models = queueModelsForStudent();
      sendJson(response, 200, {
        load: queueLoadForCustomer(user),
        models,
        modelType: "neural-network-regression",
        minSamplesPerCounter: MIN_TRAINING_SAMPLES
      });
      return;
    }
    if (method === "GET" && pathname === "/api/orders/favorites") {
      requireRole(user, ["student", "faculty", "staff"]);
      const items = db.prepare(`SELECT
        json_extract(item.value, '$.id') AS id,
        json_extract(item.value, '$.name') AS name,
        SUM(CAST(json_extract(item.value, '$.quantity') AS INTEGER)) AS count
        FROM orders o, json_each(o.data_json, '$.items') AS item
        WHERE o.owner_id = ? AND o.hidden_by_customer = 0
        GROUP BY json_extract(item.value, '$.name')
        ORDER BY count DESC, name COLLATE NOCASE LIMIT 5`).all(user.id);
      sendJson(response, 200, { items });
      return;
    }
    if (method === "GET" && pathname === "/api/orders") { sendJson(response, 200, orderRows(user, url)); return; }
    if (method === "POST" && pathname === "/api/orders") {
      requireRole(user, ["student", "faculty", "staff"]);
      const body = await readJson(request);
      if (!body.order || typeof body.order !== "object") throw httpError(400, "Provide the order to place.");
      db.exec("BEGIN IMMEDIATE");
      let order;
      try {
        order = persistOrder({ ...body.order, id: allocateOrderId() }, user);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(response, 201, { order });
      return;
    }
    const hideMatch = pathname.match(/^\/api\/orders\/([^/]+)\/hide$/);
    if (method === "POST" && hideMatch) {
      requireRole(user, ["student", "faculty", "staff"]);
      const id = decodeURIComponent(hideMatch[1]);
      const order = statements.getOrder.get(id);
      if (!order || order.owner_id !== user.id) throw httpError(404, "Order not found in your history.");
      const data = JSON.parse(order.data_json);
      if (!["collected", "cancelled", "rejected"].includes(data.status) && data.paymentStatus !== "refunded") throw httpError(409, "Only completed orders can be hidden from history.");
      const result = statements.hideOrder.run(Date.now(), id, user.id);
      if (!result.changes) throw httpError(404, "Order not found in your history.");
      sendJson(response, 200, { ok: true, version: stateVersion() });
      return;
    }
    if (method === "POST" && pathname === "/api/orders/hide-all") {
      requireRole(user, ["student", "faculty", "staff"]);
      const result = statements.hideAllOrders.run(Date.now(), user.id);
      recordAction(user, "hide-own-history", "orders", user.id, { count: result.changes });
      sendJson(response, 200, { hidden: result.changes });
      return;
    }
    if (method === "PUT" && pathname === "/api/state") {
      const body = await readJson(request);
      if (!Array.isArray(body.orders)) throw httpError(400, "State must contain an orders array.");
      const suppliedLogs = Array.isArray(body.paymentLogs) ? body.paymentLogs : [];
      db.exec("BEGIN IMMEDIATE");
      try {
        if (["cashier", "kitchen"].includes(user.role)) {
          for (const order of body.orders) {
            const current = statements.getOrder.get(String(order.id));
            if (!current) continue;
            validatePaymentChange(user, order, JSON.parse(current.data_json), suppliedLogs);
          }
        }
        if (["admin", "kitchen", "cashier"].includes(user.role)) {
          for (const order of body.orders) persistOrder(order, user);
        } else {
          for (const order of body.orders) {
            if (order.customerId === user.id && statements.getOrder.get(String(order.id))) persistOrder(order, user);
          }
        }
        if (body.settings && user.role === "admin") {
          db.prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(body.settings));
        }
        recordPaymentLogs(suppliedLogs, user);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(response, 200, { ok: true, version: stateVersion() });
      return;
    }
    if (method === "GET" && pathname === "/api/state") {
      const saved = db.prepare("SELECT value_json FROM settings WHERE key='app'").get();
      const page = orderRows(user, new URL("/api/orders?limit=100", "http://localhost"));
      sendJson(response, 200, { settings: saved ? JSON.parse(saved.value_json) : null, orders: page.orders, version: stateVersion() });
      return;
    }
    if (method === "GET" && pathname === "/api/desk/audit") {
      requireRole(user, ["admin", "cashier"]);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const payments = db.prepare("SELECT id, order_id AS orderId, action, method, amount, actor_name AS actor, occurred_at AS at, reason FROM payment_logs ORDER BY occurred_at DESC LIMIT ?").all(limit);
      sendJson(response, 200, { payments });
      return;
    }
    if (pathname.startsWith("/api/admin/")) {
      requireRole(user, ["admin"]);
      if (method === "GET" && pathname === "/api/admin/queue-models") {
        const models = db.prepare("SELECT station, sample_count, updated_at FROM queue_models ORDER BY station").all();
        const byStation = new Map(models.map(model => [Number(model.station), model]));
        sendJson(response, 200, {
          minSamplesPerCounter: MIN_TRAINING_SAMPLES,
          counters: Array.from({ length: 5 }, (_, index) => {
            const station = index + 1;
            const model = byStation.get(station);
            return {
              station,
              name: COUNTER_NAMES[station],
              sampleCount: Number(model?.sample_count) || 0,
              trainedAt: Number(model?.updated_at) || null,
              status: Number(model?.sample_count) >= MIN_TRAINING_SAMPLES ? "active" : "learning"
            };
          })
        });
        return;
      }
      if (method === "GET" && pathname === "/api/admin/orders") {
        const archivedUrl = new URL(url);
        if (url.searchParams.get("archived") === "1") archivedUrl.searchParams.set("archived", "1");
        else archivedUrl.searchParams.delete("archived");
        archivedUrl.searchParams.set("all", "1");
        sendJson(response, 200, orderRows(user, archivedUrl));
        return;
      }
      if (method === "GET" && pathname === "/api/admin/audit") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        const logs = db.prepare("SELECT id, actor_name AS actor, action, target_type AS targetType, target_id AS targetId, details_json AS details, occurred_at AS at FROM admin_action_logs ORDER BY occurred_at DESC LIMIT ?").all(limit);
        const payments = db.prepare("SELECT id, order_id AS orderId, action, method, amount, actor_name AS actor, occurred_at AS at, reason FROM payment_logs ORDER BY occurred_at DESC LIMIT ?").all(limit);
        sendJson(response, 200, { actions: logs.map(log => ({ ...log, details: JSON.parse(log.details) })), payments });
        return;
      }
      const archiveMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(archive|restore)$/);
      if (method === "POST" && archiveMatch) {
        const [, id, action] = archiveMatch;
        const result = action === "archive" ? statements.archiveOrder.run(Date.now(), id) : statements.restoreOrder.run(Date.now(), id);
        if (!result.changes) throw httpError(404, "Order not found or already in that archive state.");
        recordAction(user, action, "order", id);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && pathname === "/api/admin/archive-range") {
        const body = await readJson(request);
        const cutoff = Date.parse(body.before || "");
        if (!Number.isFinite(cutoff)) throw httpError(400, "Provide a valid archive cutoff date.");
        const result = db.prepare("UPDATE orders SET archived_by_admin = 1, updated_at = ? WHERE archived_by_admin = 0 AND created_at < ?").run(Date.now(), cutoff);
        recordAction(user, "bulk-archive", "orders", null, { before: new Date(cutoff).toISOString(), count: result.changes });
        sendJson(response, 200, { archived: result.changes });
        return;
      }
      if (method === "GET" && pathname === "/api/admin/export.csv") {
        url.searchParams.set("limit", "100");
        let rows = [];
        let offset = 0;
        let total = 0;
        do {
          url.searchParams.set("offset", String(offset));
          const page = orderRows(user, url);
          total = page.total;
          rows.push(...page.orders);
          offset += page.limit;
        } while (offset < total);
        const headers = ["Order", "Customer", "Username", "Role", "Placed at", "Accepted at", "Ready at", "Paid at", "Collected at", "Items", "Counters", "Total INR", "Payment method", "Payment status", "Paid by", "Order status", "Reason", "Archived"];
        const csvRows = rows.map(order => [
          order.id, order.ownerName || order.customer, order.ownerUsername || "", order.role,
          new Date(Number(order.createdAt)).toISOString(), order.acceptedAt ? new Date(Number(order.acceptedAt)).toISOString() : "",
          order.readyAt ? new Date(Number(order.readyAt)).toISOString() : "", order.paidAt ? new Date(Number(order.paidAt)).toISOString() : "",
          order.collectedAt ? new Date(Number(order.collectedAt)).toISOString() : "",
          order.items.map(item => `${item.quantity}x ${item.name} @ ${item.price}`).join("; "),
          [...new Set(order.items.map(item => item.station).filter(value => value != null))].join("; "),
          order.total, order.paymentMethodAtDesk || order.payment, order.paymentStatus, order.paidBy || "",
          order.status, order.rejectionReason || order.cancellationReason || "", order.archivedByAdmin ? "Yes" : "No"
        ]);
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="canteen-orders-${new Date().toISOString().slice(0, 10)}.csv"` });
        response.end([headers, ...csvRows].map(row => row.map(csvEscape).join(",")).join("\r\n"));
        return;
      }
      if (method === "GET" && pathname === "/api/admin/users") {
        const users = db.prepare("SELECT id, username, display_name AS name, role, created_at AS createdAt, disabled FROM users ORDER BY created_at DESC").all();
        sendJson(response, 200, { users });
        return;
      }
      if (method === "POST" && pathname === "/api/admin/users") {
        const body = await readJson(request);
        const role = String(body.role || "").toLowerCase();
        if (!["kitchen", "cashier", "admin"].includes(role)) throw httpError(400, "Admin can create kitchen, cashier, or admin accounts here.");
        const created = createUser(String(body.username || "").trim(), String(body.name || "").trim(), String(body.password || ""), role);
        recordAction(user, "create-user", "user", created.id, { username: created.username, role });
        sendJson(response, 201, { user: created });
        return;
      }
    }
    throw httpError(404, "API route not found.");
  }

  const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const file = path.resolve(ROOT, `.${relative}`);
  if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, "File not found.");
  const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
  response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(response);
}

function backupDatabase() {
  try {
    db.exec("PRAGMA wal_checkpoint(FULL)");
    const destination = path.join(BACKUP_DIR, `canteen-${new Date().toISOString().slice(0, 10)}.sqlite`);
    fs.copyFileSync(DB_PATH, destination);
    const backups = fs.readdirSync(BACKUP_DIR).filter(name => /^canteen-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort();
    for (const old of backups.slice(0, -30)) fs.unlinkSync(path.join(BACKUP_DIR, old));
  } catch (error) {
    console.error("Daily SQLite backup failed:", error.message);
  }
}

function applyRetentionPolicy() {
  const saved = db.prepare("SELECT value_json FROM settings WHERE key='app'").get();
  const years = Number(saved ? JSON.parse(saved.value_json).historyRetentionYears : 0);
  if (![1, 3].includes(years)) return;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const result = db.prepare("UPDATE orders SET archived_by_admin = 1, updated_at = ? WHERE archived_by_admin = 0 AND created_at < ?").run(Date.now(), cutoff.getTime());
  if (result.changes) recordAction({ id: null, name: "System" }, "auto-archive", "orders", null, { years, count: result.changes, before: cutoff.toISOString() });
}

async function handleCliCommands() {
  if (process.argv[2] === "--create-admin") {
    const username = process.argv[3] || process.env.CANTEEN_ADMIN_USERNAME || "admin";
    const name = process.argv[4] || process.env.CANTEEN_ADMIN_NAME || "Canteen Admin";
    const existing = statements.userByName.get(username);
    if (existing) {
      console.log(`Admin account "${username}" already exists.`);
      return;
    }
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const password = process.env.CANTEEN_ADMIN_PASSWORD || await prompt.question("New admin password (10+ characters): ");
      delete process.env.CANTEEN_ADMIN_PASSWORD;
      const user = createUser(username, name, password, "admin");
      console.log(`Created admin account "${user.username}". Start the app with: npm start`);
    } finally { prompt.close(); }
  }
}

function bootstrapSeedAccounts() {
  const seedAccounts = [
    {
      username: process.env.CANTEEN_ADMIN_USERNAME || "admin",
      name: process.env.CANTEEN_ADMIN_NAME || "Canteen Admin",
      password: process.env.CANTEEN_ADMIN_PASSWORD || "admin12345",
      role: "admin",
      minLen: 8
    },
    {
      username: "canteen-admin",
      name: "Canteen Admin",
      password: process.env.CANTEEN_ADMIN_PASSWORD || "admin12345",
      role: "admin",
      minLen: 8
    },
    {
      username: process.env.CANTEEN_KITCHEN_USERNAME || "kitchen",
      name: "Kitchen Head",
      password: process.env.CANTEEN_KITCHEN_PASSWORD || "kitchen12345",
      role: "kitchen",
      minLen: 8
    },
    {
      username: process.env.CANTEEN_CASHIER_USERNAME || "cashier",
      name: "Cash Desk",
      password: process.env.CANTEEN_CASHIER_PASSWORD || "cashier12345",
      role: "cashier",
      minLen: 8
    },
    {
      username: process.env.CANTEEN_DEMO_USERNAME || "saai",
      name: process.env.CANTEEN_DEMO_NAME || "Sai Demo",
      password: process.env.CANTEEN_DEMO_PASSWORD || "saai12345",
      role: "student",
      minLen: 8
    }
  ];

  for (const account of seedAccounts) {
    if (!account.username || !account.password) continue;
    const existing = statements.userByName.get(account.username);
    if (!existing) {
      try {
        createUser(account.username, account.name, account.password, account.role, account.minLen);
        console.log(`Provisioned initial ${account.role} account: ${account.username}`);
      } catch (err) {
        console.warn(`Could not seed ${account.username}: ${err.message}`);
      }
    }
  }
}

async function main() {
  await handleCliCommands();
  bootstrapSeedAccounts();
  backupDatabase();
  applyRetentionPolicy();
  setInterval(() => { backupDatabase(); applyRetentionPolicy(); }, 24 * 60 * 60 * 1000).unref();
  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error("Request failed:", error);
      if (!response.headersSent) sendJson(response, status, { error: status >= 500 ? "The server could not complete this request." : error.message });
      else response.destroy();
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
      console.error("To fix this in Windows PowerShell, terminate the lingering node process:");
      console.error(`Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force`);
      console.error(`Or start on a different port: $env:PORT="${PORT + 1}"; npm start\n`);
    } else {
      console.error("Server error:", error);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const displayHost = (HOST === "0.0.0.0" || HOST === "127.0.0.1") ? "localhost" : HOST;
    console.log(`\n=================================================`);
    console.log(`🍽️  MPSTME New Canteen Server is Live!`);
    console.log(`=================================================`);
    console.log(`- Local App:    http://${displayHost}:${PORT}`);
    console.log(`- Student Menu: http://${displayHost}:${PORT}/student.html`);
    console.log(`- Kitchen Board:http://${displayHost}:${PORT}/kitchen.html`);
    console.log(`- Cash Desk:    http://${displayHost}:${PORT}/cashier.html`);
    console.log(`- Health Check: http://${displayHost}:${PORT}/api/health`);
    console.log(`=================================================\n`);
  });
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  handle,
  db,
  statements,
  bootstrapSeedAccounts,
  createUser
};
