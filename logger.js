const pino = require('pino');

const logger = pino({
        level: process.env.LOG_LEVEL || 'INFO',

        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: true,
                ignore: 'pid,hostname'
            }
        },
    }
);

module.exports = logger;
