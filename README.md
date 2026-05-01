# cryptjapan

## SNKRDUNK Price API

**Base URL:** `https://cryptjapan-proxy.mew-860.workers.dev`

---

### `GET /snkrdunk/price`

Returns the average recent sale price for a graded card on SNKRDUNK (Japanese marketplace).

#### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `keywords` | yes | Search terms, e.g. `Umbreon 069` |
| `grade` | no | Grade string, e.g. `PSA10`, `PSA9` |
| `setnum` | no | Set denominator `086` or full fraction `069/086` — narrows results to a specific set |
| `masterball` | no | `1` to allow Master Ball stamp variants (default: skipped) |

#### Response

```json
{
  "price": 148222,
  "apparelId": 93117,
  "name": "Umbreon GX HR[SM1M 069/086](...)",
  "image": "https://cdn.snkrdunk.com/...",
  "salesCount": 12,
  "priceType": "avg"
}
```

| Field | Description |
|-------|-------------|
| `price` | Average sale price in JPY (null if no matching sales) |
| `apparelId` | SNKRDUNK apparel ID — link: `https://snkrdunk.com/apparels/{apparelId}` |
| `name` | Full apparel name from SNKRDUNK |
| `image` | Product image URL (null if unavailable) |
| `salesCount` | Number of sales used to compute the average |
| `priceType` | `"avg"` = priced result, `"na"` = card found but no matching grade sales |

#### Pricing logic

- Prefers sales within the last **7 days** (with 3× median outlier filter)
- Falls back to **21 days** if fewer than 2 recent sales
- Falls back to the single most recent sale if nothing in 21 days
- Always averages at most the **5 most recent** sales from whichever window is used

---

### `GET /alt-price`

Returns the alt.xyz predicted price for a graded card by cert number.

#### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `cert` | yes | Grading cert number, e.g. `12345678` |

#### Response

```json
{
  "price": 1.45,
  "assetId": "abc123",
  "certNumber": "12345678",
  "gradeNumber": 10,
  "gradingCompany": "PSA"
}
```

`price` is in USDC. `null` if the cert is not found on alt.xyz.

#### Example

```bash
curl "https://cryptjapan-proxy.mew-860.workers.dev/alt-price?cert=12345678"
```

---

### `/snkrdunk/price` Examples

```bash
# PSA 10 Umbreon from the 086-card set
curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA10&setnum=086"

# Full set fraction for tighter matching
curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA10&setnum=069%2F086"

# PSA 9, no set filter
curl "https://cryptjapan-proxy.mew-860.workers.dev/snkrdunk/price?keywords=Umbreon%20069&grade=PSA9"
```
