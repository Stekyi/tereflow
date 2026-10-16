-- A line count with no ad valorem equivalent (specific duties) and a flag for rows whose source rate is a placeholder.
ALTER TABLE tf_tariff ADD (na_lines NUMBER(8), no_ad_valorem NUMBER(1) DEFAULT 0 NOT NULL)
