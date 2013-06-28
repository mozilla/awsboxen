/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Load CloudFormation template from a git checkout of a project.
 *
 * This module is responsible for loading the info and configuration for
 * a given project, parsings its .awsboxen file(s) and returning a full
 * CloudFormation template.
 *
 */

const path = require('path');
const child_process = require('child_process');
const async = require('async');
const traverse = require('traverse');
const awsbox = {
  key: require('awsbox/lib/key')
};

const config = require('./config');


const CONFIG_TOP_LEVEL_KEYS = ["Boxen", "Profiles", "AWSBoxenVersion",
                               "AWSTemplateFormatVersion", "Description",
                               "Parameters", "Resources", "Mappings",
                               "Outputs"];


// Make the module callable, returning a ProjectInfo object.
//
module.exports = loadTemplate;

module.exports.CONFIG_TOP_LEVEL_KEYS = CONFIG_TOP_LEVEL_KEYS;


// Load the (extended) CloudFormation template for this project.
// This method takes care of locating and parsing the config files,
// filling in the selected profile, providing sensible defaults, and
// returns the completed config object ready for use.
//
function loadTemplate(projDir, opts, cb) {
  if (!cb && typeof opts === 'function') {
    cb = opts;
    opts = {};
  }

  projDir = path.resolve(process.cwd(), projDir);
  opts.profile = opts.profile || 'Default';

  var currentCommit = null;
  var cwd = { cwd: projDir };

  config.loadRootConfig(projDir, function(err, cfg) {
    if (err) return cb(err);

    async.waterfall([

      // Check for uncommitted changes; bail out if present.
      function checkForUncommittedChanges(cb) {
        if (opts.ignore_uncommitted) return cb(null);
        child_process.exec('git status', cwd, function(err, stdout) {
          if (err) return cb(err);
          if (stdout.indexOf('nothing to commit') === -1) {
            return cb('there are uncommitted changes; aborting');
          }
          return cb(null);
        });
      },

      // Figure out the current commit.
      function findCurrentCommit(cb) {
        var cmd = 'git log --pretty=%h -1';
        child_process.exec(cmd, cwd, function(err, stdout) {
          if (err) return cb(err);
          currentCommit = stdout.trim();
          if (!currentCommit || currentCommit.length !== 7) {
            return cb('failed to get current commit');
          }
          cb(null);
        });
      },

      // In-place upgrade any .awsbox.json declarations into fully
      // structured awsboxen declarations.  Do this for the base config
      // as well as any profiles, so they can be merged cleanly.
      function upgradeAWSBoxDeclarations(cb) {
        upgradeFromAWSBoxConfig(cfg, function(err) {
          if (err) return cb(err);
          async.eachSeries(Object.keys(cfg.Profiles || {}), function(k, cb) {
            upgradeFromAWSBoxConfig(cfg.Profiles[k], cb);
          }, cb);
        });
      },

      // Merge the selected profile into the base configuration.
      // The special profile 'Default' is assumed to be empty if not exists.
      function mergeProfileConfig(cb) {
        var profileCfg = cfg.Profiles ? cfg.Profiles[opts.profile] : null;
        if (!profileCfg) {
          if (opts.profile !== 'Default') {
            return cb('unknown profile "' + opts.profile + '"');
          }
        } else {
          cfg = config.mergeConfig(cfg, profileCfg);
        }
        delete cfg.Profiles;
        cb(null);
      },

      // Add some default parameters to reflect the environment.
      function setDefaultParameters(cb) {
        if (!cfg.Parameters) cfg.Parameters = {};
        if (!cfg.Outputs) cfg.Outputs = {};
        async.waterfall([
          function setAWSBoxDeployKey(cb) {
            if (cfg.Parameters.AWSBoxDeployKey) return cb(null);
            // XXX TODO: we currently assume that this key is available
            awsbox.key.fingerprint(function(err, keyFingerprint) {
              cfg.Parameters.AWSBoxDeployKey = {
                Type: 'String',
                Default: 'awsbox deploy key (' + keyFingerprint + ')'
              };
              cb(null);
            });
          },
          function setAWSBoxenDetails(cb) {
            cfg.Parameters.AWSBoxenProfile = {
              Type: 'String',
              Default: opts.profile
            };
            cfg.Outputs.AWSBoxenProfile = {
              Value: {'Ref' : 'AWSBoxenProfile'},
              Description: 'AWSBoxen Deployment Profile Name'
            };
            cfg.Parameters.AWSBoxenCommit = {
              Type: 'String',
              Default: currentCommit
            };
            cfg.Outputs.AWSBoxenCommit = {
              Value: {'Ref' : 'AWSBoxenCommit'},
              Description: 'AWSBoxen Deployed Commit SHA1'
            };
            return cb(null);
          }
        ], cb);
      },

      // Ensure we have at least one Resource definition.
      // If not, then create an EC2 instance for each Boxen definition
      // along with some supporting infrastructure.
      function setDefaultResources(cb) {
        if (cfg.Resources) return cb(null);
        cfg.Resources = {
          AWSBoxSecurityGroup: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: {
              GroupDescription: 'awsboxen default security group',
              SecurityGroupIngress: [
                {IpProtocol: "tcp", FromPort: "22", ToPort: "22",
                 CidrIp: "0.0.0.0/0"},
                {IpProtocol: "tcp", FromPort: "80", ToPort: "80",
                 CidrIp: "0.0.0.0/0"},
                {IpProtocol: "tcp", FromPort: "443", ToPort: "443",
                 CidrIp: "0.0.0.0/0"}
              ]
            }
          }
        };
        Object.keys(cfg.Boxen).forEach(function(boxName) {
          cfg.Resources[boxName + 'Server'] = {
            Type: 'AWS::EC2::Instance',
            Properties: {
              ImageId: { Ref: boxName + 'AMI' },
              InstanceType: 'm1.small',
              SecurityGroups: [{ Ref: 'AWSBoxSecurityGroup' }],
              KeyName: { Ref: 'AWSBoxDeployKey' }
            }
          };
          cfg.Outputs[boxName + 'ServerURL'] = {
            Value: {'Fn::GetAtt' : [boxName + 'Server', 'PublicDnsName']},
            Description: 'Public URL for ' + boxName + 'Server'
          };
        });
        cb(null);
      },

      // Delete any unrecognised top-level keys that might have been
      // introduced by the profile merge.
      function deleteExtraKeys(cb) {
        Object.keys(cfg).forEach(function(k) {
          if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
            delete cfg[k];
          }
        });
        cb(null);
      },

      // Clear out any null definitions left over after the merge.
      function cleanupNullDefinitions(cb) {
        Object.keys(cfg.Boxen).forEach(function(boxName) {
          if (!cfg.Boxen[boxName]) {
            delete cfg.Boxen[boxName];
          }
        });
        Object.keys(cfg.Resources).forEach(function(resName) {
          if (!cfg.Resources[resName]) {
            delete cfg.Resources.resName;
          }
        });
        cb(null);
      },

      // Resolve any CloudFormation function calls inside Boxen declarations.
      // It's kinda yuck that we have to do this, but the Boxen need to be
      // build before CloudFormation ever sees the template.
      function resolveFunctionCallsInBoxenDefinitions(cb) {
        // Do one pass to resolve "AWS::Region" and "AWS::StackName" refs.
        traverse(cfg).forEach(function(obj) {
          if (typeof obj === 'object') {
            var keys = Object.keys(obj);
            if (keys.length === 1 && keys[0] === 'Ref') {
              if (obj['Ref'] === 'AWS::Region') {
                this.update(opts.aws_region);
              } else if (obj['Ref'] === 'AWS::StackName' && opts.name) {
                this.update(opts.name);
              }
            }
          }
        });
        // Now we can resolve any occurrances of Fn::FindInMap.
        traverse(cfg).forEach(function(obj) {
          if (typeof obj === 'object') {
            var keys = Object.keys(obj);
            if (keys.length === 1 && keys[0] === 'Fn::FindInMap') {
              try {
                var mapped = cfg.Mappings[obj['Fn::FindInMap'][0]];
                mapped = mapped[obj['Fn::FindInMap'][1]];
                mapped = mapped[obj['Fn::FindInMap'][2]];
                this.update(mapped);
              } catch (e) { };
            }
          }
        });
        return cb(null);
      },

      // Apply any custom helper functions.
      // We traverse the entire document looking for single-key objects
      // whose key matches "Fn::AWSBoxen::<funcname>", then call the named
      // function and sub its result back into the document.
      function applyCustomHelperFunctions(cb) {
        traverse(cfg).forEach(function(obj) {
          if (typeof obj !== 'object') return;
          var keys = Object.keys(obj);
          if (keys.length !== 1) return;
          if (keys[0].indexOf('Fn::AWSBoxen::') !== 0) return;
          var funcName = keys[0].split('Fn::AWSBoxen::')[1];
          this.update(templateFunctions[funcName](obj[keys[0]]));
        });
        return cb(null);
      },

      // Fill in any final defaults.
      function setFinalDefaults(cb) {
        if (!cfg.Description) {
          var projName = path.basename(projDir);
          cfg.Description = 'awsboxen deployment of ' + projName;
        }
        if (!cfg.AWSTemplateFormatVersion) {
          cfg.AWSTemplateFormatVersion = '2010-09-09';
        }
        cb(null);
      }
    ], function finalize(err) {
        return cb(err, cfg);
    });
  });
}


