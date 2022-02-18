'use strict';

const winston = require('winston');
const Transport = require('winston-transport');
const dayjs = require('dayjs');
const defaults = require('lodash.defaults');
const omit = require('lodash.omit');
const { Client } = require('@opensearch-project/opensearch');
const defaultTransformer = require('./transformer');
const BulkWriter = require('./bulk_writer');

class OpensearchTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.name = 'opensearch';
    this.handleExceptions = opts.handleExceptions || false;
    this.handleRejections = opts.handleRejections || false;
    this.exitOnError = false;
    this.source = null;

    this.on('pipe', (source) => {
      this.source = source;
    });

    this.on('error', (err) => {
      this.source.pipe(this); // re-pipes readable
    });

    this.opts = opts || {};

    // Set defaults
    defaults(opts, {
      level: 'info',
      index: opts.dataStream ? 'logs-app-default' : null,
      indexPrefix: 'logs',
      indexSuffixPattern: 'YYYY.MM.DD',
      transformer: defaultTransformer,
      useTransformer: true,
      ensureIndexTemplate: true,
      flushInterval: 2000,
      waitForActiveShards: 1,
      handleExceptions: false,
      exitOnError: false,
      pipeline: null,
      bufferLimit: null,
      buffering: true,
      healthCheckTimeout: '30s',
      healthCheckWaitForStatus: 'yellow',
      healthCheckWaitForNodes: '>=1',
      dataStream: false,
      internalLogger: console.error,
    });

    // Use given client or create one
    if (opts.client) {
      this.client = opts.client;
    } else {
      defaults(opts, {
        clientOpts: {
          log: [
            {
              type: 'console',
              level: 'error',
            }
          ]
        }
      });

      // Create a new ES client
      // http://localhost:9200 is the default of the client already
      const copts = { ...this.opts.clientOpts };
      this.client = new Client(copts);
    }

    const bulkWriterOpts = {
      index: opts.index,
      interval: opts.flushInterval,
      waitForActiveShards: opts.waitForActiveShards,
      pipeline: opts.pipeline,
      ensureIndexTemplate: opts.ensureIndexTemplate,
      indexTemplate: opts.indexTemplate,
      indexPrefix: opts.indexPrefix,
      buffering: opts.buffering,
      bufferLimit: opts.buffering ? opts.bufferLimit : 0,
      healthCheckTimeout: opts.healthCheckTimeout,
      healthCheckWaitForStatus: opts.healthCheckWaitForStatus,
      healthCheckWaitForNodes: opts.healthCheckWaitForNodes,
      dataStream: opts.dataStream,
      retryLimit: opts.retryLimit,
      internalLogger: opts.internalLogger,
    };

    this.bulkWriter = new BulkWriter(this, this.client, bulkWriterOpts);
    this.bulkWriter.start();
  }

  async flush() {
    await this.bulkWriter.flush();
  }

  // end() will be called from here: https://github.com/winstonjs/winston/blob/master/lib/winston/logger.js#L328
  end(chunk, encoding, callback) {
    this.bulkWriter.schedule = () => { };
    this.bulkWriter.flush().then(() => {
      setImmediate(() => {
        super.end(chunk, encoding, callback); // this emits finish event from stream
      });
    });
  }

  async log(info, callback) {
    const { level, message, timestamp } = info;
    const meta = Object.assign({}, omit(info, ['level', 'message']));
    setImmediate(() => {
      this.emit('logged', level);
    });

    const logData = {
      message,
      level,
      timestamp,
      meta,
    };

    const entry = this.opts.useTransformer
      ? await this.opts.transformer(logData)
      : info;

    let index = this.opts.dataStream
      ? this.opts.index
      : this.getIndexName(this.opts);

    if (this.opts.source) {
      entry.source = this.opts.source;
    }

    if (entry.indexInterfix !== undefined) {
      index = this.opts.dataStream
        ? this.getDataStreamName(this.opts, entry.indexInterfix)
        : this.getIndexName(this.opts, entry.indexInterfix);
      delete entry.indexInterfix;
    }

    console.log("indexName", index);
    console.log("appending", entry);
    this.bulkWriter.append(index, entry);

    callback();
  }

  getIndexName(opts, indexInterfix) {
    this.test = 'test';
    let indexName = opts.index;
    if (indexName === null) {
      // eslint-disable-next-line prefer-destructuring
      let indexPrefix = opts.indexPrefix;
      if (typeof indexPrefix === 'function') {
        // eslint-disable-next-line prefer-destructuring
        indexPrefix = opts.indexPrefix();
      }
      const now = dayjs();
      const dateString = now.format(opts.indexSuffixPattern);
      indexName = indexPrefix
        + (indexInterfix !== undefined ? '-' + indexInterfix : '')
        + '-'
        + dateString;
    }
    return indexName;
  }
}

winston.transports.OpensearchTransport = OpensearchTransport;

module.exports = {
  OpensearchTransport: OpensearchTransport,
  OpensearchTransformer: defaultTransformer
};
