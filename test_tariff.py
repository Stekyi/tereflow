import os
import comtradeapicall

key = '3e8973bf22ca440cb5ad4ce013430e40'

print("Testing Ghana tariff-line availability...")

df = comtradeapicall.getTarifflineDataAvailability(
    key,
    typeCode="C",
    freqCode="A",
    clCode="HS",
    period="2025",
    reporterCode="288",
)

print(df.to_string())
print()
print("Rows:", len(df))