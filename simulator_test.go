package simulator

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

type failingRPC struct {
	err   error
	calls int
}

func (r *failingRPC) CallContext(ctx context.Context, result any, method string, args ...any) error {
	r.calls++
	if err := ctx.Err(); err != nil {
		return err
	}
	return r.err
}

func TestTransferZeroAndExplicitFailures(t *testing.T) {
	rpc := &failingRPC{err: errors.New("state overrides unsupported")}
	req := TransferRequest{Token: common.HexToAddress("0x1"), From: common.HexToAddress("0x2"), To: common.HexToAddress("0x3"), Amount: new(big.Int)}
	got, err := SimulateTransfer(context.Background(), rpc, req)
	if err != nil || got.Sign() != 0 || rpc.calls != 0 {
		t.Fatalf("zero transfer: %v %v calls=%d", got, err, rpc.calls)
	}
	req.Amount = big.NewInt(42)
	got, err = SimulateTransfer(context.Background(), rpc, req)
	if !errors.Is(err, rpc.err) || got != nil {
		t.Fatalf("engine must return explicit error: %v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = SimulateTransfer(ctx, rpc, req)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestInvalidAmountsAndClients(t *testing.T) {
	for _, amount := range []*big.Int{nil, big.NewInt(-1), new(big.Int).Lsh(big.NewInt(1), 256)} {
		_, err := SimulateTransfer(context.Background(), nil, TransferRequest{Amount: amount})
		if err == nil {
			t.Fatalf("invalid amount accepted: %v", amount)
		}
	}
	_, err := Simulate(context.Background(), nil, Request{Execution: common.HexToAddress("0x1")})
	if err == nil {
		t.Fatal("nil client accepted")
	}
}

func TestTransferRejectsNativeTokenWithoutRPC(t *testing.T) {
	client := &failingRPC{err: errors.New("unexpected RPC")}
	_, err := SimulateTransfer(context.Background(), client, TransferRequest{From: common.HexToAddress("0x2"), To: common.HexToAddress("0x3"), Amount: big.NewInt(42)})
	if err == nil || client.calls != 0 {
		t.Fatalf("native transfer accepted: %v calls=%d", err, client.calls)
	}
}
