"""CLI entry point for the CollectorCrypt vs Snkrdunk arbitrage tool."""

import argparse
import sys

from rich.console import Console
from rich.table import Table

from .collectorcrypt import CollectorCryptClient
from .snkrdunk import SnkrdunkClient
from .arbitrage import find_opportunities, ArbitrageOpportunity

console = Console()


def render_table(opportunities: list[ArbitrageOpportunity]) -> None:
    if not opportunities:
        console.print("[yellow]No arbitrage opportunities found.[/yellow]")
        return

    table = Table(title="Arbitrage Opportunities", show_lines=True)
    table.add_column("Card", style="bold")
    table.add_column("Set")
    table.add_column("Buy on", style="cyan")
    table.add_column("Buy (JPY)", justify="right")
    table.add_column("Sell on", style="magenta")
    table.add_column("Sell (JPY)", justify="right")
    table.add_column("Profit (JPY)", justify="right", style="green")
    table.add_column("Profit %", justify="right", style="green")

    for opp in opportunities:
        table.add_row(
            opp.card_name,
            opp.set_name,
            opp.buy_platform,
            f"¥{opp.buy_price_jpy:,.0f}",
            opp.sell_platform,
            f"¥{opp.sell_price_jpy:,.0f}",
            f"¥{opp.profit_jpy:,.0f}",
            f"{opp.profit_pct:.1f}%",
        )

    console.print(table)

    console.print("\n[bold]Links:[/bold]")
    for i, opp in enumerate(opportunities, 1):
        console.print(f"  {i}. Buy: {opp.buy_url}")
        console.print(f"     Sell: {opp.sell_url}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find arbitrage opportunities between CollectorCrypt and Snkrdunk."
    )
    parser.add_argument("--query", "-q", help="Card name search term")
    parser.add_argument("--set", "-s", dest="set_id", help="Filter by set ID (CollectorCrypt)")
    parser.add_argument(
        "--min-profit-pct",
        type=float,
        default=5.0,
        help="Minimum profit %% to show (default: 5)",
    )
    parser.add_argument(
        "--min-profit-jpy",
        type=float,
        default=0.0,
        help="Minimum profit in JPY to show (default: 0)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Max listings to fetch per platform (default: 100)",
    )
    args = parser.parse_args()

    cc_client = CollectorCryptClient()
    snkr_client = SnkrdunkClient()

    with console.status("Fetching CollectorCrypt listings..."):
        try:
            cc_listings = cc_client.get_listings(
                query=args.query,
                set_id=args.set_id,
                limit=args.limit,
            )
        except Exception as exc:
            console.print(f"[red]CollectorCrypt fetch failed:[/red] {exc}")
            sys.exit(1)

    with console.status("Fetching Snkrdunk listings..."):
        try:
            snkr_listings = snkr_client.get_listings(query=args.query)
        except NotImplementedError as exc:
            console.print(f"[yellow]Snkrdunk:[/yellow] {exc}")
            snkr_listings = []
        except Exception as exc:
            console.print(f"[red]Snkrdunk fetch failed:[/red] {exc}")
            snkr_listings = []

    if not snkr_listings:
        console.print(
            "[yellow]No Snkrdunk data available yet — implement SnkrdunkClient first.[/yellow]"
        )
        console.print(f"Fetched [bold]{len(cc_listings)}[/bold] CollectorCrypt listings.")
        for listing in cc_listings[:20]:
            console.print(
                f"  {listing.card_name} ({listing.set_name}) — ¥{listing.price_jpy:,.0f}  {listing.url}"
            )
        return

    opportunities = find_opportunities(
        cc_listings=cc_listings,
        snkrdunk_listings=snkr_listings,
        min_profit_pct=args.min_profit_pct,
        min_profit_jpy=args.min_profit_jpy,
    )

    render_table(opportunities)


if __name__ == "__main__":
    main()
