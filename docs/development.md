# 🛠️ Development

## 🧪 Checks

```sh
go test ./...
go build ./...
go vet ./...
forge test
go test -tags integration -race ./...
```

Ordinary Go checks use the embedded artifact and need no local Solidity compiler
or node. Solidity tests require Foundry. The Go integration suite requires
`anvil` and launches fresh local nodes with embedded token/router fixtures.
It does not need an external RPC or funded wallet.

## 📦 Rebuild artifacts

Run `./build` with Foundry and `jq`. The script uses a temporary compiler output
directory and updates `artifact/simulator.json` plus the token/router test
artifacts. `foundry.toml` pins Solidity 0.8.24, the Paris EVM, optimizer settings,
and metadata hash settings. Keep source and embedded artifacts together.

Run the build again and verify identical artifact contents, then rerun the checks
above. Do not hand-edit runtime bytecode. No deployed contract is required to
consume the package.

## 🚀 Releases

Publish new Go module contents under a new version. Do not move an existing
version tag to different contents: Go consumers verify cached module checksums.
Examples and public documentation should describe the package API and use only
generic execution contexts.
