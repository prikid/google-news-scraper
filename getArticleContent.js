const {Readability} = require('@mozilla/readability');
const jsdom = require("jsdom");
const {JSDOM} = jsdom;
const puppeteer = require('puppeteer');
const logger = require("./logger");

const axios = require('axios');

class ProxyManager {
    constructor(proxies) {
        this.proxies = proxies;
        this.currentIndex = 0;
        this.preCheckProxies().then(() => {
            if (!this.hasProxies()) {
                throw new Error('No valid proxies available after pre-check');
            }
        });
    }

    async validateProxy(proxy) {
        try {
            const response = await axios.get('https://www.google.com', {
                proxy: {
                    host: proxy.split(':')[0],
                    port: proxy.split(':')[1]
                },
                timeout: 5000 // Timeout after 5 seconds
            });
            return response.status === 200;
        } catch (error) {
            console.warn(`Invalid proxy detected: ${proxy}`);
            return false;
        }
    }

    async preCheckProxies() {
        const maxConcurrentRequests = 100;
        const iterator = this.proxies[Symbol.iterator]();
        const validProxies = [];

        const processNext = async () => {
            const { value: proxy, done } = iterator.next();
            if (done) return;

            const isValid = await this.validateProxy(proxy);
            if (isValid) {
                validProxies.push(proxy);
            }
            await processNext();
        };

        const initialRequests = Array.from(
            { length: Math.min(maxConcurrentRequests, this.proxies.length) },
            processNext
        );

        await Promise.all(initialRequests);
        this.proxies = validProxies;
    }

    getNextProxy() {
        if (this.proxies.length === 0) {
            throw new Error('No proxies available');
        }
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        return proxy;
    }

    removeProxy(proxy) {
        this.proxies = this.proxies.filter(p => p !== proxy);
        if (this.currentIndex >= this.proxies.length) {
            this.currentIndex = 0;
        }
    }

    hasProxies() {
        return this.proxies.length > 0;
    }
}


async function withProxyRetry(proxyManager, func) {
    let proxy;
    while (proxyManager.hasProxies()) {
        proxy = proxyManager.getNextProxy();
        const browser = await puppeteer.launch({
            args: [`--proxy-server=${proxy}`]
        });
        try {
            const result = await func(browser, proxy);
            await browser.close();
            return result;
        } catch (error) {
            await browser.close();
            if (error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')
                || error.message.includes('ERR_TIMED_OUT')
                || error.message.includes('ERR_PROXY_CONNECTION_FAILED')
                || error.message.includes('ERR_CERT_AUTHORITY_INVALID')
                || error.message.includes('net::ERR_CONNECTION_RESET')
                || error.message.includes('net::ERR_EMPTY_RESPONSE')

            ) {
                proxyManager.removeProxy(proxy);
                console.warn(`Removed faulty proxy: ${proxy}`);
            } else {
                throw error;
            }
        }
    }
    throw new Error('All proxies failed');
}

class PageReader {
    original_url;

    constructor(browser, url, wait = false) {
        this.browser = browser;
        this.url = url;
        this.wait = wait;

        this.success = false;
    }

    readPage = async () => {
        this.page = await this.browser.newPage();
        await this.page.goto(this.url, this.wait ? {waitUntil: 'networkidle2'} : {});
        this.original_url = this.page.url();

        if (!this.original_url.includes('sorry/index')) {
            this.success = true;
        }

        return this;
    }

    getPageContent = async () => {
        return await this.page.evaluate(() => document.documentElement.innerHTML);
    }

    getFavicon = async () => {
        return this.page.evaluate(() => {
            const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
            return link ? link.getAttribute('href') : '';
        });
    }

    closePage = async () => {
        await this.page.close();
    }
}

class ArticleContent {
    // Messages used to identify verification prompts in content.
    verifyMessages = [
        "you are human",
        "are you human",
        "i'm not a robot",
        "recaptcha"
    ];


    constructor(filterWords, proxies = null) {
        this.filterWords = filterWords;
        this.logger = logger;
        this.proxyManager = new ProxyManager(proxies);
    }

