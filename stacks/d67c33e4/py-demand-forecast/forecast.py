"""Demand curve and safety-stock calculations."""

import numpy as np
import pandas as pd

SEASONAL_UPLIFT = [1.0, 1.08, 1.14, 1.05]


def _weekly_curve(weekly_demand, weeks):
    curve = []
    for week in range(weeks):
        uplift = SEASONAL_UPLIFT[week % len(SEASONAL_UPLIFT)]
        curve.append(np.float(weekly_demand) * uplift)
    return curve


def forecast_positions(positions, weeks):
    frame = pd.DataFrame(columns=["siteId", "sku", "serviceTier", "weeklyDemand", "curve"])

    for position in positions:
        curve = _weekly_curve(position.get("weeklyDemand", 0), weeks)
        frame = frame.append(
            {
                "siteId": position.get("siteId"),
                "sku": position.get("sku"),
                "serviceTier": position.get("serviceTier"),
                "weeklyDemand": position.get("weeklyDemand", 0),
                "curve": [int(round(value)) for value in curve],
            },
            ignore_index=True,
        )

    frame["horizonDemand"] = frame["curve"].apply(lambda curve: int(sum(curve)))
    return frame


def service_tier_safety_stock(tiers, service_tier, weekly_demand):
    tier = tiers.get(service_tier, {})
    days = tier.get("safety_stock_days", 0)
    return int(round((np.float(weekly_demand) / 7.0) * days))
