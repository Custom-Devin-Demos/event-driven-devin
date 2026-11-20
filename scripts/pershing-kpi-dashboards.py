"""Render the Pershing Access daily metrics dashboard PNGs from config/pershing/kpi-days.json.

Usage: python3 scripts/pershing-kpi-dashboards.py [YYYY-MM-DD ...]
Writes app/public/pershing/kpi/<date>.png (served at /pershing/kpi/<date>.png).
"""
import json
import sys
from datetime import date
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyBboxPatch  # noqa: E402

plt.rcParams['font.family'] = ['Liberation Sans', 'DejaVu Sans']

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'config/pershing/kpi-days.json').read_text())
DAYS = CONFIG['days']
ROLLOUT = CONFIG.get('release', {}).get('rolloutDate', '2026-11-15')
OUT = ROOT / 'app/public/pershing/kpi'
WINDOW = 14
BASELINE = 7
DROP_PTS = 2

INK, MUTED, LINE, BG, CARD = '#0B1F3A', '#6B7A90', '#E3E8EF', '#F3F5F9', '#FFFFFF'
TEAL, ANDROID, WEB, RED, GREEN, AMBER = '#1F6FEB', '#2DA44E', '#5B5BD6', '#D1242F', '#1A7F37', '#9A6700'


def total(key):
    return lambda d: d['android'][key] + d['web'][key]


def weighted(key, scale=1):
    return lambda d: (d['android'][key] * d['android']['dau'] + d['web'][key] * d['web']['dau']) \
        / (d['android']['dau'] + d['web']['dau']) * scale


ROWS = [
    ('ENGAGEMENT', [
        ('Daily active users', total('dau'), 'k', TEAL, 'up'),
        ('Transfers started', total('transfersStarted'), 'k', TEAL, 'up'),
        ('Transfers completed', total('transfersCompleted'), 'k', TEAL, 'up'),
    ]),
    ('TRANSFER COMPLETION', [
        ('Android', lambda d: d['android']['completionRate'] * 100, 'pct', ANDROID, 'up'),
        ('Web', lambda d: d['web']['completionRate'] * 100, 'pct', WEB, 'up'),
        ('Android vs web gap', lambda d: (d['android']['completionRate'] - d['web']['completionRate']) * 100, 'gap', AMBER, 'up'),
    ]),
    ('RELIABILITY & PERFORMANCE', [
        ('Crash-free sessions', weighted('crashFree', 100), 'pct2', TEAL, 'up'),
        ('p95 API latency', weighted('p95LatencyMs'), 'ms', TEAL, 'down'),
        ('Android share of DAU', lambda d: d['android']['dau'] / (d['android']['dau'] + d['web']['dau']) * 100, 'pct', ANDROID, None),
    ]),
]


def fmt(v, kind):
    return {'k': f'{v / 1000:.1f}k', 'pct': f'{v:.1f}%', 'pct2': f'{v:.2f}%',
            'gap': f'{v:+.1f} pts', 'ms': f'{v:.0f} ms'}[kind]


def delta(cur, prev, kind):
    if kind == 'k':
        d = (cur / prev - 1) * 100
        return d, f'{d:+.1f}%'
    if kind == 'ms':
        d = cur - prev
        return d, f'{d:+.0f} ms'
    d = cur - prev
    return d, f'{d:+.2f} pts' if kind == 'pct2' else f'{d:+.1f} pts'


def chip_color(d, kind, better):
    flat = {'k': 0.6, 'ms': 3, 'pct2': 0.02}.get(kind, 0.2)
    if abs(d) < flat or better is None:
        return MUTED, '#EEF1F5'
    good = (d > 0) == (better == 'up')
    return (GREEN, '#E6F4EA') if good else (RED, '#FDECEC')


def card(fig, x, y, w, h):
    fig.patches.append(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0,rounding_size=0.012',
                                      transform=fig.transFigure, facecolor=CARD, edgecolor=LINE, linewidth=1, zorder=-2))


