# 🧪 evm-sim

Simulate ERC20 transfers, swaps, and ordered EVM calls in Go. Returns balance
deltas without sending transactions.

## 📦 Install

```sh
go get github.com/orbs-network/evm-sim@v1.5.2
```

Requires Go 1.24+ and an Ethereum RPC supporting state overrides. Contract included.

## ⚡ Usage

```go
import simulator "github.com/orbs-network/evm-sim"

received, err := simulator.SimulateTransfer(ctx, client.Client(), simulator.TransferRequest{
    Token: token, From: sender, To: receiver, Amount: amount,
})
```

The sender must approve the receiver first. `client` is an `ethclient.Client`.

1. `SimulateTransfer` → receiver's ERC20 balance delta.
2. `SimulateSwap` → swap results; `Deltas[0]` is the recipient's output delta.
3. `Simulate` → ordered calls, balance deltas, return data, and gas.

## 🛠️ Develop

```sh
go test ./...
go build ./...
go vet ./...
forge test
go test -tags integration -race ./...
./build
```

Foundry is needed for Solidity checks and artifact rebuilds; integration tests
use Anvil. Rebuilding also requires `jq`.
