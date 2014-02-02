var assert = require('assert');
var _ = require('lodash');
var safe = require('safe');
var tutils = require("./utils");

describe.skip('Misc', function () {
    var db;
    before(function (done) {
        tutils.getDb('misc', true, safe.sure(done, function (_db) {
            db = _db;
            done();
        }));
    });
    it('GH-20,GH-17 toArray should not fail/close with one record or count', function (done) {
        db.collection("GH2017", {}, safe.sure(done, function (_coll) {
            _coll.insert({}, safe.sure(done, function () {
                var cursor = _coll.find();
                cursor.count(safe.sure(done, function (res) {
                    assert.equal(res, 1);
                    cursor.toArray(done);
                }));
            }));
        }));
    });
    it('GH-19 Unset must clean key from object', function (done) {
        db.collection("GH19", {}, safe.sure(done, function (_coll) {
            _coll.insert({name: 'Tony', age: '37'}, safe.sure(done, function () {
                _coll.findAndModify({}, {age: 1}, {$set: {name: 'Tony'}, $unset: { age: true }}, {new: true}, safe.sure(done, function (doc) {
                    assert(!_.contains(_.keys(doc), 'age'));
                    _coll.findOne({}, {age: 1}, safe.sure(done, function (obj) {
                        assert(!_.contains(_.keys(obj), 'age'));
                        done();
                    }));
                }));
            }));
        }));
    });
    it('GH-14 Exclude projection for _id can be mixed with include projections', function (done) {
        db.collection("GH14", {}, safe.sure(done, function (_coll) {
            _coll.insert({name: 'Tony', age: '37'}, safe.sure(done, function () {
                _coll.findOne({}, {_id: 0, age: 1}, safe.sure(done, function (obj) {
                    assert(!_.contains(_.keys(obj), '_id'));
                    assert(_.contains(_.keys(obj), 'age'));
                    assert(!_.contains(_.keys(obj), 'name'));
                    _coll.findOne({}, {age: 1}, safe.sure(done, function (obj) {
                        assert(_.contains(_.keys(obj), '_id'));
                        assert(_.contains(_.keys(obj), 'age'));
                        assert(!_.contains(_.keys(obj), 'name'));
                        _coll.findOne({}, {age: 0}, safe.sure(done, function (obj) {
                            assert(_.contains(_.keys(obj), '_id'));
                            assert(!_.contains(_.keys(obj), 'age'));
                            assert(_.contains(_.keys(obj), 'name'));
                            _coll.findOne({}, {_id: 0, age: 0}, safe.sure(done, function (obj) {
                                assert(!_.contains(_.keys(obj), '_id'));
                                assert(!_.contains(_.keys(obj), 'age'));
                                assert(_.contains(_.keys(obj), 'name'));
                                _coll.findOne({}, {_id: 1, age: 0}, function (err) {
                                    assert(err);
                                    done();
                                });
                            }));
                        }));
                    }));
                }));
            }));
        }));
    });
    it('GH-26 sort order can also be optional for findAndRemove', function (done) {
        db.collection("GH26", {}, safe.sure(done, function (_coll) {
            _coll.insert({}, safe.sure(done, function () {
                _coll.findAndRemove({}, done);
            }));
        }));
    });
});
