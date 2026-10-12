#!/usr/bin/env python3
"""Switch a wallet's HyperEVM transactions to big blocks (on) or back to small blocks (off).

HyperEVM has small blocks (~1 s, 2M gas) and big blocks (~1 min, 30M gas).
Deploying Spaces' implementations and factories needs more than 2M gas, so
the deploying wallet must use big blocks while it deploys. This sends the
HyperCore action that does it ({"type": "evmUserModify", "usingBigBlocks": ...}),
signed with Hyperliquid's official Python SDK (Exchange.use_big_blocks).

    pip install hyperliquid-python-sdk
    python3 script/hyperevm_big_blocks.py on  --testnet
    python3 script/hyperevm_big_blocks.py off --testnet

The private key is asked for with hidden input, never taken as an argument.
Drop --testnet for HyperEVM mainnet.
"""
import argparse
import getpass

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("state", choices=["on", "off"], help="on: big blocks; off: back to small blocks")
    parser.add_argument("--testnet", action="store_true", help="HyperEVM testnet (chain 998) instead of mainnet")
    args = parser.parse_args()

    key = getpass.getpass("Deployer private key (hidden): ").strip()
    wallet = Account.from_key(key)
    url = constants.TESTNET_API_URL if args.testnet else constants.MAINNET_API_URL
    exchange = Exchange(wallet, url)
    result = exchange.use_big_blocks(args.state == "on")
    print(f"{wallet.address}: big blocks {args.state} on {'testnet' if args.testnet else 'mainnet'} ->", result)


if __name__ == "__main__":
    main()
