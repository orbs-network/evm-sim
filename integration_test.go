//go:build integration

package simulator

import (
	"context"
	_ "embed"
	"encoding/json"
	"math/big"
	"net"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/rpc"
)

//go:embed test/token.json
var tokenFixture []byte

//go:embed test/router.json
var routerFixture []byte

type chainFixture struct {
	client                                         *rpc.Client
	user, token, output, router, recipient, sender common.Address
	tokenABI, routerABI                            abi.ABI
}

func newChain(t *testing.T) *chainFixture {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := listener.Addr().String()
	listener.Close()
	_, port, _ := net.SplitHostPort(endpoint)
	cmd := exec.Command("anvil", "--host", "127.0.0.1", "--port", port, "--silent")
	if err := cmd.Start(); err != nil {
		t.Fatal("integration tests require anvil:", err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	client, err := rpc.DialHTTP("http://" + endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	var accounts []common.Address
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = client.Call(&accounts, "eth_accounts")
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	f := &chainFixture{client: client, user: accounts[0], token: common.HexToAddress("0x1001"), output: common.HexToAddress("0x1002"), router: common.HexToAddress("0x1003"), recipient: accounts[1], sender: accounts[2]}
	f.tokenABI = f.install(t, f.token, tokenFixture)
	f.install(t, f.output, tokenFixture)
	f.routerABI = f.install(t, f.router, routerFixture)
	f.rpc(t, nil, "anvil_setBalance", f.router, "0xffffffffffffffff")
	// The simulator override must replace pre-existing code and leave it intact.
	f.rpc(t, nil, "anvil_setCode", f.recipient, "0x00")
	return f
}

func (f *chainFixture) rpc(t *testing.T, result any, method string, args ...any) {
	t.Helper()
	if err := f.client.Call(result, method, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *chainFixture) install(t *testing.T, address common.Address, data []byte) abi.ABI {
	t.Helper()
	var artifact struct {
		ABI     json.RawMessage
		Runtime string
	}
	if err := json.Unmarshal(data, &artifact); err != nil {
		t.Fatal(err)
	}
	f.rpc(t, nil, "anvil_setCode", address, artifact.Runtime)
	parsed, err := abi.JSON(strings.NewReader(string(artifact.ABI)))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func (f *chainFixture) data(t *testing.T, method string, args ...any) []byte {
	t.Helper()
	data, err := f.tokenABI.Pack(method, args...)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func (f *chainFixture) tx(t *testing.T, from, token common.Address, method string, args ...any) {
	t.Helper()
	var hash common.Hash
	f.rpc(t, &hash, "eth_sendTransaction", map[string]any{"from": from, "to": token, "data": hexutil.Bytes(f.data(t, method, args...)), "gas": "0x100000"})
	var receipt *struct{ Status hexutil.Uint64 }
	deadline := time.Now().Add(5 * time.Second)
	for receipt == nil && time.Now().Before(deadline) {
		f.rpc(t, &receipt, "eth_getTransactionReceipt", hash)
		if receipt == nil {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if receipt == nil {
		t.Fatal("fixture transaction was not mined")
	}
	if receipt.Status != 1 {
		t.Fatalf("fixture transaction reverted: %s", method)
	}
}

func (f *chainFixture) balance(t *testing.T, token, account common.Address) *big.Int {
	t.Helper()
	var raw hexutil.Bytes
	f.rpc(t, &raw, "eth_call", map[string]any{"to": token, "data": hexutil.Bytes(f.data(t, "balanceOf", account))}, "latest")
	return new(big.Int).SetBytes(raw)
}

func TestTransferStateOverrides(t *testing.T) {
	f := newChain(t)
	amount := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(123))
	f.tx(t, f.user, f.token, "mint", f.user, new(big.Int).Mul(amount, big.NewInt(2)))
	f.tx(t, f.user, f.token, "mint", f.recipient, big.NewInt(77))
	var beforeApproval hexutil.Big
	f.rpc(t, &beforeApproval, "eth_blockNumber")
	f.tx(t, f.user, f.token, "approve", f.recipient, amount)
	req := TransferRequest{Token: f.token, From: f.user, To: f.recipient, Amount: amount}
	for _, fee := range []int64{0, 250, 10000} {
		t.Run(big.NewInt(fee).String(), func(t *testing.T) {
			f.tx(t, f.user, f.token, "configure", big.NewInt(fee), f.recipient, false, false)
			got, err := SimulateTransfer(context.Background(), f.client, req)
			want := new(big.Int).Sub(amount, new(big.Int).Div(new(big.Int).Mul(amount, big.NewInt(fee)), big.NewInt(10000)))
			if err != nil || got.Cmp(want) != 0 {
				t.Fatalf("receipt: %v want %v err %v", got, want, err)
			}
			if f.balance(t, f.token, f.recipient).Cmp(big.NewInt(77)) != 0 {
				t.Fatal("simulation persisted recipient balance")
			}
			if f.balance(t, f.token, f.user).Cmp(new(big.Int).Mul(amount, big.NewInt(2))) != 0 {
				t.Fatal("simulation persisted sender balance")
			}
			var code hexutil.Bytes
			f.rpc(t, &code, "eth_getCode", f.recipient, "latest")
			if hexutil.Encode(code) != "0x00" {
				t.Fatal("simulation persisted code override")
			}
		})
	}
	req.Block = (*big.Int)(&beforeApproval)
	if _, err := SimulateTransfer(context.Background(), f.client, req); err == nil {
		t.Fatal("historical missing allowance accepted")
	}
	req.Block = nil
	req.Amount = new(big.Int).Mul(amount, big.NewInt(3))
	f.tx(t, f.user, f.token, "approve", f.recipient, req.Amount)
	if _, err := SimulateTransfer(context.Background(), f.client, req); err == nil {
		t.Fatal("insufficient balance accepted")
	}
	req.Amount = amount
	f.tx(t, f.user, f.token, "configure", new(big.Int), common.Address{}, true, false)
	if _, err := SimulateTransfer(context.Background(), f.client, req); err == nil {
		t.Fatal("false return accepted")
	}
	f.tx(t, f.user, f.token, "configure", big.NewInt(250), f.sender, false, false)
	got, err := SimulateTransfer(context.Background(), f.client, req)
	if err != nil || got.Cmp(amount) != 0 {
		t.Fatalf("recipient-specific fee: %v %v", got, err)
	}
}

func TestSwapStateOverrides(t *testing.T) {
	for _, alternate := range []bool{false, true} {
		for _, native := range []bool{false, true} {
			t.Run(strings.Join([]string{map[bool]string{false: "same", true: "alternate"}[alternate], map[bool]string{false: "token", true: "native"}[native]}, "/"), func(t *testing.T) {
				f := newChain(t)
				amount := big.NewInt(1000)
				f.tx(t, f.user, f.token, "mint", f.user, amount)
				sender := f.user
				if alternate {
					sender = f.sender
					f.tx(t, f.user, f.output, "mint", sender, big.NewInt(77))
				}
				// Nonzero existing allowance requires reset-before-approve.
				f.tx(t, sender, f.token, "approve", f.router, big.NewInt(1))
				f.tx(t, f.user, f.token, "configure", new(big.Int), common.Address{}, false, true)
				output := f.output
				method := "swap"
				args := []any{f.token, f.output, amount, f.recipient}
				if alternate {
					args[3] = sender
				}
				if native {
					output = common.Address{}
					method = "swapNative"
					args = []any{f.token, amount, args[3]}
				}
				data, err := f.routerABI.Pack(method, args...)
				if err != nil {
					t.Fatal(err)
				}
				req := SwapRequest{User: f.user, Sender: sender, Recipient: f.recipient, InputToken: f.token, OutputToken: output, Amount: amount, Target: f.router, Data: data}
				result, err := SimulateSwap(context.Background(), f.client, req)
				if err != nil || result.Deltas[0].Cmp(big.NewInt(2000)) != 0 {
					t.Fatalf("swap output: %v err=%v", result, err)
				}
				if len(result.Calls) == 0 || result.Calls[0].GasUsed.Sign() <= 0 {
					t.Fatal("missing per-call gas")
				}
				if f.balance(t, f.token, f.user).Cmp(amount) != 0 {
					t.Fatal("swap persisted balance")
				}
				req.Data = []byte{0x01}
				if _, err := SimulateSwap(context.Background(), f.client, req); err == nil {
					t.Fatal("swap revert accepted")
				}
			})
		}
	}
}

func TestSwapFeeHopsAndPreCalls(t *testing.T) {
	for _, alternate := range []bool{false, true} {
		f := newChain(t)
		sender := f.user
		if alternate {
			sender = f.sender
		}
		f.tx(t, f.user, f.output, "configure", big.NewInt(250), common.Address{}, false, false)
		data, err := f.routerABI.Pack("swap", f.token, f.output, big.NewInt(1000), sender)
		if err != nil {
			t.Fatal(err)
		}
		pre := Call{Target: f.token, Data: f.data(t, "mint", f.user, big.NewInt(1000))}
		req := SwapRequest{User: f.user, Sender: sender, InputToken: f.token, OutputToken: f.output, Amount: big.NewInt(1000), Target: f.router, Data: data, PreCalls: []Call{pre}}
		result, err := SimulateSwap(context.Background(), f.client, req)
		want := int64(1902) // 2000 -> 1950 -> 1902 through 2 taxed output hops.
		if alternate {
			want = 1950
		}
		if err != nil || result.Deltas[0].Cmp(big.NewInt(want)) != 0 {
			t.Fatalf("FOT output, alternate=%v: %v %v", alternate, result, err)
		}
		if f.balance(t, f.token, f.user).Sign() != 0 {
			t.Fatal("pre-call persisted")
		}
		zero := req
		zero.Amount = new(big.Int)
		zero.PreCalls = nil
		zero.Data, err = f.routerABI.Pack("swap", f.token, f.output, zero.Amount, sender)
		if err != nil {
			t.Fatal(err)
		}
		zeroResult, err := SimulateSwap(context.Background(), f.client, zero)
		if err != nil || zeroResult.Deltas[0].Sign() != 0 {
			t.Fatalf("zero swap: %v %v", zeroResult, err)
		}
		f.tx(t, f.user, f.token, "configure", big.NewInt(250), common.Address{}, false, false)
		if _, err := SimulateSwap(context.Background(), f.client, req); err == nil {
			t.Fatal("input FOT with insufficient post-hop amount must fail")
		}
	}
}

type recordingRPC struct {
	RPC
	block any
}

func (r *recordingRPC) CallContext(ctx context.Context, result any, method string, args ...any) error {
	if method == "eth_call" {
		r.block = args[1]
	}
	return r.RPC.CallContext(ctx, result, method, args...)
}

func TestGenericRequestBlockZeroAndNativeValue(t *testing.T) {
	f := newChain(t)
	recorder := &recordingRPC{RPC: f.client}
	_, err := Simulate(context.Background(), recorder, Request{Execution: f.user, Block: big.NewInt(0)})
	if err != nil || recorder.block != "0x0" {
		t.Fatalf("genesis block: %v %v", recorder.block, err)
	}
	result, err := Simulate(context.Background(), f.client, Request{
		Execution: f.user, From: f.sender, Value: big.NewInt(123),
		Calls:    []Call{{Target: f.recipient, Value: big.NewInt(123)}},
		Balances: []Balance{{Account: f.recipient}},
	})
	if err != nil || result.Deltas[0].Cmp(big.NewInt(123)) != 0 {
		t.Fatalf("native value call: %v %v", result, err)
	}
	_, err = Simulate(context.Background(), f.client, Request{Execution: f.user, Calls: []Call{{Target: f.recipient, Value: big.NewInt(123)}}})
	if err == nil {
		t.Fatal("value mismatch accepted")
	}
	result, err = Simulate(context.Background(), f.client, Request{
		Execution: f.user, Calls: []Call{{Target: f.token, Data: []byte{1}, AllowFailure: true}},
	})
	if err != nil || len(result.Calls) != 1 || result.Calls[0].Success {
		t.Fatalf("allowed revert: %v %v", result, err)
	}
}
