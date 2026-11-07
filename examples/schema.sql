-- A small shop database: open the Schema view (Ctrl+Shift+V).
-- KiloNote only reads this file: nothing is run against a database.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  email       TEXT UNIQUE,
  country     CHAR(2)
);

CREATE TABLE products (
  sku         VARCHAR(20) PRIMARY KEY,
  label       TEXT NOT NULL,
  price       NUMERIC(10, 2) NOT NULL
);

CREATE TABLE orders (
  id          INT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid        BOOLEAN DEFAULT FALSE
);

CREATE TABLE order_items (
  order_id    INT,
  sku         VARCHAR(20),
  qty         INT CHECK (qty > 0),
  PRIMARY KEY (order_id, sku),
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  FOREIGN KEY (sku) REFERENCES products (sku)
);

INSERT INTO customers (id, name, email, country) VALUES
  (1, 'Acme Corp', 'contact@acme.test', 'FR'),
  (2, 'Globex', NULL, 'DE'),
  (3, 'Initech', 'it@initech.test', 'US');

INSERT INTO products (sku, label, price) VALUES
  ('KB-01', 'Keyboard', 49.90),
  ('MS-07', 'Mouse', 19.50);

SELECT c.name, COUNT(o.id) AS orders
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.name
ORDER BY orders DESC;
