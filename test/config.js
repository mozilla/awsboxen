
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

  it('can merge several configs to give a root config', function(done) {
    config.loadRootConfig(testDataPath(''), 'simple', function(err, res) {
      assert.equal(err, null);
      assert.deepEqual(res, {
        one: 1,
        map: { key: 'value' },
        items: [ 'one', 'two', 'three' ]
      });
      done();
    });
  });

});
