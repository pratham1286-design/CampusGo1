import os
import tempfile
import unittest
from pathlib import Path

os.environ["CAMPUSGO_DB"] = str(Path(tempfile.gettempdir()) / "campusgo-wallet-test.sqlite3")
from backend import api


class WalletTransactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            Path(os.environ["CAMPUSGO_DB"]).unlink()
        except FileNotFoundError:
            pass
        api.init_db()
        db = api.connect()
        user_id = db.execute("INSERT INTO users (lpu_id,email,role,verified,created_at) VALUES (?,?,?,?,?)", ("student-001", "student001@lpu.in", "rider", 1, api.utc_now())).lastrowid
        db.execute("INSERT INTO wallets (user_id,balance) VALUES (?,?)", (user_id, 100))
        cls.user_id = user_id
        db.close()

    @classmethod
    def tearDownClass(cls):
        Path(os.environ["CAMPUSGO_DB"]).unlink(missing_ok=True)

    def test_wallet_balance_is_derived_from_server_wallet(self):
        db = api.connect()
        db.execute("UPDATE wallets SET balance=balance-? WHERE user_id=?", (35, self.user_id))
        db.execute("INSERT INTO wallet_transactions (user_id,amount,type,status,created_at) VALUES (?,?,?,?,?)", (self.user_id, -35, "ride_charge", "completed", api.utc_now()))
        balance = db.execute("SELECT balance FROM wallets WHERE user_id=?", (self.user_id,)).fetchone()["balance"]
        transactions = db.execute("SELECT SUM(amount) AS total FROM wallet_transactions WHERE user_id=?", (self.user_id,)).fetchone()["total"]
        db.close()
        self.assertEqual(balance, 65)
        self.assertEqual(transactions, -35)

    def test_insufficient_balance_does_not_partially_charge(self):
        db = api.connect()
        before = db.execute("SELECT balance FROM wallets WHERE user_id=?", (self.user_id,)).fetchone()["balance"]
        charges_before = db.execute("SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=? AND type='ride_charge'", (self.user_id,)).fetchone()["count"]
        db.execute("BEGIN IMMEDIATE")
        wallet = db.execute("SELECT balance FROM wallets WHERE user_id=?", (self.user_id,)).fetchone()
        if wallet["balance"] < 1000:
            db.rollback()
        after = db.execute("SELECT balance FROM wallets WHERE user_id=?", (self.user_id,)).fetchone()["balance"]
        charges_after = db.execute("SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=? AND type='ride_charge'", (self.user_id,)).fetchone()["count"]
        db.close()
        self.assertEqual(before, after)
        self.assertEqual(charges_before, charges_after)


if __name__ == "__main__":
    unittest.main()
