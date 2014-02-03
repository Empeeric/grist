'use strict';
var path = require('path');

var _ = require('lodash');
var safe = require('safe');
var async = require('async');
var Promise = require('mpromise');

var Cursor = require('./Cursor');
var wqueue = require('./wqueue');
var tindex = require('./tindex');
var Cache = require("./Cache");
var Updater = require('./updater');


function Collection() {
    this._tdb = null;
    this._name = null;
    this._store = {};
    this._fd = null;
    this._fsize = null;
    this._id = 1;
    this._tq = null;
    this._idx = {};
    this._cache = null;
    // native mongo db compatibility attrs
    this.collectionName = null;
}
module.exports = Collection;


Collection.simplifyKey = function simplifyKey(key) {
    if (_.isNumber(key)) return key;
    return key.toJSON ? key.toJSON() : String(key);
};


Collection.prototype.init = function (tdb, name, options, callback) {
    var self = this;
    this._tdb = tdb;
    this._cache = new Cache(tdb, tdb._gopts.cacheSize);
    this._cmaxobj = tdb._gopts.cacheMaxObjSize || 1024;
    this._name = this.collectionName = name;
    this._filename = path.join(this._tdb._path, this._name + '.json');
    this._tq = new wqueue(100);

    var p = new Promise(callback);
    self._init_store(0, 0).then(
        function () {
            p.fulfill();
        }
    );
    return p;
};


Collection.prototype.drop = function (cb) {
    this._tdb.dropCollection(this._name, cb);
};


Collection.prototype.rename = function rename(nname, opts, cb) {
    var self = this;
    var err = self._tdb._nameCheck(nname);
    if (err) throw err;
    this._rename(nname, opts, cb);
};


Collection.prototype.createIndex = Collection.prototype.ensureIndex = function (obj, options, cb) {
    var self = this;
    if (_.isFunction(options) && !cb) {
        cb = options;
        options = {};
    }
    cb = cb || function () {};
    options = options || {};

    var p = new Promise(cb);
    var c = new Cursor(this, {}, {}, {});
    c.sort(obj);
    if (c._err) {
        p.reject(c._err);
        return p;
    }
    var key = c._sort;

    if (!key) throw new Error("No fields are specified");

    var index = self._idx[key];
    if (index) {
        p.fulfill(index.name);
        return p;
    }

    // force array support when global option is set
    if (_.isUndefined(options._tiarr) && self._tdb._gopts.searchInArray)
        options._tiarr = true;

    var index_name = key + "_" + (key == '_id' ? '' : c._order);
    index = self._idx[key] = new tindex(key, self, options, index_name);
    p.fulfill(index.name);
    return p;
};


Collection.prototype.indexExists = function (idx, cb) {
    if (!_.isArray(idx))
        idx = [idx];
    var i = _.intersection(idx, _(this._idx).values().map('name').value());
    cb(null, i.length == idx.length);
};


Collection.prototype.indexes = function (cb) {
    var self = this;
    this._tq.add(function (cb) {
        cb(null, _.values(self._idx));
    }, false, cb);
};


Collection.prototype.insert = function (docs, __, callback) {
    if (_.isFunction(__) && arguments.length == 2) {
        callback = __;
    }
    if (!_.isArray(docs))
        docs = [docs];
    var p = this._put_batch(docs);
    p.onResolve(callback);
    return p;
};


Collection.prototype.distinct = function (prop, match, options, cb) {
    var docs = this._find(match, prop, options);
    docs = _.unique(docs);
    cb(null, docs);
};


Collection.prototype._wrapTypes = function (obj) {
    var self = this;
    _.each(obj, function (v, k) {
        if (_.isDate(v))
            obj[k] = {$wrap: "$date", v: v.valueOf(), h: v};
        else if (v instanceof self._tdb.ObjectID)
            obj[k] = {$wrap: "$oid", v: v.toJSON()};
        else if (v instanceof self._tdb.Binary)
            obj[k] = {$wrap: "$bin", v: v.toJSON()};
        else if (_.isObject(v))
            self._wrapTypes(v);

    });
    return obj;
};

