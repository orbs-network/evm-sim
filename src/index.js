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
        preSwapCalls,
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
        if (preswapCalls) calls.push(...preSwapCalls);

        if (sender != userAddress) {
            calls.push(transferAll(web3, userAddress, inToken, sender));
            calls.push({ target: sender, callData: web3.eth.abi.encodeFunctionCall(MULTISPY_ABI, [[

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
                [sender]: { code: MULTISPY_BYTECODE },
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
const MULTISPY_BYTECODE = "0x6080604052600436106100a05760003560e01c806342cbb15c1161006457806342cbb15c146101855780634b14e003146101b05780634d2301cc146101d957806386d516e814610216578063a8b0574e14610241578063ee82ac5e1461026c576100a7565b80630f28c97d146100a9578063174dea71146100d457806327e86d6e146101045780633408e4701461012f5780633e64a6961461015a576100a7565b366100a757005b005b3480156100b557600080fd5b506100be6102a9565b6040516100cb91906106f9565b60405180910390f35b6100ee60048036038101906100e99190610783565b6102b1565b6040516100fb919061099c565b60405180910390f35b34801561011057600080fd5b506101196104f2565b60405161012691906109d7565b60405180910390f35b34801561013b57600080fd5b506101446104fe565b60405161015191906106f9565b60405180910390f35b34801561016657600080fd5b5061016f610506565b60405161017c91906106f9565b60405180910390f35b34801561019157600080fd5b5061019a61050e565b6040516101a791906106f9565b60405180910390f35b3480156101bc57600080fd5b506101d760048036038101906101d29190610a50565b610516565b005b3480156101e557600080fd5b5061020060048036038101906101fb9190610a90565b610681565b60405161020d91906106f9565b60405180910390f35b34801561022257600080fd5b5061022b6106a2565b60405161023891906106f9565b60405180910390f35b34801561024d57600080fd5b506102566106aa565b6040516102639190610acc565b60405180910390f35b34801561027857600080fd5b50610293600480360381019061028e9190610b13565b6106b2565b6040516102a091906109d7565b60405180910390f35b600042905090565b60606000808484905090508067ffffffffffffffff8111156102d6576102d5610b40565b5b60405190808252806020026020018201604052801561030f57816020015b6102fc6106bd565b8152602001906001900390816102f45790505b5092503660005b828110156104a657600085828151811061033357610332610b6f565b5b602002602001015190508787838181106103505761034f610b6f565b5b90506020028101906103629190610bad565b925060008360400135905080860195505a82604001818152505083600001602081019061038f9190610a90565b73ffffffffffffffffffffffffffffffffffffffff16818580606001906103b69190610bd5565b6040516103c4929190610c77565b60006040518083038185875af1925050503d8060008114610401576040519150601f19603f3d011682016040523d82523d6000602084013e610406565b606091505b508360000184602001829052821515151581525050505a8260400181815161042e9190610cbf565b915081815250508151602085013517610499577f08c379a000000000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260846000fd5b8260010192505050610316565b508234146104e9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016104e090610d50565b60405180910390fd5b50505092915050565b60006001430340905090565b600046905090565b600048905090565b600043905090565b600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1603610596578073ffffffffffffffffffffffffffffffffffffffff166108fc479081150290604051600060405180830381858888f19350505050158015610590573d6000803e3d6000fd5b5061067d565b8173ffffffffffffffffffffffffffffffffffffffff1663a9059cbb828473ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016105ec9190610acc565b602060405180830381865afa158015610609573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061062d9190610d85565b6040518363ffffffff1660e01b815260040161064a929190610db2565b600060405180830381600087803b15801561066457600080fd5b505af1158015610678573d6000803e3d6000fd5b505050505b5050565b60008173ffffffffffffffffffffffffffffffffffffffff16319050919050565b600045905090565b600041905090565b600081409050919050565b604051806060016040528060001515815260200160608152602001600081525090565b6000819050919050565b6106f3816106e0565b82525050565b600060208201905061070e60008301846106ea565b92915050565b600080fd5b600080fd5b600080fd5b600080fd5b600080fd5b60008083601f8401126107435761074261071e565b5b8235905067ffffffffffffffff8111156107605761075f610723565b5b60208301915083602082028301111561077c5761077b610728565b5b9250929050565b6000806020838503121561079a57610799610714565b5b600083013567ffffffffffffffff8111156107b8576107b7610719565b5b6107c48582860161072d565b92509250509250929050565b600081519050919050565b600082825260208201905092915050565b6000819050602082019050919050565b60008115159050919050565b610811816107fc565b82525050565b600081519050919050565b600082825260208201905092915050565b60005b83811015610851578082015181840152602081019050610836565b60008484015250505050565b6000601f19601f8301169050919050565b600061087982610817565b6108838185610822565b9350610893818560208601610833565b61089c8161085d565b840191505092915050565b6108b0816106e0565b82525050565b60006060830160008301516108ce6000860182610808565b50602083015184820360208601526108e6828261086e565b91505060408301516108fb60408601826108a7565b508091505092915050565b600061091283836108b6565b905092915050565b6000602082019050919050565b6000610932826107d0565b61093c81856107db565b93508360208202850161094e856107ec565b8060005b8581101561098a578484038952815161096b8582610906565b94506109768361091a565b925060208a01995050600181019050610952565b50829750879550505050505092915050565b600060208201905081810360008301526109b68184610927565b905092915050565b6000819050919050565b6109d1816109be565b82525050565b60006020820190506109ec60008301846109c8565b92915050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000610a1d826109f2565b9050919050565b610a2d81610a12565b8114610a3857600080fd5b50565b600081359050610a4a81610a24565b92915050565b60008060408385031215610a6757610a66610714565b5b6000610a7585828601610a3b565b9250506020610a8685828601610a3b565b9150509250929050565b600060208284031215610aa657610aa5610714565b5b6000610ab484828501610a3b565b91505092915050565b610ac681610a12565b82525050565b6000602082019050610ae16000830184610abd565b92915050565b610af0816106e0565b8114610afb57600080fd5b50565b600081359050610b0d81610ae7565b92915050565b600060208284031215610b2957610b28610714565b5b6000610b3784828501610afe565b91505092915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600080fd5b600080fd5b600080fd5b600082356001608003833603038112610bc957610bc8610b9e565b5b80830191505092915050565b60008083356001602003843603038112610bf257610bf1610b9e565b5b80840192508235915067ffffffffffffffff821115610c1457610c13610ba3565b5b602083019250600182023603831315610c3057610c2f610ba8565b5b509250929050565b600081905092915050565b82818337600083830152505050565b6000610c5e8385610c38565b9350610c6b838584610c43565b82840190509392505050565b6000610c84828486610c52565b91508190509392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b6000610cca826106e0565b9150610cd5836106e0565b9250828203905081811115610ced57610cec610c90565b5b92915050565b600082825260208201905092915050565b7f4d756c746963616c6c333a2076616c7565206d69736d61746368000000000000600082015250565b6000610d3a601a83610cf3565b9150610d4582610d04565b602082019050919050565b60006020820190508181036000830152610d6981610d2d565b9050919050565b600081519050610d7f81610ae7565b92915050565b600060208284031215610d9b57610d9a610714565b5b6000610da984828501610d70565b91505092915050565b6000604082019050610dc76000830185610abd565b610dd460208301846106ea565b939250505056fea26469706673582212205abf1e0d082f04fb25c3c5cc1c14f734e382199cccbe2fba9c04b60e4246ed8464736f6c63430008180033";

