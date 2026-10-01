# 🧪 Public Go API

The package executes `eth_call` with state overrides. Calls and overrides do not
persist onchain, and the package does not sign or broadcast transactions.
The Solidity runtime is intended for simulation overrides rather than deployment.

## ⌨️ Entry points

All entry points take a caller-provided `context.Context` and an `RPC`
implementation. `rpc.Client` implements this interface; when using
`ethclient.Client`, pass `client.Client()`.

1. `Simulate(ctx, client, Request) (*Result, error)` runs ordered calls and
   snapshots the requested balances before and after execution. `Result` contains
   `Before`, `After`, signed `Deltas`, and each call's success, return bytes, and
   gas units.
2. `SimulateTransfer(ctx, client, TransferRequest) (*big.Int, error)` returns the
   receiver's ERC20 balance delta after a simulated `transferFrom`. The receiver
   acts as spender, so the sender must already have approved it. This function
   neither creates allowance nor transfers native currency.
3. `SimulateSwap(ctx, client, SwapRequest) (*Result, error)` builds approvals,
   transfer hops, and swap execution through the same pipeline. `Deltas[0]` is
   the recipient's output delta. Input must be ERC20; output may be ERC20 or
   native. Use `Simulate` for other execution arrangements.

Execution and decoding errors are returned explicitly and wrap their causes.
The package does not replace failures with a guessed amount or fee. A successful
execution can produce zero or a negative balance delta; callers must evaluate
whether the result satisfies their requirements.

## 🔢 Amounts and blocks

Amounts and call values use `*big.Int`. Amounts must be non-nil, nonnegative,
and fit uint256. A valid zero transfer returns zero without RPC. Nil call values
and nil request value mean zero.

`Block` applies to the whole request: nil selects `latest`, and `big.NewInt(0)`
explicitly selects genesis. Pass the same block number to separate requests when
comparing results at one chain state. `GasPrice` is optional and expressed in wei.
For balance snapshots and swap output, the zero token address denotes native
currency.

## 🛠️ Generic requests

`Request.Execution` is the simulated execution address. Its code is replaced
with the embedded runtime. `Helpers` installs that same runtime at additional
addresses for nested calls. Existing storage and balances remain unless the
caller explicitly overrides them. `Overrides` supports code, balance, nonce,
and storage differences; conflicting code overrides at execution/helper
addresses are rejected. Use `From` and `Value` when caller identity or native
value affects execution.

Each `Call` specifies its target, calldata, and value. `CheckReturn` accepts an
empty or true ERC20 return value and treats false/malformed values as failures.
For other calls, success means low-level EVM call success. `AllowFailure` returns
the failed call's result instead of aborting the request. Request value must
equal the sum of call values.

Call gas includes the low-level invocation and execution cost. It is not a
complete transaction gas limit or fee. Nested execution is included in its
parent call's gas and must not be counted again.

## 🔁 Swap construction

`Sender` and `Recipient` default to `User`; `ApprovalTarget` defaults to `Target`.
`PreCalls` run before the swap's transfer and approval calls. Approval is reset
to zero before approving the requested input amount.

1. With sender equal to user, the builder transfers the full input balance
   user → helper → user, executes approvals and the swap, then transfers the
   full output balance recipient → helper → recipient. These hops can incur
   token fees, and existing balances participate in them. Use explicit generic
   calls when those full-balance hops do not match the intended execution.
2. With an alternate sender, the builder transfers the user's full input
   balance to that sender, runs approvals and swap calls there, and forwards
   only the newly generated output to the recipient. Swap calldata must deliver
   output to the sender in this branch; its pre-existing output holdings are
   excluded from forwarding.
3. The helper address is `0x0000000000000000000000000000000012341234`; it cannot
   be a swap actor. Override addresses should be chosen to represent the
   intended execution context. There is no inferred extra-transfer multiplier.

## 📋 Swap example

```go
result, err := simulator.SimulateSwap(ctx, client.Client(), simulator.SwapRequest{
    User: user, InputToken: inputToken, OutputToken: outputToken,
    Amount: amount, Target: router, Data: swapCalldata,
})
if err != nil {
    return err
}
output := result.Deltas[0]
```

The router calldata must match the selected sender, recipient, approval target,
and exact input amount. A simulation's result describes that request at its
selected block, not the outcome of a future transaction.
