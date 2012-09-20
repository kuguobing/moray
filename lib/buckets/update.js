// Copyright 2012 Joyent, Inc.  All rights reserved.

var util = require('util');

var assert = require('assert-plus');
var deepEqual = require('deep-equal');
var uuid = require('node-uuid');
var vasync = require('vasync');

var common = require('./common');
require('../errors');


///--- Globals

var sprintf = util.format;



///--- Handlers

function loadIndexes(req, cb) {
        var b = req.bucket;
        var log = req.log;
        var pg = req.pg;
        var q;
        var row;
        var sql = sprintf('SELECT index FROM buckets_config WHERE name=\'%s\'',
                          b.name);

        log.debug({
                bucket: b.name
        }, 'loadBucket: entered');

        q = pg.query(sql);
        q.once('error', function (err) {
                log.debug({
                        bucket: b.name,
                        err: err
                }, 'loadIndexes: failed');
                cb(err);
        });

        q.once('row', function (r) {
                row = r;
        });

        q.once('end', function (r) {
                if (!row) {
                        cb(new BucketNotFoundError(req.bucket.name));
                } else {
                        req.index = JSON.parse(row.index);
                        log.debug({
                                bucket: b.name,
                                oldIndex: req.index
                        }, 'loadIndexes: done');
                        cb();
                }
        });
}


function updateConfig(req, cb) {
        var bucket = req.bucket;
        var log = req.log;
        var pg = req.pg;
        var q;
        var sql = 'UPDATE buckets_config ' +
                'SET index=$1, pre=$2, post=$3, options=$4 ' +
                'WHERE name=$5';
        var values = [JSON.stringify(bucket.index)];
        values.push(JSON.stringify((bucket.pre || []).map(function (f) {
                return (f.toString());
        })));
        values.push(JSON.stringify((bucket.post || []).map(function (f) {
                return (f.toString());
        })));
        values.push(JSON.stringify(bucket.options || {}));
        values.push(bucket.name);

        log.debug({
                bucket: bucket.name,
                values: values
        }, 'updateConfig: entered');
        q = pg.query(sql, values);

        q.once('error', function (err) {
                log.debug({
                        bucket: bucket.name,
                        err: err
                }, 'updateConfig: failed');
                cb(err);
        });

        q.once('end', function () {
                log.debug({
                        bucket: bucket.name
                }, 'updateConfig: done');
                cb();
        });
}


function calculateDiff(req, cb) {
        var diff = {
                add: [],
                del: [],
                mod: []
        };
        var next = req.bucket.index;
        var prev = req.index;

        Object.keys(next).forEach(function (k) {
                if (prev[k] === undefined) {
                        diff.add.push(k);
                } else if (!deepEqual(next[k], prev[k])) {
                        diff.mod.push(k);
                }
        });

        Object.keys(prev).forEach(function (k) {
                if (!next[k]) {
                        diff.del.push(k);
                }
        });

        req.diff = diff;
        req.log.debug({
                bucket: req.bucket.name,
                diff: req.diff
        }, 'calculateDiff: done');
        cb();
}


function dropColumns(req, cb) {
        if (req.diff.del.length === 0)
                return (cb());

        var log = req.log;
        var pg = req.pg;
        var sql = sprintf('ALTER TABLE %s DROP COLUMN ', req.bucket.name);

        log.debug({
                bucket: req.bucket.name,
                del: req.diff.del.join(', ')
        }, 'dropColumns: entered');
        vasync.forEachParallel({
                func: function _drop(c, _cb) {
                        var q = pg.query(sql + c);
                        q.once('error', _cb);
                        q.once('end', function () {
                                _cb();
                        });
                },
                inputs: req.diff.del
        }, function (err) {
                log.debug({
                        bucket: req.bucket.name,
                        err: err
                }, 'dropColumns: %s', err ? 'failed' : 'done');
                cb(err);
        });

        return (undefined);
}


function addColumns(req, cb) {
        if (req.diff.add.length === 0)
                return (cb());

        var log = req.log;
        var pg = req.pg;
        var sql = sprintf('ALTER TABLE %s ADD COLUMN ', req.bucket.name);

        log.debug({
                bucket: req.bucket.name,
                add: req.diff.add.join(', ')
        }, 'addColumns: entered');
        vasync.forEachParallel({
                func: function _drop(c, _cb) {
                        var str = sql + c +
                                ' ' + common.typeToPg(req.bucket.index[c].type);
                        log.debug({
                                bucket: req.bucket.name,
                                sql: str
                        }, 'addColumns: adding column');
                        var q = pg.query(str);
                        q.once('error', _cb);
                        q.once('end', function () {
                                _cb();
                        });
                },
                inputs: req.diff.add
        }, function (err) {
                log.debug({
                        bucket: req.bucket.name,
                        err: err
                }, 'dropColumns: %s', err ? 'failed' : 'done');
                cb(err);
        });

        return (undefined);
}


function createIndexes(req, cb) {
        if (req.diff.add.length === 0)
                return (cb());

        var add = req.diff.add.filter(function (k) {
                return (!req.bucket.index[k].unique);
        });

        if (add.length === 0)
                return (cb());

        common.createIndexes({
                bucket: req.bucket.name,
                log: req.log,
                pg: req.pg,
                indexes: add
        }, cb);

        return (undefined);
}


function createUniqueIndexes(req, cb) {
        if (req.diff.add.length === 0)
                return (cb());

        var add = req.diff.add.filter(function (k) {
                return (req.bucket.index[k].unique);
        });

        if (add.length === 0)
                return (cb());

        common.createIndexes({
                bucket: req.bucket.name,
                log: req.log,
                pg: req.pg,
                unique: true,
                indexes: add
        }, cb);

        return (undefined);
}


function update(options) {
        assert.object(options, 'options');
        assert.object(options.log, 'options.log');
        assert.object(options.manatee, 'options.manatee');

        var manatee = options.manatee;

        function _update(name, cfg, opts, res) {
                var log = options.log.child({
                        req_id: opts.req_id || uuid.v1()
                });

                log.debug({
                        bucket: name,
                        cfg: cfg,
                        opts: opts
                }, 'updateBucket: entered');

                manatee.start(function (startErr, pg) {
                        if (startErr) {
                                log.debug(startErr,
                                          'updateBucket: no DB handle');
                                res.end(startErr);
                                return;
                        }

                        log.debug({
                                pg: pg
                        }, 'updateBucket: transaction started');

                        vasync.pipeline({
                                funcs: [
                                        common.validateBucket,
                                        loadIndexes,
                                        updateConfig,
                                        calculateDiff,
                                        dropColumns,
                                        addColumns,
                                        createIndexes,
                                        createUniqueIndexes
                                ],
                                arg: {
                                        bucket: {
                                                name: name,
                                                index: cfg.index || {},
                                                pre: cfg.pre || [],
                                                post: cfg.post || []
                                        },
                                        log: log,
                                        pg: pg,
                                        manatee: manatee
                                }
                        }, common.pipelineCallback({
                                log: log,
                                name: 'updateBucketBucket',
                                pg: pg,
                                res: res
                        }));
                });
        }

        return (_update);
}



///--- Exports

module.exports = {
        update: update
};