/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* 
 * Testcases for configuration file loading.
 * These reqiure the data files located in ./config-test-data/
 *
 */

const assert = require('assert');
const path = require('path');

const config = require('../lib/config');


function testDataPath(name) {
  return path.join(__dirname, 'config-test-data', name);
}


describe('config loader', function() {

  it('can load a simple JSON file', function(done) {
    config.loadConfig(testDataPath('simple.json'), function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, {'one': 1, 'map': { 'key': 'value' }});
      done();
    });
  });

  it('can load a simple YAML file', function(done) {
    config.loadConfig(testDataPath('simple.yml'), function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, { 'items': ['one', 'two', 'three'] });
      done();
    });
  });

  it('can merge a complex directory structure', function(done) {
    config.loadConfig(testDataPath('merged'), function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, {
        Sub: {
          extras: ['check', 'check'],
          Sub2: {
            one: 1,
            two: 2,
            three: 3
          },
        },
        Items: {
          milk: true,
          bread: false
        }
      });
      done();
    });
  });

  it('can merge several configs into a root config', function(done) {
    config.loadRootConfig(testDataPath(''), ['simple'], function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, {
        one: 1,
        map: { key: 'value' },
        items: [ 'one', 'two', 'three' ]
      });
      done();
    });
  });

  it('can merge an explicit list of files into a root config', function(done) {
    var configPaths = [
      testDataPath('simple.json'),
      testDataPath('simple.yml')
    ];
    config.loadRootConfig(configPaths, function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, {
        one: 1,
        map: { key: 'value' },
        items: [ 'one', 'two', 'three' ]
      });
      done();
    });
  });

  it('merges config dicts in a sensible way', function(done) {
    assert.deepEqual(config.mergeConfig({one: 1, two: 2}, {two: null}),
                     {one: 1, two: null});
    assert.deepEqual(config.mergeConfig({one: 1, two: 2}, "hippopotamus"),
                     "hippopotamus");
    assert.deepEqual(config.mergeConfig("rhymenocerous", {one: 1, two: 2}),
                     {one: 1, two: 2});
    done();
  });

});
