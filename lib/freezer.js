/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Functions for freezing configured instances into an AMI.
 *
 * This is currently specialised towards using awsbox for the freezing,
 * but if the idea works out it could become quite generic and use e.g.
 * chef or puppet as an alternative for building the machine.
 *
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const async = require('async');
const temp = require('temp');
const crypto = require('crypto');
const aws = require('awssum-amazon');
const Ec2 = require('awssum-amazon-ec2').Ec2;

// Need path to awsbox executable, so we can shell out to it.
// This ensures we always use the locally-bundled one given to us by npm.
const AWSBOX = require.resolve('awsbox/awsbox.js');


module.exports = {
  createAMI: createAMI,
  _createAMIFromInstance: createAMIFromInstance,
  _getConnection: getConnection,
  _extractError: extractError
};


//  Get a connection to the EC2 API.
//  Use paramters from the given options, or defaults from environment.
//
function getConnection(opts, cb) {
  var ec2 = null;
  var err = null;
  try {
    ec2 = new Ec2({
      accessKeyId: opts.aws_id || process.env.AWS_ID,
      secretAccessKey: opts.aws_secret || process.env.AWS_SECRET,
      region: opts.aws_region || aws.US_EAST_1
    });
  } catch (e) { err = e; }
  cb(err, ec2);
}


// Extract a useful error object.
// This peeks inside the awssum error response to return the actual body,
// but passes other error object through unchanged.
//
// XXX TODO: de-duplicate this logic between EC2 and CFN handlers.
//
function extractError(err) {
  if (!err) return err;
  if (!err.Body) return err;
  if (!err.Body.Response || !err.Body.Response.Errors) return err.Body;
  return err.Body.Response.Errors;
}


// Create an AMI from a running EC2 instance.
// Currently it must be an EBS-backed instance, so that it can be
// stopped and snapshotted.  Eventually we might add other capabilities
// here, e.g. generating non-EBS-backed instances from an EBS-backed
// template.
//
function createAMIFromInstance(opts, instanceId, imageName, cb) {
  getConnection(opts, function(err, ec2) {
    if (err) return cb(err);
    console.log("Creating AMI", imageName, "from instance", instanceId);
    ec2.CreateImage({
      InstanceId: instanceId,
      Name: imageName,
      Description: imageName,
    }, function(err, res) {
      if (err) return cb(extractError(err));
      var imageId = res.Body.CreateImageResponse.imageId;
      // Loop waiting for the creation to complete.
      var state = null;
      async.doWhilst(function(cb) {
        setTimeout(function() {
          ec2.DescribeImages({ ImageId: imageId }, function(err, res) {
            if (err) return cb(extractError(err));
            state = res.Body.DescribeImagesResponse.imagesSet.item.imageState;
            console.log('AMI state: ' + state);
            cb(null);
          });
        }, 8000);
      }, function() {
        return state === 'pending';
      }, function(err) {
        if (err) return cb(err);
        if (state !== 'available') return cb('image creation failed');
        // Find the snapshot ID, and use it to set a friendly name
        // on the snapshot.  This makes it easier to clean them up.
        ec2.DescribeImages({ ImageId: imageId }, function(err, res) {
          if (err) return cb(extractError(err));
          res = res.Body.DescribeImagesResponse;
          var bdm = res.imagesSet.item.blockDeviceMapping;
          var snapshotId = bdm.item.ebs.snapshotId;
          console.log('Snapshot ID: ' + snapshotId);
          ec2.CreateTags({
            ResourceId: snapshotId,
            Tag: { "0.Key": "Name", "0.Value": imageName }
          }, function(err) {
            if (err) return cb(extractError(err));
            return cb(null, imageId);
          });
        });
      });
    });
  });
}


//  Check for an AMI, given the intended name.
//  This will return either the amiId, or null.
//
function checkAMI(opts, name, cb) {
  getConnection(opts, function(err, ec2) {
    if (err) return cb(err);
    ec2.DescribeImages({
      Filter: {Name: 'name', Value: name}
    }, function(err, res) {
      if (err) return cb(extractError(err));
      var id = null;
      if (res.Body.DescribeImagesResponse.imagesSet.item) {
        id = res.Body.DescribeImagesResponse.imagesSet.item.imageId;
      }
      cb(null, id);
    });
  });
}


