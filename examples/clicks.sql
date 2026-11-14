-- Top rules by clicks over the last 7 days (Workers Analytics Engine SQL API).
-- blob1 = rule id, blob2 = host, blob3 = path, blob4 = location, blob5 = status,
-- blob6 = country, blob7 = referrer host, double1 = 1 per click.
SELECT
  blob1 AS rule_id,
  SUM(_sample_interval * double1) AS clicks
FROM redirect_clicks
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY rule_id
ORDER BY clicks DESC
LIMIT 50;
