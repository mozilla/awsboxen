/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Functions for freezing code into an AMI using a simple buildscript.
 *
 * This is the super-simple way of building out an AMI.  You specify a
 * base image and a script file to execute on an instance of that image.
 * We boot the instance, write out the script to a temp file, execute it
 * and remove it.
 *
 * Two additional conveniences:
 *
 *    - You can specify a list of scripts to run in order, which may be
 *      helpful for re-using some common logic.
 *
 *    - You can use {"Ref": "ParamName"} in the script for simple replacement
 *      of template parameters.
 *
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const async = require('async');
const temp = require('temp');
const aws = require('awssum-amazon');
const Ec2 = require('awssum-amazon-ec2').Ec2;
const awsbox = {
  key: require('awsbox/lib/key'),
  sec: require('awsbox/lib/sec')
};

const freezer = require('../freezer.js');
const template = require('../template.js');


module.exports = {
  createInstance: createInstance,
  teardownInstance: teardownInstance,
  calcConfigHash: calcConfigHash,
  _loadBuildScripts: loadBuildScripts
};


var extractError = freezer._extractError;
var getConnection = freezer._getConnection;


// Create a running instance from a base AMI and a build script.
//
function createInstance(state, cb) {
  var boxProps = state.boxCfg.Properties;
  getConnection(state.opts, function(err, ec2) {
    if (err) return cb(err);

    async.waterfall([

      function fillInDefaults(cb) {
        if (!boxProps.User) boxProps.User = 'ec2-user';
        return cb(null);
      },

      function findKeyName(cb) {
        if (boxProps.KeyName) return cb(null);
        awsbox.key.getName(function(err, keyName) {
          if (err) return cb(err);
          boxProps.KeyName = keyName;
          return cb(null);
        });
      },

      function findSecurityGroup(cb) {
        if (boxProps.SecurityGroup) return cb(null);
        awsbox.sec.getName(null, function(err, groupName) {
          if (err) return cb(err);
          boxProps.SecurityGroup = groupName;
          return cb(null);
        });
      },

      function startInstance(cb) {
        var baseAMI = boxProps.BaseAMI;
        if (!baseAMI) return cb('Missing property: "BaseAMI"');
        console.log("Launching instance from AMI", baseAMI);
        // Start the arduous process of launching an instance.
        ec2.RunInstances({
          ImageId: baseAMI,
          MinCount: 1,
          MaxCount: 1,
          KeyName: boxProps.KeyName,
          SecurityGroup: boxProps.SecurityGroup,
          InstanceType: 'm1.small'
        }, function(err, res) {
          if (err) return cb(extractError(err));
          // Wait for the instance to come up.
          res = res.Body.RunInstancesResponse.instancesSet.item;
          var instanceId = res.instanceId;
          console.log("Launched instance:", instanceId);
          waitForInstanceState(ec2, instanceId, "running", function(err) {
            return cb(err, instanceId);
          });
        });
      },

      function setServerName(instanceId, cb) {
        ec2.CreateTags({
          ResourceId: instanceId,
          Tag: { "0.Key": "Name", "0.Value": state.imageName + '-freezer' }
        }, function(err) {
          if (err) return cb(extractError(err));
          return cb(null, instanceId);
        });
      },

      function findInstanceURL(instanceId, cb) {
        ec2.DescribeInstances({
          InstanceId: instanceId
        }, function(err, res) {
          if (err) return cb(extractError(err));
          res = res.Body.DescribeInstancesResponse;
          res = res.reservationSet.item.instancesSet.item;
          return cb(null, instanceId, res.dnsName);
        });
      },

      function waitForSSHAccess(instanceId, instanceURL, cb) {
        console.log("Waiting for ssh access to ", instanceURL);
        var hasSSH = false;
        async.doWhilst(function(cb) {
          setTimeout(function() {
            var s = new net.Socket({type: 'tcp4'});
            s.once('error', function() {
              console.log("  ssh not ready");
              s.destroy();
              cb(null);
            });
            s.once('timeout', function() {
              console.log("  ssh not ready");
              s.destroy();
              cb(null);
            });
            s.once('connect', function() {
              console.log("  ssh ready");
              hasSSH = true;
              s.destroy();
              cb(null);
            });
            s.setTimeout(1000);
            s.connect(22, instanceURL);
          }, 3000);
        }, function() {
          return !hasSSH;
        }, function(err) {
          return cb(err, instanceId, instanceURL);
        });
      },

      function runBuildScripts(instanceId, instanceURL, cb) {
        loadBuildScripts(state, function(err, buildScriptBodies) {
          if (err) return cb(err);
          async.eachSeries(buildScriptBodies, function(buildScriptBody, cb) {
            var tf = temp.openSync();
            fs.writeSync(tf.fd, buildScriptBody);
            fs.closeSync(tf.fd);
            console.log("Copying build script");
            var remoteHost =  boxProps.User + '@' + instanceURL;
            var args = ['-o', 'StrictHostKeyChecking no',
                        tf.path, remoteHost + ':/tmp/buildit'];
            var p = child_process.spawn('scp', args,
                                    {stdio: 'inherit', cwd: state.workDir});
            p.on('exit', function(code, signal) {
              var err = code || signal;
              if (err) return cb('Failed to copy build script');
              fs.unlinkSync(tf.path);
              console.log("Running build script");
              var cmd = 'chmod +x /tmp/buildit && sudo /tmp/buildit';
              var args = ['-t', '-o', 'StrictHostKeyChecking no',
                          remoteHost, cmd];
              var p = child_process.spawn('ssh', args,
                                     {stdio: 'inherit', cwd: state.workDir});
              p.on('exit', function(code, signal) {
                var err = code || signal;
                return cb(err);
              });
            });
          }, function(err) {
            return cb(err, instanceId, instanceURL);
          });
        });
      }

    ], function(err, instanceId) {
      return cb(err, instanceId);
    });
  });
}


