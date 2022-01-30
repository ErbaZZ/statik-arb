const Web3 = require('web3');
const BN = Web3.utils.BN;
const isBN = Web3.utils.isBN;

function hexDataSlice(data, offset, endOffset) {
    if (typeof (data) !== "string") {
        data = hexlify(data);
    }
    else if (!isHexString(data) || (data.length % 2)) {
        return null;
    }
    offset = 2 + 2 * offset;
    if (endOffset != null) {
        return "0x" + data.substring(offset, 2 + 2 * endOffset);
    }
    return "0x" + data.substring(offset);
}

export async function callGetReserves(contract) {
    return contract.methods.getReserves().call();
}

export async function callGetAmountsOut(routerContract, amountIn, path) {
    return routerContract.methods.getAmountsOut(amountIn, path).call();
}

export async function callGetAmountsIn(routerContract, amountOut, path) {
    return routerContract.methods.getAmountsIn(amountOut, path).call();
}

export function getPair(factoryAddress, factoryCodeHash, tokenAAddress, tokenBAddress) {
    let tokens = [tokenAAddress, tokenBAddress]
    tokens.sort();
    let salt = web3.utils.soliditySha3({type: 'bytes20', value: tokens[0]}, {type: 'bytes20', value: tokens[1]});
    let rawAddress = web3.utils.soliditySha3({type: 'bytes1', value: '0xff'}, {type: 'bytes20', value: factoryAddress}, {type: 'bytes32', value: salt}, {type: 'bytes32', value: factoryCodeHash});
    return hexDataSlice(rawAddress, 12);
}

export async function callGetPair(factoryContract, tokenAAddress, tokenBAddress) {
    return factoryContract.getPair(tokenAAddress, tokenBAddress);
}

export function getAmountOut(amountIn, fee, reserveIn, reserveOut) {
    if (!isBN(amountIn)) amountIn = new BN(amountIn);
    if (!isBN(fee)) fee = new BN(fee);
    if (!isBN(reserveIn)) reserveIn = new BN(reserveIn);
    if (!isBN(reserveOut)) reserveOut = new BN(reserveOut);

    let amountInWithFee = amountIn.mul(fee).div(new BN(10000))
    let numerator = amountInWithFee.mul(reserveOut);
    let denominator = reserveIn.add(amountInWithFee);
    return numerator.div(denominator);
}

// If path = A -> B -> C, reservesArray = [[resA, resB], [resB, resC]]
export function getAmountsOut(amountIn, fee, reservesArray) {
    const amounts = [];
    amounts[0] = amountIn;
    for (let i = 0; i < reservesArray.length; i++) {
        const reserveIn = reservesArray[i][0];
        const reserveOut = reservesArray[i][1];
        amounts.push(getAmountOut(amounts[i], fee, reserveIn, reserveOut));
    }
    return amounts;
}

export function getAmountIn(amountOut, fee, reserveIn, reserveOut) {
    if (!isBN(amountOut)) amountOut = new BN(amountOut);
    if (!isBN(fee)) amountIn = new BN(fee);
    if (!isBN(reserveIn)) amountIn = new BN(reserveIn);
    if (!isBN(reserveOut)) amountIn = new BN(reserveOut);
    
    let numerator = reserveIn.mul(amountOut).mul(new BN(10000));
    let denominator = reserveOut.sub(amountOut).mul(fee);
    return numerator.div(denominator).add(1);
}