def panel(fig, x, y, w, h, spec, window, labels, rollout_idx):
    title, fn, kind, color, better = spec
    card(fig, x, y, w, h)
    values = [fn(d) for d in window]
    cur, prev = values[-1], values[-2]
    base = values[-1 - BASELINE:-1]
    base_avg = sum(base) / len(base)
    alert = title == 'Android' and base_avg - cur >= DROP_PTS
    line = RED if alert else color
    d, dtxt = delta(cur, prev, kind)
    fg, bg = chip_color(d, kind, better)

    fig.text(x + 0.014, y + h - 0.032, title, fontsize=12.5, color=MUTED, fontweight='bold')
    fig.text(x + 0.014, y + h - 0.082, fmt(cur, kind), fontsize=24, color=RED if alert else INK, fontweight='bold')
    fig.text(x + w - 0.014, y + h - 0.030, f'{dtxt} DoD', fontsize=10.5, color=fg, ha='right', va='center',
             fontweight='bold', bbox=dict(boxstyle='round,pad=0.35,rounding_size=0.6', fc=bg, ec='none'))
    if alert:
        fig.text(x + w - 0.014, y + h - 0.072, f'{cur - base_avg:+.1f} pts vs 7-day avg', fontsize=10, color=RED,
                 ha='right', va='center')

    ax = fig.add_axes([x + 0.03, y + 0.03, w - 0.045, h - 0.135])
    ax.set_facecolor(CARD)
    xs = range(len(values))
    lo, hi = min(values + [base_avg]), max(values + [base_avg])
    pad = (hi - lo or abs(hi) * 0.01 or 1) * 0.25
    ax.set_ylim(lo - pad, hi + pad)
    ax.fill_between(xs, values, lo - pad, color=line, alpha=0.10, linewidth=0)
    ax.plot(xs, values, color=line, linewidth=2.4, solid_capstyle='round')
    ax.axhline(base_avg, color=MUTED, linewidth=1, linestyle=(0, (3, 3)), alpha=0.7)
    ax.scatter([len(values) - 1], [cur], s=60, color=CARD, edgecolor=line, linewidth=2.4, zorder=4)
    if rollout_idx is not None:
        ax.axvline(rollout_idx, color=AMBER, linewidth=1.2, linestyle=(0, (2, 2)))
        ax.text(rollout_idx - 0.15, hi + pad * 0.55, '2.4.0', fontsize=8.5, color=AMBER, ha='right', va='center')
    for side in ('top', 'right', 'left'):
        ax.spines[side].set_visible(False)
    ax.spines['bottom'].set_color(LINE)
    ax.tick_params(axis='both', length=0, labelsize=8.5, colors=MUTED)
    ax.set_xticks([0, len(values) // 2, len(values) - 1], [labels[0], labels[len(values) // 2], labels[-1]])
    ax.yaxis.set_major_locator(plt.MaxNLocator(3))
    if kind == 'k':
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v / 1000:.1f}k'))
    ax.grid(axis='y', color='#EEF1F5', linewidth=1)
    ax.set_axisbelow(True)
    return alert


def render(target):
    i = next(n for n, d in enumerate(DAYS) if d['date'] == target)
    window = DAYS[max(0, i - WINDOW + 1): i + 1]
    labels = [date.fromisoformat(d['date']).strftime('%b %-d') for d in window]
    dates = [d['date'] for d in window]
    rollout_idx = dates.index(ROLLOUT) if ROLLOUT in dates else None
    day = date.fromisoformat(target)

    fig = plt.figure(figsize=(16, 11), dpi=110)
    fig.patch.set_facecolor(BG)
    fig.patches.append(FancyBboxPatch((0, 0.885), 1, 0.115, boxstyle='square,pad=0', transform=fig.transFigure,
                                      facecolor=INK, edgecolor='none', zorder=-2))
    fig.text(0.03, 0.952, 'PERSHING ACCESS', fontsize=11, color='#8FB3E8', fontweight='bold')
    fig.text(0.03, 0.905, 'Daily Metrics', fontsize=28, color='white', fontweight='bold')
    fig.text(0.215, 0.910, day.strftime('%A, %B %-d, %Y'), fontsize=15, color='#C9D6EA')

    margin, gap, row_h, label_h = 0.03, 0.016, 0.228, 0.03
    w = (1 - 2 * margin - 2 * gap) / 3
    alerts = 0
    top = 0.855
    for name, specs in ROWS:
        fig.text(margin, top - 0.012, name, fontsize=10.5, color=MUTED, fontweight='bold')
        y = top - label_h - row_h
        for j, spec in enumerate(specs):
            alerts += panel(fig, margin + j * (w + gap), y, w, row_h, spec, window, labels, rollout_idx)
        top = y - 0.022

    pill = ('1 KPI needs attention', '#FFFFFF', RED) if alerts else ('All KPIs within range', '#FFFFFF', GREEN)
    fig.text(0.97, 0.930, pill[0], fontsize=12.5, color=pill[1], ha='right', va='center', fontweight='bold',
             bbox=dict(boxstyle='round,pad=0.55,rounding_size=0.9', fc=pill[2], ec='none'))
    fig.text(0.97, 0.898, f'Trailing {len(window)} days · Android + web · dashed line = 7-day avg',
             fontsize=10, color='#C9D6EA', ha='right', va='center')
    fig.text(1 - margin, 0.018, 'KPI Bot · Pershing Access', fontsize=9, color=MUTED, ha='right')

    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f'{target}.png', facecolor=BG)
    plt.close(fig)


if __name__ == '__main__':
    targets = sys.argv[1:] or [d['date'] for d in DAYS[7:]]
    for t in targets:
        render(t)
        print(OUT / f'{t}.png')
