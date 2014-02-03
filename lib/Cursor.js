var _ = require('lodash');
var safe = require('safe');
var async = require('async');
var CursorStream = require('./CursorStream');


Cursor.INIT = 0;
Cursor.OPEN = 1;
Cursor.CLOSED = 2;
Cursor.GET_MORE = 3;
function Cursor(tcoll, query, fields, opts) {
    var self = this;
    this._query = query;
    this._c = tcoll;
    this._i = 0;
    this._skip = 0;
    this._limit = null;
    this._count = null;
    this._items = null;
    this._sort = null;
    this._order = null;
    this._fieldsExcludeId = false;
    this._fields = {};
    this.timeout = 'timeout' in opts ? opts.timeout : true;

    _.each(fields, function (v, k) {
        if (!k && _.isString(v)) {
            k = v;
            v = 1;
        }
        if (v === 0 || v == 1) {
            // _id treated specially
            if (k == "_id" && v === 0) {
                self._fieldsExcludeId = true;
                return;
            }

            if (!self._fieldsType)
                self._fieldsType = v;
            if (self._fieldsType == v) {
                self._fields[k] = v;
            } else if (!self._err)
                self._err = new Error("Mixed set of projection options (0,1) is not valid");
        } else if (!self._err)
            self._err = new Error("Unsupported projection option: " + JSON.stringify(v));
    });
    // _id treated specially
    if ((self._fieldsType === 0 || self._fieldsType === null) && self._fieldsExcludeId) {
        self._fieldsType = 0;
        self._fields['_id'] = 0;
    }
}


Cursor.prototype.isClosed = function () {
    if (!this._items)
        return false;
    return this._i == -1 || this._i >= this._items.length;
};

Cursor.prototype.skip = function (v, cb) {
    var self = this;
    if (!_.isFinite(v)) {
        self._err = new Error("skip requires an integer");
        if (!cb) throw self._err;
    }
    if (self._i) {
        self._err = new Error('Cursor is closed');
        if (!cb) throw self._err;
    }
    if (!self._err)
        this._skip = v;
    if (cb)
        process.nextTick(function () {cb(self._err, self);});
    return this;
};


Cursor.prototype.sort = function (v, cb) {
    if (_.isNumber(cb) || _.isString(cb)) { // handle sort(a,1)
        v = {v: cb};
        cb = null;
    }

    if (this._i) this._err = new Error('Cursor is closed');

    if (this._err) return this;

    if (!_.isObject(v)) {
        if (!_.isString(v)) {
            this._err = new Error("Illegal sort clause, must be of the form [['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");
        } else {
            this._sort = v;
            this._order = 1;
        }
    } else {
        if (_.size(v) <= 2) {
            if (_.isArray(v)) {
                if (_.isArray(v[0])) {
                    this._sort = v[0][0];
                    this._order = v[0][1];
                } else {
                    this._sort = v[0];
                    this._order = 1;
                }
            } else {
                this._sort = _.keys(v)[0];
                this._order = v[this._sort];
            }
            if (this._sort) {
                if (this._order == 'asc')
                    this._order = 1;
                if (this._order == 'desc')
                    this._order = -1;
                if (!(this._order == 1 || this._order == -1))
                    this._err = new Error("Illegal sort clause, must be of the form [['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");
            }
        } else this._err = new Error("Multi field sort is not supported");
    }

    if (!this._err)
        this.sortValue = v;

    var self = this;
    if (cb)
        process.nextTick(function () {cb(self._err, self);});

    return this;
};


Cursor.prototype.limit = function (v, cb) {
    var self = this;
    if (!_.isFinite(v)) {
        self._err = new Error("limit requires an integer");
        if (!cb) throw self._err;
    }
    if (self._i) {
        self._err = new Error('Cursor is closed');
        if (!cb) throw self._err;
    }
    if (!self._err) {
        this._limit = v === 0 ? null : Math.abs(v);
    }
    if (cb)
        process.nextTick(function () {cb(self._err, self);});
    return this;
};


