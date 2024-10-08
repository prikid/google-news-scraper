const winston = require('winston');

const config = {
    levels: {
        none: 0,
        error: 1,
        warn: 2,
        info: 3,
        verbose: 4,
    },
    colors: {
        none: 'black',
        error: 'red',
        warn: 'yellow',
        info: 'blue',
        verbose: 'white',
    }
};

winston.addColors(config.colors);

const logger = winston.createLogger({
    levels: config.levels,
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
    ),
    transports: [
        new winston.transports.Console()
    ],
    level: process.env.LOG_LEVEL || 'info',
});

module.exports = logger;
