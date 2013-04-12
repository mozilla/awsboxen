//
// Find info about a given project.
//
// This module is responsible for finding the info and configuration for
// a given project.  Currently this involved parsing the .awsboxen config
// file out of its root directory.  Eventually it'll grow more functionality
// for e.g. interrogating git for project metadata.

const path = require('path');

const config = require('./config');


const CONFIG_TOP_LEVEL_KEYS = ["Boxen", "AWSTemplateFormatVersion",
                               "Description", "Parameters", "Resources",
                               "Mappings", "Outputs"];


// Make the module callable, returning a ProjectInfo object.
//
module.exports = function projinfo(projDir, profile, ref) {
  return new ProjectInfo(projDir, profile, ref);
};

module.exports.ProjectInfo = ProjectInfo;


//  Object representing a snapshot of the project to be deployed.
//  It encapsulates the git repo, selected profile, and selected git ref.
//
function ProjectInfo(projDir, profile, ref) {
  this.projDir = path.join(process.cwd(), projDir);
  this.profile = profile || 'Default';
  this.ref = ref;
}


// Load the (extended) CloudFormation config for this project.
// This method takes care of locating and parsing the config files,
// filling in the selected profile, providing sensible defaults, and
// returns the completed config object ready for use.
//
ProjectInfo.prototype.loadConfig = function loadConfig(cb) {
  var self = this;
  config.loadRootConfig(this.projDir, function(err, cfg) {
    if (err) return cb(err);
    // Merge the selected profile into the base configuration.
    // The special profile 'Default' is assumed to be empty if not exists.
    var profileCfg = cfg.Profiles ? cfg.Profiles[self.profile] : null;
    if (!profileCfg) {
      if (self.profile !== 'Default') {
        return cb('unknown profile "' + self.profile + '"');
      }
    } else {
      cfg = config.mergeConfig(cfg, profileCfg);
    }
    delete cfg.Profiles;
    // Ensure we have at least one Boxen definition, using values from the
    // top-level of the config if necessary.
    if (!cfg.Boxen) {
      cfg.Boxen = { DefaultBox: {} };
      Object.keys(cfg).forEach(function(k) {
        if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
          cfg.Boxen.DefaultBox[k] = cfg[k];
          delete cfg[k];
        }
      });
    }
    // Ensure we have at least one Resource definition.
    // If non, then create an EC2 instance fo each Boxen definition.
    if (!cfg.Resources) {
      cfg.Resources = {};
      Object.keys(cfg.Boxen).forEach(function(boxName) {
        cfg.Resources[boxName + 'Server'] = {
          'Type': 'AWS::EC2::Instance',
          'Properties': {
            // XXX TODO: somehow refer to the generated boxen AMI
            // XXX TODO: a default security group to put them in.
            'ImageId': 'ami-1624987f',
            'InstanceType': 'm1.small'
          }
        };
      });
    }
    // Delete anything that's not recognised as a top-level key.
    Object.keys(cfg).forEach(function(k) {
      if (CONFIG_TOP_LEVEL_KEYS.indexOf(k) === -1) {
        delete cfg[k];
      }
    });
    // Fill in any final defaults.
    if (!cfg.Parameters) {
      cfg.Parameters = {};
    }
    if (!cfg.Description) {
      var projName = path.basename(self.projDir);
      cfg.Description = 'awsboxen deployment of ' + projName;
    }
    if (!cfg.AWSTemplateFormatVersion) {
      cfg.AWSTemplateFormatVersion = '2010-09-09';
    }
    // And we're done!
    return cb(null, cfg);
  });
};
