var main = require('../lib/main')({_tiar:0});
var temp = require('temp');
var _ = require('lodash');
var async = require('async');
var Db = require('mongodb').Db,
	Server = require('mongodb').Server;
var safe = require('safe');
var spawn = require('child_process').spawn;

var cfg = { db: "tingodb" };
var mongo = false;
module.exports.setConfig = function (cfg_) {
	_.defaults(cfg_, cfg);
	cfg = cfg_;
	mongo = cfg.db == 'mongodb';
};

var dbPort = 37017;
var dbInstance;

var startDb = module.exports.startDb = function (cb) {
	if (!mongo) return cb();
	if (dbInstance) return cb(new Error('Database already started'));
	var dbpath = temp.mkdirSync('mongodb');
	dbInstance = spawn('mongod', ['--noprealloc', '--nojournal',
			'--dbpath', dbpath, '--port', dbPort]);
	function ensureUp(retries, cb) {
		getDb('test', false, function (err, db) {
			if (err) {
				if (--retries < 1) {
					return cb(new Error('Failed to connect to db'));
				}
				setTimeout(function () {
					ensureUp(retries, cb);
				}, 500);
				return;
			}
			db.close(cb);
		});
	}
	ensureUp(3, cb);
};

var stopDb = module.exports.stopDb = function (cb) {
	cb = cb || function () {};
	if (!mongo) return cb();
	if (!dbInstance) return cb(new Error('Database is not started'));
	dbInstance.kill();
	dbInstance = null;
	cb();
};

var paths = {};

var getDb = module.exports.getDb = function (tag, drop, cb) {
	if (mongo) {
		var dbs = new Db(tag, new Server('localhost', dbPort),{w:1});
		dbs.open(safe.sure(cb, function (db) {
			if (drop) {
				db.dropDatabase(safe.sure(cb, function () {
					var dbs = new Db(tag, new Server('localhost', dbPort),{w:1});
					dbs.open(cb)
				}))
			} else
				cb(null,db)
		}))
	}
	else {
		if (drop)
			delete paths[tag];
		if (!paths[tag]) {
			paths[tag] = temp.mkdirSync(tag);
		} 
		var db = new main.Db(paths[tag], {});
		db.open(cb);
	}
};

module.exports.getDbSync = function (tag, db_options, server_options, drop) {
	if (mongo) {
		return new Db(tag, new Server('localhost', dbPort, server_options), db_options);
	} else {
		if (drop)
			delete paths[tag];
		if (!paths[tag]) {
			paths[tag] = temp.mkdirSync(tag);
		} 
		return new main.Db(paths[tag], {name:tag});
	}
};

module.exports.openEmpty = function (db, cb) {
	db.open(safe.sure(cb, function () {
		if (mongo) {
			db.dropDatabase(cb);
		} else {
			// nothing to do: for tingodb we can request
			// empty database with getDbSync
			cb();
		}
	}));
};

module.exports.getDbPackage = function () {
	return mongo ? require('mongodb') : main;
};
