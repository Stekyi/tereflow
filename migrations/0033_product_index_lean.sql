-- Every secondary index multiplies the D1 row writes of each written line, and D1's free plan allows 100,000 row writes a day for the whole app.
-- The fallback search scans this table anyway, so the two secondary indexes only cost writes.
DROP INDEX IF EXISTS idx_product_index_code;
DROP INDEX IF EXISTS idx_product_index_score;
