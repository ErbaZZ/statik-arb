require('dotenv').config();

import Web3 from 'web3';
import axios from 'axios';
import chalk from 'chalk';
import ERC20 from './abi/ERC20.json';
import Pair from './abi/Pair.json';
import StatikMaster from './abi/StatikMaster.json';
import Router from './abi/Router.json';
import ContractAddress from './ContractAddress.json';
import StatikArb from './abi/StatikArb.json';

import { getAmountOut, getAmountsOut } from './modules/price_helper.js';

// ====== ENV ======

const RPC_URL = process.env.RPC_URL;
const HTTP_RPC_URL = process.env.HTTP_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const GAS_BASE = process.env.GAS_BASE;
const GAS_LIMIT = process.env.GAS_LIMIT;
const LINE_NOTI_TOKEN = process.env.LINE_NOTI_TOKEN;
const CLAIM = process.env.CLAIM;

// ==== Notifications ====

const LINE_NOTI_CONFIG = { headers: { Authorization: `Bearer ${LINE_NOTI_TOKEN}` } };
const LINE_NOTI_URL = 'https://notify-api.line.me/api/notify';

// ====== CONSTANTS ======

const BN = Web3.utils.BN;

// ====== CONNECTION ======

const options = {
    clientConfig: {
        keepalive: true,
        keepaliveInterval: 60000,
        maxReceivedFrameSize: 2000000, // bytes - default: 1MiB, current: 2MiB
        maxReceivedMessageSize: 10000000, // bytes - default: 8MiB, current: 10Mib
    },
    reconnect: {
        auto: true,
        delay: 12000,
        onTimeout: true,
        maxAttempts: 10
    }
}

const provider = new Web3.providers.WebsocketProvider(RPC_URL, options);
const httpProvider = new Web3.providers.HttpProvider(HTTP_RPC_URL, options);

const web3 = new Web3(provider);
const web3Http = new Web3(httpProvider);

// const httpProvider = new Web3.providers.HttpProvider(HTTP_RPC_URL);
// const httpweb3 = new Web3(httpProvider);

const account = web3.eth.accounts.wallet.add(PRIVATE_KEY);
provider.on('connect', () => {
    console.log("Connected!");
});
provider.on('error', err => {
    console.log(`WSS Error: ${err.message}`);
});
provider.on('end', async (err) => {
    console.log(`WSS Connection Stopped!`);
});

// ====== CONTRACTS ======

const statikMaster = new web3.eth.Contract(StatikMaster, ContractAddress["StatikMaster"]);
const statikusdcPair = new web3.eth.Contract(Pair, ContractAddress["STATIKUSDCLP"]);
const usdcthoPair = new web3.eth.Contract(Pair, ContractAddress["USDCTHOLP"]);
const usdc = new web3.eth.Contract(ERC20, ContractAddress["USDC"]);
const statik = new web3.eth.Contract(ERC20, ContractAddress["STATIK"]);
const tho = new web3.eth.Contract(ERC20, ContractAddress["THO"]);
const statikArb = new web3.eth.Contract(StatikArb, ContractAddress["StatikArb"]);

// ====== VARIABLES ======

let currentBlock = 0;
let isTransactionOngoing = false;
let fetching = false;
let lastProfit;

// ====== FUNCTIONS ======

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const sendLineNotification = async (message) => {
    return axios.post(LINE_NOTI_URL, `message=${encodeURIComponent(message)}`, LINE_NOTI_CONFIG);
}

const swapAndRedeem = async (usdcAmount, minStatikAmount, txConfig) => {
    return statikArb.methods.swapAndRedeem(usdcAmount, minStatikAmount).send(txConfig)
        .on('transactionHash', function (transactionHash) {
            console.log(`Swapping and Redeeming: https://snowtrace.io/tx/${transactionHash} (${web3.utils.fromWei(txConfig.gasPrice, 'Gwei')} gwei)`);
        }).on('receipt', (receipt) => {
            console.log("Swapping and Redeeming Success!");
        });
}

