//
// Functions for freezing configured instances into an AMI.
//
// This is currently specialised towards using awsbox for the freezing,
// but if the idea works out it could become quite generic and use e.g.
// chef or puppet as an alternative for building the machine.
//

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const async = require('async');
const temp = require('temp');
const aws = require('awssum-amazon');
const Ec2 = require('awssum-amazon-ec2').Ec2;

// Need path to awsbox executable, so we can shell out to it.
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
function createAMIFromInstance(opts, instanceId, cb) {
  getConnection(opts, function(err, ec2) {
    if (err) return cb(err);
    ec2.CreateImage({
      InstanceId: instanceId,
      Name: 'awsboxen-' + opts.name + '-ami',
      Description: 'awsboxen ' + opts.name + ' ami'
    }, function(err, res) {
      if (err) return cb(extractError(err));
      var imageId = res.Body.CreateImageResponse.imageId;
      // Loop waiting for the creation to complete.
      var state = null;
      async.doWhilst(function(cb) {
        setTimeout(function() {
          ec2.DescribeImages({ ImageId: imageId }, function(err, res) {
             if (err) return cb(extractError(err));
             console.log(res.Body.DescribeImagesResponse);
             state = res.Body.DescribeImagesResponse.imagesSet.item.imageState;
             cb(null);
          });
        }, 3000);
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
  var amiId = null;
  var serverName = 'awsboxen-build-server';
  async.waterfall([
    function makeWorkingDir(cb) {
      temp.mkdir('awsboxen-freezer', function(err, dirPath) {
        if (err) return cb(err);
        workDir = dirPath;
        cb(null);
      });
    },
    function cloneGitRepo(cb) {
      var p = child_process.spawn('git', ['clone', projDir, workDir]);
      p.on('exit', function(code, signal) {
        cb(code || signal);
      });
    },
    function writeAwsBoxConfig(cb) {
      if (!boxCfg) return cb(null);
      try {
        var cfg = JSON.stringify(boxCfg);
        fs.writeFile(path.join(workDir, '.awsbox.json'), cfg, cb);
      } catch (err) { return cb(err); }
    },
    function createInstance(cb) {
      // Spawn awsbox as a sub-process.
      // We capture stdout trough a pipe, but also buffer it in
      // memory so that we can grab info out of it.
      var output = '';
      var p = child_process.spawn(AWSBOX,
                                  ['create', '-n', serverName],
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
        var instanceId = output.match(/"instanceId": "([a-z0-9\-]+)",/)[1];
        if (!instanceId) return cb('awsbox failure');
        // Push the current commit up to the awsbox.
        var p = child_process.spawn('git', ['push', serverName, 'HEAD:master'],
                                    {stdio: 'inherit', cwd: workDir});
        p.on('exit', function(code, signal) {
          cb(code || signal, instanceId);
        });
      });
    }, 
    function freezeInstance(instanceId, cb) {
      createAMIFromInstance(opts, instanceId, function(err, res) {
        if (err) return cb(err);
        amiId = res;
        cb(null);
      });
    }, 
    function teardownInstance(cb) {
      var p = child_process.spawn(AWSBOX, ['destroy', serverName],
                                  {stdio: 'inherit', cwd: workDir});
      p.on('exit', function(code, signal) {
        cb(code || signal);
      });
    }, 
  ], function cleanup(err) {
    if (!workDir) return cb(err, amiId);
    cleanupDir(workDir, function(cleanupError) {
      return cb(err || cleanupError, amiId);
    });
  });
}



// Recursively delete a directory.
// Probably there is a better way to handle this, but I don't
// feel like shaving yak right now...
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
