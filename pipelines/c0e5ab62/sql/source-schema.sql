-- Data-centre billing database (system of record).
-- Timestamps are stored as UK local time (Europe/London) without a zone.
CREATE TABLE customers (
  customer_id   integer PRIMARY KEY,
  full_name     varchar(80)  NOT NULL,
  email         varchar(120) NOT NULL,
  address_line  varchar(120) NOT NULL,
  city          varchar(60)  NOT NULL,
  postcode      varchar(10)  NOT NULL,
  created_at    timestamp    NOT NULL
);

CREATE TABLE accounts (
  account_id    integer PRIMARY KEY,
  customer_id   integer     NOT NULL REFERENCES customers (customer_id),
  account_type  varchar(12) NOT NULL,
  msisdn        varchar(15),
  status        varchar(10) NOT NULL,
  opened_at     timestamp   NOT NULL
);

CREATE TABLE invoices (
  invoice_id    integer PRIMARY KEY,
  account_id    integer       NOT NULL REFERENCES accounts (account_id),
  issued_at     timestamp     NOT NULL,
  due_date      date          NOT NULL,
  net_amount    numeric(12,4) NOT NULL,
  vat_amount    numeric(12,4) NOT NULL,
  status        varchar(10)   NOT NULL
);
