"""CLI entry point for the CollectorCrypt vs Snkrdunk arbitrage tool."""

import argparse
import sys

from rich.console import Console
from rich.table import Table

from . import __version__
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
    table.add_column("Grade")
    table.add_column("PSA Cert")
    table.add_column("Buy on", style="cyan")
    table.add_column("Buy (USDC)", justify="right")
    table.add_column("Sell on", style="magenta")
    table.add_column("Sell (USDC)", justify="right")
    table.add_column("Profit", justify="right", style="green")
    table.add_column("Profit %", justify="right", style="green")

    for opp in opportunities:
        table.add_row(
            opp.card_name,
            opp.set_name,
            opp.grade,
            opp.grading_id,
            opp.buy_platform,
            f"${opp.buy_price_usdc:,.2f}",
            opp.sell_platform,
            f"${opp.sell_price_usdc:,.2f}",
            f"${opp.profit_usdc:,.2f}",
            f"{opp.profit_pct:.1f}%",
        )

    console.print(table)

    console.print("\n[bold]Links:[/bold]")
    for i, opp in enumerate(opportunities, 1):
        console.print(f"  {i}. Buy:  {opp.buy_url}")
        console.print(f"     Sell: {opp.sell_url}")


def cmd_listings(args: argparse.Namespace) -> None:
    """Dump raw CollectorCrypt listings (useful for testing before Snkrdunk is wired up)."""
    client = CollectorCryptClient()
    categories = args.categories.split(",") if args.categories else None

    with console.status("Fetching CollectorCrypt listings..."):
        try:
            page = client.get_marketplace_page(
                page=args.page,
                step=args.step,
                categories=categories,
                grading_company=args.grading_company or None,
                grade=args.grade or None,
                language=args.language or None,
            )
        except Exception as exc:
            console.print(f"[red]Fetch failed:[/red] {exc}")
            sys.exit(1)

    console.print(
        f"Page {args.page}/{page.total_pages} — "
        f"[bold]{page.total_found:,}[/bold] total matching listings"
    )

    table = Table(show_lines=True)
    table.add_column("Card", style="bold")
    table.add_column("Set")
    table.add_column("Grade")
    table.add_column("PSA Cert")
    table.add_column("Price", justify="right")
    table.add_column("Currency")
    table.add_column("Platform")

    for l in page.listings:
        table.add_row(
            l.card_name,
            l.set_name,
            l.grade,
            l.grading_id,
            f"{l.price_usdc:,.2f}",
            l.currency,
            l.marketplace,
        )

    console.print(table)


def cmd_arbitrage(args: argparse.Namespace) -> None:
    categories = args.categories.split(",") if args.categories else None
    cc_client = CollectorCryptClient()
    snkr_client = SnkrdunkClient()

    with console.status("Fetching CollectorCrypt listings..."):
        try:
            cc_listings = cc_client.get_all_listings(
                categories=categories,
                grading_company=args.grading_company or None,
                grade=args.grade or None,
                language=args.language or None,
                max_pages=args.max_pages,
            )
        except Exception as exc:
            console.print(f"[red]CollectorCrypt fetch failed:[/red] {exc}")
            sys.exit(1)

    console.print(f"Fetched [bold]{len(cc_listings)}[/bold] CollectorCrypt listings.")

    with console.status("Fetching Snkrdunk listings..."):
        try:
            snkr_listings = snkr_client.get_listings()
        except NotImplementedError as exc:
            console.print(f"[yellow]Snkrdunk:[/yellow] {exc}")
            snkr_listings = []
        except Exception as exc:
            console.print(f"[red]Snkrdunk fetch failed:[/red] {exc}")
            snkr_listings = []

    if not snkr_listings:
        console.print("[yellow]No Snkrdunk data — implement SnkrdunkClient to run arbitrage.[/yellow]")
        return

    usdc_per_jpy = args.usdc_per_jpy if args.usdc_per_jpy else None
    opportunities = find_opportunities(
        cc_listings=cc_listings,
        snkrdunk_listings=snkr_listings,
        min_profit_pct=args.min_profit_pct,
        min_profit_usdc=args.min_profit_usdc,
        usdc_per_jpy=usdc_per_jpy,
    )
    render_table(opportunities)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="CollectorCrypt vs Snkrdunk arbitrage tool."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # Shared filter args
    def add_filters(p: argparse.ArgumentParser) -> None:
        p.add_argument("--categories", "-c", default="Pokemon,One Piece",
                       help="Comma-separated categories (default: Pokemon,One Piece)")
        p.add_argument("--grading-company", default="PSA")
        p.add_argument("--grade", default="GEM-MT 10")
        p.add_argument("--language", default="Japanese")

    # listings subcommand — dump raw CC data
    p_list = sub.add_parser("listings", help="Show raw CollectorCrypt marketplace listings")
    add_filters(p_list)
    p_list.add_argument("--page", type=int, default=1)
    p_list.add_argument("--step", type=int, default=96)
    p_list.set_defaults(func=cmd_listings)

    # arbitrage subcommand
    p_arb = sub.add_parser("arbitrage", help="Find arbitrage opportunities")
    add_filters(p_arb)
    p_arb.add_argument("--max-pages", type=int, default=None,
                       help="Limit pages fetched from CollectorCrypt (default: all)")
    p_arb.add_argument("--min-profit-pct", type=float, default=5.0,
                       help="Minimum profit %% to show (default: 5)")
    p_arb.add_argument("--min-profit-usdc", type=float, default=0.0,
                       help="Minimum profit in USDC to show (default: 0)")
    p_arb.add_argument("--usdc-per-jpy", type=float, default=None,
                       help="Exchange rate: 1 JPY = X USDC (e.g. 0.0067). "
                            "Required once Snkrdunk returns JPY prices.")
    p_arb.set_defaults(func=cmd_arbitrage)

    args = parser.parse_args()
    args.func(args)
    console.print(f"\n[dim]v{__version__}[/dim]")


if __name__ == "__main__":
    main()
