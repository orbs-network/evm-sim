// Package simulator executes ordered EVM calls with state overrides, without
// broadcasting transactions.
package simulator

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

//go:embed artifact/simulator.json
var artifactJSON []byte

var contractABI, runtimeCode = loadArtifact()

func loadArtifact() (abi.ABI, hexutil.Bytes) {
	var artifact struct {
		ABI     json.RawMessage
		Runtime string
	}
	if err := json.Unmarshal(artifactJSON, &artifact); err != nil {
		panic(err)
	}
	parsed, err := abi.JSON(strings.NewReader(string(artifact.ABI)))
	if err != nil {
		panic(err)
	}
	code, err := hexutil.Decode(artifact.Runtime)
	if err != nil {
		panic(err)
	}
	return parsed, code
}

// RPC is implemented by rpc.Client; ethclient users pass client.Client().
type RPC interface {
	CallContext(context.Context, any, string, ...any) error
}

type Call struct {
	Target       common.Address
	AllowFailure bool
	CheckReturn  bool // Require an empty or true ERC20 return value.
	Value        *big.Int
	Data         []byte
}

// A zero Token denotes native currency.
type Balance struct{ Token, Account common.Address }
type CallResult struct {
	Success bool
	Data    []byte
	GasUsed *big.Int
}
type Result struct {
	Before, After, Deltas []*big.Int
	Calls                 []CallResult
}

// Account overrides use pointer values so zero balance/nonce can be explicit.
type Account struct {
	Code      hexutil.Bytes               `json:"code,omitempty"`
	Balance   *hexutil.Big                `json:"balance,omitempty"`
	Nonce     *hexutil.Uint64             `json:"nonce,omitempty"`
	StateDiff map[common.Hash]common.Hash `json:"stateDiff,omitempty"`
}

type Request struct {
	Execution common.Address
	From      common.Address
	Calls     []Call
	Balances  []Balance
	// Install the same runtime at every address executing nested helper calls.
	Helpers   []common.Address
	Overrides map[common.Address]Account
	Block     *big.Int // nil is latest; zero explicitly selects genesis.
	GasPrice  *big.Int
	Value     *big.Int
}

func unsigned(name string, value *big.Int) error {
	if value == nil || value.Sign() < 0 || value.BitLen() > 256 {
		return fmt.Errorf("%s must be a uint256", name)
	}
	return nil
}

func zeroIfNil(value *big.Int) *big.Int {
	if value == nil {
		return new(big.Int)
	}
	return new(big.Int).Set(value)
}

// Simulate is the single encoding, execution, and decoding pipeline.
func Simulate(ctx context.Context, client RPC, request Request) (*Result, error) {
	if client == nil {
		return nil, errors.New("missing RPC client")
	}
	if request.Execution == (common.Address{}) {
		return nil, errors.New("missing execution address")
	}
	calls := append([]Call(nil), request.Calls...)
	for i := range calls {
		calls[i].Value = zeroIfNil(calls[i].Value)
		if err := unsigned("call value", calls[i].Value); err != nil {
			return nil, err
		}
	}
	value := zeroIfNil(request.Value)
	if err := unsigned("value", value); err != nil {
		return nil, err
	}
	data, err := contractABI.Pack("simulate", calls, request.Balances)
	if err != nil {
		return nil, fmt.Errorf("encode simulation: %w", err)
	}
	overrides := make(map[common.Address]Account, len(request.Overrides)+len(request.Helpers)+1)
	for address, account := range request.Overrides {
		overrides[address] = account
	}
	installed := make(map[common.Address]bool)
	for _, address := range append([]common.Address{request.Execution}, request.Helpers...) {
		if installed[address] {
			continue
		}
		account := overrides[address]
		if len(account.Code) != 0 {
			return nil, fmt.Errorf("conflicting code override at %s", address)
		}
		account.Code = runtimeCode
		overrides[address] = account
		installed[address] = true
	}
	block := "latest"
	if request.Block != nil {
		if err := unsigned("block", request.Block); err != nil {
			return nil, err
		}
		block = hexutil.EncodeBig(request.Block)
	}
	args := map[string]any{"to": request.Execution, "data": hexutil.Bytes(data), "value": (*hexutil.Big)(value)}
	if request.From != (common.Address{}) {
		args["from"] = request.From
	}
	if request.GasPrice != nil {
		if err := unsigned("gas price", request.GasPrice); err != nil {
			return nil, err
		}
		args["gasPrice"] = (*hexutil.Big)(request.GasPrice)
	}
	var raw hexutil.Bytes
	if err := client.CallContext(ctx, &raw, "eth_call", args, block, overrides); err != nil {
		return nil, fmt.Errorf("execute simulation: %w", err)
	}
	values, err := contractABI.Unpack("simulate", raw)
	if err != nil {
		return nil, fmt.Errorf("decode simulation: %w", err)
	}
	before := values[0].([]*big.Int)
	after := values[1].([]*big.Int)
	results := *abi.ConvertType(values[2], new([]CallResult)).(*[]CallResult)
	if len(before) != len(request.Balances) || len(after) != len(before) || len(results) != len(calls) {
		return nil, errors.New("unexpected simulation result lengths")
	}
	deltas := make([]*big.Int, len(before))
	for i := range before {
		deltas[i] = new(big.Int).Sub(after[i], before[i])
	}
	return &Result{Before: before, After: after, Deltas: deltas, Calls: results}, nil
}

