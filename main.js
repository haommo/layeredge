import axios from "axios";
import chalk from "chalk";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Wallet } from "ethers";
import xlsx from "xlsx"; 

const EXCEL_FILE = "wallet.xlsx";
const MAX_CONCURRENT_WALLETS = 10;
const logger = {
    verbose: true,

    formatTimestamp() {
        return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
    },

    getLevelStyle(level) {
        const styles = {
            info: chalk.blueBright.bold,
            warn: chalk.yellowBright.bold,
            error: chalk.redBright.bold,
            success: chalk.greenBright.bold,
            debug: chalk.magentaBright.bold,
            verbose: chalk.cyan.bold
        };
        return styles[level] || chalk.white;
    },

    log(level, message, value = '', error = null) {
        const timestamp = this.formatTimestamp();
        const levelStyle = this.getLevelStyle(level);
        const levelTag = levelStyle(`[${level.toUpperCase()}]`);
        const header = chalk.cyan('◆ LayerEdge');

        let formattedMessage = `${header} ${timestamp} ${levelTag} ${message}`;

        if (value) {
            const valueStyle = level === 'error' ? chalk.red :
                level === 'warn' ? chalk.yellow :
                    chalk.green;
            formattedMessage += ` ${valueStyle(value)}`;
        }

        if (error && this.verbose) {
            formattedMessage += `\n${chalk.red(error.message)}`;
        }

        console.log(formattedMessage);
    },

    info: (message, value = '') => logger.log('info', message, value),
    warn: (message, value = '') => logger.log('warn', message, value),
    error: (message, value = '', error = null) => logger.log('error', message, value, error),
    success: (message, value = '') => logger.log('success', message, value),
    verbose: (message, value = '') => logger.verbose && logger.log('verbose', message, value),
    progress(wallet, step, status) {
        const progressStyle = status === 'success' 
            ? chalk.green('✔') 
            : status === 'failed' 
            ? chalk.red('✘') 
            : chalk.yellow('➤ ');
        
        console.log(
            chalk.cyan('◆ LayerEdge'),
            chalk.gray(`[${new Date().toLocaleTimeString()}]`),
            chalk.blueBright(`[PROGRESS]`),
            `${progressStyle} ${wallet} - ${step}`
        );
    }
};

async function readWalletsFromExcel() {
    try {
        const workbook = xlsx.readFile(EXCEL_FILE);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        return xlsx.utils.sheet_to_json(sheet);
    } catch (error) {
        logger.error(`Lỗi khi đọc file Excel: ${error.message}`);
        return [];
    }
}

async function updatePointsToExcel(wallets) {
    try {
        const workbook = xlsx.readFile(EXCEL_FILE);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        const updatedData = wallets.map(wallet => ({
            address: wallet.address,
            privateKey: wallet.privateKey,
            proxy: wallet.proxy,
            refCode: wallet.refCode,
            point: wallet.point || 0
        }));

        const newSheet = xlsx.utils.json_to_sheet(updatedData);
        workbook.Sheets[workbook.SheetNames[0]] = newSheet;

        xlsx.writeFile(workbook, EXCEL_FILE);
        logger.success("Cập nhật điểm thành công vào file Excel!");
    } catch (error) {
        logger.error("Lỗi khi cập nhật file Excel", error);
    }
}

class RequestHandler {
    static async makeRequest(config, retries = 3, backoffMs = 2000) {
        for (let i = 0; i < retries; i++) {
            try {
                //logger.verbose(`Attempting request (${i + 1}/${retries})`, `URL: ${config.url}`);
                const response = await axios(config);
                //logger.verbose(`Request successful`, `Status: ${response.status}`);
                return response;
            } catch (error) {
                const isLastRetry = i === retries - 1;
                const status = error.response?.status;
                
                // Special handling for 500 errors
                if (status === 500) {
                    logger.error(`Server Error (500)`, `Attempt ${i + 1}/${retries}`, error);
                    if (isLastRetry) break;
                    
                    // Exponential backoff for 500 errors
                    const waitTime = backoffMs * Math.pow(1.5, i);
                    logger.warn(`Waiting ${waitTime/1000}s before retry...`);
                    await delay(waitTime/1000);
                    continue;
                }

                if (isLastRetry) {
                    logger.error(`Max retries reached`, '', error);
                    return null;
                }

                logger.warn(`Request failed`, `Attempt ${i + 1}/${retries}`, error);
                await delay(2);
            }
        }
        return null;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms * 1000));
}

