-- Ghana-specific raw commodity overrides. Exact HS6 rows win over chapter defaults.
-- Keep raw cocoa beans out of opportunity rankings while leaving processed cocoa
-- products (for example cocoa paste/butter/powder) independently classifiable.
INSERT INTO export_classifications (id, entity_id, hs_code, category, note, source_label)
SELECT 'cls_ghana_180100', id, '180100', 'traditional',
       'Cocoa beans: raw commodity; keep out of non-traditional opportunity rankings.',
       'Tereflow country classification'
  FROM entities WHERE slug = 'ghana'
ON CONFLICT(entity_id, hs_code) DO UPDATE SET
  category = excluded.category,
  note = excluded.note,
  source_label = excluded.source_label,
  updated_at = datetime('now');
