"""Snkrdunk marketplace client.

TODO: fill in once API / scraping approach is determined in next step.
"""

from dataclasses import dataclass


@dataclass
class SnkrdunkListing:
    card_name: str
    set_name: str
    grade: str              # e.g. "GEM-MT 10"
    grading_id: str         # PSA cert number — primary match key against CollectorCrypt
    price_jpy: float        # Snkrdunk lists prices in JPY
    seller: str
    listing_id: str
    url: str


class SnkrdunkClient:
    """Placeholder — implementation deferred until API/scraping method confirmed."""

    def get_listings(
        self,
        query: str | None = None,
        set_name: str | None = None,
    ) -> list[SnkrdunkListing]:
        """Fetch active listings from Snkrdunk.

        TODO: implement once API / scraping approach is confirmed.
        """
        raise NotImplementedError(
            "Snkrdunk client not yet implemented. "
            "Determine API or scraping approach first."
        )
