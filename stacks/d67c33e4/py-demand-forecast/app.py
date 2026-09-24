"""Weekly demand forecast service for the stock & inventory control tower.

Runs on the legacy Python 3.7 estate behind gunicorn. The replenishment run in
the control tower calls ``/forecast`` for the weekly demand curve and the
safety-stock allowance for each site and SKU.
"""

import os

import yaml
from flask import Flask, jsonify, request
from flask.json import JSONEncoder
from werkzeug.contrib.cache import SimpleCache
from werkzeug.contrib.fixers import ProxyFix

from forecast import forecast_positions, service_tier_safety_stock

CONFIG_PATH = os.environ.get("FORECAST_CONFIG", "config/tiers.yaml")

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app)
cache = SimpleCache(default_timeout=900)


class NumpyJSONEncoder(JSONEncoder):
    def default(self, obj):
        if hasattr(obj, "item"):
            return obj.item()
        return JSONEncoder.default(self, obj)


app.json_encoder = NumpyJSONEncoder


def load_tiers():
    tiers = cache.get("tiers")
    if tiers is None:
        with open(CONFIG_PATH) as handle:
            tiers = yaml.load(handle.read())
        cache.set("tiers", tiers)
    return tiers


@app.route("/health")
def health():
    return jsonify({"status": "ok", "tiers": sorted(load_tiers().keys())})


@app.route("/forecast", methods=["POST"])
def forecast():
    payload = request.get_json(force=True)
    weeks = int(payload.get("weeks", 2))
    positions = payload.get("positions", [])

    frame = forecast_positions(positions, weeks)
    tiers = load_tiers()

    records = []
    for row in frame.to_dict("records"):
        row["safetyStockUnits"] = service_tier_safety_stock(
            tiers, row["serviceTier"], row["weeklyDemand"]
        )
        records.append(row)

    return jsonify({"weeks": weeks, "positions": records})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5055)))
