import os
import comtradeapicall

key = "3e8973bf22ca440cb5ad4ce013430e40"

df = comtradeapicall.getTarifflineData(
    key,
    typeCode="C",
    freqCode="A",
    clCode="HS",
    period="2025",
    reporterCode="288",
    cmdCode="08",
    flowCode="M",
    partnerCode=0,
    partner2Code=None,
    customsCode=None,
    motCode=None,
    maxRecords=250000,
    format_output="JSON",
    countOnly=None,
    includeDesc=True,
)

print("Rows:", len(df))
print()
print(df.head(20).to_string())
print()
print("Columns:")
print(df.columns.tolist())