const claim = async (minUsdcFromTho, minUsdcFromShare, txConfig) => {
    return statikArb.methods.claim(minUsdcFromTho, minUsdcFromShare).send(txConfig)
        .on('transactionHash', function (transactionHash) {
            console.log(`Claiming: https://snowtrace.io/tx/${transactionHash} (${web3.utils.fromWei(txConfig.gasPrice, 'Gwei')} gwei)`);
        }).on('receipt', (receipt) => {
            console.log("Claiming Success!");
        });
}

const fetchInfo = async () => {
    const gasPrice = web3.eth.getGasPrice();
    const nonce = web3.eth.getTransactionCount(account.address, "pending");
    const usdcBalance = usdc.methods.balanceOf(account.address).call();
    const statikSupply = statik.methods.totalSupply().call();
    const thoBalance = tho.methods.balanceOf(ContractAddress["StatikMaster"]).call();
    const thorusPermille = statikMaster.methods.thorusPermille().call();
    const treasuryPermille = statikMaster.methods.treasuryPermille().call();
    const statikusdcReserves = statikusdcPair.methods.getReserves().call();
    const usdcthoReserves = usdcthoPair.methods.getReserves().call();
    const pendingClaim = statikMaster.methods.usdcClaimAmount(ContractAddress["StatikArb"]).call();
    const masterUsdcBalance = usdc.methods.balanceOf(ContractAddress['StatikMaster']).call();

    return {
        gasPrice: new BN(await gasPrice).add(new BN("2")),
        nonce: await nonce,
        usdcBalance: new BN(await usdcBalance),
        statikSupply: new BN(await statikSupply),
        thoBalance: new BN(await thoBalance),
        thorusPermille: new BN(await thorusPermille),
        treasuryPermille: new BN(await treasuryPermille),
        statikusdcReserves: await statikusdcReserves,
        usdcthoReserves: await usdcthoReserves,
        pendingClaim: await pendingClaim,
        masterUsdcBalance: new BN(await masterUsdcBalance)
    };
}

const getMostProfitableAmount = (info) => {
    // Starts with USDC
    let middlePoint = info.usdcBalance.div(new BN(2));

    let usdcToSwap = new BN(0);
    let limitL = new BN(0);
    let limitR = info.usdcBalance;
    let profit = 0;
    let usdcFromRedeem = 0;
    let statikAmount = 0;

    // USDC -> Statik
    const reservesArray = [[info.statikusdcReserves[1], info.statikusdcReserves[0]]];

    const portionAfterFees = new BN('1000').sub(info.thorusPermille).sub(info.treasuryPermille);
    const swapFee = 9990;

    // Divide in half and search for increasing profit
    do {
        const usdcToSwapL = limitL.add(middlePoint).div(new BN(2));
        const statikAmountL = getAmountsOut(usdcToSwapL, swapFee, reservesArray).slice(-1)[0];
        const thoToSwapL = info.thoBalance.mul(statikAmountL).div(info.statikSupply);
        const usdcFromThoL = getAmountOut(thoToSwapL, swapFee, info.usdcthoReserves[1], info.usdcthoReserves[0]);
        const usdcFromRedeemL = statikAmountL.mul(portionAfterFees).div(new BN('1000000000000000')).add(usdcFromThoL); // statik(18) -> usdc(12) / 1000 permille = 18 - 6 + 3 = 15 decimals 
        const profitL = usdcFromRedeemL.sub(usdcToSwapL);

        const usdcToSwapR = middlePoint.add(limitR).div(new BN(2));
        const statikAmountR = getAmountsOut(usdcToSwapR, swapFee, reservesArray).slice(-1)[0];
        const thoToSwapR = info.thoBalance.mul(statikAmountR).div(info.statikSupply);
        const usdcFromThoR = getAmountOut(thoToSwapR, swapFee, info.usdcthoReserves[1], info.usdcthoReserves[0]);
        const usdcFromRedeemR = statikAmountR.mul(portionAfterFees).div(new BN('1000000000000000')).add(usdcFromThoR);
        const profitR = usdcFromRedeemR.sub(usdcToSwapR);

        if (profitL.gt(profitR)) {
            usdcToSwap = usdcToSwapL;
            limitR = middlePoint;
            middlePoint = limitL.add(limitR).div(new BN(2));
            profit = profitL;
            usdcFromRedeem = usdcFromRedeemL;
            statikAmount = statikAmountL;
        } else {
            usdcToSwap = usdcToSwapR;
            limitL = middlePoint;
            middlePoint = limitL.add(limitR).div(new BN(2));
            profit = profitR;
            usdcFromRedeem = usdcFromRedeemR;
            statikAmount = statikAmountR;
        }
    } while (parseFloat(web3.utils.fromWei(limitR.sub(limitL).abs(), 'mwei')).toFixed(4) > 0.5);
    return { "amount": usdcToSwap, "statikAmount": statikAmount, "redeem": usdcFromRedeem, "profit": profit };
}

