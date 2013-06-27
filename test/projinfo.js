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

const projinfo = require('../lib/projinfo');


var PROJDIR = path.resolve(__dirname, '..');

var TOP_LEVEL_KEYS = ["AWSTemplateFormatVersion", "Boxen", "Description", 
                      "Outputs", "Parameters", "Resources"];

describe('projinfo loader', function() {

  it('loads a .awsbox.json file into a default config', function(done) {
    var pi = projinfo(PROJDIR, null, true);
    pi.loadConfig(function(err, cfg) {
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
    var pi = projinfo(PROJDIR, 'ExtraAWSBoxSettingsTL', true);
    pi.loadConfig(function(err, cfg) {
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
    var pi = projinfo(PROJDIR, 'ExtraAWSBoxSettingsEX', true);
    pi.loadConfig(function(err, cfg) {
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
    var pi = projinfo(PROJDIR, 'RemoveDefaultBoxen', true);
    pi.loadConfig(function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(Object.keys(cfg).sort(), TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(cfg.Boxen), []);
      done();
    });
  });

  it('pre-processes to apply UserDataFiles template function', function(done) {
    var pi = projinfo(PROJDIR, 'FnUserDataFiles', true);
    pi.loadConfig(function(err, cfg) {
      assert.equal(err, null);
      assert.deepEqual(cfg.Resources.AWSBox.Properties.UserData, {
        "Fn::Base64": { "Fn::Join" : [ "\n", [
          "#!/bin/bash",
          "set -e -x",
          "cat << EOF_MARKER > /path/to/file.json",
          '{"config":"data","goes":"here"}',
          "EOF_MARKER",
          "cat << EOF_MARKER > /config/files/can",
          {"Fn::Join": [ "", [
            '{"reference":"', { "Ref": "TemplateParameters" }, '"}'
          ]]},
          "EOF_MARKER"
      ]]}});
      done();
    });
  });

});
