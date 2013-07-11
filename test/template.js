/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* 
 * Testcases for projinfo config file loading/merging.
 * These require the awsboxen projet itself to provide the test data,
 * so they must be run from a git checkout.
 *
 */

const assert = require('assert');
const path = require('path');

const loadTemplate = require('../lib/loadTemplate');


var PROJDIR = path.resolve(__dirname, '..');

var TOP_LEVEL_KEYS = ["AWSTemplateFormatVersion", "Boxen", "Description", 
                      "Outputs", "Parameters", "Resources"];


describe('template loader', function() {

  it('loads a .awsbox.json file into a default config', function(done) {
    var opts = { ignore_uncommitted: true };
    loadTemplate(PROJDIR, opts, function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(Object.keys(cfg).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(cfg.Boxen), ['AWSBox']);
      assert.equal(cfg.Boxen.AWSBox.Type, 'AWSBox');
      assert.deepEqual(Object.keys(cfg.Boxen.AWSBox.Properties).sort(),
                       ['env', 'processes']);
      assert.deepEqual(Object.keys(cfg.Resources).sort(),
                       ["AWSBoxSecurityGroup","AWSBoxServer"]);
      done();
    });
  });

  it('merges profile AWSBox settings from top-level keys', function(done) {
    var opts = { ignore_uncommitted: true, profile: 'ExtraAWSBoxSettingsTL' };
    loadTemplate(PROJDIR, opts, function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(Object.keys(cfg).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(cfg.Boxen), ['AWSBox']);
      assert.deepEqual(Object.keys(cfg.Boxen.AWSBox.Properties).sort(),
                       ['env', 'hooks', 'processes']);
      assert.deepEqual(Object.keys(cfg.Resources).sort(),
                       ["AWSBoxSecurityGroup","AWSBoxServer"]);
      assert.deepEqual(cfg.Boxen.AWSBox.Properties.processes,
                       ['somethingelse.js']);
      done();
    });
  });

  it('merges profile AWSBox settings from explicit decl', function(done) {
    var opts = { ignore_uncommitted: true, profile: 'ExtraAWSBoxSettingsEX' };
    loadTemplate(PROJDIR, opts, function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(Object.keys(cfg).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(cfg.Boxen), ['AWSBox']);
      assert.deepEqual(Object.keys(cfg.Boxen.AWSBox.Properties).sort(),
                       ['env', 'hooks', 'processes']);
      assert.deepEqual(Object.keys(cfg.Resources).sort(),
                       ["AWSBoxSecurityGroup","AWSBoxServer"]);
      assert.deepEqual(cfg.Boxen.AWSBox.Properties.processes,
                       ['somethingelse.js']);
      done();
    });
  });

  it('allows a profile to remove the default AWSBox boxen', function(done) {
    var opts = { ignore_uncommitted: true, profile: 'RemoveDefaultBoxen' };
    loadTemplate(PROJDIR, opts, function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(Object.keys(cfg).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(cfg.Boxen), []);
      done();
    });
  });

  it('resolves params and function calls in boxen definitions', function(done) {
    var opts = {
      ignore_uncommitted: true,
      profile: 'ParameterizedBoxen',
      aws_region: 'us-east-1',
    };
    loadTemplate(PROJDIR, opts, function(err, cfg) {
      assert.equal(err, null);
      assert.equal(cfg.Boxen.TestRegionMap.Properties.BaseAMI, "ami-EAST");
      assert.equal(cfg.Boxen.TestParam.Properties.BaseAMI, "DefaultValue");
      opts.aws_region = 'us-west-1';
      opts.define = {'UserParam1': 'UserValue'};
      loadTemplate(PROJDIR, opts, function(err, cfg) {
        assert.equal(cfg.Boxen.TestRegionMap.Properties.BaseAMI, "ami-WEST");
        assert.equal(cfg.Boxen.TestParam.Properties.BaseAMI, "UserValue");
        done();
      });
    });
  });

});