const newAgent = (proxy = null) => {
    if (proxy) {
        if (proxy.startsWith('http://')) {
            return new HttpsProxyAgent(proxy);
        } else if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
            return new SocksProxyAgent(proxy);
        } else {
            logger.warn(`Proxy không hỗ trợ: ${proxy}`);
            return null;
        }
    }
    return null;
};

class LayerEdgeConnection {
    constructor(proxy, privateKey, refCode) {
        this.refCode = refCode;
        this.proxy = proxy;
        this.retryCount = 2;
        this.headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://layeredge.io',
            'Referer': 'https://layeredge.io/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
        };

        this.axiosConfig = {
            ...(this.proxy && { httpsAgent: newAgent(this.proxy) }),
            timeout: 60000,
            headers: this.headers,
            validateStatus: (status) => {
                return status < 500;
            }
        };

        this.wallet = new Wallet(privateKey);
    }

    async makeRequest(method, url, config = {}) {
        const finalConfig = {
            method,
            url,
            ...this.axiosConfig,
            ...config,
            headers: {
                ...this.headers,
                ...(config.headers || {})
            }
        };
        
        return await RequestHandler.makeRequest(finalConfig, this.retryCount);
    }

    async isWalletRegistered() {
        const url = `https://referralapi.layeredge.io/api/referral/wallet-details/${this.wallet.address}`;
        const response = await this.makeRequest("get", url);
        
        if (response && response.status === 200) {
            logger.info(`Wallet is registered`);
            return true;
        } else if (response && response.status === 404 && response.data.message === 'user not found') {
            logger.warn(`Wallet is NOT registered.`);
            return false;
        } else {
            logger.error(`Failed to check wallet registration`, '', response?.data || {});
            return null;
        }
    }

    async checkInvite() {
        const response = await this.makeRequest(
            "post",
            "https://referralapi.layeredge.io/api/referral/verify-referral-code",
            { data: { invite_code: this.refCode } }
        );

        if (response && response.data?.data?.valid) {
            logger.info("Invite Code is valid");
            return true;
        } else {
            logger.error("Invalid invite code");
            return false;
        }
    }

    async registerWallet() {
        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/referral/register-wallet/${this.refCode}`,
            { data: { walletAddress: this.wallet.address } }
        );

        if (response && response.status === 200) {
            logger.info("Wallet successfully registered");
            return true;
        } else {
            logger.error("Failed to register wallet", response?.data || {});
            return false;
        }
    }

    async dailyCheckIn() {
        const timestamp = Date.now();
        const message = `I am claiming my daily node point for ${this.wallet.address} at ${timestamp}`;
        const sign = await this.wallet.signMessage(message);

        const dataSign = {
            sign: sign,
            timestamp: timestamp,
            walletAddress: this.wallet.address
        };

        const response = await this.makeRequest(
            "post",
            "https://referralapi.layeredge.io/api/light-node/claim-node-points",
            { data: dataSign }
        );

        if (response && response.data) {
            logger.info("Daily Check-in Done:");
            return true;
        } else {
            logger.error("Failed to perform daily check-in");
            return false;
        }
    }

    async checkNodeStatus() {
        const response = await this.makeRequest(
            "get",
            `https://referralapi.layeredge.io/api/light-node/node-status/${this.wallet.address}`
        );

        if (response && response.data && response.data.data.startTimestamp !== null) {
            logger.info("Node Status Running");
            return true;
        } else {
            logger.error("Node not running. Start node now...");
            return false;
        }
    }

    async connectNode() {
        const timestamp = Date.now();
        const message = `Node activation request for ${this.wallet.address} at ${timestamp}`;
        const sign = await this.wallet.signMessage(message);

        const dataSign = {
            sign: sign,
            timestamp: timestamp,
        };

        const config = {
            data: dataSign,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/light-node/node-action/${this.wallet.address}/start`,
            config
        );

        if (response && response.data && response.data.message === "node action executed successfully") {
            logger.info("Connected Node Successfully");
            return true;
        } else {
            logger.info("Failed to connect Node");
            return false;
        }
    }

    async stopNode() {
        const timestamp = Date.now();
        const message = `Node deactivation request for ${this.wallet.address} at ${timestamp}`;
        const sign = await this.wallet.signMessage(message);

        const dataSign = {
            sign: sign,
            timestamp: timestamp,
        };

        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/light-node/node-action/${this.wallet.address}/stop`,
            { data: dataSign }
        );

        if (response && response.data) {
            logger.info("Stop and Claim Points Result:");
            return true;
        } else {
            logger.error("Failed to Stopping Node and claiming points");
            return false;
        }
    }

    async checkNodePoints() {
        const response = await this.makeRequest(
            "get",
            `https://referralapi.layeredge.io/api/referral/wallet-details/${this.wallet.address}`
        );
    
        if (response && response.data) {
            const nodePoints = response.data.data?.nodePoints || 0;
            logger.info(`${this.wallet.address} Total Points:`, nodePoints);
            return nodePoints; 
        } else {
            logger.error("Failed to check Total Points.");
            return null; 
        }
    }
}

