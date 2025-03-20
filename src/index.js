module.exports = { simulateSwap };

/**
 * @param {{ web3: any; userAddress: string; inToken: string; outToken: string; inAmount: string; swapTarget: string; swapApprovalTarget: string; swapCallData: string; recipient?: string; sender?: string;}} params
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
        blockNumber,
        gasPrice,
        sender
    } = params;
    swapApprovalTarget = swapApprovalTarget || swapTarget;
    recipient = recipient || userAddress;
    outToken = isNativeAddress(outToken) ? nativeTokenAddresses[0] : outToken;
    sender = sender || userAddress;

    try {
        if (!web3) throw new Error("missing web3")
        if (!userAddress) throw new Error("missing userAddress")
        if (!inToken) throw new Error("missing inToken")
        if (!outToken) throw new Error("missing outToken")
        if (!inAmount) throw new Error("missing inAmount")
        if (!swapTarget) throw new Error("missing swapTarget")
        if (!swapCallData) throw new Error("missing swapCallData")
        if (!recipient) throw new Error("missing recipient")

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

        if (sender != userAddress) {
            calls.push(transferAll(web3, userAddress, inToken, sender));
            calls.push({ target: sender, calldata: web3.eth.abi.encodeFunctionCall(MULTISPY_ABI, [[

                approve(web3, inToken, swapApprovalTarget, 0),
                approve(web3, inToken, swapApprovalTarget, inAmount),
                { target: swapTarget, callData: swapCallData, value: 0, allowFailure: false },
                transferAll(web3, sender, outToken, recipient)

            ]]), value:0, allowFailure: false });
        } else {
            calls.push(transferAll(web3, sender, inToken, mc));
            calls.push(transferAll(web3, mc, inToken, sender));
            calls.push(approve(web3, inToken, swapApprovalTarget, 0));
            calls.push(approve(web3, inToken, swapApprovalTarget, inAmount));
            calls.push({ target: swapTarget, callData: swapCallData, value: 0, allowFailure: false });
            calls.push(transferAll(web3, recipient, outToken, mc));
            calls.push(transferAll(web3, mc, outToken, recipient));
        }

        calls.push(balanceOf(web3, outToken, recipient));

        const result = await web3.eth.callWithState(
            {
                to: userAddress,
                data: web3.eth.abi.encodeFunctionCall(MULTISPY_ABI, [calls]),
                gasPrice: gasPrice ? web3.utils.toHex(gasPrice) : undefined,
            },
            blockNumber ? web3.eth.abi.encodeParameter("uint256", blockNumber) : "latest",
            {
                [mc]: { code: MULTISPY_BYTECODE },
                [userAddress]: { code: MULTISPY_BYTECODE },
                [sender]: { code: MULTISPY_BYTECODE }
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

const isNativeAddress = (address) =>
    !!nativeTokenAddresses.find((a) => eqAddress(a, address));

const eqAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

const MULTISPY_ABI = {"type":"function","name":"aggregate3Value","inputs":[{"name":"calls","type":"tuple[]","internalType":"struct MultiSpy.Call3Value[]","components":[{"name":"target","type":"address","internalType":"address"},{"name":"allowFailure","type":"bool","internalType":"bool"},{"name":"value","type":"uint256","internalType":"uint256"},{"name":"callData","type":"bytes","internalType":"bytes"}]}],"outputs":[{"name":"returnData","type":"tuple[]","internalType":"struct MultiSpy.Result[]","components":[{"name":"success","type":"bool","internalType":"bool"},{"name":"returnData","type":"bytes","internalType":"bytes"},{"name":"gasCost","type":"uint256","internalType":"uint256"}]}],"stateMutability":"payable"};
const MULTISPY_BYTECODE = "0x60806040526004361061009f575f3560e01c806342cbb15c1161006357806342cbb15c146101805780634b14e003146101aa5780634d2301cc146101d257806386d516e81461020e578063a8b0574e14610238578063ee82ac5e14610262576100a6565b80630f28c97d146100a8578063174dea71146100d257806327e86d6e146101025780633408e4701461012c5780633e64a69614610156576100a6565b366100a657005b005b3480156100b3575f80fd5b506100bc61029e565b6040516100c991906106cc565b60405180910390f35b6100ec60048036038101906100e7919061074e565b6102a5565b6040516100f99190610954565b60405180910390f35b34801561010d575f80fd5b506101166104db565b604051610123919061098c565b60405180910390f35b348015610137575f80fd5b506101406104e6565b60405161014d91906106cc565b60405180910390f35b348015610161575f80fd5b5061016a6104ed565b60405161017791906106cc565b60405180910390f35b34801561018b575f80fd5b506101946104f4565b6040516101a191906106cc565b60405180910390f35b3480156101b5575f80fd5b506101d060048036038101906101cb91906109ff565b6104fb565b005b3480156101dd575f80fd5b506101f860048036038101906101f39190610a3d565b61065b565b60405161020591906106cc565b60405180910390f35b348015610219575f80fd5b5061022261067b565b60405161022f91906106cc565b60405180910390f35b348015610243575f80fd5b5061024c610682565b6040516102599190610a77565b60405180910390f35b34801561026d575f80fd5b5061028860048036038101906102839190610aba565b610689565b604051610295919061098c565b60405180910390f35b5f42905090565b60605f808484905090508067ffffffffffffffff8111156102c9576102c8610ae5565b5b60405190808252806020026020018201604052801561030257816020015b6102ef610693565b8152602001906001900390816102e75790505b509250365f5b8281101561048f575f85828151811061032457610323610b12565b5b6020026020010151905087878381811061034157610340610b12565b5b90506020028101906103539190610b4b565b92505f8360400135905080860195505a826040018181525050835f01602081019061037e9190610a3d565b73ffffffffffffffffffffffffffffffffffffffff16818580606001906103a59190610b72565b6040516103b3929190610c10565b5f6040518083038185875af1925050503d805f81146103ed576040519150601f19603f3d011682016040523d82523d5f602084013e6103f2565b606091505b50835f0184602001829052821515151581525050505a826040018181516104199190610c55565b915081815250508151602085013517610482577f08c379a0000000000000000000000000000000000000000000000000000000005f52602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260845ffd5b8260010192505050610308565b508234146104d2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016104c990610ce2565b60405180910390fd5b50505092915050565b5f6001430340905090565b5f46905090565b5f48905090565b5f43905090565b5f73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1603610577578073ffffffffffffffffffffffffffffffffffffffff166108fc4790811502906040515f60405180830381858888f19350505050158015610571573d5f803e3d5ffd5b50610657565b8173ffffffffffffffffffffffffffffffffffffffff1663a9059cbb828473ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016105cd9190610a77565b602060405180830381865afa1580156105e8573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061060c9190610d14565b6040518363ffffffff1660e01b8152600401610629929190610d3f565b5f604051808303815f87803b158015610640575f80fd5b505af1158015610652573d5f803e3d5ffd5b505050505b5050565b5f8173ffffffffffffffffffffffffffffffffffffffff16319050919050565b5f45905090565b5f41905090565b5f81409050919050565b60405180606001604052805f15158152602001606081526020015f81525090565b5f819050919050565b6106c6816106b4565b82525050565b5f6020820190506106df5f8301846106bd565b92915050565b5f80fd5b5f80fd5b5f80fd5b5f80fd5b5f80fd5b5f8083601f84011261070e5761070d6106ed565b5b8235905067ffffffffffffffff81111561072b5761072a6106f1565b5b602083019150836020820283011115610747576107466106f5565b5b9250929050565b5f8060208385031215610764576107636106e5565b5b5f83013567ffffffffffffffff811115610781576107806106e9565b5b61078d858286016106f9565b92509250509250929050565b5f81519050919050565b5f82825260208201905092915050565b5f819050602082019050919050565b5f8115159050919050565b6107d6816107c2565b82525050565b5f81519050919050565b5f82825260208201905092915050565b5f5b838110156108135780820151818401526020810190506107f8565b5f8484015250505050565b5f601f19601f8301169050919050565b5f610838826107dc565b61084281856107e6565b93506108528185602086016107f6565b61085b8161081e565b840191505092915050565b61086f816106b4565b82525050565b5f606083015f83015161088a5f8601826107cd565b50602083015184820360208601526108a2828261082e565b91505060408301516108b76040860182610866565b508091505092915050565b5f6108cd8383610875565b905092915050565b5f602082019050919050565b5f6108eb82610799565b6108f581856107a3565b935083602082028501610907856107b3565b805f5b85811015610942578484038952815161092385826108c2565b945061092e836108d5565b925060208a0199505060018101905061090a565b50829750879550505050505092915050565b5f6020820190508181035f83015261096c81846108e1565b905092915050565b5f819050919050565b61098681610974565b82525050565b5f60208201905061099f5f83018461097d565b92915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6109ce826109a5565b9050919050565b6109de816109c4565b81146109e8575f80fd5b50565b5f813590506109f9816109d5565b92915050565b5f8060408385031215610a1557610a146106e5565b5b5f610a22858286016109eb565b9250506020610a33858286016109eb565b9150509250929050565b5f60208284031215610a5257610a516106e5565b5b5f610a5f848285016109eb565b91505092915050565b610a71816109c4565b82525050565b5f602082019050610a8a5f830184610a68565b92915050565b610a99816106b4565b8114610aa3575f80fd5b50565b5f81359050610ab481610a90565b92915050565b5f60208284031215610acf57610ace6106e5565b5b5f610adc84828501610aa6565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b5f80fd5b5f80fd5b5f80fd5b5f82356001608003833603038112610b6657610b65610b3f565b5b80830191505092915050565b5f8083356001602003843603038112610b8e57610b8d610b3f565b5b80840192508235915067ffffffffffffffff821115610bb057610baf610b43565b5b602083019250600182023603831315610bcc57610bcb610b47565b5b509250929050565b5f81905092915050565b828183375f83830152505050565b5f610bf78385610bd4565b9350610c04838584610bde565b82840190509392505050565b5f610c1c828486610bec565b91508190509392505050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f610c5f826106b4565b9150610c6a836106b4565b9250828203905081811115610c8257610c81610c28565b5b92915050565b5f82825260208201905092915050565b7f4d756c746963616c6c333a2076616c7565206d69736d617463680000000000005f82015250565b5f610ccc601a83610c88565b9150610cd782610c98565b602082019050919050565b5f6020820190508181035f830152610cf981610cc0565b9050919050565b5f81519050610d0e81610a90565b92915050565b5f60208284031215610d2957610d286106e5565b5b5f610d3684828501610d00565b91505092915050565b5f604082019050610d525f830185610a68565b610d5f60208301846106bd565b939250505056fea26469706673582212200db7af021c8c81ff6ae67f48d805ed66650fc2f388b27e3e4b1f53f9a984c64864736f6c63430008180033";