// Upgrade a config from .awsbox.json configuration style to the more
// richly-structured style of a generic .awsboxen.js.  This is factored
// out as a separate function so it can be applied to both the root
// config and to individual profiles.
//
function upgradeFromAWSBoxConfig(cfg, cb) {
  async.waterfall([
    // Ensure that each boxen declaration has a "type" and associated
    // properties.  The default type is an awsbox box with properties
    // taken from the top-level dict.
    function setDefaultBoxenType(cb) {
      if (!cfg.Boxen) {
        cfg.Boxen = {};
      }
      Object.keys(cfg.Boxen).forEach(function(boxName) {
        if (cfg.Boxen[boxName] && !cfg.Boxen[boxName].Type) {
          if (!cfg.Boxen[boxName].Properties) {
            cfg.Boxen[boxName] = {
              'Properties': cfg.Boxen[boxName]
            };
          }
          cfg.Boxen[boxName].Type = 'AWSBox';
        }
      });
      cb(null);
    },
    // If there are any unexpected top-level keys, pull them into a
    // default boxen definition named 'AWSBox'.  This might already
    // exist, in which case it's merged over top of the extra keys.
    function createDefaultBoxen(cb) {
      var extraTopLevelKeys = {};
      var hasExtraTopLevelKeys = false;
      Object.keys(cfg).forEach(function(k) {
        if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
          hasExtraTopLevelKeys = true;
          extraTopLevelKeys[k] = cfg[k];
          delete cfg[k];
        }
      });
      if (hasExtraTopLevelKeys) {
        var origAWSBox = cfg.Boxen.AWSBox;
        cfg.Boxen.AWSBox = {
          Type: 'AWSBox',
          Properties: extraTopLevelKeys
        };
        if (typeof origAWSBox !== 'undefined') {
          cfg.Boxen.AWSBox = config.mergeConfig(cfg.Boxen.AWSBox, origAWSBox);
        }
      }
      cb(null);
    },
  ], cb);
}



