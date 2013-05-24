/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Functions for freezing code into an AMI using awsbox.
 *
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const async = require('async');

const freezer = require('../freezer.js');

// Need path to awsbox executable, so we can shell out to it.
// This ensures we always use the locally-bundled one given to us by npm.
const AWSBOX = require.resolve('awsbox/awsbox.js');


module.exports = {
  createInstance: createInstance,
  teardownInstance: teardownInstance
};


// Create a running instance from an awsbox configuration.
// This function writes the provided awsbox config directly into the working
// directory, then shells out to awsbox to generate a running instance.
// Inelegant, but effective enough for now.
//
function createInstance(state, cb) {
  async.waterfall([

    function writeAwsBoxConfig(cb) {
      try {
        var cfg = JSON.stringify(state.boxCfg.Properties);
        fs.writeFile(path.join(state.workDir, '.awsbox.json'), cfg, cb);
      } catch (err) { return cb(err); }
    },

    function createAwsInstance(cb) {
      var serverName = state.imageName + '-freezer';
      // Spawn awsbox as a sub-process.
      // We capture stdout through a pipe, but also buffer it in
      // memory so that we can grab info out of it.
      var output = '';
      var p = child_process.spawn(AWSBOX,
                              ['create', '-n', serverName, '-t', 'm1.small'],
                              {stdio: [0, 'pipe', 2], cwd: state.workDir});
      p.stdout.on('data', function(d) {
        process.stdout.write(d);
        output += d;
      });
      p.on('exit', function(code, signal) {
        var err = code || signal;
        if (err) return cb(err);
        // Parse out the instance details from the awsbox output.
        // This is...err...a little suboptimal...
        var instanceId = output.match(/"instanceId": "([a-z0-9\-]+)",/)[1];
        if (!instanceId) return cb('awsbox failure');
        return cb(null, serverName, instanceId);
      });
    },

    function pushCurrentCommit(serverName, instanceId, cb) {
      // Push the current commit up to the awsbox.
      var p = child_process.spawn('git',
                                  ['push', serverName, 'HEAD:master'],
                                  {stdio: 'inherit', cwd: state.workDir});
      p.on('exit', function(code, signal) {
        var err = code || signal;
        return cb(err, instanceId);
      });
    } 

  ], cb);
}


function teardownInstance(state, cb) {
  var serverName = state.imageName + '-freezer';
  var p = child_process.spawn(AWSBOX, ['destroy', serverName],
                              {stdio: 'inherit', cwd: state.workDir});
  p.on('exit', function(code, signal) {
    cb(code || signal);
  });
}
