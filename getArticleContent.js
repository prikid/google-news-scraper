const {Readability} = require('@mozilla/readability');
const jsdom = require("jsdom");
const {JSDOM} = jsdom;
const logger = require("./logger");
const PageReader = require("./PageReader");

class TooManyRequestsError extends Error {
    constructor(message) {
        super(message);
        this.name = "TooManyRequestsError";
        this.statusCode = 429; // HTTP status code for "Too Many Requests"
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


    constructor(extractContent = false, filterWords = [], browser = null, articleReadyCallback = null) {
        this.extractContent = extractContent;
        this.browser = browser;
        this.articleReadyCallback = articleReadyCallback;
        this.filterWords = filterWords || [];
        this.logger = logger;
    }

    async getContent(articles) {
        // Create a shallow copy of the articles array
        const articlesCopy = [...articles];

        for (let i = 0; i < articlesCopy.length; i++) {
            this.logger.info(`Processing ${articlesCopy[i].title}`);

            try {
                const mArticle = await this._extractArticle(articlesCopy[i]);
                articlesCopy[i] = mArticle;

                if (this.articleReadyCallback)
                    this.articleReadyCallback(mArticle);

                this.logger.info(`Processed: ${mArticle.title}`);
            } catch (error) {
                if (error instanceof TooManyRequestsError) {
                    this.logger.error("Receive too many requests error. Stop processing articles...");
                    return articles;
                } else {
                    this.logger.error('getContent ERROR:', error);
                }
            }
        }
        return articlesCopy;
    }

    async _processImage(imageUrl) {
        if (!imageUrl)
            return null;

        const reader = await new PageReader(imageUrl, false).readPage(this.browser);
        return reader.success ? reader.original_url : imageUrl;
    }

    _hasVerifyMessage(content) {
        return this.verifyMessages.some(w => content.toLowerCase().includes(w));
    }

    _extractArticleContent(content, modifiedArticle) {
        const virtualConsole = new jsdom.VirtualConsole();
        virtualConsole.on("virtualConsole ERROR", this.logger.error);

        const dom = new JSDOM(content, {url: modifiedArticle.link, virtualConsole});
        const reader = new Readability(dom.window.document);
        return reader.parse();
    }

    async _extractArticle(article) {
        const modifiedArticle = {...article};

        const reader = new PageReader(modifiedArticle.link, false);
        await reader.readPage(this.browser);

        if (reader.too_many_requests)
            throw new TooManyRequestsError();

        if (reader.success) {
            // Updating the original article URL.
            modifiedArticle.link = reader.original_url;
            modifiedArticle.favicon = reader.favicon;
            modifiedArticle.image = await this._processImage(modifiedArticle.image);

            if (this.extractContent) {
                const articleContent = this._extractArticleContent(reader.html, modifiedArticle);

                if (articleContent) {
                    return this._processArticleContent(modifiedArticle, articleContent);
                }
            }
        }

        return modifiedArticle;
    }

    _processArticleContent(modifiedArticle, articleContent) {
        // Copy the excerpt if it exists
        if (articleContent.excerpt) {
            modifiedArticle.excerpt = articleContent.excerpt;
        }

        // Early return if no content or textContent is not parsable
        if (!articleContent.textContent) {
            this.logger.warn("Article content could not be parsed or is empty.");
            return modifiedArticle;
        }

        // Early return if human verification is required
        if (this._hasVerifyMessage(articleContent.textContent)) {
            this.logger.warn("Article requires human verification.");
            return modifiedArticle;
        }

        const cleanedText = this._cleanText(articleContent.textContent);

        // Early return if the content is too short
        if (cleanedText.split(' ').length < 100) { // Example threshold: 100 words
            this.logger.warn("Article content is too short and likely not valuable.");
            return modifiedArticle;
        }

        // Log success and return the modified article with cleaned content
        this.logger.info("SUCCESSFULLY SCRAPED ARTICLE CONTENT:");
        return {...modifiedArticle, content: cleanedText};
    }

    _cleanText(text) {
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