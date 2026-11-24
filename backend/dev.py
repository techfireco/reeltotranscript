import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

os.environ["DEV_MODE"] = "1"
os.environ["PUBLIC_ORIGIN"] = "http://localhost:4321"
os.environ["DATA_DIR"] = "var"
os.environ["WORK_DIR"] = "/tmp/rtt-jobs"

from backend.app import create_app

app = create_app()

if __name__ == "__main__":
    print("Starting local backend on http://127.0.0.1:8000 (DEV_MODE=1)...")
    app.run(host="127.0.0.1", port=8000, debug=False)
