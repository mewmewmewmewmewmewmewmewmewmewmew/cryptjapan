cryptjapan proxy API
Base URL: https://cryptjapan-proxy.mew-860.workers.dev

----------------------------------------------------------------------

GET /alt-price?cert=CERT_NUMBER

Looks up a graded card on alt.xyz by cert number, returns the predicted
price and automatically queries SNKRDUNK for the Japanese market price.

Parameters:
  cert (required) - grading cert number, e.g. 88127127

Response fields:
  altPrice       - alt.xyz predicted price in USDC (null if not found)
  assetId        - alt.xyz asset UUID
  certNumber     - cert number as returned by alt.xyz
  gradeNumber    - grade as returned by alt.xyz, e.g. "10.0"
  gradingCompany - grading company, e.g. "PSA"
  psaGrade       - normalized grade string used for SNKRDUNK, e.g. "PSA10"
  cardName       - card name from alt.xyz (subject field), e.g. "Umbreon GX HR"
  cardNumber     - card number from alt.xyz, zero-padded if numeric, e.g. "069"
  snkrdunk       - SNKRDUNK price result (null if card not found or not Japanese)
    .price       - average recent sale price in JPY
    .apparelId   - SNKRDUNK apparel ID (link: snkrdunk.com/apparels/{id})
    .name        - full apparel name on SNKRDUNK
    .image       - product image URL
    .salesCount  - number of sales averaged (max 5)
    .priceType   - "avg" if priced, "na" if card found but no matching grade sales

Example:
  curl "https://cryptjapan-proxy.mew-860.workers.dev/alt-price?cert=88127127"

----------------------------------------------------------------------

GET /snkrdunk/price

Returns the average recent sale price for a graded card on SNKRDUNK.

Parameters:
  keywords   (required) - search terms, e.g. "Umbreon 069"
  grade      (optional) - grade string, e.g. "PSA10", "PSA9"
  setnum     (optional) - set denominator "086" or full fraction "069/086"
                          narrows results to a specific set size
                          short numbers are auto-padded (69 = 069, 69/86 = 069/086)
  masterball (optional) - pass "1" to allow Master Ball stamp variants
                          (skipped by default)

Response fields:
  price       - average recent sale price in JPY (null if no matching sales)
  apparelId   - SNKRDUNK apparel ID (link: snkrdunk.com/apparels/{id})
  name        - full apparel name on SNKRDUNK
  image       - product image URL (null if unavailable)
  salesCount  - number of sales used to compute the average (max 5)
  priceType   - "avg" if priced, "na" if card found but no matching grade sales

Pricing logic:
  Prefers sales within the last 7 days, removing outliers above 3x the median.
  Falls back to 21 days if fewer than 2 sales survive.
  Falls back to the single most recent sale if nothing in 21 days.
  Always averages at most the 5 most recent sales from whichever window is used.

Examples:
  curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA10&setnum=086"
  curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA10&setnum=069%2F086"
  curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA9"
