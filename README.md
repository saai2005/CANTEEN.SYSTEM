# MPSTME New Canteen

The app is a responsive front end served by a small Node.js backend. SQLite keeps order history, payment and admin audit records, settings, and account data on this computer.

## Run locally

1. Install Node.js 22.5 or newer (Node.js 24 is recommended).
2. In this folder, create the first administrator:

   ```powershell
   node server.js --create-admin admin "Canteen Admin"
   ```

   Enter a password of at least 10 characters when prompted. This command also starts the app. For later starts, run `npm start`.
3. Open `http://localhost:4173`.
4. Students, faculty, and staff can create their own accounts. An administrator creates Kitchen, Cashier, and additional Admin accounts in the Admin screen.

The default server address is `127.0.0.1`. To allow devices on a trusted local network to connect, set `HOST=0.0.0.0` before starting the server and open `http://<this-computer-LAN-IP>:4173` on those devices. Do not expose this development server directly to the public internet; use HTTPS and a production reverse proxy before handling real credentials or payments.

## Data and backups

- Database: `data/canteen.sqlite`
- Daily SQLite backups: `data/backups/`
- Backups are retained for 30 days. Keep an additional off-device backup for important accounting records.
- Admins can archive and restore orders; records are not permanently deleted. Optional 1- or 3-year rules archive old orders.
- Students can hide their own orders from their view. This does not delete the accounting record.
- Receipt PDF output uses the browser's **Print / Save as PDF** dialog.

`index.html` also runs directly as a local-only demo when opened from disk. Local demo data is browser storage only and does not provide account privacy, cross-device sync, or server backups. Use the server URL for the SQLite-backed app.

Menu photos are stored locally under `assets/food/` and matched to menu categories.

## Shared counter wait estimates

The authenticated `GET /api/queue` endpoint returns per-counter counts and remaining preparation workload for other customers' accepted and preparing orders. It does not return customer names, order numbers, or item details. Student screens combine that aggregate with the signed-in customer's own active orders, so queues stay independent by counter and update while the kitchen works.

## Neural-network wait prediction

Each counter has its own small feed-forward neural-network regressor. It learns from completed counter tickets, using queue size, queued workload, ticket prep time and quantity, staffing, rush mode, and the time and day as inputs. Its training target is the actual elapsed time from order acceptance until that counter ticket is marked ready.

The model has eight inputs, one eight-neuron ReLU hidden layer, and a wait-time output. After each new completed ticket, the server retrains that counter's model using up to its latest 300 saved examples and stores both samples and weights in SQLite. Student screens use the trained model for counter estimates; the order estimate remains the slowest counter's estimate because counters work in parallel.

**Cold start:** each counter needs at least eight completed-ticket examples before its neural model is used. Before then, the screen identifies that counter as learning and uses the existing preparation/workload estimate. A fresh database does not have trained models; real kitchen completions build the training history over time. Eight examples is an activation threshold, not proof of prediction accuracy.

Run the current automated checks with `npm test`.

## Current payment scope

UPI and card checkout are demo flows; this app does not collect card numbers or charge money. Cash-desk entries and audit events are stored in SQLite. Connect a payment provider and validate its server-side webhook before accepting real online payments.
