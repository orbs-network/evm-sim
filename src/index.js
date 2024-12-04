module.exports = { simulateSwap };

/**
 * @param {{ web3: any; userAddress: string; inToken: string; outToken: string; inAmount: string; swapTarget: string; swapApprovalTarget: string; swapCallData: string; recipient?: string; extraTransfers?: number}} params
 */
async function simulateSwap(params) {
    let {
        web3,
        userAddress,
        inToken,
        outToken,
        inAmount,
        swapTarget,
        swapApprovalTarget,
        swapCallData,
        recipient,
        extraTransfers,
        blockNumber
    } = params;
    swapApprovalTarget = swapApprovalTarget || swapTarget;
    recipient = recipient || userAddress;
    extraTransfers = extraTransfers || 0;

    try {
        if (!web3) throw new Error("missing web3")
        if (!userAddress) throw new Error("missing userAddress")
        if (!inToken) throw new Error("missing inToken")
        if (!outToken) throw new Error("missing outToken")
        if (!inAmount) throw new Error("missing inAmount")
        if (!swapTarget) throw new Error("missing swapTarget")
        if (!swapApprovalTarget) throw new Error("missing swapApprovalTarget")
        if (!swapCallData) throw new Error("missing swapCallData")
        if (!recipient) throw new Error("missing recipient")
        if (extraTransfers % 2 !== 0) throw new Error("extraTransfers must be even")

        web3.eth.extend({
            methods: [
                {
                    name: "callWithState",
                    call: "eth_call",
                    params: 3,
                },
            ],
        });

        const calls = [balanceOf(web3, outToken, recipient)];

        if (isUSDT(inToken)) calls.push(approve(web3, inToken, swapApprovalTarget, 0));

        calls.push(approve(web3, inToken, swapApprovalTarget, inAmount));

        for (let i = 0; i < extraTransfers; i += 2) {
            calls.push(transferAll(web3, userAddress, inToken, mc2));
            calls.push(transferAll(web3, mc2, inToken, userAddress));
        }

        calls.push({ target: swapTarget, callData: swapCallData, value: 0, allowFailure: false });

        for (let i = 0; i < extraTransfers; i += 2) {
            calls.push(transferAll(web3, recipient, outToken, mc2));
            calls.push(transferAll(web3, mc2, outToken, recipient));
        }

        calls.push(balanceOf(web3, outToken, recipient));

        const result = await web3.eth.callWithState(
            {
                to: userAddress,
                data: web3.eth.abi.encodeFunctionCall(MULTISPY_ABI, [calls]),
            },
            blockNumber ? web3.eth.abi.encodeParameter("uint256", blockNumber) : "latest",
            {
                [mc]: { code: MULTISPY_BYTECODE },
                [mc2]: { code: MULTISPY_BYTECODE },
                [userAddress]: { code: MULTISPY_BYTECODE },
                [recipient]: { code: MULTISPY_BYTECODE },
            }
        );
        const results = web3.eth.abi.decodeParameters(MULTISPY_ABI.outputs, result).returnData;

        const gasCost = results.reduce((acc, r) => acc + BigInt(r?.gasCost || 0), BigInt(0));
        const startBalance = web3.eth.abi.decodeParameter("uint256", results[0].returnData);
        const endBalance = web3.eth.abi.decodeParameter("uint256", results[calls.length - 1].returnData);
        const outAmount = BigInt(endBalance) - BigInt(startBalance);
        if (outAmount <= 0) throw new Error("invalid output amount");

        return { success: true, outAmount: outAmount.toString(), gasCost: gasCost.toString(), raw: results };
    } catch (e) {
        return { success: false, error: e.message, outAmount: "0", gasCost: "0", raw: "" };
    }
}

const approve = (web3, token, spender, amount) => ({
    value: 0,
    allowFailure: false,
    target: token,
    callData: web3.eth.abi.encodeFunctionCall(
        {
            name: "approve",
            type: "function",
            inputs: [
                {
                    type: "address",
                    name: "spender",
                },
                {
                    type: "uint256",
                    name: "amount",
                },
            ],
        },
        [spender, amount]
    ),
});

const transferAll = (web3, sender, token, recipient) => ({
    value: 0,
    allowFailure: false,
    target: sender,
    callData: web3.eth.abi.encodeFunctionCall(
        {
            name: "transferAll",
            type: "function",
            inputs: [
                {
                    type: "address",
                    name: "token",
                },
                {
                    type: "address",
                    name: "recipient",
                },
            ],
        },
        [token, recipient]
    ),
});

const balanceOf = (web3, token, target) =>
    isNativeAddress(token)
        ? {
            value: 0,
            allowFailure: false,
            target: mc,
            callData: web3.eth.abi.encodeFunctionCall(
                {
                    name: "getEthBalance",
                    type: "function",
                    inputs: [
                        {
                            type: "address",
                            name: "account",
                        },
                    ],
                },
                [target]
            ),
        }
        : {
            value: 0,
            allowFailure: false,
            target: token,
            callData: web3.eth.abi.encodeFunctionCall(
                {
                    name: "balanceOf",
                    type: "function",
                    inputs: [
                        {
                            type: "address",
                            name: "account",
                        },
                    ],
                },
                [target]
            ),
        };