async function processWallet(wallet, index, total, stats) {
    try {
        logger.verbose(`Processing wallet ${index + 1}/${total}`, wallet.address);
        const socket = new LayerEdgeConnection(wallet.proxy, wallet.privateKey, wallet.refCode);

        logger.progress(wallet.address, 'Checking registration status', 'processing');
        const isRegistered = await socket.isWalletRegistered();

        if (isRegistered === false) {
            logger.progress(wallet.address, 'Registering wallet...', 'processing');

            const isValidInvite = await socket.checkInvite();
            if (!isValidInvite) {
                logger.error(`Invalid referral code for wallet ${wallet.address}, skipping...`);
                return;
            }

            const registered = await socket.registerWallet();
            if (!registered) {
                logger.error(`Failed to register wallet ${wallet.address}, skipping...`);
                return;
            }
        }

        logger.progress(wallet.address, 'Performing Daily Check-in', 'processing');
        await socket.dailyCheckIn();

        logger.progress(wallet.address, 'Checking Node Status', 'processing');
        const isRunning = await socket.checkNodeStatus();

        if (isRunning) {
            logger.progress(wallet.address, 'Claiming Node Points', 'processing');
            await socket.stopNode();
        }

        logger.progress(wallet.address, 'Reconnecting Node', 'processing');
        await socket.connectNode();

        logger.progress(wallet.address, 'Checking Node Points', 'processing');
        wallet.point = await socket.checkNodePoints();

        logger.progress(wallet.address, 'Wallet Processing Complete', 'success');
        stats.success++;
    } catch (error) {
        logger.error(`Failed processing wallet ${wallet.address}`, '', error);
        logger.progress(wallet.address, 'Wallet Processing Failed', 'failed');
        stats.failed++;
    }
}

async function processWalletsInBatches(wallets, batchSize) {
    const total = wallets.length;
    let stats = { success: 0, failed: 0 }; 
    for (let i = 0; i < total; i += batchSize) {
        const batch = wallets.slice(i, i + batchSize); 
        logger.info(`Processing batch ${i / batchSize + 1}/${Math.ceil(total / batchSize)}`, `Wallets: ${batch.length}`);
        await Promise.allSettled(batch.map((wallet, index) => processWallet(wallet, i + index, total, stats)));
    }
    return stats; 
}

async function run() {
    logger.info('Starting Layer Edge', 'Initializing...');
    try {
        let wallets = await readWalletsFromExcel();
        if (wallets.length === 0) {
            throw new Error('No wallets configured in Excel');
        }
        logger.info('Configuration loaded', `Wallets: ${wallets.length}`);
        const stats = await processWalletsInBatches(wallets, MAX_CONCURRENT_WALLETS);
        await updatePointsToExcel(wallets);
        logger.success(`Summary: ${stats.success} wallets processed successfully, ${stats.failed} wallets failed.`);
        logger.warn('Complete', 'Waiting 2 hour before next run...');
        await delay(120 * 60);
    } catch (error) {
        logger.error('Fatal error occurred', '', error);
        process.exit(1);
    }
}

run();
