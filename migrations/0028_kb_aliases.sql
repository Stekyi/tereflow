-- Search terms for a relationship, lowercase and comma separated, so a typed product can be mapped to a main product or to
-- the main product it is a by-product of.
ALTER TABLE kb_relationship ADD COLUMN aliases TEXT;