const nativeTokenAddresses = [
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000001010",
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "0x000000000000000000000000000000000000dEaD",
    "0x000000000000000000000000000000000000800A",
];

const mc = "0x0000000000000000000000000000000012341234";
const mc2 = "0x0000000000000000000000000000000012341235";

const isNativeAddress = (address) =>
    !!nativeTokenAddresses.find((a) => eqAddress(a, address));

const isUSDT = (address) => eqAddress(address, "0xdAC17F958D2ee523a2206206994597C13D831ec7");

const eqAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

const MULTISPY_ABI = {"type":"function","name":"aggregate3Value","inputs":[{"name":"calls","type":"tuple[]","internalType":"struct MultiSpy.Call3Value[]","components":[{"name":"target","type":"address","internalType":"address"},{"name":"allowFailure","type":"bool","internalType":"bool"},{"name":"value","type":"uint256","internalType":"uint256"},{"name":"callData","type":"bytes","internalType":"bytes"}]}],"outputs":[{"name":"returnData","type":"tuple[]","internalType":"struct MultiSpy.Result[]","components":[{"name":"success","type":"bool","internalType":"bool"},{"name":"returnData","type":"bytes","internalType":"bytes"},{"name":"gasCost","type":"uint256","internalType":"uint256"}]}],"stateMutability":"payable"};
const MULTISPY_BYTECODE = "0x60806040526004361061009a5760003560e01c806342cbb15c1161006157806342cbb15c146101235780634b14e003146101365780634d2301cc1461015657806386d516e81461017e578063a8b0574e14610191578063ee82ac5e146101ac57005b80630f28c97d146100a3578063174dea71146100c557806327e86d6e146100e55780633408e470146100fd5780633e64a6961461011057005b366100a157005b005b3480156100af57600080fd5b50425b6040519081526020015b60405180910390f35b6100d86100d33660046104a3565b6101cb565b6040516100bc9190610518565b3480156100f157600080fd5b504360001901406100b2565b34801561010957600080fd5b50466100b2565b34801561011c57600080fd5b50486100b2565b34801561012f57600080fd5b50436100b2565b34801561014257600080fd5b506100a16101513660046105eb565b6103e7565b34801561016257600080fd5b506100b261017136600461061e565b6001600160a01b03163190565b34801561018a57600080fd5b50456100b2565b34801561019d57600080fd5b506040514181526020016100bc565b3480156101b857600080fd5b506100b26101c7366004610640565b4090565b60606000828067ffffffffffffffff8111156101e9576101e9610659565b60405190808252806020026020018201604052801561024057816020015b61022d604051806060016040528060001515815260200160608152602001600081525090565b8152602001906001900390816102075790505b5092503660005b8281101561038a5760008582815181106102635761026361066f565b6020026020010151905087878381811061027f5761027f61066f565b90506020028101906102919190610685565b6040810135958601959093505a60408301526102b0602085018561061e565b6001600160a01b0316816102c760608701876106a5565b6040516102d59291906106f3565b60006040518083038185875af1925050503d8060008114610312576040519150601f19603f3d011682016040523d82523d6000602084013e610317565b606091505b506020840152151582525a826040018181516103339190610703565b90525081516020850135176103805762461bcd60e51b600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260846000fd5b5050600101610247565b508234146103de5760405162461bcd60e51b815260206004820152601a60248201527f4d756c746963616c6c333a2076616c7565206d69736d61746368000000000000604482015260640160405180910390fd5b50505092915050565b6001600160a01b03821661042f576040516001600160a01b038216904780156108fc02916000818181858888f1935050505015801561042a573d6000803e3d6000fd5b505050565b60405163a9059cbb60e01b81526001600160a01b0382811660048301526103e8602483015283169063a9059cbb906044016020604051808303816000875af115801561047f573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061042a919061072a565b600080602083850312156104b657600080fd5b823567ffffffffffffffff808211156104ce57600080fd5b818501915085601f8301126104e257600080fd5b8135818111156104f157600080fd5b8660208260051b850101111561050657600080fd5b60209290920196919550909350505050565b60006020808301818452808551808352604092508286019150828160051b8701018488016000805b848110156105c057603f198a85030186528251606081511515865289820151818b880152805180838901528592505b8083101561058d578183018c015188840160800152918b019161056f565b8781016080908101879052938b01518b890152988b0198601f01601f191690960190910194505091870191600101610540565b50919998505050505050505050565b80356001600160a01b03811681146105e657600080fd5b919050565b600080604083850312156105fe57600080fd5b610607836105cf565b9150610615602084016105cf565b90509250929050565b60006020828403121561063057600080fd5b610639826105cf565b9392505050565b60006020828403121561065257600080fd5b5035919050565b634e487b7160e01b600052604160045260246000fd5b634e487b7160e01b600052603260045260246000fd5b60008235607e1983360301811261069b57600080fd5b9190910192915050565b6000808335601e198436030181126106bc57600080fd5b83018035915067ffffffffffffffff8211156106d757600080fd5b6020019150368190038213156106ec57600080fd5b9250929050565b8183823760009101908152919050565b8181038181111561072457634e487b7160e01b600052601160045260246000fd5b92915050565b60006020828403121561073c57600080fd5b8151801515811461063957600080fdfea26469706673582212204f979614e142efbd0a33113bc7d3f9410dd646ff1d21060f575a6c1066da575e64736f6c63430008130033";

