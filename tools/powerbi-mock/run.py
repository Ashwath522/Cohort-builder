"""Fake Power BI service for testing the Power BI path without a real workspace.
python3 tools/powerbi-mock/gen_data.py && python3 tools/powerbi-mock/run.py
Then start the app with the PBI_* settings shown in README ("Test the Power BI path with the mock")."""
import time, mock_servers
mock_servers.start(8765)
print("Mock Power BI (and Entra token endpoint) on http://127.0.0.1:8765 — Ctrl+C to stop")
while True: time.sleep(3600)
