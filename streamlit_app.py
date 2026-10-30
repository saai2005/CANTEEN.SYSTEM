from __future__ import annotations

import json
import math
import os
import sqlite3
from pathlib import Path
from typing import Any

import streamlit as st

import canteen_core as core

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("CANTEEN_DB_PATH", ROOT / "data" / "streamlit-canteen.sqlite"))
MENU: list[dict[str, Any]] = json.loads((ROOT / "menu.json").read_text(encoding="utf-8"))
MENU_BY_ID = {str(item["id"]): item for item in MENU}

st.set_page_config(
    page_title="MPSTME Canteen",
    page_icon="🥗",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
    <style>
    :root { color-scheme: dark; }
    .stApp { background: linear-gradient(145deg, #071b16 0%, #0c2b21 58%, #10291f 100%); }
    [data-testid="stSidebar"] { background: #071712; border-right: 1px solid #244c3a; }
    h1, h2, h3 { color: #f0c66a !important; }
    p, label, span { color: #e7eee8; }
    div[data-testid="stMetric"] {
      background: #10291f; border: 1px solid #28513d; padding: 14px; border-radius: 14px;
    }
    div.stButton > button {
      background: #c89b4b; color: #102017; border: 0; border-radius: 10px;
      font-weight: 700; min-height: 42px;
    }
    div.stButton > button:hover { background: #e0b75e; color: #102017; border: 0; }
    div[data-testid="stForm"] {
      background: #10291f; border: 1px solid #28513d; padding: 16px; border-radius: 14px;
    }
    .hero {
      padding: 28px 30px; border-radius: 22px;
      background: linear-gradient(120deg, #173d2d, #10271e);
      border: 1px solid #396344; margin-bottom: 20px;
    }
    .hero p { color: #cbd9ce; margin-bottom: 0; }
    .food-card {
      background: #10291f; border: 1px solid #28513d; border-radius: 16px;
      padding: 12px; min-height: 82px;
    }
    .muted { color: #b7c8bb; font-size: .9rem; }
    </style>
    """,
    unsafe_allow_html=True,
)


def _read_runtime_secrets() -> dict[str, str]:
    config = {
        key: os.environ.get(key, "")
        for key in (
            "DEMO_USERNAME", "DEMO_PASSWORD", "DEMO_NAME",
            "KITCHEN_USERNAME", "KITCHEN_PASSWORD", "KITCHEN_NAME",
            "CASHIER_USERNAME", "CASHIER_PASSWORD", "CASHIER_NAME",
            "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_NAME",
        )
    }
    try:
        for key in config:
            config[key] = str(st.secrets.get(key, config[key]))
    except FileNotFoundError:
        pass
    return config


RUNTIME_CONFIG = _read_runtime_secrets()
try:
    core.seed_configured_users(RUNTIME_CONFIG, DB_PATH)
except (sqlite3.Error, ValueError) as error:
    st.error(f"Could not initialize the canteen database: {error}")
    st.stop()


def _money(amount: float) -> str:
    return f"₹{amount:,.0f}"


def _login_screen() -> None:
    st.markdown(
        """
        <div class="hero">
          <h1>MPSTME Canteen</h1>
          <p>Fresh food, minus the queue. Order from campus counters and follow your order.</p>
        </div>
        """,
        unsafe_allow_html=True,
    )
    login_tab, register_tab = st.tabs(["Sign in", "Create student account"])
    with login_tab:
        with st.form("login-form"):
            username = st.text_input("Username")
            password = st.text_input("Password", type="password")
            submitted = st.form_submit_button("Sign in", width="stretch")
        if submitted:
            user = core.authenticate(username, password, DB_PATH)
            if user is None:
                st.error("Username or password is incorrect.")
            else:
                st.session_state["user"] = user
                st.rerun()
        if not (RUNTIME_CONFIG.get("DEMO_USERNAME") and RUNTIME_CONFIG.get("DEMO_PASSWORD")):
            st.caption("Demo accounts are configured through Streamlit secrets; no shared password is stored in this repository.")
    with register_tab:
        with st.form("register-form"):
            name = st.text_input("Your name")
            username = st.text_input("Choose a username")
            password = st.text_input("Choose a password (10+ characters)", type="password")
            submitted = st.form_submit_button("Create account", width="stretch")
        if submitted:
            try:
                user = core.create_user(username, name, password, "student", DB_PATH)
            except (ValueError, sqlite3.IntegrityError) as error:
                st.error(f"Could not create account: {error}")
            else:
                st.session_state["user"] = user
                st.success("Your student account is ready.")
                st.rerun()


def _student_page(user: dict[str, str]) -> None:
    st.markdown(
        f'<div class="hero"><h1>Good food, {user["name"].split()[0]}.</h1>'
        "<p>Choose your favourites. Your items route to the right kitchen counters.</p></div>",
        unsafe_allow_html=True,
    )
    col_a, col_b, col_c = st.columns(3)
    col_a.metric("Menu items", len(MENU))
    col_b.metric("Kitchen counters", len(core.COUNTER_NAMES))
    col_c.metric("Payment choices", "Cash · UPI · Card")

    orders = core.list_orders(user, DB_PATH)
    active_orders = [order for order in orders if order["status"] not in {"collected", "cancelled"}]
    with st.expander(f"Your active orders ({len(active_orders)})", expanded=bool(active_orders)):
        if not active_orders:
            st.write("No active orders yet.")
        for order in active_orders:
            with st.container(border=True):
                st.markdown(
                    f"**Order {order['id']}** · {order['status'].title()} · "
                    f"{_money(order['total'])} · {order['payment_method']}"
                )
                eta_parts = []
                for ticket in order["tickets"]:
                    if ticket["status"] == "ready":
                        eta_parts.append(f"{core.COUNTER_NAMES[ticket['counter']]}: ready")
                    else:
                        minutes, _ = core.estimate_wait(
                            ticket["counter"], ticket["prep_minutes"], ticket["quantity"],
                            created_before=ticket["created_at"], db_path=DB_PATH,
                        )
                        eta_parts.append(f"{core.COUNTER_NAMES[ticket['counter']]}: about {minutes} min")
                st.caption(" · ".join(eta_parts))
                st.caption(", ".join(f"{item['quantity']} × {item['name']}" for item in order["items"]))

    categories = sorted({item["category"] for item in MENU})
    filter_col, search_col = st.columns([1, 2])
    category = filter_col.selectbox("Menu section", ["All sections", *categories])
    search = search_col.text_input("Search the menu", placeholder="Try dosa, paneer, juice…")
    shown = [
        item for item in MENU
        if (category == "All sections" or item["category"] == category)
        and (not search or search.casefold() in item["name"].casefold())
    ]
    st.subheader(
        f"{category} · {len(shown)} items"
        if category != "All sections"
        else f"Menu · {len(shown)} items"
    )
    if not shown:
        st.info("No items match that search.")
    page_count = max(1, math.ceil(len(shown) / 12))
    if st.session_state.get("menu_page", 1) > page_count:
        st.session_state["menu_page"] = 1
    page_col, range_col = st.columns([1, 4])
    page_number = page_col.selectbox("Menu page", range(1, page_count + 1), key="menu_page")
    start_index = (page_number - 1) * 12
    page_items = shown[start_index:start_index + 12]
    range_col.caption(
        f"Showing {start_index + 1}–{min(start_index + len(page_items), len(shown))} "
        f"of {len(shown)} matching items"
    )
    cart: dict[str, int] = st.session_state.setdefault("cart", {})
    for start in range(0, len(page_items), 3):
        columns = st.columns(3, gap="medium")
        for column, item in zip(columns, page_items[start:start + 3]):
            with column:
                with st.container(border=True):
                    image = ROOT / item["photo"]
                    if image.is_file():
                        st.image(str(image), width="stretch")
                    st.markdown(f"**{item['emoji']} {item['name']}**")
                    st.caption(f"{item['category']} · {core.COUNTER_NAMES[item['station']]}")
                    st.markdown(f"**{_money(item['price'])}** · ~{item['basePrepMinutes']} min prep")
                    qty_col, add_col = st.columns([1, 1])
                    qty = qty_col.number_input(
                        "Qty", min_value=1, max_value=20, value=1,
                        key=f"qty-{item['id']}", label_visibility="collapsed",
                    )
                    if add_col.button("Add", key=f"add-{item['id']}", width="stretch"):
                        cart[str(item["id"])] = cart.get(str(item["id"]), 0) + int(qty)
                        st.toast(f"Added {item['name']} to your cart.")
    with st.expander(f"Your cart ({sum(cart.values())} items)", expanded=False):
        if not cart:
            st.write("Your cart is empty.")
        else:
            subtotal = 0.0
            for item_id, quantity in list(cart.items()):
                item = MENU_BY_ID[item_id]
                line_total = float(item["price"]) * quantity
                subtotal += line_total
                left, right = st.columns([4, 1])
                left.write(f"{quantity} × {item['name']} — {_money(line_total)}")
                if right.button("Remove", key=f"remove-{item_id}"):
                    del cart[item_id]
                    st.rerun()
            st.markdown(f"**Subtotal: {_money(subtotal)}**")
            payment = st.radio(
                "Payment method",
                ["Cash on delivery", "UPI (demo)", "Card (demo)"],
                horizontal=True,
                help="UPI and card are demo selections only; this app does not process payments.",
            )
            station_prep: dict[int, tuple[int, float]] = {}
            for item_id, quantity in cart.items():
                item = MENU_BY_ID[item_id]
                count, minutes = station_prep.get(item["station"], (0, 0.0))
                station_prep[item["station"]] = (
                    count + quantity,
                    minutes + float(item["basePrepMinutes"]) * quantity,
                )
            estimates = []
            for counter, (quantity, prep) in station_prep.items():
                wait, _ = core.estimate_wait(counter, prep, quantity, db_path=DB_PATH)
                estimates.append(f"{core.COUNTER_NAMES[counter]} ~{wait} min")
            st.caption("Estimated pickup time by counter: " + " · ".join(estimates))
            if st.button("Place order", type="primary", width="stretch"):
                try:
                    order_id = core.place_order(user, cart, MENU, payment, DB_PATH)
                except (ValueError, sqlite3.Error) as error:
                    st.error(f"Could not place your order: {error}")
                else:
                    st.session_state["cart"] = {}
                    st.success(f"Order {order_id} placed. Your items are routed to their kitchen counters.")
                    st.rerun()
    with st.expander("Recent order history"):
        if not orders:
            st.write("Your completed orders will appear here.")
        for order in orders:
            st.write(
                f"**{order['id']}** · {order['status'].title()} · "
                f"{_money(order['total'])} · {len(order['items'])} items"
            )


def _kitchen_page() -> None:
    st.markdown(
        '<div class="hero"><h1>Kitchen board</h1>'
        "<p>Each ticket is sent only to its designated food counter.</p></div>",
        unsafe_allow_html=True,
    )
    counter = st.selectbox(
        "Kitchen counter",
        list(core.COUNTER_NAMES),
        format_func=lambda value: f"{value}. {core.COUNTER_NAMES[value]}",
    )
    tickets = core.list_counter_tickets(counter, DB_PATH)
    st.metric("Tickets waiting / in progress", len(tickets))
    if not tickets:
        st.success("All clear — no active tickets at this counter.")
    for ticket in tickets:
        with st.container(border=True):
            st.markdown(
                f"**Order {ticket['public_order_id']}** · {ticket['customer_name']} · "
                f"{ticket['status'].title()}"
            )
            st.write(", ".join(
                f"{item['quantity']} × {item['name']}" for item in ticket["items"]
            ))
            st.caption(f"Preparation estimate: ~{ticket['prep_minutes']:.0f} min")
            if ticket["status"] == "queued":
                if st.button("Accept · start preparation", key=f"start-{ticket['id']}"):
                    try:
                        core.set_ticket_status(ticket["id"], "preparing", db_path=DB_PATH)
                    except (ValueError, sqlite3.Error) as error:
                        st.error(f"Could not start ticket: {error}")
                    else:
                        st.rerun()
            elif st.button("Mark ready for pickup", key=f"ready-{ticket['id']}"):
                try:
                    core.set_ticket_status(ticket["id"], "ready", db_path=DB_PATH)
                except (ValueError, sqlite3.Error) as error:
                    st.error(f"Could not complete ticket: {error}")
                else:
                    st.rerun()


def _cashier_page() -> None:
    st.markdown(
        '<div class="hero"><h1>Cash desk</h1>'
        "<p>Verify ready orders and record collection. Online selections are demo-only.</p></div>",
        unsafe_allow_html=True,
    )
    orders = core.list_orders({"id": "", "role": "cashier"}, DB_PATH)
    ready = [order for order in orders if order["status"] == "ready"]
    st.metric("Orders ready for handover", len(ready))
    if not ready:
        st.info("No ready orders to hand over.")
    for order in ready:
        with st.container(border=True):
            st.markdown(f"**Order {order['id']}** · {order['customer_name']} · {_money(order['total'])}")
            st.caption(f"{order['payment_method']} · Payment: {order['payment_status']}")
            if order["payment_status"] == "pending":
                if st.button("Record cash received", key=f"paid-{order['id']}"):
                    try:
                        core.set_payment_status(order["id"], "paid", DB_PATH)
                    except (ValueError, sqlite3.Error) as error:
                        st.error(f"Could not record payment: {error}")
                    else:
                        st.rerun()
            elif st.button("Mark collected", key=f"collect-{order['id']}"):
                try:
                    core.set_payment_status(order["id"], "collected", DB_PATH)
                except (ValueError, sqlite3.Error) as error:
                    st.error(f"Could not record collection: {error}")
                else:
                    st.rerun()


def _admin_page() -> None:
    st.markdown(
        '<div class="hero"><h1>Canteen overview</h1>'
        "<p>Live workload and queue-model training status by counter.</p></div>",
        unsafe_allow_html=True,
    )
    models = core.model_status(DB_PATH)
    columns = st.columns(len(core.COUNTER_NAMES))
    for column, (counter, data) in zip(columns, models.items()):
        model = data["model"]
        column.metric(
            core.COUNTER_NAMES[counter],
            f"{data['sampleCount']} completed",
            "Model ready" if model and model["ready"] else "Collecting examples",
        )
    st.caption(
        "Wait prediction is a per-counter neural-network regression model trained on completed "
        "kitchen tickets; it is hidden from the student-facing interface."
    )


def _application() -> None:
    user = st.session_state["user"]
    with st.sidebar:
        st.markdown("## 🥗 MPSTME Canteen")
        st.caption(f"Signed in as **{user['name']}** · {user['role'].title()}")
        if user["role"] in {"student", "faculty", "staff"}:
            page = "Order food"
        elif user["role"] == "kitchen":
            page = "Kitchen"
        elif user["role"] == "cashier":
            page = "Cash desk"
        else:
            page = st.radio("Navigate", ["Canteen overview", "Kitchen", "Cash desk"])
        if st.button("Sign out", width="stretch"):
            st.session_state.pop("user", None)
            st.session_state.pop("cart", None)
            st.rerun()
    if page == "Order food":
        _student_page(user)
    elif page == "Kitchen status" or page == "Kitchen":
        _kitchen_page()
    elif page == "Cash desk":
        _cashier_page()
    else:
        _admin_page()


if "user" not in st.session_state:
    _login_screen()
else:
    _application()