Collection.prototype._ensureIds = function (obj) {
    var self = this;
    _.each(obj, function (v, k) {
        if (k.length > 0) {
            if (k[0] == '$')
                throw new Error("key " + k + " must not start with '$'");

            if (k.indexOf('.') != -1)
                throw new Error("key " + k + " must not contain '.'");
        }
        if (_.isObject(v)) {
            if (v instanceof self._tdb.ObjectID) {
                if (v.id < 0) {
                    v._persist(++self._id);
                }
            }
            else
                self._ensureIds(v);
        }
    });
    return obj;
};


Collection.prototype._unwrapTypes = function (obj) {
    var self = this;
    _.each(obj, function (v, k) {
        if (_.isObject(v)) {
            switch (v.$wrap) {
                case "$date":
                    obj[k] = new Date(v.v);
                    break;
                case "$oid":
                    var oid = new self._tdb.ObjectID(v.v);
                    obj[k] = oid;
                    break;
                case "$bin":
                    var bin = new self._tdb.Binary(new Buffer(v.v, 'base64'));
                    obj[k] = bin;
                    break;
                default:
                    self._unwrapTypes(v);
            }
        }
    });
    return obj;
};


Collection.prototype.count = function (query, options, cb) {
    if (arguments.length == 1) {
        cb = arguments[0];
        options = null;
        query = null;
    }
    if (arguments.length == 2) {
        query = arguments[0];
        cb = arguments[1];
        options = null;
    }
    var docs = _.isEmpty(query) ? this._store : this._find(query, options);
    var p = new Promise(cb);
    p.fulfill(_.size(docs));
    return p;

};

Collection.prototype.stats = function (cb) {
    var self = this;
    this._tq.add(function (cb) {
        cb(null, {count: _.size(self._store)});
    }, false, cb);
};


var findOpts = ['limit', 'sort', 'fields', 'skip', 'hint', 'timeout', 'batchSize', 'safe', 'w'];

Collection.prototype.findOne = function () {
    var findArgs = _.toArray(arguments);
    var cb = findArgs.pop();
    var p = new Promise(cb);
    this.find.apply(this, findArgs).limit(1).nextObject(p.resolve.bind(p));
    return p;
};


function argsForFind(args) {
    var opts = {};
    if (args.length === 0) return opts;
    // guess callback, it is always latest
    var cb = _.last(args);
    if (_.isFunction(cb)) {
        args.pop();
        opts.cb = cb;
    }
    opts.query = args.shift();
    if (args.length === 0) return opts;
    if (args.length == 1) {
        var val = args.shift();
        // if val looks like findOpt
        if (_.intersection(_.keys(val), findOpts).length) {
            opts = _.merge(opts, val);
        } else {
            opts.fields = val;
        }
        return opts;
    }
    opts.fields = args.shift();
    if (args.length == 1) {
        opts = _.merge(opts, args.shift());
    } else {
        opts.skip = args.shift();
        opts.limit = args.shift();
    }
    return opts;
}


Collection.prototype.find = function () {
    var opts = argsForFind(_.toArray(arguments));
    var cursor = new Cursor(this, opts.query, opts.fields, opts);
    if (opts.skip) cursor.skip(opts.skip);
    if (opts.limit) cursor.limit(opts.limit);
    if (opts.sort) cursor.sort(opts.sort);
    if (opts.cb)
        return opts.cb(null, cursor);
    else
        return cursor;
};


Collection.prototype.update = function (query, doc, opts, callback) {
    var self = this;
    if (_.isFunction(opts) && !callback) {
        callback = opts;
    }
    opts = opts || {};
    if (opts.w > 0 && !_.isFunction(callback))
        throw new Error("Callback is required for safe update");
    callback = callback || function () {};
    if (!_.isObject(query))
        throw new Error("selector must be a valid JavaScript object");
    if (!_.isObject(doc))
        throw new Error("document must be a valid JavaScript object");

    var multi = opts.multi || false;
    var updater = new Updater(doc, self._tdb);
    var $doc = updater.hasAtomic() ? null : doc;
    var p = new Promise(callback);
    var res = self._find(query, null, 0, multi ? null : 1);
    if (_.isEmpty(res)) {
        if (!opts.upsert) return p.fulfill(0);
        $doc = $doc || query;
        $doc = self._tdb._cloneDeep($doc);
        updater.update($doc, true);
        if (_.isUndefined($doc._id))
            $doc._id = new self._tdb.ObjectID();

        self._put($doc).then(function () {
            p.fulfill(1, {updatedExisting: false, upserted: $doc._id, n: 1});
        });
        return;
    }
    var pr = Promise.fulfilled().end();
    res.forEach(function (obj) {
        var udoc = $doc;
        if (!$doc) {
            udoc = obj;
            updater.update(udoc);
        }
        udoc._id = obj._id;
        pr = pr.then(function () { return self._put(udoc);});
    });
    pr.then(
        function () {
            p.fulfill(res.length, {updatedExisting: true, n: res.length});
        }
    ).end();
    return p;
};


