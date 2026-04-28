"""Price comparison and arbitrage detection logic."""

from dataclasses import dataclass
from .collectorcrypt import Listing as CCListing
from .snkrdunk import SnkrdunkListing


@dataclass
class ArbitrageOpportunity:
    card_name: str
    set_name: str
    buy_platform: str
    buy_price_jpy: float
    buy_url: str
    sell_platform: str
    sell_price_jpy: float
    sell_url: str
    profit_jpy: float
    profit_pct: float


def _normalize_name(name: str) -> str:
    """Case-fold and strip whitespace for fuzzy card matching."""
    return name.lower().strip()


def find_opportunities(
    cc_listings: list[CCListing],
    snkrdunk_listings: list[SnkrdunkListing],
    min_profit_pct: float = 5.0,
    min_profit_jpy: float = 0.0,
) -> list[ArbitrageOpportunity]:
    """Compare prices across both platforms and return profitable spreads.

    Matching is done by normalized card name + set name since there is no
    shared card ID between platforms yet.
    """
    # Index Snkrdunk listings by (card_name, set_name) -> cheapest listing
    snkr_index: dict[tuple[str, str], SnkrdunkListing] = {}
    for listing in snkrdunk_listings:
        key = (_normalize_name(listing.card_name), _normalize_name(listing.set_name))
        if key not in snkr_index or listing.price_jpy < snkr_index[key].price_jpy:
            snkr_index[key] = listing

    # Index Collector Crypt listings the same way
    cc_index: dict[tuple[str, str], CCListing] = {}
    for listing in cc_listings:
        key = (_normalize_name(listing.card_name), _normalize_name(listing.set_name))
        if key not in cc_index or listing.price_jpy < cc_index[key].price_jpy:
            cc_index[key] = listing

    opportunities: list[ArbitrageOpportunity] = []

    for key, cc in cc_index.items():
        snkr = snkr_index.get(key)
        if not snkr:
            continue
        _check_pair(cc, snkr, min_profit_pct, min_profit_jpy, opportunities)

    opportunities.sort(key=lambda o: o.profit_pct, reverse=True)
    return opportunities


def _check_pair(
    cc: CCListing,
    snkr: SnkrdunkListing,
    min_profit_pct: float,
    min_profit_jpy: float,
    out: list[ArbitrageOpportunity],
) -> None:
    """Check both directions (CC→Snkrdunk and Snkrdunk→CC) for a matched pair."""
    for buy_price, buy_platform, buy_url, sell_price, sell_platform, sell_url in [
        (cc.price_jpy, "CollectorCrypt", cc.url, snkr.price_jpy, "Snkrdunk", snkr.url),
        (snkr.price_jpy, "Snkrdunk", snkr.url, cc.price_jpy, "CollectorCrypt", cc.url),
    ]:
        if sell_price <= buy_price:
            continue
        profit_jpy = sell_price - buy_price
        profit_pct = (profit_jpy / buy_price) * 100
        if profit_pct >= min_profit_pct and profit_jpy >= min_profit_jpy:
            out.append(
                ArbitrageOpportunity(
                    card_name=cc.card_name,
                    set_name=cc.set_name,
                    buy_platform=buy_platform,
                    buy_price_jpy=buy_price,
                    buy_url=buy_url,
                    sell_platform=sell_platform,
                    sell_price_jpy=sell_price,
                    sell_url=sell_url,
                    profit_jpy=profit_jpy,
                    profit_pct=profit_pct,
                )
            )