Cursor.prototype.nextObject = function (cb) {
    var self = this;
    if (self._err) {
        if (cb) process.nextTick(function () {cb(self._err);});
        return;
    }
    self._ensure(safe.sure(cb, function () {
        if (self._i >= self._items.length)
            return cb(null, null);
        self._get(self._items[self._i], cb);
        self._i++;
    }));
};


Cursor.prototype.count = function (applySkipLimit, cb) {
    var self = this;
    if (!cb) {
        cb = applySkipLimit;
        applySkipLimit = false;
    }
    if (self._err) {
        if (cb) process.nextTick(function () {cb(self._err);});
        return;
    }
    if ((!self._skip && self._limit === null) || applySkipLimit) {
        self._ensure(safe.sure(cb, function () {
            cb(null, self._items.length);
        }));
        return;
    }
    if (self._count !== null) {
        process.nextTick(function () {
            cb(null, self._count);
        });
        return;
    }
    var data = self._c._find(self._query, {}, 0);
    self._count = data.length;
    cb(null, self._count);
};


//noinspection JSUnusedGlobalSymbols
Cursor.prototype.setReadPreference = function (the, cb) {
    var self = this;
    if (self._err) {
        if (cb) process.nextTick(function () {cb(self._err);});
        return;
    }
    return this;
};


Cursor.prototype.batchSize = function (v, cb) {
    var self = this;
    if (!_.isFinite(v)) {
        self._err = new Error("batchSize requires an integer");
        if (!cb) throw self._err;
    }
    if (self._i) {
        self._err = new Error('Cursor is closed');
        if (!cb) throw self._err;
    }
    if (cb) process.nextTick(function () {cb(self._err, self);});
    return this;
};


Cursor.prototype.close = function (cb) {
    var self = this;
    this._items = [];
    this._i = -1;
    this._err = null;
    if (cb)
        process.nextTick(function () {cb(self._err, self);});
    return this;
};


//noinspection JSUnusedGlobalSymbols
Cursor.prototype.rewind = function () {
    this._i = 0;
    return this;
};


Cursor.prototype.toArray = function (cb) {
    if (!_.isFunction(cb))
        throw new Error('Callback is required');
    var self = this;

    if (self.isClosed())
        self._err = new Error("Cursor is closed");

    if (self._err) {
        process.nextTick(function () {cb(self._err);});
        return;
    }

    self._ensure(function () {
        var iteratorValue = self._i;
        var docs = self._items.slice(iteratorValue);
        cb(null, docs);
    });
};


Cursor.prototype.each = function (cb) {
    if (!_.isFunction(cb))
        throw new Error('Callback is required');

    var self = this;

    if (self.isClosed())
        self._err = new Error("Cursor is closed");

    if (self._err) {
        if (cb) process.nextTick(function () {cb(self._err);});
        return;
    }
    self._ensure(safe.sure(cb, function () {
        async.forEachSeries(self._i ? self._items.slice(self._i, self._items.length) : self._items, function (pos, cb1) {
            self._get(pos, safe.sure(cb, function (obj) {
                cb(null, obj);
                cb1();
            }));
        }, safe.sure(cb, function () {
            self._i = self._items.length;
            cb(null, null);
        }));
    }));
};


Cursor.prototype.stream = function (options) {
    return new CursorStream(this, options);
};


Cursor.prototype._ensure = function (cb) {
    var self = this;
    if (self._items) return process.nextTick(cb);
    var data = self._c._find(self._query, {}, self._skip, self._limit, self._sort, self._order);
    data = data.map(self._projectFields.bind(self));
    self._items = data;
    self._i = 0;
    cb(null, data);
};


Cursor.prototype._projectFields = function (obj) {
    if ('_fieldsType' in this) {
        var keys = _(this._fields).keys().map(function (o) { return o.split('.')[0]; }).valueOf();
        if (this._fieldsType === 0)
            obj = _.omit(obj, keys);
        else {
            if (!this._fieldsExcludeId)
                keys.push('_id');
            obj = _.pick(obj, keys);
        }
    }
    return obj;
};


Cursor.prototype._get = function (pos, cb) {
    cb(null, this._projectFields(pos));
};


module.exports = Cursor;