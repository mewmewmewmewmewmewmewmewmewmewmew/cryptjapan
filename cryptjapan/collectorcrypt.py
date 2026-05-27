"""Collector Crypt marketplace API client.

Public endpoint discovered via browser DevTools:
  GET https://api.collectorcrypt.com/marketplace
No authentication required for reads.
"""

import requests
from dataclasses import dataclass

BASE_URL = "https://api.collectorcrypt.com"

CARD_URL = "https://collectorcrypt.com/assets/solana/{nft_address}"


@dataclass
class Listing:
    card_id: str        # CollectorCrypt internal ID e.g. "2026030551C108504"
    card_name: str      # full item name e.g. "2022 #054 Full Art/Mew Vmax PSA 10 ..."
    set_name: str       # e.g. "Pokemon Japanese Sword & Shield Vstar Universe"
    grade: str          # e.g. "GEM-MT 10"
    grading_company: str  # e.g. "PSA"
    grading_id: str     # PSA cert number
    price_usdc: float   # listing price in USDC (or SOL — see currency field)
    currency: str       # "USDC" or "SOL"
    seller_id: str
    nft_address: str
    marketplace: str    # e.g. "ME" (Magic Eden cross-listing)
    url: str


@dataclass
class MarketplacePage:
    listings: list[Listing]
    total_found: int    # cards matching the filters
    total_pages: int


class CollectorCryptClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers["Content-Type"] = "application/json"

    def _get(self, path: str, params: dict | None = None) -> dict:
        resp = self.session.get(f"{BASE_URL}{path}", params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()

    def get_marketplace_page(
        self,
        page: int = 1,
        step: int = 96,
        categories: list[str] | None = None,
        grading_company: str | None = None,
        grade: str | None = None,
        language: str | None = None,
        card_type: str = "Card",
        order_by: str = "listedDateDesc",
    ) -> MarketplacePage:
        """Fetch one page of active marketplace listings.

        GET /marketplace
        Response key: filterNFtCard (sic)
        """
        params: dict = {
            "page": page,
            "step": step,
            "cardType": card_type,
            "orderBy": order_by,
        }
        if categories:
            params["categories"] = ",".join(categories)
        if grading_company:
            params["gradingCompany"] = grading_company
        if grade:
            params["grade"] = grade
        if language:
            params["language"] = language

        data = self._get("/marketplace", params=params)

        listings: list[Listing] = []
        for item in data.get("filterNFtCard", []):
            listing_data = item.get("listing")
            if not listing_data:
                continue  # card exists but is not currently listed for sale
            listings.append(
                Listing(
                    card_id=item.get("id", ""),
                    card_name=item.get("itemName", ""),
                    set_name=item.get("set", ""),
                    grade=item.get("grade", ""),
                    grading_company=item.get("gradingCompany", ""),
                    grading_id=item.get("gradingID", ""),
                    price_usdc=float(listing_data.get("price", 0)),
                    currency=listing_data.get("currency", "USDC"),
                    seller_id=listing_data.get("sellerId", ""),
                    nft_address=item.get("nftAddress", ""),
                    marketplace=listing_data.get("marketplace", ""),
                    url=CARD_URL.format(nft_address=item.get("nftAddress", "")),
                )
            )

        return MarketplacePage(
            listings=listings,
            total_found=data.get("findTotal", 0),
            total_pages=data.get("totalPages", 0),
        )

    def get_all_listings(
        self,
        categories: list[str] | None = None,
        grading_company: str | None = None,
        grade: str | None = None,
        language: str | None = None,
        card_type: str = "Card",
        order_by: str = "listedDateDesc",
        max_pages: int | None = None,
        step: int = 96,
    ) -> list[Listing]:
        """Fetch all pages of listings matching the given filters."""
        first = self.get_marketplace_page(
            page=1,
            step=step,
            categories=categories,
            grading_company=grading_company,
            grade=grade,
            language=language,
            card_type=card_type,
            order_by=order_by,
        )
        all_listings = list(first.listings)
        total_pages = first.total_pages
        if max_pages:
            total_pages = min(total_pages, max_pages)

        for page in range(2, total_pages + 1):
            page_data = self.get_marketplace_page(
                page=page,
                step=step,
                categories=categories,
                grading_company=grading_company,
                grade=grade,
                language=language,
                card_type=card_type,
                order_by=order_by,
            )
            all_listings.extend(page_data.listings)

        return all_listings