Collection.prototype.findAndModify = function (query, sort, doc, opts, cb) {
    var self = this;
    if (_.isFunction(opts) && !cb) {
        cb = opts;
        opts = {};
    }
    var updater = new Updater(doc, self._tdb);
    var $doc = updater.hasAtomic() ? null : doc;

    var c = new Cursor(this, {}, opts.fields || {}, {});
    c.sort(sort);
    if (c._err)
        return safe.back(cb, c._err);

    var res = self._find(query, null, 0, 1, c._sort, c._order);
    if (_.isEmpty(res)) {
        if (!opts.upsert) return cb();
        $doc = $doc || query;
        $doc = self._tdb._cloneDeep($doc);
        updater.update($doc, true);
        if (_.isUndefined($doc._id))
            $doc._id = new self._tdb.ObjectID();
        self._put($doc).onFulfill(function () { cb(null, opts.new ? c._projectFields($doc) : {}); }).end();
    } else {
        self._get(res[0], safe.sure(cb, function (obj) {
            var robj = (opts.new && !opts.remove) ? obj : self._tdb._cloneDeep(obj);
            // remove current version of doc from indexes
            _(self._idx).forEach(function (v) {
                v.del(obj, Collection.simplifyKey(obj._id));
            });
            var udoc = $doc;
            if (!$doc) {
                udoc = obj;
                updater.update(udoc);
            }
            udoc._id = obj._id;
            self._put(udoc).onFulfill(function () { cb(null, c._projectFields(robj)); }).end();
        }));
    }
};


Collection.prototype.save = function (doc, __, callback) {
    var args = _.toArray(arguments);
    callback = args.pop();
    callback = _.isFunction(callback) ? callback : null;
    doc = doc || {};
    if (_.isUndefined(doc._id)) {
        doc._id = new this._tdb.ObjectID();
    }
    var p = this._put(doc).onResolve(callback);
    return p;
};


Collection.prototype.remove = function (query, opts, callback) {
    var self = this;
    if (_.isFunction(query)) {
        callback = query;
        query = opts = {};
    } else if (_.isFunction(opts)) {
        callback = opts;
        opts = {};
    }
    opts = opts || {};
    if (opts.w > 0 && !_.isFunction(callback))
        throw new Error("Callback is required");
    callback = callback || function () {};
    var single = opts.single || false;
    var limit = single ? 1 : null;
    var res = self._find(query, null, 0, limit);
    var p = self._remove_batch(res).onResolve(callback);
    return p;
};

Collection.prototype.findAndRemove = function (query, sort, opts, cb) {
    var self = this;

    if (_.isFunction(sort) && !cb && !opts) {
        cb = sort;
        sort = {};
    } else if (_.isFunction(opts) && !cb) {
        cb = opts;
    }

    var c = new Cursor(this, {}, {}, {});
    c.sort(sort);
    if (c._err)
        return safe.back(cb, c._err);

    var res = self._find(query, null, 0, 1, c._sort, c._order);
    if (res.length === 0)
        return cb();
    var obj;
    self._get(res[0]).then(
        function (o) {
            obj = o;
            self._remove(o);
        }
    ).then(
        function () {
            cb(null, obj);
        }
    ).end();
};


Collection.prototype._stop_and_drop = function (cb) {
    this._stop();
    this._drop(cb);
};


require('./Collection-ext');
require('./Collection-storage');