type TransferRequest struct {
	Token, From, To common.Address
	Amount          *big.Int
	Block           *big.Int
}

// SimulateTransfer uses the receiver as spender and requires existing allowance.
// Errors are explicit; fee-free fallback belongs to the consuming policy.
func SimulateTransfer(ctx context.Context, client RPC, request TransferRequest) (*big.Int, error) {
	if err := unsigned("amount", request.Amount); err != nil {
		return nil, err
	}
	if request.Amount.Sign() == 0 {
		return new(big.Int), nil
	}
	if request.Token == (common.Address{}) {
		return nil, errors.New("transfer probe requires an ERC20 token")
	}
	call, err := tokenCall(request.Token, "transferFrom", request.From, request.To, request.Amount)
	if err != nil {
		return nil, err
	}
	result, err := Simulate(ctx, client, Request{
		Execution: request.To, Block: request.Block,
		Calls: []Call{call}, Balances: []Balance{{Token: request.Token, Account: request.To}},
	})
	if err != nil {
		return nil, err
	}
	return result.Deltas[0], nil
}

var tokenABI = func() abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(`[
        {"type":"function","name":"transferFrom","inputs":[{"type":"address"},{"type":"address"},{"type":"uint256"}]},
        {"type":"function","name":"approve","inputs":[{"type":"address"},{"type":"uint256"}]}
    ]`))
	if err != nil {
		panic(err)
	}
	return parsed
}()

func tokenCall(token common.Address, method string, args ...any) (Call, error) {
	data, err := tokenABI.Pack(method, args...)
	return Call{Target: token, CheckReturn: true, Data: data}, err
}

type SwapRequest struct {
	User, Sender, Recipient common.Address
	InputToken, OutputToken common.Address
	Amount                  *big.Int
	Target, ApprovalTarget  common.Address
	Data                    []byte
	PreCalls                []Call
	Block                   *big.Int
	GasPrice                *big.Int
}

// SimulateSwap preserves the ordered hops of the former swap simulator. Native
// output uses the zero address. Input must be ERC20; use Simulate for other flows.
func SimulateSwap(ctx context.Context, client RPC, request SwapRequest) (*Result, error) {
	if err := unsigned("amount", request.Amount); err != nil {
		return nil, err
	}
	if request.User == (common.Address{}) || request.InputToken == (common.Address{}) || request.Target == (common.Address{}) || len(request.Data) == 0 {
		return nil, errors.New("missing swap user, input token, target, or calldata")
	}
	sender, recipient, approval := request.Sender, request.Recipient, request.ApprovalTarget
	if sender == (common.Address{}) {
		sender = request.User
	}
	if recipient == (common.Address{}) {
		recipient = request.User
	}
	if approval == (common.Address{}) {
		approval = request.Target
	}
	// This helper has no persisted state and never receives a broadcast transaction.
	helper := common.HexToAddress("0x0000000000000000000000000000000012341234")
	if helper == sender || helper == recipient || helper == request.User {
		return nil, errors.New("swap actor collides with helper address")
	}
	reset, err := tokenCall(request.InputToken, "approve", approval, new(big.Int))
	if err != nil {
		return nil, err
	}
	approve, err := tokenCall(request.InputToken, "approve", approval, request.Amount)
	if err != nil {
		return nil, err
	}
	swap := Call{Target: request.Target, Data: request.Data, Value: new(big.Int)}
	transfer := func(from, token, to common.Address) Call {
		data, packErr := contractABI.Pack("transferAll", token, to)
		if packErr != nil {
			panic(packErr)
		} // Fixed ABI and typed arguments.
		return Call{Target: from, Data: data, Value: new(big.Int)}
	}
	calls := append([]Call(nil), request.PreCalls...)
	if sender != request.User {
		nested := []Call{reset, approve, swap}
		for i := range nested {
			nested[i].Value = zeroIfNil(nested[i].Value)
		}
		data, err := contractABI.Pack("executeAndTransfer", nested, request.OutputToken, recipient)
		if err != nil {
			return nil, fmt.Errorf("encode nested swap: %w", err)
		}
		calls = append(calls, transfer(request.User, request.InputToken, sender), Call{Target: sender, Data: data})
	} else {
		calls = append(calls,
			transfer(sender, request.InputToken, helper), transfer(helper, request.InputToken, sender),
			reset, approve, swap,
			transfer(recipient, request.OutputToken, helper), transfer(helper, request.OutputToken, recipient))
	}
	return Simulate(ctx, client, Request{
		Execution: request.User, Calls: calls,
		Balances: []Balance{{Token: request.OutputToken, Account: recipient}},
		Helpers:  []common.Address{helper, sender, recipient},
		Block:    request.Block, GasPrice: request.GasPrice,
	})
}
