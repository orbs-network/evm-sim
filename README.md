# evm-sim

🧪 Simulate ERC20 transfers, swaps, and ordered EVM calls in Go.

## 📦 Install

```sh
go get github.com/orbs-network/evm-sim@v1.5.2
```

Requires Go 1.24+ and an Ethereum RPC supporting state overrides. The compiled
contract is included; Node.js and a local Solidity compiler are not required.

## ⌨️ Usage

```go
package example

import (
    "context"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
    simulator "github.com/orbs-network/evm-sim"
)

func received(ctx context.Context, client *ethclient.Client,
    token, sender, receiver common.Address, amount *big.Int,
) (*big.Int, error) {
    return simulator.SimulateTransfer(ctx, client.Client(), simulator.TransferRequest{
        Token: token, From: sender, To: receiver, Amount: amount,
    })
}
```

## 🧭 Navigation

1. [Public API](docs/api.md)
2. [Maintainer checks and artifact rebuild](docs/development.md)
3. [Go implementation](simulator.go)
4. [Solidity simulator](src/Simulator.sol)
