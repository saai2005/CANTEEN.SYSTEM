"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const { handle, db, statements } = require("../server");

async function dispatch(pathname, options = {}) {
  const method = options.method || "GET";
  const bodyText = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : "";
  const req = Readable.from(bodyText ? [Buffer.from(bodyText)] : []);
  req.url = pathname;
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  if (options.cookie) {
    req.headers["cookie"] = options.cookie;
  }

  let statusCode = 200;
  const headers = {};
  const chunks = [];

  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    }
  });

  res.headersSent = false;
  res.writeHead = (status, hdrs = {}) => {
    statusCode = status;
    res.headersSent = true;
    for (const [k, v] of Object.entries(hdrs)) {
      headers[k.toLowerCase()] = v;
    }
  };
  res.setHeader = (key, val) => {
    headers[key.toLowerCase()] = val;
  };

  await new Promise((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    handle(req, res).catch(err => {
      statusCode = Number(err.status) || 500;
      chunks.push(Buffer.from(JSON.stringify({ error: err.message })));
      resolve();
    });
  });

  const raw = Buffer.concat(chunks).toString("utf8");
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: statusCode, headers, body: raw, json };
}

function extractCookie(headers) {
  const cookie = headers["set-cookie"];
  if (!cookie) return "";
  return Array.isArray(cookie) ? cookie[0].split(";")[0] : cookie.split(";")[0];
}

test("1. Health check returns 200 and sqlite status", async () => {
  const res = await dispatch("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.sqlite, true);
});

test("2. Static HTML files and assets are served correctly", async () => {
  const routes = ["/", "/student.html", "/kitchen.html", "/cashier.html", "/favicon.ico"];
  for (const route of routes) {
    const res = await dispatch(route);
    assert.equal(res.status, 200, `Expected 200 for ${route}`);
    assert.ok(res.body.length > 0, `Expected content for ${route}`);
  }
});

let studentCookie = "";
let adminCookie = "";
let kitchenCookie = "";
let cashierCookie = "";

test("3. Authenticates seeded demo accounts for all roles", async () => {
  // Student
  const studentRes = await dispatch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { username: "saai", password: "saai12345" }
  });
  assert.equal(studentRes.status, 200);
  assert.equal(studentRes.json.user.role, "student");
  studentCookie = extractCookie(studentRes.headers);
  assert.ok(studentCookie.includes("canteen_session="));

  // Kitchen
  const kitchenRes = await dispatch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { username: "kitchen", password: "kitchen12345" }
  });
  assert.equal(kitchenRes.status, 200);
  assert.equal(kitchenRes.json.user.role, "kitchen");
  kitchenCookie = extractCookie(kitchenRes.headers);

  // Cashier
  const cashierRes = await dispatch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { username: "cashier", password: "cashier12345" }
  });
  assert.equal(cashierRes.status, 200);
  assert.equal(cashierRes.json.user.role, "cashier");
  cashierCookie = extractCookie(cashierRes.headers);

  // Admin
  const adminRes = await dispatch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { username: "admin", password: "admin12345" }
  });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.json.user.role, "admin");
  adminCookie = extractCookie(adminRes.headers);
});

test("4. Protected route /api/auth/me enforces authentication", async () => {
  // Without cookie
  const unauth = await dispatch("/api/auth/me");
  assert.equal(unauth.status, 401);

  // With student cookie
  const auth = await dispatch("/api/auth/me", { cookie: studentCookie });
  assert.equal(auth.status, 200);
  assert.equal(auth.json.user.username, "saai");
  assert.equal(auth.json.user.role, "student");
});

test("5. Self-registration for student accounts works", async () => {
  const newUsername = `reg_${Date.now()}`;
  const res = await dispatch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { username: newUsername, name: "Test Student", password: "password12345", role: "student" }
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.username, newUsername);
  assert.equal(res.json.user.role, "student");
});

test("6. Student queue wait load endpoint operates properly", async () => {
  const res = await dispatch("/api/queue", { cookie: studentCookie });
  assert.equal(res.status, 200);
  assert.ok(res.json.load);
  assert.equal(res.json.modelType, "neural-network-regression");
});

let placedOrderId = "";

test("7. Placing a student COD order with catalog item", async () => {
  const payload = {
    order: {
      payment: "cod",
      items: [
        { id: "201", name: "Masala dosa", quantity: 1, price: 42, station: 2, prep: 10 }
      ]
    }
  };
  const res = await dispatch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cookie: studentCookie,
    body: payload
  });
  assert.equal(res.status, 201);
  assert.ok(res.json.order.id);
  assert.equal(res.json.order.status, "incoming");
  assert.equal(res.json.order.paymentStatus, "unpaid");
  placedOrderId = res.json.order.id;
});

test("8. Kitchen accepts incoming order and creates counter ticket", async () => {
  const stateRes = await dispatch("/api/state", { cookie: kitchenCookie });
  assert.equal(stateRes.status, 200);
  const order = stateRes.json.orders.find(o => o.id === placedOrderId);
  assert.ok(order, "Placed order should be in state");

  const acceptedOrder = {
    ...order,
    status: "accepted",
    tasks: [
      {
        id: `${order.id}-2`,
        station: 2,
        status: "queued",
        prep: 10,
        items: [{ id: "201", name: "Masala dosa", quantity: 1, price: 42, prep: 10 }]
      }
    ]
  };

  const putRes = await dispatch("/api/state", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    cookie: kitchenCookie,
    body: { orders: [acceptedOrder] }
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.json.ok, true);
});

test("9. Cashier audit ledger access", async () => {
  const deskRes = await dispatch("/api/desk/audit", { cookie: cashierCookie });
  assert.equal(deskRes.status, 200);
  assert.ok(Array.isArray(deskRes.json.payments));
});

test("10. Admin audit and users management", async () => {
  const auditRes = await dispatch("/api/admin/audit", { cookie: adminCookie });
  assert.equal(auditRes.status, 200);
  assert.ok(Array.isArray(auditRes.json.actions));

  const usersRes = await dispatch("/api/admin/users", { cookie: adminCookie });
  assert.equal(usersRes.status, 200);
  assert.ok(Array.isArray(usersRes.json.users));
  assert.ok(usersRes.json.users.some(u => u.username === "admin"));
  assert.ok(usersRes.json.users.some(u => u.username === "kitchen"));
  assert.ok(usersRes.json.users.some(u => u.username === "cashier"));

  const csvRes = await dispatch("/api/admin/export.csv", { cookie: adminCookie });
  assert.equal(csvRes.status, 200);
  assert.ok(csvRes.headers["content-type"].includes("text/csv"));
});