var templateFunctions = {};


// Template helper function that can generate UserData scripts for writing
// config files.  It takes a hash mapping file paths to values, and outputs
// the necessary CloudFormation palaver to produce a CloudInit script that
// will generate those files on first boot.
//
// The CloudInit script it produces will look something like this:
//
//    #!/bin/bash
//    set -e -x
//    cat << EOF_MARKER > /path/to/file
//    <FILE DATA>
//    EOF_MARKER
//
//  But it will be wrapped in the necessary CloudFormation function calls
//  to pass it as a Base64 blob, to interpolate {Ref} calls, etc.
//
templateFunctions.UserDataFiles = function UserDataFiles(fileData) {
  var scriptLines = [];
  scriptLines.push('#!/bin/bash');
  scriptLines.push('set -e -x');
  // Write each file using a here-doc.
  for (var filePath in fileData) {
    if (fileData.hasOwnProperty(filePath)) {
      var fileBody = fileData[filePath];
      scriptLines.push('cat << EOF_MARKER > ' + filePath);
      if (typeof fileBody !== 'object') {
        scriptLines.push(fileBody.toString());
      } else {
        scriptLines.push(stringifyWithCFNRefs(fileBody));
      }
      scriptLines.push('EOF_MARKER');
    }
  }
  // Wrap the script into a Base64 blob in CloudFormation.
  return { 'Fn::Base64': { 'Fn::Join': [ '\n', scriptLines ] } };
};


// Detect if an object represents a CloudFormation function reference
// or similar non-stringifable thing.
function isCFNRef(obj) {
  var keys = Object.keys(obj);
  if (keys.length !== 1) return false;
  if (keys[0] === "Ref") return true;
  if (keys[0].indexOf("Fn::") === 0) return true;
  return false;
}


// Stringify an object into JSON, but leaving CFN function references
// intact.  This produces a {"Fn::Join"} CFN ref that will build the
// appropriate string at runtime.
//
function stringifyWithCFNRefs(obj) {
  // Recusrive accumulator implementation of the stringifer.
  function stringifyRec(obj, collect) {
    if (typeof obj !== 'object') {
      // Non-object values can be stringified directly.
      collect(JSON.stringify(obj));
    } else if (isCFNRef(obj)) {
      // CFN refs produce strings, so surround them with quotes.
      collect('"');
      collect(obj);
      collect('"');
    } else if (Array.isArray(obj)) {
      // Encode each item of the array recursively.
      collect('[');
      for (var i=0; i < obj.length; i++) {
        if (i > 0) {
          collect(',');
        }
        stringifyRec(obj[i], collect);
      }
      collect(']');
    } else {
      // Encode each entry of the hash recursively.
      collect('{');
      var firstRun = true;
      for (var k in obj) {
        if (!obj.hasOwnProperty(k)) continue;
        if (!firstRun) {
          collect(',');
        } else {
          firstRun = false;
        }
        collect(JSON.stringify(k));
        collect(':');
        stringifyRec(obj[k], collect);
      }
      collect('}');
    }
  }
  // Accumulate each part of the stringifaction in this array.
  // Consecutive string values are merged as they come in.
  var parts = [];
  stringifyRec(obj, function collect(val) {
    if (parts.length === 0 || typeof val === 'object') {
      parts.push(val);
    } else if (typeof parts[parts.length - 1] === 'object') {
      parts.push(val);
    } else {
      parts[parts.length - 1] += val;
    }
  });
  // If there were no refs, we can return a plain string.
  if (parts.length < 2) {
    return parts.join('');
  }
  // Otherwise CloudFormation must build the string at runtime.
  return {'Fn::Join': ['', parts] };
}
