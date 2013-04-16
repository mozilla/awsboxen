/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Find info about a given project.
 *
 * This module is responsible for finding the info and configuration for
 * a given project.  Currently this involved parsing the .awsboxen config
 * file out of its root directory.  Eventually it'll grow more functionality
 * for e.g. interrogating git for project metadata.
 *
 */

const path = require('path');
const child_process = require('child_process');
const async = require('async');
const awsbox = {
  key: require('awsbox/lib/key')
};

const config = require('./config');


const CONFIG_TOP_LEVEL_KEYS = ["Boxen", "AWSTemplateFormatVersion",
                               "Description", "Parameters", "Resources",
                               "Mappings", "Outputs"];


// Make the module callable, returning a ProjectInfo object.
//
module.exports = function projinfo(projDir, profile) {
  return new ProjectInfo(projDir, profile);
};

module.exports.ProjectInfo = ProjectInfo;


//  Object representing a snapshot of the project to be deployed.
//  It encapsulates the git repo and selected profile.
//
function ProjectInfo(projDir, profile) {
  this.projDir = path.join(process.cwd(), projDir);
  this.profile = profile || 'Default';
}


// Load the (extended) CloudFormation config for this project.
// This method takes care of locating and parsing the config files,
// filling in the selected profile, providing sensible defaults, and
// returns the completed config object ready for use.
//
ProjectInfo.prototype.loadConfig = function loadConfig(cb) {
  var self = this;
  var currentCommit = null;

  config.loadRootConfig(this.projDir, function(err, cfg) {
    if (err) return cb(err);

    async.waterfall([
      // Figure out the current commit.
      function findCurrentCommit(cb) {
        child_process.exec('git log --pretty=%h -1', function(err, stdout) {
          if (err) return cb(err);
          currentCommit = stdout.trim();
          if (!currentCommit || currentCommit.length !== 7) {
            return cb('failed to get current commit');
          }
          cb(null);
        });
      },
      // Merge the selected profile into the base configuration.
      // The special profile 'Default' is assumed to be empty if not exists.
      function mergeProfileConfig(cb) {
        var profileCfg = cfg.Profiles ? cfg.Profiles[self.profile] : null;
        if (!profileCfg) {
          if (self.profile !== 'Default') {
            return cb('unknown profile "' + self.profile + '"');
          }
        } else {
          cfg = config.mergeConfig(cfg, profileCfg);
        }
        delete cfg.Profiles;
        cb(null);
      },
      // Ensure we have at least one Boxen definition, using values from the
      // top-level of the config if necessary.
      function setDefaultBoxen(cb) {
        if (cfg.Boxen) return cb(null);
        cfg.Boxen = { AWSBox: {} };
        Object.keys(cfg).forEach(function(k) {
          if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
            cfg.Boxen.AWSBox[k] = cfg[k];
            delete cfg[k];
          }
        });
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
              Default: self.profile
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
      // Delete anything that's not recognised as a top-level key.
      function deleteExtraKeys(cb) {
        Object.keys(cfg).forEach(function(k) {
          if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
            delete cfg[k];
          }
        });
        cb(null);
      },
      // Fill in any final defaults.
      function setFinalDefaults(cb) {
        if (!cfg.Description) {
          var projName = path.basename(self.projDir);
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
};
