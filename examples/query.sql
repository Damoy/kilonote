-- Monthly revenue by country (an example for the syntax coloring)
SELECT c.country,
       DATE_TRUNC('month', o.created_at) AS month,
       SUM(i.qty * i.price)            AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
WHERE o.paid = TRUE
  AND o.created_at >= '2026-01-01'
GROUP BY c.country, month
ORDER BY month DESC, revenue DESC;
