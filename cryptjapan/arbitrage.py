"""Price comparison and arbitrage detection logic."""

from dataclasses import dataclass
from .collectorcrypt import Listing as CCListing
from .snkrdunk import SnkrdunkListing


@dataclass
class ArbitrageOpportunity:
    card_name: str
    set_name: str
    grade: str
    grading_id: str         # PSA cert — reliable cross-platform match key
    buy_platform: str
    buy_price_usdc: float
    buy_url: str
    sell_platform: str
    sell_price_usdc: float
    sell_url: str
    profit_usdc: float
    profit_pct: float


def _normalize(s: str) -> str:
    return s.lower().strip()


def find_opportunities(
    cc_listings: list[CCListing],
    snkrdunk_listings: list[SnkrdunkListing],
    min_profit_pct: float = 5.0,
    min_profit_usdc: float = 0.0,
    usdc_per_jpy: float | None = None,  # set once Snkrdunk is implemented
) -> list[ArbitrageOpportunity]:
    """Compare prices across platforms and return profitable spreads.

    Primary match key: PSA grading_id (cert number) — unique per physical card,
    so it's the most reliable cross-platform identifier.
    Fallback: normalized (card_name, set_name, grade).
    """
    # Index CC listings by grading_id and by name+set+grade
    cc_by_cert: dict[str, CCListing] = {}
    cc_by_name: dict[tuple[str, str, str], CCListing] = {}
    for l in cc_listings:
        if l.grading_id:
            if l.grading_id not in cc_by_cert or l.price_usdc < cc_by_cert[l.grading_id].price_usdc:
                cc_by_cert[l.grading_id] = l
        key = (_normalize(l.card_name), _normalize(l.set_name), _normalize(l.grade))
        if key not in cc_by_name or l.price_usdc < cc_by_name[key].price_usdc:
            cc_by_name[key] = l

    # Index Snkrdunk listings the same way
    snkr_by_cert: dict[str, SnkrdunkListing] = {}
    snkr_by_name: dict[tuple[str, str, str], SnkrdunkListing] = {}
    for l in snkrdunk_listings:
        if l.grading_id:
            price = _snkr_price_usdc(l, usdc_per_jpy)
            existing = snkr_by_cert.get(l.grading_id)
            if not existing or price < _snkr_price_usdc(existing, usdc_per_jpy):
                snkr_by_cert[l.grading_id] = l
        key = (_normalize(l.card_name), _normalize(l.set_name), _normalize(l.grade))
        existing_name = snkr_by_name.get(key)
        if not existing_name or _snkr_price_usdc(l, usdc_per_jpy) < _snkr_price_usdc(existing_name, usdc_per_jpy):
            snkr_by_name[key] = l

    opportunities: list[ArbitrageOpportunity] = []

    # Match by cert number first (exact physical card match)
    matched_certs: set[str] = set()
    for cert, cc in cc_by_cert.items():
        snkr = snkr_by_cert.get(cert)
        if snkr:
            matched_certs.add(cert)
            _check_pair(cc, snkr, usdc_per_jpy, min_profit_pct, min_profit_usdc, opportunities)

    # Match remaining by name+set+grade
    for key, cc in cc_by_name.items():
        if cc.grading_id in matched_certs:
            continue
        snkr = snkr_by_name.get(key)
        if snkr:
            _check_pair(cc, snkr, usdc_per_jpy, min_profit_pct, min_profit_usdc, opportunities)

    opportunities.sort(key=lambda o: o.profit_pct, reverse=True)
    return opportunities


def _snkr_price_usdc(l: "SnkrdunkListing", usdc_per_jpy: float | None) -> float:
    if usdc_per_jpy is not None:
        return l.price_jpy * usdc_per_jpy
    return l.price_jpy  # treated as USDC if no rate given (for testing)


def _check_pair(
    cc: CCListing,
    snkr: "SnkrdunkListing",
    usdc_per_jpy: float | None,
    min_profit_pct: float,
    min_profit_usdc: float,
    out: list[ArbitrageOpportunity],
) -> None:
    cc_price = cc.price_usdc
    snkr_price = _snkr_price_usdc(snkr, usdc_per_jpy)

    for buy_price, buy_platform, buy_url, sell_price, sell_platform, sell_url in [
        (cc_price, "CollectorCrypt", cc.url, snkr_price, "Snkrdunk", snkr.url),
        (snkr_price, "Snkrdunk", snkr.url, cc_price, "CollectorCrypt", cc.url),
    ]:
        if sell_price <= buy_price:
            continue
        profit_usdc = sell_price - buy_price
        profit_pct = (profit_usdc / buy_price) * 100
        if profit_pct >= min_profit_pct and profit_usdc >= min_profit_usdc:
            out.append(
                ArbitrageOpportunity(
                    card_name=cc.card_name,
                    set_name=cc.set_name,
                    grade=cc.grade,
                    grading_id=cc.grading_id,
                    buy_platform=buy_platform,
                    buy_price_usdc=buy_price,
                    buy_url=buy_url,
                    sell_platform=sell_platform,
                    sell_price_usdc=sell_price,
                    sell_url=sell_url,
                    profit_usdc=profit_usdc,
                    profit_pct=profit_pct,
                )
            )
