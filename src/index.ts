import { WalletBackend, Daemon, prettyPrintAmount } from 'turtlecoin-wallet-backend';
import { Logger } from '@turtlepay/logger';
import * as path from 'path';
import fetch from 'node-fetch';
import * as fs from 'fs';
const pkg = require('../package.json');

(async () => {
    Logger.info('TurtleCoin Wallet Repair Utility v%s', pkg.version);

    if (process.argv.length < 4) {
        Logger.error('Usage: turtlecoin-wallet-repair <wallet-file> <password> [dump]', process.argv[1]);

        return;
    }

    const walletFilename = path.resolve(process.argv[2]);
    const walletPassword = process.argv[3];
    const dump = (process.argv[4] && process.argv[4] === 'dump');
    const backupWalletFilename = walletFilename + '.backup';

    if (!fs.existsSync(walletFilename)) {
        Logger.error('%s does not exist, please check the path and try again.', walletFilename);

        return;
    }

    if (fs.existsSync(backupWalletFilename)) {
        Logger.error('Backup wallet file already exists! Refusing to continue with existing backup!');

        return;
    }

    fs.copyFileSync(walletFilename, backupWalletFilename);
    Logger.warn('A backup of the wallet file has been created as: %s', backupWalletFilename);

    // set up a basic daemon connection
    const daemon = new Daemon('node.turtlepay.io', 443, true);
    Logger.info('Daemon connection established to: node.turtlepay.io:443');

    // attempt to open the wallet
    const [wallet, open_err] = await WalletBackend.openWalletFromFile(daemon, walletFilename, walletPassword);

    if (open_err || !wallet) {
        Logger.error('Could not open wallet file using supplied password: %s', walletFilename);

        process.exit(1);
    }

    Logger.info('Wallet file opened successfully: %s', walletFilename);

    const [init_unlocked, init_locked] = await wallet.getBalance();

    const init_balance = init_unlocked + init_locked;

    Logger.info('Wallet reports a balance of: %s', prettyPrintAmount(init_balance));

    await wallet.stop();

    let start_height = 10000000;
    let end_height = 0;

    const init_json = JSON.parse(wallet.toJSONString());
    const all_spent: Map<string, any> = new Map<string, any>();
    const all_unspent: Map<string, any> = new Map<string, any>();

    for (let i = 0; i < init_json.subWallets.subWallet.length; ++i) {
        Logger.info('Checking subwallet: %s', init_json.subWallets.subWallet[i].address);

        const unspent = [];
        const spent = [];

        Logger.info('Found %s unspent inputs in wallet', init_json.subWallets.subWallet[i].unspentInputs.length);

        for (let j = 0; j < init_json.subWallets.subWallet[i].unspentInputs.length; ++j) {
            const input = init_json.subWallets.subWallet[i].unspentInputs[j];

            if (input.blockHeight < start_height) {
                start_height = input.blockHeight;
            }

            if (input.blockHeight > end_height) {
                end_height = input.blockHeight;
            }

            const response = await fetch('https://blockapi.turtlepay.io/keyImage/' + input.keyImage);

            if (!response.ok) {
                input.spendHeight = 0;

                Logger.info('Input with keyImage: %s marked as unspent', input.keyImage);

                all_unspent.set(input.keyImage, input);

                unspent.push(input);
            } else {
                const data = await response.json();

                input.spendHeight = data.height;

                Logger.info('Input with keyImage: %s marked as spent in block %s', input.keyImage, data.height);

                all_spent.set(input.keyImage, data);

                spent.push(input);
            }
        }

        Logger.info('Found %s spent inputs in wallet', init_json.subWallets.subWallet[i].spentInputs.length);

        for (let j = 0; j < init_json.subWallets.subWallet[i].spentInputs.length; ++j) {
            const input = init_json.subWallets.subWallet[i].spentInputs[j];

            if (input.blockHeight < start_height) {
                start_height = input.blockHeight;
            }

            if (input.blockHeight > end_height) {
                end_height = input.blockHeight;
            }

            const response = await fetch('https://blockapi.turtlepay.io/keyImage/' + input.keyImage);

            if (!response.ok) {
                input.spendHeight = 0;

                Logger.info('Input with keyImage: %s marked as unspent', input.keyImage);

                all_unspent.set(input.keyImage, input);

                unspent.push(input);
            } else {
                const data = await response.json();

                input.spendHeight = data.height;

                Logger.info('Input with keyImage: %s marked as spent in block %s', input.keyImage, data.height);

                all_spent.set(input.keyImage, data);

                spent.push(input);
            }
        }

        Logger.info('Found %s locked inputs in wallet', init_json.subWallets.subWallet[i].lockedInputs.length);

        for (let j = 0; j < init_json.subWallets.subWallet[i].lockedInputs.length; ++j) {
            const input = init_json.subWallets.subWallet[i].lockedInputs[j];

            if (input.blockHeight < start_height) {
                start_height = input.blockHeight;
            }

            if (input.blockHeight > end_height) {
                end_height = input.blockHeight;
            }

            const response = await fetch('https://blockapi.turtlepay.io/keyImage/' + input.keyImage);

            if (!response.ok) {
                input.spendHeight = 0;

                Logger.info('Input with keyImage: %s marked as unspent', input.keyImage);

                all_unspent.set(input.keyImage, input);

                unspent.push(input);
            } else {
                const data = await response.json();

                input.spendHeight = data.height;

                Logger.info('Input with keyImage: %s marked as spent in block %s', input.keyImage, data.height);

                all_spent.set(input.keyImage, data);

                spent.push(input);
            }
        }

        Logger.info('Updating subwallet structure...');

        init_json.subWallets.subWallet[i].unspentInputs = unspent;

        init_json.subWallets.subWallet[i].spentInputs = [];

        init_json.subWallets.subWallet[i].lockedInputs = [];
    }

    const transactions: Map<string, any> = new Map<string, any>();

    Logger.info('Reconstructing incoming transactions...');

    for (const [, data] of all_unspent) {
        if (!transactions.has(data.parentTransactionHash)) {
            const res = await fetch('https://blockapi.turtlepay.io/transaction/' + data.parentTransactionHash);

            if (!res.ok) {
                Logger.error('Could not retrieve transaction details...');

                process.exit(1);
            }

            const txn = await res.json();

            transactions.set(data.parentTransactionHash, {
                transfers: [{
                    amount: 0,
                    publicKey: init_json.subWallets.publicSpendKeys[0]
                }],
                hash: data.parentTransactionHash,
                fee: txn.tx.fee || 0,
                blockHeight: txn.block.height || 0,
                timestamp: txn.block.timestamp || 0,
                paymentID: txn.tx.paymentId || '',
                unlockTime: parseInt(txn.tx.unlock_time, 10) || 0,
                isCoinbaseTransaction: false
            });
        }

        const tx = transactions.get(data.parentTransactionHash);

        if (!tx) {
            Logger.error('Could not retrieve internal temporary transaction. Cancelling...');

            process.exit(1);
        }

        tx.transfers[0].amount += data.amount;

        transactions.set(data.parentTransactionHash, tx);

        Logger.info('Reconstructed transaction: %s', data.parentTransactionHash);
    }

    init_json.subWallets.transactions = [];

    for (const [, tx] of transactions) {
        init_json.subWallets.transactions.push(tx);
    }

    if (start_height === 10000000) {
        start_height = 0;
    }

    init_json.walletSynchronizer.startHeight = end_height + 1; // Math.round(start_height / 1000) * 1000;
    init_json.walletSynchronizer.transactionSynchronizerStatus = {
        blockHashCheckpoints: [],
        lastKnownBlockHashes: [],
        lastKnownBlockHeight: init_json.walletSynchronizer.startHeight
    };

    Logger.warn('The transaction history of the wallet has been altered!');

    const str = JSON.stringify(init_json, null, 4);

    if (dump) {
        fs.writeFileSync(walletFilename + '.json', str);
    }

    const [final_wallet, final_error] = await WalletBackend.loadWalletFromJSON(daemon, str);

    if (final_error || !final_wallet) {
        Logger.error('Could not reload altered wallet into wallet-backend. Cancelling...');

        process.exit(1);
    }

    const [final_unlocked, final_locked] = await final_wallet.getBalance();

    Logger.info('Locked: %s', prettyPrintAmount(final_locked));
    Logger.info('Unlocked: %s', prettyPrintAmount(final_unlocked));

    const final_balance = final_unlocked + final_locked;

    Logger.warn('Wallet now reports a balance of: %s', prettyPrintAmount(final_balance));
    Logger.warn('This balance is likely different than what you expected, but it is the balance of unspent funds.')

    Logger.warn('Saving updated wallet...');

    await final_wallet.saveWalletToFile(walletFilename, walletPassword);

    Logger.warn('Transactions as found in the wallet may not match transactions as provided on block explorers');
    Logger.warn('You may now re-open the wallet file in your usual wallet software.');
    Logger.warn('THe wallet had inputs starting at block %s that were checked', start_height);
    Logger.warn('The wallet will begin re-scanning at block %s', init_json.walletSynchronizer.startHeight);
    Logger.warn('Once the scanning is complete, please move ALL remaining funds to a NEW wallet.');
})();
