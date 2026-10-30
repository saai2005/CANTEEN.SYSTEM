import json
import tempfile
import unittest
from pathlib import Path

import canteen_core as core


ROOT = Path(__file__).resolve().parents[1]
MENU = json.loads((ROOT / "menu.json").read_text(encoding="utf-8"))


class CanteenCoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "canteen.sqlite"
        core.initialize_db(self.db_path)
        self.student = core.create_user(
            "student1", "Test Student", "a-strong-password", db_path=self.db_path
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_password_authentication_and_demo_account_seeding(self) -> None:
        self.assertEqual(
            core.authenticate("STUDENT1", "a-strong-password", self.db_path)["id"],
            self.student["id"],
        )
        self.assertIsNone(core.authenticate("student1", "wrong-password", self.db_path))

        core.seed_configured_users(
            {"DEMO_USERNAME": "saai", "DEMO_PASSWORD": "demo12345"},
            self.db_path,
        )
        self.assertEqual(
            core.authenticate("saai", "demo12345", self.db_path)["role"], "student"
        )

    def test_menu_order_routes_to_each_counter_and_completes_at_cash_desk(self) -> None:
        station_items = {}
        for item in MENU:
            station_items.setdefault(int(item["station"]), item)
        chosen = [station_items[1], station_items[5]]
        order_id = core.place_order(
            self.student,
            {str(item["id"]): 1 for item in chosen},
            MENU,
            "Cash on delivery",
            self.db_path,
        )

        order = core.list_orders(self.student, self.db_path)[0]
        self.assertEqual(order["id"], order_id)
        self.assertEqual(
            {ticket["counter"] for ticket in order["tickets"]}, {1, 5}
        )
        for ticket in order["tickets"]:
            core.set_ticket_status(ticket["id"], "preparing", db_path=self.db_path)
            core.set_ticket_status(ticket["id"], "ready", db_path=self.db_path)

        cashier = {"id": "cashier", "role": "cashier"}
        core.set_payment_status(order_id, "paid", self.db_path)
        core.set_payment_status(order_id, "collected", self.db_path)
        final_order = core.list_orders(cashier, self.db_path)[0]
        self.assertEqual(final_order["status"], "collected")
        self.assertEqual(final_order["payment_status"], "paid")
        self.assertEqual(core.model_status(self.db_path)[1]["sampleCount"], 1)

    def test_queue_model_waits_for_eight_samples(self) -> None:
        samples = [
            {
                "features": {
                    "queueOrders": index,
                    "queueMinutes": index * 3,
                    "prepMinutes": 12,
                    "quantity": 1,
                    "staff": 1,
                    "rushFactor": 1.25,
                    "hour": 12,
                    "weekday": 2,
                },
                "targetMinutes": 12 + index * 3,
            }
            for index in range(8)
        ]
        model = core.train_queue_model(samples[:7], 1)
        self.assertFalse(model["ready"])
        model = core.train_queue_model(samples, 1)
        self.assertTrue(model["ready"])
        estimate = core.predict_queue_minutes(model, samples[-1]["features"])
        self.assertGreaterEqual(estimate, 0)
        self.assertLessEqual(estimate, core.MAX_WAIT_MINUTES)


if __name__ == "__main__":
    unittest.main()
