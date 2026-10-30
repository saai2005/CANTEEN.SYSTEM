# MPSTME New Canteen

The application is the Node.js/SQLite canteen system in `index.html` and `server.js`. Its student, kitchen, and cash-desk pages keep the existing interface and share the same authenticated API and order database.

## Full project report

The [PDF project report and viva guide](PROJECT_REPORT.pdf) explains the system in simple language, including the three pages, user roles, order pipeline, backend, database, queue-prediction ML, deployment, limitations, and viva questions with suggested answers. The [Markdown source](PROJECT_REPORT.md) is also available.

## Deploy the original UI on Render

1. In Render, create a **Blueprint** or **Web Service** from this GitHub repository's `main` branch. Render reads `render.yaml` and deploys the Node.js app on its free web-service plan.
2. The server comes pre-configured with default demo and staff accounts so the deployed service is immediately ready and functional, even after service sleep:
   - **Student:** `saai` / `saai12345`
   - **Kitchen:** `kitchen` / `kitchen12345`
   - **Cashier:** `cashier` / `cashier12345`
   - **Admin:** `canteen-admin` (or `admin`) / `admin12345` (or set custom `CANTEEN_ADMIN_PASSWORD` in Render)
3. Wait for the service health check to pass, then use these pages on its `onrender.com` URL:
   - `/student.html` — menu, checkout, queue estimates, and the customer's own order history.
   - `/kitchen.html` — incoming orders and preparation counters; requires a Kitchen or Admin account.
   - `/cashier.html` — payment ledger and order handover; requires a Cashier or Admin account.
   - `/` — the original combined interface, including Admin controls.

The free service uses temporary local SQLite storage. Free instances can sleep when idle, and accounts, orders, and backups can be lost on a restart or redeploy. Seed accounts automatically re-initialize upon start so you can test all roles at any time without interruption. UPI and card checkout are demo flows, not real payment processing.

## Run locally

1. Install Node.js 22.5 or newer (Node.js 24 is recommended).
2. Start the server:

   ```powershell
   npm start
   ```

   The server automatically seeds ready-to-test accounts on first launch:
   - **Student:** `saai` / `saai12345`
   - **Kitchen:** `kitchen` / `kitchen12345`
   - **Cashier:** `cashier` / `cashier12345`
   - **Admin:** `admin` / `admin12345`

   *(Optional) You can also create a custom administrator account interactively:*
   ```powershell
   node server.js --create-admin admin "Canteen Admin"
   ```

3. Open the corresponding role page:
   - Student menu: `http://localhost:4173/student.html`
   - Kitchen board: `http://localhost:4173/kitchen.html`
   - Cash desk: `http://localhost:4173/cashier.html`
   - Full app & Admin: `http://localhost:4173/`

4. Students, faculty, and staff can also self-register. An administrator creates additional Kitchen, Cashier, and Admin accounts in the Admin settings screen.

The server listens on `0.0.0.0`, allowing local connection at `http://localhost:4173` and connection across the same local network using `http://<your-LAN-IP>:4173` for testing on mobile devices.

## Data and backups

- Database: `data/canteen.sqlite`
- Daily SQLite backups: `data/backups/`
- Backups are retained for 30 days. Keep an additional off-device backup for important accounting records.
- Admins can archive and restore orders; records are not permanently deleted. Optional 1- or 3-year rules archive old orders.
- Students can hide their own orders from their view. This does not delete the accounting record.
- Receipt PDF output uses the browser's **Print / Save as PDF** dialog.

Use the server URL for authenticated accounts, shared cross-page orders, and SQLite-backed storage.

Menu photos are stored locally under `assets/food/` and matched to menu items. Openly licensed photo credits and source links are listed in [`assets/food/PHOTO_CREDITS.md`](assets/food/PHOTO_CREDITS.md).

## Shared counter wait estimates

The authenticated `GET /api/queue` endpoint returns per-counter counts and remaining preparation workload for other customers' accepted and preparing orders. It does not return customer names, order numbers, or item details. Student screens combine that aggregate with the signed-in customer's own active orders, so queues stay independent by counter and update while the kitchen works.

## Neural-network wait prediction

Each counter has its own small feed-forward neural-network regressor. It learns from completed counter tickets, using queue size, queued workload, ticket prep time and quantity, staffing, rush mode, and the time and day as inputs. Its training target is the actual elapsed time from order acceptance until that counter ticket is marked ready.

The model has eight inputs, one eight-neuron ReLU hidden layer, and a wait-time output. After each new completed ticket, the server retrains that counter's model using up to its latest 300 saved examples and stores both samples and weights in SQLite. Student screens use the trained model for counter estimates; the order estimate remains the slowest counter's estimate because counters work in parallel.

**Cold start:** each counter needs at least eight completed-ticket examples before its neural model is used. Before then, the screen identifies that counter as learning and uses the existing preparation/workload estimate. A fresh database does not have trained models; real kitchen completions build the training history over time. Eight examples is an activation threshold, not proof of prediction accuracy.

Run the automated test suite with:

```powershell
npm test
```

## Current payment scope

UPI and card checkout are demo flows; this app does not collect card numbers or charge money. Cash-desk entries and audit events are stored in SQLite. Connect a payment provider and validate its server-side webhook before accepting real online payments.
