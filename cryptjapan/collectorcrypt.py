"""Collector Crypt marketplace API client.

Docs: https://docs.collectorcrypt.com/marketplace/api
"""

import os
import requests
from dataclasses import dataclass

BASE_URL = "https://api.collectorcrypt.com"  # TODO: confirm base URL from docs


@dataclass
class Listing:
    card_id: str
    card_name: str
    set_name: str
    price_jpy: float
    price_usd: float | None
    seller: str
    listing_id: str
    condition: str | None
    url: str


class CollectorCryptClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("COLLECTORCRYPT_API_KEY", "")
        self.session = requests.Session()
        if self.api_key:
            # TODO: confirm auth header name from docs (Bearer / x-api-key / etc.)
            self.session.headers["Authorization"] = f"Bearer {self.api_key}"
        self.session.headers["Content-Type"] = "application/json"

    def _get(self, path: str, params: dict | None = None) -> dict:
        resp = self.session.get(f"{BASE_URL}{path}", params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()

    def get_listings(
        self,
        query: str | None = None,
        set_id: str | None = None,
        page: int = 1,
        limit: int = 100,
    ) -> list[Listing]:
        """Fetch active marketplace listings.

        TODO: confirm endpoint path and param names from docs.
        Placeholder endpoint: GET /marketplace/listings
        """
        params: dict = {"page": page, "limit": limit}
        if query:
            params["q"] = query
        if set_id:
            params["set_id"] = set_id

        # TODO: update path once confirmed from docs
        data = self._get("/marketplace/listings", params=params)

        # TODO: update field mapping to match actual API response shape
        results: list[Listing] = []
        for item in data.get("listings", data if isinstance(data, list) else []):
            results.append(
                Listing(
                    card_id=item.get("card_id", item.get("id", "")),
                    card_name=item.get("card_name", item.get("name", "")),
                    set_name=item.get("set_name", item.get("set", "")),
                    price_jpy=float(item.get("price_jpy", item.get("price", 0))),
                    price_usd=item.get("price_usd"),
                    seller=item.get("seller", item.get("seller_id", "")),
                    listing_id=item.get("listing_id", item.get("id", "")),
                    condition=item.get("condition", item.get("grade")),
                    url=item.get("url", f"https://collectorcrypt.com/listing/{item.get('id', '')}"),
                )
            )
        return results

    def get_card_listings(self, card_id: str) -> list[Listing]:
        """All active listings for a specific card.

        TODO: confirm endpoint — might be GET /marketplace/listings?card_id=X
        or GET /cards/{card_id}/listings
        """
        # TODO: update path/params once confirmed from docs
        data = self._get(f"/cards/{card_id}/listings")
        items = data.get("listings", data if isinstance(data, list) else [])
        return [
            Listing(
                card_id=card_id,
                card_name=item.get("card_name", ""),
                set_name=item.get("set_name", ""),
                price_jpy=float(item.get("price_jpy", item.get("price", 0))),
                price_usd=item.get("price_usd"),
                seller=item.get("seller", ""),
                listing_id=item.get("listing_id", item.get("id", "")),
                condition=item.get("condition"),
                url=item.get("url", f"https://collectorcrypt.com/listing/{item.get('id', '')}"),
            )
            for item in items
        ]