    async getContent(articles) {
        await this.proxyManager.preCheckProxies();

        try {
            const mArticles = [];
            for (const article of articles) {
                this.logger.info(`Processing ${article.link}`);
                try {
                    const mArticle = await this.extractArticleWithRetry(article);
                    this.logger.info(`Processed: ${mArticle.link}`);
                    mArticles.push(mArticle);

                } catch (error) {
                    this.logger.info(error);
                }
            }
            return mArticles;
        } catch (err) {
            this.logger.error("getContent ERROR:", err);
            return articles;
        }
    }

    async extractArticleWithRetry(article) {
        return withProxyRetry(this.proxyManager, async (browser, proxy) => {
            return this.extractArticleContentAndFavicon(article, browser);
        });
    }

    async processImageWithRetry(imageUrl) {
        return withProxyRetry(this.proxyManager, async (browser, proxy) => {
            const PRI = await new PageReader(browser, imageUrl).readPage();
            await PRI.closePage();
            return PRI.success ? PRI.original_url : imageUrl;
        });
    }

    hasVerifyMessage(content) {
        return this.verifyMessages.some(w => content.toLowerCase().includes(w));
    }

    extractArticleContent(content, modifiedArticle) {
        const virtualConsole = new jsdom.VirtualConsole();
        virtualConsole.on("error", this.logger.error);

        const dom = new JSDOM(content, {url: modifiedArticle.link, virtualConsole});
        const reader = new Readability(dom.window.document);
        return reader.parse();
    }

    async extractArticleContentAndFavicon(article, browser) {
        const modifiedArticle = {...article};

        const PR = await new PageReader(browser, modifiedArticle.link, true).readPage();
        if (!PR.success) {
            this.logger.warn("Google requires human verification.", {modifiedArticle});
        } else {
            // Updating the original article URL.
            modifiedArticle.link = PR.original_url;
            const content = await PR.getPageContent();
            modifiedArticle.image = await this.processImageWithRetry(modifiedArticle.image);
            modifiedArticle.favicon = await PR.getFavicon();

            const articleContent = this.extractArticleContent(content, modifiedArticle);

            if (articleContent) {
                await PR.closePage();
                return this.processArticleContent(modifiedArticle, articleContent);
            }
        }

        return modifiedArticle;
    }

    processArticleContent(modifiedArticle, articleContent) {
        if (articleContent.excerpt) {
            modifiedArticle.excerpt = articleContent.excerpt;
        }

        if (!articleContent.textContent) {
            this.logger.warn("Article content could not be parsed or is empty.", {modifiedArticle});
            return modifiedArticle;
        }

        if (this.hasVerifyMessage(articleContent.textContent)) {
            this.logger.warn("Article requires human verification.", {modifiedArticle});
            return modifiedArticle;
        }

        const cleanedText = this.cleanText(articleContent.textContent);

        if (cleanedText.split(' ').length < 100) { // Example threshold: 100 words
            this.logger.warn("Article content is too short and likely not valuable.", {modifiedArticle});
            return modifiedArticle;
        }

        this.logger.info("SUCCESSFULLY SCRAPED ARTICLE CONTENT:", cleanedText);
        return {...modifiedArticle, content: cleanedText};
    }

    cleanText(text) {
        const unwantedKeywords = [
            "subscribe now",
            "sign up",
            "newsletter",
            "subscribe now",
            "sign up for our newsletter",
            "exclusive offer",
            "limited time offer",
            "free trial",
            "download now",
            "join now",
            "register today",
            "special promotion",
            "promotional offer",
            "discount code",
            "early access",
            "sneak peek",
            "save now",
            "don't miss out",
            "act now",
            "last chance",
            "expires soon",
            "giveaway",
            "free access",
            "premium access",
            "unlock full access",
            "buy now",
            "learn more",
            "click here",
            "follow us on",
            "share this article",
            "connect with us",
            "advertisement",
            "sponsored content",
            "partner content",
            "affiliate links",
            "click here",
            "for more information",
            "you may also like",
            "we think you'll like",
            "from our network",
            ...this.filterWords
        ];

        return text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.split(' ').length > 4)
            .filter(line => !unwantedKeywords.some(keyword => line.toLowerCase().includes(keyword)))
            .join('\n');
    }
}

module.exports = ArticleContent;