async function main() {
    sendLineNotification(`Starting...`);

    const blockSubscription = web3.eth.subscribe('newBlockHeaders');
    // const pendingSubscription = web3.eth.subscribe('pendingTransactions');

    currentBlock = await web3.eth.getBlockNumber();

    blockSubscription.on('data', async (block, error) => {
        currentBlock = block.number;

        // Skip on redeeming
        if (isTransactionOngoing) return;
        if (fetching) return;

        fetching = true;
        const info = await fetchInfo();
        fetching = false;

        // console.log(currentBlock);

        if (info.pendingClaim !== "0") {
            console.log("Claiming...");
            isTransactionOngoing = true;

            if (info.masterUsdcBalance.lt(new BN(info.pendingClaim).div(new BN('1000000000000')))) {
                sendLineNotification(`🟥❌ Insufficient USDC Balance in StatikMaster, waiting...`);
                console.log("Insufficient USDC Balance in StatikMaster, waiting...")
                while (info.masterUsdcBalance.lt(new BN(info.pendingClaim).div(new BN('1000000000000')))) {
                    await sleep(3000);
                    info.masterUsdcBalance = new BN(await usdc.methods.balanceOf(ContractAddress['StatikMaster']).call());
                }
            }
            try {
                await claim("0", "0", {
                    gasPrice: info.gasPrice,
                    gas: GAS_LIMIT,
                    from: account.address
                });
                isTransactionOngoing = false;
                const afterUsdcBalance = new BN(await usdc.methods.balanceOf(account.address).call());
                const actualProfit = afterUsdcBalance.sub(info.usdcBalance);
                console.log(`Claimed:\t${parseFloat(web3.utils.fromWei(actualProfit, 'mwei')).toFixed(4)} USDC`);
                sendLineNotification(`🟥✅ Claimed:\t${parseFloat(web3.utils.fromWei(actualProfit, 'mwei')).toFixed(4)} USDC\nBalance: ${parseFloat(web3.utils.fromWei(afterUsdcBalance, 'mwei')).toFixed(4)} USDC`);
                if (CLAIM) process.exit(0);
            } catch(err) {
                console.log(err);
                isTransactionOngoing = false;
                return;
            }
        }

        // Check USDC Balance
        if (info.usdcBalance.lte(new BN(0))) return;

        // Quote USDC to Statik from redeem
        const profitableAmount = getMostProfitableAmount(info);

        const profitFlat = parseFloat(web3.utils.fromWei(profitableAmount.profit, 'mwei'));
        const profitFlatStr = profitFlat.toFixed(4);

        const gasInUSD = parseFloat(web3.utils.fromWei(info.gasPrice.mul(new BN("500000")).mul(new BN("100")), 'ether'));
        const gasInUSDStr = gasInUSD.toFixed(4);
        const gasInUSDWithMargin = gasInUSD + 0.5;

        if (lastProfit !== profitFlatStr) {
            console.log(`${new Date().toLocaleString()}, Block: ${currentBlock}, Balance: ${parseFloat(web3.utils.fromWei(info.usdcBalance, 'mwei')).toFixed(4)} USDC, Amount: ${parseFloat(web3.utils.fromWei(profitableAmount.amount, 'mwei')).toFixed(4)} USDC, Redeem: ${parseFloat(web3.utils.fromWei(profitableAmount.redeem, 'mwei')).toFixed(4)} USDC, Profit: ${profitFlatStr} USDC, Gas: ${gasInUSDStr} USDC (${parseFloat(web3.utils.fromWei(info.gasPrice, 'gwei')).toFixed(0)} gwei)`);
            lastProfit = profitFlatStr;
        }

        if (profitFlat < gasInUSDWithMargin) return;

        sendLineNotification(`🟥 ${profitFlatStr} USDC\n${parseFloat(web3.utils.fromWei(profitableAmount.amount, 'mwei')).toFixed(4)} -> ${parseFloat(web3.utils.fromWei(profitableAmount.redeem, 'mwei')).toFixed(4)} USDC`);

        isTransactionOngoing = true;

        const sendTxBlock = currentBlock;

        let txConfig = {
            gasPrice: info.gasPrice,
            gas: GAS_LIMIT,
            from: account.address,
            nonce: info.nonce
        }
        try {
            swapAndRedeem(profitableAmount.amount, profitableAmount.statikAmount.mul(new BN(99)).div(new BN(100)), txConfig);
        } catch (e) {
            console.log("Swapping Failed, Skipping...")
            isTransactionOngoing = false;
            return;
        }

        txConfig = {
            gasPrice: info.gasPrice,
            gas: GAS_LIMIT,
            from: account.address,
            nonce: info.nonce + 1
        }

        while (currentBlock <= sendTxBlock + 1) {
            await sleep(10);
        }
        try {
            await claim("0", "0", txConfig);
        } catch (e) {
            console.log("Claiming Error!, Retrying...");
            txConfig = {
                gasPrice: info.gasPrice,
                gas: GAS_LIMIT,
                from: account.address,
                nonce: info.nonce + 2
            }
            await claim("0", "0", txConfig);
        }

        isTransactionOngoing = false;

        const afterUsdcBalance = new BN(await usdc.methods.balanceOf(account.address).call());

        if (afterUsdcBalance.lt(info.usdcBalance)) {
            sendLineNotification(`🟥❌ Balance: ${parseFloat(web3.utils.fromWei(afterUsdcBalance, 'mwei')).toFixed(4)} USDC`);
            console.warn(chalk.red("Bad Redeem!"));
            return;
        }

        const actualProfit = afterUsdcBalance.sub(info.usdcBalance);
        const actualProfitPercent = actualProfit.mul(new BN(10000)).div(profitableAmount.amount).toNumber();
        console.log(chalk.green(`Actual Profit:\t${parseFloat(web3.utils.fromWei(actualProfit, 'mwei')).toFixed(4)} USDC (${actualProfitPercent / 100}%)`));
        sendLineNotification(`🟥✅ ${parseFloat(web3.utils.fromWei(actualProfit, 'mwei')).toFixed(4)} USDC (${actualProfitPercent / 100}%)\nBalance: ${parseFloat(web3.utils.fromWei(afterUsdcBalance, 'mwei')).toFixed(4)} USDC`);
    }).on("error", (err) => {
        console.error(err.message);
        isTransactionOngoing = false;
    });
}

main().then(async () => {
    // do nothing
}).catch((err) => {
    console.error(err);
    process.exit(1337);
});
