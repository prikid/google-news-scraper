const axios = require("axios");
const puppeteer = require("puppeteer");
const logger = require("./logger");
const fs = require("fs").promises;

class PageReader {
    original_url;
    html;
    favicon;
    useSplash;

    constructor(url, extractContent = true, useSplash = false) {
        this.useSplash = useSplash;

        url = new URL(url);
        url.search = ''; //Remove all query parameters
        this.url = url.toString();

        this.extractContent = extractContent;
        this.too_many_requests = false;
        this.success = true;
    }

    async getPageContentWithPuppeteer(external_browser = null) {
        let _browser;

        try {
            _browser = external_browser || await puppeteer.launch();
            const page = await _browser.newPage();

            await page.goto(this.url, {waitUntil: 'networkidle2'});

            if (page.url().includes('google.com/sorry')) {
                this.too_many_requests = true;
                this.success = false;
                logger.error("Too many requests");
            } else {
                this.original_url = page.url();

                if (this.extractContent) {
                    this.html = await page.content();

                    this.favicon = await page.evaluate(() => {
                        const links = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
                        return links.length > 0 ? links[0].href : location.origin + '/favicon.ico';
                    });
                }

                this.success = true;
            }

        } catch (error) {
            logger.error("Error fetching page content:", error);
            this.success = false;
        } finally {
            // if (page)
            //     await page.close();

            if (_browser && external_browser === null)
                await _browser.close();
        }

        return this;
    }

    async getPageContentWithSplash() {
        // Read Lua script from file
        const luaScript = await fs.readFile('lua_script.lua', 'utf8');
        // Define Splash API endpoint
        const splashEndpoint = 'http://localhost:8050/execute';

        try {
            // Make POST request to Splash to execute Lua script
            await axios.post(splashEndpoint, {
                lua_source: luaScript,
                url: this.url,
            }, {headers: {'Content-Type': 'application/json'}});

            this.favicon = data.favicon;
            this.html = data.html;
            this.original_url = data.url;
            this.success = true;

        } catch (error) {
            try {
                const lua_error = error.response.data.info.error;
                if (lua_error === 'http429') {
                    this.too_many_requests = true;
                    logger.error("Too many requests");
                }
            } catch (e) {
                logger.error("Error fetching page content:", error);
            }
            this.success = false;
        }
        return this;
    }

    async readPage(...params) {
        const method = this.useSplash ? this.getPageContentWithSplash : this.getPageContentWithPuppeteer;
        return await method.apply(this, params);
    }
}

module.exports = PageReader;