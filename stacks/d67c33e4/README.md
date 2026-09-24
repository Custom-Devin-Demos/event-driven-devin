# d67c33e4 — legacy stock platform services

Source for two legacy services from the estate that predates the stock &
inventory control tower (`/d67c33e4`). They are **dependency-upgrade fixtures
only**: nothing here is installed, executed, deployed or called by the control
tower, which computes its own positions, demand curve and safety-stock
allowance. The root `package.json`, `npm run lint` and `npm test` ignore this
directory, and the WMS endpoints and signing keys the code references do not
exist.

| Service | Runtime | Entry point | What the code does |
|---|---|---|---|
| `node-stock-sync` | Node 12 | `src/sync.js` | Polls a WMS movement feed and normalises it into stock positions |
| `py-demand-forecast` | Python 3.7 | `app.py` | Serves a weekly demand forecast and safety-stock allowance |

Neither is expected to run as-is; read them as the code an upgrade would have
to carry forward.

## Known upgrade friction

Both services are pinned to dependency majors that are years behind, and the
pins are load-bearing — the code uses APIs that the current majors removed.

**node-stock-sync**

- `request@2.88.0` is deprecated and pins `tough-cookie@^2.5.0`; the advisory
  fix for tough-cookie lands in 4.1.3, which `request` will never accept, so
  the sync client has to be rewritten onto another HTTP client before the
  transitive dependency can move.
- `lodash@3.10.1` is used through `_.pluck`, `_.contains` and `_.object`, all
  of which were removed in lodash 4.
- `jsonwebtoken@8.5.1` accepts a `null` algorithm and returns errors that
  version 9 turns into throws; the WMS callback verifier depends on the old
  behaviour.
- `handlebars@4.0.11` renders the picking-note templates through a custom
  `registerHelper` that returns raw strings rather than `SafeString`, which
  later releases escape differently.

**py-demand-forecast**

- `Flask==1.1.2` is pinned by `werkzeug==0.16.1`, which still ships
  `werkzeug.contrib` (used for `ProxyFix` and `SimpleCache`); `werkzeug.contrib`
  was deleted in 1.0, and Flask 2.3 removed `Flask.json_encoder`, which the
  service also uses.
- `pandas==0.25.3` only builds its C extensions against the `numpy<1.20` ABI,
  and the forecast code calls `DataFrame.append()` and `pandas.util.testing`,
  both removed in pandas 2.0. The code also uses the `np.float` alias, which
  numpy deprecated in 1.20 and removed in 1.24, so numpy cannot move ahead of
  pandas on its own.
- `PyYAML==5.3.1` is loaded with the unsafe two-argument `yaml.load` signature
  that 6.0 no longer accepts.
- `requests==2.20.0` pins `urllib3>=1.21.1,<1.25`, so the urllib3 advisories
  cannot be closed without moving requests, which in turn wants a newer
  `chardet`/`charset-normalizer` split.

Upgrading either service is therefore a code change, not a version bump. See the
Renovate dependency dashboard issue for the current advisory list.