// Create an AMI from a boxen configuration.
//
// This function calls out to boxen-type-dependent helper functions to
// create a running instance with the appropriate configurtion, then
// freezes it into an AMI using the AWS API.  It does the dumbest thing
// that could possibly work cleanly with content stored in git:
//
//   * clones the whole git repo into a temp directory
//   * configures it to point at the appropriate commit
//   * calls the helper, which can read/write whatever it likes
//   * freezes the running instance
//   * tears everything back down
//
// Inelegant, but effective enough for now.
//
//
function createAMI(opts, projDir, boxName, boxCfg, cb) {
  // This is the state that needs to be threaded between each of the
  // waterfalled functions below, and the instance creation helpers.
  // XXX TODO: refactor it into a proper class or something.
  var state = {
    opts: opts,
    workDir: null,
    boxName: boxName,
    boxCfg: boxCfg,
    imageName: null,
    currentCommit: null,
    helper: null,
    instanceId: null,
    amiId: null,
  };
  async.waterfall([

    function makeWorkingDir(cb) {
      temp.mkdir('awsboxen-freezer', function(err, dirPath) {
        if (err) return cb(err);
        state.workDir = dirPath;
        cb(null);
      });
    },

    function findCurrentCommit(cb) {
      child_process.exec('git log --pretty=%h -1', function(err, stdout) {
        if (err) return cb(err);
        state.currentCommit = stdout.trim();
        if (!state.currentCommit || state.currentCommit.length !== 7) {
          return cb('failed to get current commit');
        }
        cb(null);
      });
    },

    function constructImageName(cb) {
      // Name the image after the project, boxName, commit and config.
      // We hash anything that could affect the config into its identifier,
      // to prevent accidental AMI collisions.
      // XXX TODO: use tags instead of encoding it all in the name?
      var projName = path.basename(path.join(process.cwd(), projDir));
      var configHasher = crypto.createHash('sha1');
      configHasher.update(projName);
      configHasher.update(state.currentCommit);
      configHasher.update(boxName);
      configHasher.update(JSON.stringify(boxCfg));
      var configHash = configHasher.digest('base64');
      configHash = configHash.replace(/[\/\-\+]/g, '').slice(0, 6);
      state.imageName = [
        projName, boxName, state.currentCommit, configHash
      ].join('-');
      cb(null);
    },

    function skipIfImageAlreadyExists(cb) {
      checkAMI(opts, state.imageName, function(err, id) {
        if (err) return cb(err);
        state.amiId = id;
        if (id) {
          // 'break' out of the waterfall with a special error value.
          return cb('AWSBOXEN_AMI_ALREADY_EXISTS');
        }
        cb(null);
      });
    },

    function cloneGitRepoAtCurrentCommit(cb) {
      var p = child_process.spawn('git', ['clone', projDir, state.workDir]);
      p.on('exit', function(code, signal) {
        var err = code || signal;
        if (err) return cb(err);
        // The awsbox deploy magic doesn't seem to work if I just checkout
        // the target commit, so instead I rewrite master to point to it.
        // *rfkelly waves hands mysteriously*
        var p = child_process.spawn('git',
                                    ['reset', '--hard', state.currentCommit],
                                    {cwd: state.workDir});
        p.on('exit', function(code, signal) {
          var err = code || signal;
          return cb(err);
        });
      });
    },

    function findInstanceCreationHelper(cb) {
      // Use the boxen type to find the appropriate helper module.
      var helperName = boxCfg.Type.toLowerCase();
      if (helperName.indexOf('awsboxen::') === 0) {
        helperName = helperName.split("awsboxen::")[1];
      }
      try {
        state.helper = require('./freezer/' + helperName + '.js');
      } catch (err) {
        return cb('Invalid boxen type: ' + boxCfg.Type);
      }
      return cb(null);
    },

    function createInstance(cb) {
      // Call the helper, capture the instance id into a scoped variable.
      state.helper.createInstance(state, function(err, instanceId) {
        state.instanceId = instanceId;
        return cb(err);
      });
    },

    function freezeInstance(cb) {
      createAMIFromInstance(state.opts, state.instanceId, state.imageName,
      function(err, res) {
        if (err) return cb(err);
        state.amiId = res;
        cb(null);
      });
    }, 

    function teardownInstance(cb) {
      state.helper.teardownInstance(state, cb);
    }
  ],

  function cleanup(err) {
    if (err === 'AWSBOXEN_AMI_ALREADY_EXISTS') err = null;
    if (!state.workDir) return cb(err, state.amiId);
    cleanupDir(state.workDir, function(cleanupError) {
      return cb(err || cleanupError, state.amiId);
    });

  });
}


// Recursively delete a directory.
// Probably there is a better way to handle this, but I don't
// feel like shaving that yak right now...
//
function cleanupDir(dirPath, cb) {
  fs.readdir(dirPath, function(err, names) {
    if (err) return cb(err);
    async.eachSeries(names, function(name, cb) {
      var childPath = path.join(dirPath, name);
      fs.stat(childPath, function(err, stat) {
        if (err) return cb(err);
        if (stat.isDirectory()) {
          cleanupDir(childPath, cb);
        } else {
          fs.unlink(childPath, cb);
        }
      });
    }, function(err) {
      if (err) return cb(err);
      fs.rmdir(dirPath, cb);
    });
  });
}