function teardownInstance(state, cb) {
  getConnection(state.opts, function(err, ec2) {
    ec2.TerminateInstances({
      InstanceId: state.instanceId
    }, function(err) {
      if (err) return cb(extractError(err));
      waitForInstanceState(ec2, state.instanceId, "terminated", function(err) {
        return cb(err);
      });
    });
  });
} 


function waitForInstanceState(ec2, instanceId, targetState, cb) {
  // These are the states it's allowed to pass through on its way
  // to something stable.  Unless, of course, it's the target state.
  var transientStates = ['pending', 'shutting-down', 'stopping'];
  var stateIdx = transientStates.indexOf(state);
  if (stateIdx !== -1) {
    transientStates.splice(stateIdx, 1);
  }
  var state = null;
  console.log("Waiting for instance", instanceId, "to be", targetState);
  async.doWhilst(function(cb) {
    // Poll for the state after some delay.
    setTimeout(function() {
      ec2.DescribeInstances({
        InstanceId: instanceId
      }, function(err, res) {
        if (err) return cb(extractError(err));
        res = res.Body.DescribeInstancesResponse;
        res = res.reservationSet.item.instancesSet.item;
        state = res.instanceState.name;
        console.log("  instance is:", state);
        cb(null);
      });
    }, 8000);
  }, function() {
    // Keep looping while it's in a transient state.
    return transientStates.indexOf(state) !== -1;
  }, cb);
}


//  Calculate a hash representing the config of the given box.
//  In our case the box depends only on the BaseAMI and the contents of
//  the build scripts, so we don't have to include e.g. the current
//  commit hash of the git repo.
//
function calcConfigHash(state, cb) {
  var configHasher = crypto.createHash('sha1');
  configHasher.update(state.projName);
  configHasher.update(state.boxName);
  configHasher.update(JSON.stringify(state.boxCfg));
  var boxProps = state.boxCfg.Properties;
  configHasher.update(boxProps.BaseAMI || "");
  loadBuildScripts(state, function(err, buildScriptBodies) {
    if (err) return cb(err);
    async.eachSeries(buildScriptBodies, function(buildScriptBody, cb) {
      configHasher.update(buildScriptBody);
      return cb(null);
    }, function(err) {
      if (err) return cb(err);
      return cb(null, configHasher.digest('base64'));
    });
  });
}


//  Helper function to load buildscript contents, interpolating
//  template parameters into each.
//

const PARAM_REFERENCE = /\{\s*["']Ref["']\s*:\s*["']([^"']*)["']\s*\}/g;

function loadBuildScripts(state, cb) {
  var boxProps = state.boxCfg.Properties;
  var buildScriptFiles = boxProps.BuildScripts || [];
  if (boxProps.BuildScript) {
      buildScriptFiles.push(boxProps.BuildScript);
  }
  var buildScriptBodies = [];
  async.eachSeries(buildScriptFiles, function(buildScriptFile, cb) {
    buildScriptFile = path.join(state.workDir, buildScriptFile);
    fs.readFile(buildScriptFile, function(err, data) {
      if (err) return cb(err);
      // Use a regexp to interpolate {"Ref": "Param"} values.
      // Yes yes, now I have two problems.  Honey Badger don't care.
      data = data.toString().replace(PARAM_REFERENCE, function(match, param) {
        return template.resolveParam(param, state.opts, state.cfg);
      });
      buildScriptBodies.push(data);
      return cb(null);
    });
  }, function(err) {
    if (err) return cb(err);
    return cb(null, buildScriptBodies);
  });
}
