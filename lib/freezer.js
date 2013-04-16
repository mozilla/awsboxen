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
const aws = require('awssum-amazon');
const Ec2 = require('awssum-amazon-ec2').Ec2;

// Need path to awsbox executable, so we can shell out to it.
// This ensures we always use the locally-bundled one given to us by npm.
const AWSBOX = require.resolve('awsbox/awsbox.js');


module.exports = {
  createAMIFromInstance: createAMIFromInstance,
  createAwsBoxAMI: createAwsBoxAMI
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
        return cb(null, imageId);
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

// Create an AMI from an awsbox configuration.
// This function shells out to awsbox to generate a running instance,
// then freezes it up into an AMI for re-use.  It's doing the dumbest
// thing that could possibly work:
//
//   * cloning the whole git repo into a temp directory
//   * overwriting the awsbox configuration file
//   * shelling out to awsbox to spin up the instance
//   * freezing the running instance
//   * tearing everything back down
//
// Inelegant, but effective enough for now.
//
function createAwsBoxAMI(opts, projDir, boxName, boxCfg, cb) {
  var workDir = null;
  var currentCommit = null;
  var imageName = null;
  var instanceId = null;
  var amiId = null;
  async.waterfall([

    function makeWorkingDir(cb) {
      temp.mkdir('awsboxen-freezer', function(err, dirPath) {
        if (err) return cb(err);
        workDir = dirPath;
        cb(null);
      });
    },

    function findCurrentCommit(cb) {
      child_process.exec('git log --pretty=%h -1', function(err, stdout) {
        if (err) return cb(err);
        currentCommit = stdout.trim();
        if (!currentCommit || currentCommit.length !== 7) {
          return cb('failed to get current commit');
        }
        // Name the image after the project, boxName and commit hash.
        // XXX TODO: should include profile/config into the image name.
        // XXX TODO: use tags instead of encoding it all in the name?
        imageName = 'awsboxen-';
        imageName += path.basename(path.join(process.cwd(), projDir)) + '-';
        imageName += boxName + '-' + currentCommit;
        cb(null);
      });
    },

    function skipIfImageAlreadyExists(cb) {
      checkAMI(opts, imageName, function(err, id) {
        if (err) return cb(err);
        amiId = id;
        cb(null);
      });
    },

    function cloneGitRepoAtCurrentCommit(cb) {
      if (amiId) return cb(null);
      var p = child_process.spawn('git', ['clone', projDir, workDir]);
      p.on('exit', function(code, signal) {
        var err = code || signal;
        if (err) return cb(err);
        // The awsbox magic doesn't seem to work if I checkout the commit, so
        // instead I rewrite master to point to it *waves hands mysteriously*
        var p = child_process.spawn('git',
                                    ['reset', '--hard', currentCommit],
                                    {cwd: workDir});
        p.on('exit', function(code, signal) {
          var err = code || signal;
          return cb(err);
        });
      });
    },

    function writeAwsBoxConfig(cb) {
      if (amiId) return cb(null);
      try {
        var cfg = JSON.stringify(boxCfg);
        fs.writeFile(path.join(workDir, '.awsbox.json'), cfg, cb);
      } catch (err) { return cb(err); }
    },

    function createInstance(cb) {
      if (amiId) return cb(null);
      var serverName = imageName + '-freezer';
      // Spawn awsbox as a sub-process.
      // We capture stdout through a pipe, but also buffer it in
      // memory so that we can grab info out of it.
      var output = '';
      var p = child_process.spawn(AWSBOX,
                              ['create', '-n', serverName, '-t', 'm1.small'],
                              {stdio: [0, 'pipe', 2], cwd: workDir});
      p.stdout.on('data', function(d) {
        process.stdout.write(d);
        output += d;
      });
      p.on('exit', function(code, signal) {
        var err = code || signal;
        if (err) return cb(err);
        // Parse out the instance details from the awsbox output.
        // This is...err...a little suboptimal...
        instanceId = output.match(/"instanceId": "([a-z0-9\-]+)",/)[1];
        if (!instanceId) return cb('awsbox failure');
        // Push the current commit up to the awsbox.
        var p = child_process.spawn('git',
                                    ['push', serverName, 'HEAD:master'],
                                    {stdio: 'inherit', cwd: workDir});
        p.on('exit', function(code, signal) {
          var err = code || signal;
          return cb(err);
        });
      });
    }, 

    function freezeInstance(cb) {
      if (amiId) return cb(null);
      createAMIFromInstance(opts, instanceId, imageName, function(err, res) {
        if (err) return cb(err);
        amiId = res;
        cb(null);
      });
    }, 

    function teardownInstance(cb) {
      if (!instanceId) return cb(null);
      var serverName = imageName + '-freezer';
      var p = child_process.spawn(AWSBOX, ['destroy', serverName],
                                  {stdio: 'inherit', cwd: workDir});
      p.on('exit', function(code, signal) {
        cb(code || signal);
      });
    }, 
  ],

  function cleanup(err) {
    if (!workDir) return cb(err, amiId);
    cleanupDir(workDir, function(cleanupError) {
      return cb(err || cleanupError, amiId);
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
