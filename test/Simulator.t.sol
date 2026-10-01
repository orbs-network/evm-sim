// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Simulator} from "../src/Simulator.sol";

interface Vm {
    function etch(address, bytes calldata) external;
    function deal(address, uint256) external;
}

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps;
    address public taxedRecipient;
    bool public returnsFalse;
    bool public resetRequired;

    function configure(uint256 fee, address recipient, bool fail, bool reset) external {
        feeBps = fee;
        taxedRecipient = recipient;
        returnsFalse = fail;
        resetRequired = reset;
    }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(!resetRequired || amount == 0 || allowance[msg.sender][spender] == 0, "reset approval");
        allowance[msg.sender][spender] = amount;
        return !returnsFalse;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 fee = taxedRecipient == address(0) || taxedRecipient == to ? amount * feeBps / 10000 : 0;
        balanceOf[to] += amount - fee;
        return !returnsFalse;
    }
}

contract Router {
    function swap(Token input, Token output, uint256 amount, address recipient) external {
        require(input.transferFrom(msg.sender, address(this), amount), "input failed");
        output.mint(recipient, amount * 2);
    }

    function swapNative(Token input, uint256 amount, address recipient) external {
        require(input.transferFrom(msg.sender, address(this), amount), "input failed");
        (bool ok,) = recipient.call{value: amount * 2}("");
        require(ok, "native failed");
    }

    receive() external payable {}
}

contract SimulatorTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testTransferUsesExistingAllowanceAndReturnsBalanceSnapshots() external {
        Simulator simulator = new Simulator();
        Token token = new Token();
        token.mint(address(this), 1000);
        token.mint(address(simulator), 77);
        token.configure(250, address(0), false, false);
        token.approve(address(simulator), 1000);
        Simulator.Call[] memory calls = new Simulator.Call[](1);
        calls[0] = Simulator.Call(address(token), false, true, 0,
            abi.encodeCall(token.transferFrom, (address(this), address(simulator), 1000)));
        Simulator.Balance[] memory balances = new Simulator.Balance[](1);
        balances[0] = Simulator.Balance(address(token), address(simulator));
        (uint256[] memory before_, uint256[] memory after_, Simulator.Result[] memory results) = simulator.simulate(calls, balances);
        require(before_[0] == 77 && after_[0] == 1052, "FOT delta");
        require(results[0].success && results[0].gasUsed > 0, "call result");
        (bool ok,) = address(simulator).call(abi.encodeCall(simulator.simulate, (calls, balances)));
        require(!ok, "existing allowance required");
    }

    function testFalseTokenReturnRevertsAndAllowedFailureIsReported() external {
        Simulator simulator = new Simulator();
        Token token = new Token();
        token.configure(0, address(0), true, false);
        Simulator.Call[] memory calls = new Simulator.Call[](1);
        calls[0] = Simulator.Call(address(token), false, true, 0, abi.encodeCall(token.approve, (address(1), 0)));
        Simulator.Balance[] memory balances = new Simulator.Balance[](0);
        (bool ok,) = address(simulator).call(abi.encodeCall(simulator.simulate, (calls, balances)));
        require(!ok, "false token return must fail");
        calls[0].allowFailure = true;
        (,, Simulator.Result[] memory results) = simulator.simulate(calls, balances);
        require(!results[0].success, "allowed failure must be visible");
    }

    function testNativeTransferAllAcceptsContractRecipient() external {
        Simulator simulator = new Simulator();
        Router recipient = new Router();
        vm.deal(address(simulator), 123);
        simulator.transferAll(address(0), address(recipient));
        require(address(recipient).balance == 123 && address(simulator).balance == 0, "native transfer");
    }
}
