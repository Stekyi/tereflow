-- Traditional (not SME-accessible) trade, set at HS2 chapter level.
--
-- HS2 is the highest classification: marking a chapter traditional covers every HS4, HS6, HS8 and
-- HS10 line beneath it (classify() checks the exact code first, then its chapter). Chapters 26, 27
-- and 71 were already defaults (migration 0006). These add the rest of the set Tereflow treats as
-- big-player, licensed, extractive or state-controlled trade that a small company or newcomer is
-- not realistically going to enter. They apply to every country ('*') and an admin can override any
-- of them for one country in the Owner portal, or unmask them per view.
INSERT OR IGNORE INTO export_classifications (id, entity_id, hs_code, category, note, source_label)
VALUES
  ('cls_default_72', '*', '72', 'traditional', 'Iron and steel. Bulk commodity inputs priced on world markets, produced by large mills.', 'Tereflow SME exemption'),
  ('cls_default_73', '*', '73', 'traditional', 'Articles of iron or steel. Heavy industrial and structural goods dominated by large producers.', 'Tereflow SME exemption'),
  ('cls_default_74', '*', '74', 'traditional', 'Copper and articles thereof. Commodity metal, mining and smelting concessions.', 'Tereflow SME exemption'),
  ('cls_default_75', '*', '75', 'traditional', 'Nickel and articles thereof. Commodity metal, mining and smelting concessions.', 'Tereflow SME exemption'),
  ('cls_default_76', '*', '76', 'traditional', 'Aluminium and articles thereof. Commodity metal, smelter-scale production.', 'Tereflow SME exemption'),
  ('cls_default_78', '*', '78', 'traditional', 'Lead and articles thereof. Commodity metal.', 'Tereflow SME exemption'),
  ('cls_default_79', '*', '79', 'traditional', 'Zinc and articles thereof. Commodity metal.', 'Tereflow SME exemption'),
  ('cls_default_80', '*', '80', 'traditional', 'Tin and articles thereof. Commodity metal.', 'Tereflow SME exemption'),
  ('cls_default_81', '*', '81', 'traditional', 'Other base metals. Commodity metal.', 'Tereflow SME exemption'),
  ('cls_default_88', '*', '88', 'traditional', 'Aircraft and spacecraft. Capital equipment with no plausible SME entry.', 'Tereflow SME exemption'),
  ('cls_default_89', '*', '89', 'traditional', 'Ships and floating structures. Capital equipment with no plausible SME entry.', 'Tereflow SME exemption'),
  ('cls_default_93', '*', '93', 'traditional', 'Arms and ammunition. Government-controlled trade.', 'Tereflow SME exemption'),
  ('cls_default_97', '*', '97', 'traditional', 'Works of art and antiques. Not a market that behaves like trade.', 'Tereflow SME exemption'),
  ('cls_default_98', '*', '98', 'traditional', 'Special classification provisions. Residual lines, not products.', 'Tereflow SME exemption'),
  ('cls_default_99', '*', '99', 'traditional', 'Special transactions. Residual lines, not products.', 'Tereflow SME exemption');
