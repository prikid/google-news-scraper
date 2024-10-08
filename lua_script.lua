function main(splash, args)
    assert(splash:go(args.url))
    assert(splash:wait(5))

    local favicon_js = [[
        (function() {
            var links = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
            if (links.length > 0) {
                return links[0].href;
            } else {
                return location.origin + '/favicon.ico';
            }
        })()
    ]]

    local favicon = splash:evaljs(favicon_js)

    return {
        html = splash:html(),
        url = splash:url(),
        favicon = favicon
    }
end