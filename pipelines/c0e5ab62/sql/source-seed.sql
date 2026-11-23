-- Deterministic synthetic data: 20,000 customers, 30,000 accounts, 50,000 invoices.
-- No real customer data. Every value derives from the row id, so each rebuild is identical.

CREATE FUNCTION pick(seed text, items text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT items[1 + (('x' || substr(md5(seed), 1, 8))::bit(32)::bigint % array_length(items, 1))::int];
$$;

CREATE FUNCTION bucket(seed text, modulus int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT (('x' || substr(md5(seed), 1, 8))::bit(32)::bigint % modulus)::int;
$$;

INSERT INTO customers
SELECT
  g,
  CASE WHEN bucket('acc' || g, 100) < 3
    THEN pick('fa' || g, ARRAY['José', 'Zoë', 'Siân', 'Renée', 'Björn', 'Søren', 'Chloë', 'André', 'François', 'Jürgen', 'Noël', 'Íñigo'])
         || ' ' || pick('la' || g, ARRAY['Núñez', 'Müller', 'Brontë', 'Lefèvre', 'Åberg', 'Gonçalves', 'Peña', 'Böhm', 'Sørensen', 'Côté'])
    ELSE pick('f' || g, ARRAY['Oliver', 'Amelia', 'George', 'Isla', 'Harry', 'Ava', 'Noah', 'Mia', 'Jack', 'Emily', 'Leo', 'Sophie', 'Arthur', 'Grace', 'Oscar', 'Freya', 'Aisha', 'Mohammed', 'Priya', 'Callum'])
         || ' ' || pick('l' || g, ARRAY['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans', 'Walker', 'Khan', 'Hughes', 'Edwards', 'Green', 'Hall', 'Clarke'])
  END,
  'customer' || g || '@example.test',
  CASE WHEN bucket('addr' || g, 100) < 5
    THEN 'Flat ' || (1 + bucket('fl' || g, 40)) || ', ' || pick('bl' || g, ARRAY['Wellington', 'Kingfisher', 'Britannia', 'Merchant', 'Harbourside']) || ' Court, '
         || (1 + bucket('hn' || g, 180)) || ' ' || pick('st' || g, ARRAY['Station', 'Victoria', 'Church', 'Manor', 'Queens', 'Mill']) || ' Road'
    ELSE (1 + bucket('hn' || g, 180)) || ' ' || pick('st' || g, ARRAY['Station', 'Victoria', 'Church', 'Manor', 'Queens', 'Mill', 'Park', 'High']) || ' '
         || pick('sx' || g, ARRAY['Road', 'Street', 'Lane', 'Avenue', 'Close'])
  END,
  pick('c' || g, ARRAY['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Newbury', 'Bristol', 'Cardiff', 'Belfast', 'Sheffield']),
  pick('pa' || g, ARRAY['RG14', 'M1', 'B2', 'LS1', 'G2', 'BS1', 'CF10', 'BT1', 'S1', 'SW1A']) || ' ' || (1 + bucket('pd' || g, 9)) || pick('pl' || g, ARRAY['AA', 'BD', 'FN', 'HT', 'JW', 'PL']),
  timestamp '2019-01-01 00:00:00' + make_interval(secs => bucket('cts' || g, 220000000))
FROM generate_series(1, 20000) AS g;

INSERT INTO accounts
SELECT
  g,
  1 + bucket('ac' || g, 20000),
  CASE WHEN bucket('at' || g, 10) < 8 THEN 'consumer' ELSE 'business' END,
  CASE WHEN g = 17263 THEN NULL
       ELSE '447' || lpad((700000000 + g * 7919 % 99999999)::text, 9, '0') END,
  pick('as' || g, ARRAY['active', 'active', 'active', 'active', 'suspended', 'closed']),
  timestamp '2019-06-01 00:00:00' + make_interval(secs => bucket('ats' || g, 205000000))
FROM generate_series(1, 30000) AS g;

INSERT INTO invoices
SELECT
  g,
  1 + bucket('ia' || g, 30000),
  issued,
  (issued + interval '14 days')::date,
  net,
  round(net * 0.20, 4),
  pick('is' || g, ARRAY['paid', 'paid', 'paid', 'paid', 'issued', 'overdue'])
FROM (
  SELECT
    g,
    timestamp '2025-01-01 00:00:00' + make_interval(secs => bucket('its' || g, 59000000)) AS issued,
    CASE WHEN bucket('usage' || g, 10) = 0
      THEN (500 + bucket('np' || g, 9000))::numeric / 100 + (1 + bucket('nu' || g, 9998))::numeric / 10000
      ELSE (500 + bucket('np' || g, 9000))::numeric / 100
    END AS net
  FROM generate_series(1, 50000) AS g
) AS s;

DROP FUNCTION pick(text, text[]);
DROP FUNCTION bucket(text, int);
